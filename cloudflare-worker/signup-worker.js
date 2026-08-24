/*
  LyDia -- signup form receiver (replaces Netlify Forms).

  2026-08-24: after moving off Netlify to GitHub Pages, the two <form
  data-netlify="true"> forms (name="newsletter" / "free-preview" and
  name="member-email") stopped working -- GitHub Pages is pure static
  hosting, no server-side form processing at all. This Worker is the
  replacement backend: it receives the POST, appends the email to a CSV on
  a dedicated "signups" branch of the repo (via the GitHub Contents API),
  and scripts/send-free-preview-emails.js / scripts/send-member-emails.js
  read that CSV directly instead of calling Netlify's Forms API.

  WHY A SEPARATE "signups" BRANCH, NOT main
  Every workflow in .github/workflows/ ends with a commit-and-push to main,
  several times a day on fixed schedules. A visitor can submit this form at
  literally any moment. If this Worker also committed straight to main, a
  submission landing mid-publish would race the workflow's own push and
  intermittently fail it -- the exact "cannot lock ref, remote had moved"
  failure diagnosed and fixed for daily-recap.yml/backfill-recaps.yml on
  2026-08-23, except unpredictable instead of a fixed 5-minute overlap.
  Writing to "signups" instead means this Worker never touches the same ref
  the pipeline writes to, so it can't collide with it. The two email
  scripts read the CSV straight off that branch (raw.githubusercontent.com),
  no merge into main required.

  Required Worker secrets (set via `wrangler secret put <NAME>`, see
  DEPLOY.md in this folder):
    GITHUB_TOKEN     -- fine-grained PAT, Contents: Read and write, scoped
                        to this one repo only.
    ALLOWED_ORIGIN    -- e.g. "https://lydiaslab.com" (CORS + _next safety)

  Non-secret config below (edit directly, no need to keep out of git):
*/
const GITHUB_OWNER = "flychico";
const GITHUB_REPO = "lydiaslab";
const SIGNUPS_BRANCH = "signups";

const LISTS = {
  "member-email": "data/signups/member-email.csv",
  "newsletter": "data/signups/free-preview.csv",
  "free-preview": "data/signups/free-preview.csv"
};
const DEFAULT_LIST = "newsletter";

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
}

function corsHeaders(origin, allowedOrigin) {
  const h = { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  if (origin === allowedOrigin) h["Access-Control-Allow-Origin"] = allowedOrigin;
  return h;
}

async function parseBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await request.json().catch(() => ({}));
    return j || {};
  }
  const text = await request.text();
  const params = new URLSearchParams(text);
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function thanksPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>LyDia</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e8edf5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:420px;padding:32px;text-align:center}
a{color:#6db4ff}</style></head>
<body><div class="card"><h1>&#9993; ${message}</h1><p><a href="https://lydiaslab.com/">Back to LyDia</a></p></div></body></html>`;
}

// GitHub Contents API: fetch current file (sha + decoded content), or null if it doesn't exist yet.
async function getFile(env, path) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${SIGNUPS_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "lydia-signup-worker",
      Accept: "application/vnd.github+json"
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: HTTP ${res.status}`);
  const json = await res.json();
  const content = atob(json.content.replace(/\n/g, ""));
  return { sha: json.sha, content };
}

// Ensure the "signups" branch exists -- created once, from main's current HEAD, if missing.
async function ensureBranch(env) {
  const refUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/${SIGNUPS_BRANCH}`;
  const check = await fetch(refUrl, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "lydia-signup-worker", Accept: "application/vnd.github+json" }
  });
  if (check.ok) return;
  const mainRefUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/main`;
  const mainRes = await fetch(mainRefUrl, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "lydia-signup-worker", Accept: "application/vnd.github+json" }
  });
  if (!mainRes.ok) throw new Error(`Could not read main's HEAD: HTTP ${mainRes.status}`);
  const mainRef = await mainRes.json();
  const createRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "lydia-signup-worker",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ref: `refs/heads/${SIGNUPS_BRANCH}`, sha: mainRef.object.sha })
  });
  if (!createRes.ok && createRes.status !== 422) {
    // 422 = ref already exists (race with another request creating it first) -- fine, ignore.
    throw new Error(`Could not create ${SIGNUPS_BRANCH} branch: HTTP ${createRes.status}`);
  }
}

// subscriptionId is only meaningful for the member-email list (membership/index.html's two
// forms let a paid member link their delivery email to their PayPal subscription ID, so
// support can match a mis-typed signup back to the actual payment). Written as a 3rd CSV
// column only when present -- the free-preview list stays 2 columns.
async function appendSignup(env, path, email, subscriptionId) {
  await ensureBranch(env);
  const existing = await getFile(env, path);
  const nowIso = new Date().toISOString();
  const emailLower = email.trim().toLowerCase();
  const extra = subscriptionId ? `,${subscriptionId.trim()}` : "";

  if (existing) {
    const lines = existing.content.split("\n").filter(Boolean);
    const already = lines.slice(1).some(l => (l.split(",")[0] || "").trim().toLowerCase() === emailLower);
    if (already) return { added: false, reason: "duplicate" };
    const newContent = existing.content.replace(/\n?$/, "") + `\n${email.trim()},${nowIso}${extra}\n`;
    const putRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "lydia-signup-worker",
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `Signup: ${path.includes("member") ? "member-email" : "free-preview"}`,
        content: btoa(newContent),
        sha: existing.sha,
        branch: SIGNUPS_BRANCH
      })
    });
    if (!putRes.ok) throw new Error(`GitHub PUT ${path} failed: HTTP ${putRes.status} ${await putRes.text()}`);
    return { added: true };
  }

  // File doesn't exist yet on this branch -- create it with a header row.
  const header = path.includes("member") ? "email,submitted_at,subscription_id\n" : "email,submitted_at\n";
  const newContent = header + `${email.trim()},${nowIso}${extra}\n`;
  const createRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "lydia-signup-worker",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Signup: ${path.includes("member") ? "member-email" : "free-preview"} (new file)`,
      content: btoa(newContent),
      branch: SIGNUPS_BRANCH
    })
  });
  if (!createRes.ok) throw new Error(`GitHub CREATE ${path} failed: HTTP ${createRes.status} ${await createRes.text()}`);
  return { added: true };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://lydiaslab.com";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin, allowedOrigin) });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const wantsJson = (request.headers.get("accept") || "").includes("application/json")
      || (request.headers.get("content-type") || "").includes("application/json");

    let body;
    try {
      body = await parseBody(request);
    } catch (e) {
      return respond(wantsJson, origin, allowedOrigin, 400, { ok: false, error: "Could not read submission." });
    }

    // Honeypot -- same field name the old Netlify forms used (bot-field). A filled honeypot
    // means a bot filled every visible field; pretend success so it doesn't learn anything.
    if (body["bot-field"]) {
      return respond(wantsJson, origin, allowedOrigin, 200, { ok: true }, "You're on the list.");
    }

    const email = body.email;
    if (!isValidEmail(email)) {
      return respond(wantsJson, origin, allowedOrigin, 400, { ok: false, error: "Enter a valid email address." });
    }

    const listKey = (body.list || body["form-name"] || DEFAULT_LIST).toLowerCase();
    const path = LISTS[listKey] || LISTS[DEFAULT_LIST];
    const subscriptionId = (body["subscription-id"] || "").trim();

    try {
      await appendSignup(env, path, email, subscriptionId);
    } catch (err) {
      console.error(err);
      return respond(wantsJson, origin, allowedOrigin, 502, { ok: false, error: "Signup failed, try again shortly." });
    }

    return respond(wantsJson, origin, allowedOrigin, 200, { ok: true }, "You're on the list — first card arrives tomorrow morning.");
  }
};

function respond(wantsJson, origin, allowedOrigin, status, jsonBody, thanksMessage) {
  const headers = corsHeaders(origin, allowedOrigin);
  if (wantsJson) {
    headers["Content-Type"] = "application/json";
    return new Response(JSON.stringify(jsonBody), { status, headers });
  }
  headers["Content-Type"] = "text/html; charset=utf-8";
  return new Response(thanksPage(thanksMessage || (jsonBody.error || "Something went wrong.")), { status, headers });
}
