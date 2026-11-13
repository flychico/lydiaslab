/*
  Leo: sign-up form receiver.

  2026-11-11 (launch plan, access A and B): rewritten to store customer
  details in the PRIVATE repository flychico/leo-signups. The site's own
  repository is public, so a name, email or phone number must never be written
  there. Before this the Worker wrote emails to a "signups" branch of the
  public repo; that path is gone (it never recorded a sign-up).

  What it does
    POST (form or JSON) with: email (required), name, phone, sms_consent,
    list, source, subscription-id, bot-field (honeypot).
    Appends one row to signups/<list>.csv in leo-signups (branch main) through
    the GitHub Contents API. One row per email per list; a repeat sign-up
    fills in a name or phone that was missing but never adds a second row.

  CSV columns
    submitted_at, list, name, email, phone, sms_consent, source, subscription_id

  Lists
    newsletter / free-preview -> signups/free.csv     (free card list)
    member-email              -> signups/member.csv   (paid members; the
                                 PayPal subscription ID links a payment)

  PayPal membership events arrive at /paypal (see handlePaypal below).

  Worker settings (Cloudflare dashboard, Settings, Variables and Secrets)
    GITHUB_TOKEN    secret. Fine-grained token limited to flychico/leo-signups,
                    Contents: Read and write. Never in this file or the repo.
    ALLOWED_ORIGIN  https://ndhorizon.com (also set in wrangler.toml)

  The Worker never returns stored data: there is no read endpoint.
*/
const GITHUB_OWNER = "flychico";
const GITHUB_REPO = "leo-signups";
const BRANCH = "main";

const LISTS = {
  "member-email": "signups/member.csv",
  "newsletter": "signups/free.csv",
  "free-preview": "signups/free.csv"
};
const DEFAULT_LIST = "newsletter";
const HEADER = "submitted_at,list,name,email,phone,sms_consent,source,subscription_id";
const UA = "leo-signup-worker";

function isValidEmail(e) {
  const s = String(e || "").trim();
  return s.length <= 254 && /^[^\s@,"]+@[^\s@,"]+\.[^\s@,"]+$/.test(s);
}

// One line of plain text, trimmed and capped. Control characters removed.
function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

// Keep what a person typed for a phone number, digits and + ( ) - . space only.
// Returns "" when it does not look like a phone number (7 to 15 digits).
function cleanPhone(v) {
  const s = clean(v, 32).replace(/[^0-9+()\-. ]/g, "");
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? s : "";
}

// CSV field: quoted when needed; a leading = + - @ is prefixed with ' so a
// spreadsheet never runs it as a formula.
function csv(v) {
  let s = String(v == null ? "" : v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Base64 that is safe for any language (btoa alone breaks on accents).
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(String(b64 || "").replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function corsHeaders(origin, allowedOrigin) {
  const h = { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept", "Vary": "Origin" };
  if (origin === allowedOrigin) h["Access-Control-Allow-Origin"] = allowedOrigin;
  return h;
}

async function parseBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await request.json().catch(() => ({}));
    return j && typeof j === "object" ? j : {};
  }
  const text = await request.text();
  if (text.length > 4000) throw new Error("too large");
  const out = {};
  for (const [k, v] of new URLSearchParams(text).entries()) out[k] = v;
  return out;
}

function thanksPage(message) {
  const safe = String(message).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Leo</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#F5F0E8;color:#2B2620;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:420px;padding:32px;text-align:center}
a{color:#8a6d1f}</style></head>
<body><div class="card"><h1>${safe}</h1><p><a href="https://ndhorizon.com/">Back to Leo</a></p></div></body></html>`;
}

function gh(env, path, init) {
  return fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}${init && init.method === "PUT" ? "" : `?ref=${BRANCH}`}`, {
    ...(init || {}),
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": UA,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init && init.body ? { "Content-Type": "application/json" } : {})
    }
  });
}

async function getFile(env, path) {
  const res = await gh(env, path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed: HTTP ${res.status}`);
  const json = await res.json();
  return { sha: json.sha, content: fromBase64(json.content) };
}

// row: { list, name, email, phone, sms_consent, source, subscription_id }
// Returns { added } or { updated } or { duplicate }.
async function saveSignup(env, path, row) {
  const emailLower = row.email.toLowerCase();
  // Two people can sign up in the same second; GitHub answers 409 when the
  // file changed under us, so read again and retry a few times.
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await getFile(env, path);
    const lines = existing ? existing.content.split("\n").filter(l => l.trim()) : [HEADER];
    if (!lines.length || !/^submitted_at,/.test(lines[0])) lines.unshift(HEADER);

    let result = "added";
    const at = lines.findIndex((l, i) => i > 0 && (parseCsvLine(l)[3] || "").trim().toLowerCase() === emailLower);
    if (at > 0) {
      const f = parseCsvLine(lines[at]);
      while (f.length < 8) f.push("");
      let changed = false;
      if (!f[2] && row.name) { f[2] = row.name; changed = true; }
      if (!f[4] && row.phone) { f[4] = row.phone; f[5] = row.sms_consent; changed = true; }
      if (f[5] !== "yes" && row.sms_consent === "yes" && row.phone) { f[4] = row.phone; f[5] = "yes"; changed = true; }
      if (!f[7] && row.subscription_id) { f[7] = row.subscription_id; changed = true; }
      if (!changed) return { duplicate: true };
      lines[at] = f.map(csv).join(",");
      result = "updated";
    } else {
      lines.push([new Date().toISOString(), row.list, row.name, row.email, row.phone, row.sms_consent, row.source, row.subscription_id].map(csv).join(","));
    }

    const body = { message: `Sign-up (${row.list})`, content: toBase64(lines.join("\n") + "\n"), branch: BRANCH };
    if (existing) body.sha = existing.sha;
    const put = await gh(env, path, { method: "PUT", body: JSON.stringify(body) });
    if (put.ok) return { [result]: true };
    if (put.status !== 409 && put.status !== 422) throw new Error(`GitHub write failed: HTTP ${put.status}`);
  }
  throw new Error("GitHub write failed: file kept changing");
}

function respond(wantsJson, origin, allowedOrigin, status, jsonBody, thanksMessage) {
  const headers = corsHeaders(origin, allowedOrigin);
  headers["Cache-Control"] = "no-store";
  if (wantsJson) {
    headers["Content-Type"] = "application/json";
    return new Response(JSON.stringify(jsonBody), { status, headers });
  }
  headers["Content-Type"] = "text/html; charset=utf-8";
  return new Response(thanksPage(thanksMessage || jsonBody.error || "Something went wrong."), { status, headers });
}


// ---------- PayPal membership webhook (launch plan day 4, item C) ----------
// PayPal posts subscription events to /paypal. Each event is verified with
// PayPal's own verify-webhook-signature API before anything is saved, then the
// member's row in signups/members.csv (private leo-signups repo) is created or
// updated, keyed by the PayPal subscription ID.
//
// Worker settings needed (Cloudflare dashboard, Settings, Variables and Secrets;
// Lynold enters them, they are never in this file or the repo):
//   PAYPAL_CLIENT_ID      from the PayPal REST app (Live)
//   PAYPAL_CLIENT_SECRET  secret, from the same app
//   PAYPAL_WEBHOOK_ID     secret, the ID PayPal shows for the webhook
// members.csv columns: subscription_id, status, email, name, plan_id, updated_at, last_event
const PAYPAL_API = "https://api-m.paypal.com";
const MEMBERS_PATH = "signups/members.csv";
const MEMBERS_HEADER = "subscription_id,status,email,name,plan_id,updated_at,last_event";
const STATUS_BY_EVENT = {
  "BILLING.SUBSCRIPTION.ACTIVATED": "active",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED": "active",
  "BILLING.SUBSCRIPTION.UPDATED": null,          // keep status, refresh details
  "BILLING.SUBSCRIPTION.CANCELLED": "cancelled",
  "BILLING.SUBSCRIPTION.SUSPENDED": "suspended",
  "BILLING.SUBSCRIPTION.EXPIRED": "expired",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED": "payment_failed",
  "PAYMENT.SALE.COMPLETED": "active"
};

async function paypalToken(env) {
  const res = await fetch(PAYPAL_API + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  if (!res.ok) throw new Error("PayPal token failed: HTTP " + res.status);
  return (await res.json()).access_token;
}

async function verifyPaypal(env, request, event) {
  const h = n => request.headers.get(n) || "";
  const token = await paypalToken(env);
  const res = await fetch(PAYPAL_API + "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"), transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"), webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: event
    })
  });
  if (!res.ok) return false;
  return (await res.json()).verification_status === "SUCCESS";
}

async function upsertMember(env, row) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await getFile(env, MEMBERS_PATH);
    const lines = existing ? existing.content.split("\n").filter(l => l.trim()) : [MEMBERS_HEADER];
    if (!/^subscription_id,/.test(lines[0] || "")) lines.unshift(MEMBERS_HEADER);
    const at = lines.findIndex((l, i) => i > 0 && parseCsvLine(l)[0] === row.subscription_id);
    const old = at > 0 ? parseCsvLine(lines[at]) : [];
    const merged = [
      row.subscription_id,
      row.status || old[1] || "",
      row.email || old[2] || "",
      row.name || old[3] || "",
      row.plan_id || old[4] || "",
      new Date().toISOString(),
      row.event
    ].map(csv).join(",");
    if (at > 0) lines[at] = merged; else lines.push(merged);
    const body = { message: "Member update (" + row.event + ")", content: toBase64(lines.join("\n") + "\n"), branch: BRANCH };
    if (existing) body.sha = existing.sha;
    const put = await gh(env, MEMBERS_PATH, { method: "PUT", body: JSON.stringify(body) });
    if (put.ok) return;
    if (put.status !== 409 && put.status !== 422) throw new Error("GitHub write failed: HTTP " + put.status);
  }
  throw new Error("GitHub write failed: file kept changing");
}

async function handlePaypal(request, env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || !env.PAYPAL_WEBHOOK_ID) {
    return new Response("not configured", { status: 503 });
  }
  const text = await request.text();
  if (text.length > 100000) return new Response("too large", { status: 413 });
  let event;
  try { event = JSON.parse(text); } catch (e) { return new Response("bad json", { status: 400 }); }
  let ok = false;
  try { ok = await verifyPaypal(env, request, event); } catch (e) { console.error(String(e.message || e)); }
  if (!ok) return new Response("not verified", { status: 400 });

  const type = String(event.event_type || "");
  if (!(type in STATUS_BY_EVENT)) return new Response("ignored", { status: 200 });
  const r = event.resource || {};
  const sub = r.subscriber || {};
  const subscription_id = clean(type === "PAYMENT.SALE.COMPLETED" ? r.billing_agreement_id : r.id, 40).replace(/[^A-Za-z0-9\-]/g, "");
  if (!subscription_id) return new Response("no subscription", { status: 200 });
  const nm = sub.name || {};
  try {
    await upsertMember(env, {
      subscription_id,
      status: STATUS_BY_EVENT[type],
      email: isValidEmail(sub.email_address) ? clean(sub.email_address, 254) : "",
      name: clean([nm.given_name, nm.surname].filter(Boolean).join(" "), 80),
      plan_id: clean(r.plan_id, 40),
      event: type
    });
  } catch (e) {
    console.error(String(e.message || e));
    return new Response("save failed", { status: 500 });   // PayPal retries
  }
  return new Response("ok", { status: 200 });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://ndhorizon.com";

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin, allowedOrigin) });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (new URL(request.url).pathname === "/paypal") return handlePaypal(request, env);

    const wantsJson = (request.headers.get("accept") || "").includes("application/json")
      || (request.headers.get("content-type") || "").includes("application/json");

    // Only the site's own pages may post. (A browser always sends Origin on a
    // cross-site POST; a script without it is not our form.)
    if (origin !== allowedOrigin) {
      return respond(wantsJson, origin, allowedOrigin, 403, { ok: false, error: "Sign up from ndhorizon.com." });
    }

    let body;
    try { body = await parseBody(request); }
    catch (e) { return respond(wantsJson, origin, allowedOrigin, 400, { ok: false, error: "Could not read the form." }); }

    // Honeypot: a filled hidden field means a bot. Pretend success.
    if (body["bot-field"]) return respond(wantsJson, origin, allowedOrigin, 200, { ok: true }, "You are on the list.");

    const email = clean(body.email, 254);
    if (!isValidEmail(email)) {
      return respond(wantsJson, origin, allowedOrigin, 400, { ok: false, error: "Enter a valid email address." });
    }

    const listKey = clean(body.list || body["form-name"] || DEFAULT_LIST, 40).toLowerCase();
    const list = LISTS[listKey] ? listKey : DEFAULT_LIST;
    const phone = cleanPhone(body.phone);
    const consent = phone && /^(yes|on|true|1)$/i.test(String(body.sms_consent || "")) ? "yes" : "no";
    const row = {
      list: list === "member-email" ? "member" : "free",
      name: clean(body.name, 80),
      email,
      phone,
      sms_consent: phone ? consent : "",
      source: clean(body.source, 80),
      subscription_id: clean(body["subscription-id"], 40).replace(/[^A-Za-z0-9\-]/g, "")
    };

    try {
      await saveSignup(env, LISTS[list], row);
    } catch (err) {
      console.error(String(err && err.message || err));   // never logs the person's details
      return respond(wantsJson, origin, allowedOrigin, 502, { ok: false, error: "Sign up failed, try again shortly." });
    }
    return respond(wantsJson, origin, allowedOrigin, 200, { ok: true }, "You are on the list.");
  }
};
