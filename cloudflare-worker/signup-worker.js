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

  Unsubscribe (launch plan day 3): every row carries a random unsub_token.
  The send scripts put /unsubscribe?e=<email>&t=<token> in each email; a GET
  shows a confirm button, a POST (the button, or a mail app's one-click
  unsubscribe) adds the address to signups/unsubscribed.csv. Signing up
  again takes the address off that file.

  Confirmation email: a new sign-up gets one email through Resend saying
  what they joined, with its unsubscribe link. Needs RESEND_API_KEY (secret)
  and EMAIL_FROM; EMAIL_POSTAL_ADDRESS is printed in the footer when set.
  Without RESEND_API_KEY the sign-up is saved and no email is sent.

  Worker settings (Cloudflare dashboard, Settings, Variables and Secrets)
    GITHUB_TOKEN    secret. Fine-grained token limited to flychico/leo-signups,
                    Contents: Read and write. Never in this file or the repo.
    ALLOWED_ORIGIN  https://ndhorizon.com (also set in wrangler.toml)

  The Worker never returns stored data: there is no read endpoint.
  (The send scripts read leo-signups directly with their own read-only token.)
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
const HEADER = "submitted_at,list,name,email,phone,sms_consent,source,subscription_id,unsub_token";
const UNSUB_PATH = "signups/unsubscribed.csv";
const UNSUB_HEADER = "email,unsubscribed_at";
const SELF = "https://leo-signup.lynoldmercado.workers.dev";
const SITE = "https://ndhorizon.com";
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

// 24 hex characters from the platform's secure random source.
function newToken() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

// Gives every data row (after the header) a token in column `col` if it has none.
function fillTokens(lines, col) {
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    if (f[col]) continue;
    while (f.length < col) f.push("");
    f[col] = newToken();
    lines[i] = f.map(csv).join(",");
  }
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
    lines[0] = HEADER;

    let result = "added", token = "";
    const at = lines.findIndex((l, i) => i > 0 && (parseCsvLine(l)[3] || "").trim().toLowerCase() === emailLower);
    if (at > 0) {
      const f = parseCsvLine(lines[at]);
      while (f.length < 9) f.push("");
      let changed = !f[8];
      if (!f[8]) f[8] = newToken();
      if (!f[2] && row.name) { f[2] = row.name; changed = true; }
      if (!f[4] && row.phone) { f[4] = row.phone; f[5] = row.sms_consent; changed = true; }
      if (f[5] !== "yes" && row.sms_consent === "yes" && row.phone) { f[4] = row.phone; f[5] = "yes"; changed = true; }
      if (!f[7] && row.subscription_id) { f[7] = row.subscription_id; changed = true; }
      token = f[8];
      if (!changed) return { duplicate: true, token };
      lines[at] = f.map(csv).join(",");
      result = "updated";
    } else {
      token = newToken();
      lines.push([new Date().toISOString(), row.list, row.name, row.email, row.phone, row.sms_consent, row.source, row.subscription_id, token].map(csv).join(","));
    }
    fillTokens(lines, 8);

    const body = { message: `Sign-up (${row.list})`, content: toBase64(lines.join("\n") + "\n"), branch: BRANCH };
    if (existing) body.sha = existing.sha;
    const put = await gh(env, path, { method: "PUT", body: JSON.stringify(body) });
    if (put.ok) return { [result]: true, token };
    if (put.status !== 409 && put.status !== 422) throw new Error(`GitHub write failed: HTTP ${put.status}`);
  }
  throw new Error("GitHub write failed: file kept changing");
}

// ---------- Unsubscribe ----------
// Adds (unsubscribe) or removes (sign-up again) an address on unsubscribed.csv.
// Returns true when the file changed.
async function setUnsubscribed(env, email, on) {
  const emailLower = email.toLowerCase();
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await getFile(env, UNSUB_PATH);
    if (!existing && !on) return false;
    const lines = existing ? existing.content.split("\n").filter(l => l.trim()) : [UNSUB_HEADER];
    if (!/^email,/.test(lines[0] || "")) lines.unshift(UNSUB_HEADER);
    const at = lines.findIndex((l, i) => i > 0 && (parseCsvLine(l)[0] || "").trim().toLowerCase() === emailLower);
    if (on && at > 0) return false;
    if (!on && at < 0) return false;
    if (on) lines.push([emailLower, new Date().toISOString()].map(csv).join(","));
    else lines.splice(at, 1);
    const body = { message: on ? "Unsubscribe" : "Re-subscribe", content: toBase64(lines.join("\n") + "\n"), branch: BRANCH };
    if (existing) body.sha = existing.sha;
    const put = await gh(env, UNSUB_PATH, { method: "PUT", body: JSON.stringify(body) });
    if (put.ok) return true;
    if (put.status !== 409 && put.status !== 422) throw new Error(`GitHub write failed: HTTP ${put.status}`);
  }
  throw new Error("GitHub write failed: file kept changing");
}

// True when this email and token match a row in any list file.
async function tokenMatches(env, email, token) {
  const emailLower = email.toLowerCase();
  const files = [["signups/free.csv", 3, 8], ["signups/member.csv", 3, 8], [MEMBERS_PATH, 2, 7]];
  for (const [path, ec, tc] of files) {
    const f = await getFile(env, path);
    if (!f) continue;
    for (const l of f.content.split("\n").slice(1)) {
      const r = parseCsvLine(l);
      if ((r[ec] || "").trim().toLowerCase() === emailLower && r[tc] && r[tc] === token) return true;
    }
  }
  return false;
}

function page(title, inner, status) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} | Leo</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#F5F0E8;color:#2B2620;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:440px;padding:32px;text-align:center}button{font:inherit;font-weight:700;background:#1F2A44;color:#fff;border:0;border-radius:999px;padding:12px 22px;cursor:pointer}
a{color:#8a6d1f}</style></head><body><div class="card">${inner}<p><a href="${SITE}/">Back to Leo</a></p></div></body></html>`,
    { status: status || 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const email = clean(url.searchParams.get("e"), 254);
  const token = clean(url.searchParams.get("t"), 64);
  const bad = page("Unsubscribe", "<h1>That link did not work</h1><p>Write to support@ndhorizon.com and we will take you off the list.</p>", 400);
  if (!isValidEmail(email) || !/^[0-9a-f]{24}$/.test(token)) return bad;
  const safe = email.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  if (request.method === "GET") {
    // A GET never unsubscribes: mail scanners open links on their own.
    return page("Unsubscribe", `<h1>Unsubscribe from Leo emails?</h1><p>${safe} will stop getting Leo's emails.</p>
<form method="post" action="${SELF}/unsubscribe?e=${encodeURIComponent(email)}&amp;t=${token}"><button type="submit">Unsubscribe</button></form>`);
  }
  try {
    if (!(await tokenMatches(env, email, token))) return bad;
    await setUnsubscribed(env, email, true);
  } catch (e) {
    console.error(String(e.message || e));
    return page("Unsubscribe", "<h1>Something went wrong</h1><p>Try the link again in a minute, or write to support@ndhorizon.com.</p>", 502);
  }
  return page("Unsubscribed", `<h1>You are unsubscribed</h1><p>${safe} will not get Leo's emails anymore. Changed your mind? Sign up again on the site.</p>`);
}

// ---------- Confirmation email ----------
function unsubLink(email, token) {
  return `${SELF}/unsubscribe?e=${encodeURIComponent(email)}&t=${token}`;
}

async function sendConfirmation(env, row, token) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !token) return false;
  const member = row.list === "member";
  const hi = row.name ? `Hi ${row.name.split(" ")[0]},` : "Hi,";
  const what = member
    ? "Thanks for joining Leo as a member. Your member emails come to this address: the full brief before each NFL and NBA slate, the morning after review of every miss, and a weekly note on what Leo learned."
    : "You are on the Leo list. Leo's free card comes to this address before NFL and NBA games: Leo's calls and the reasons behind them.";
  const unsub = unsubLink(row.email, token);
  const addr = String(env.EMAIL_POSTAL_ADDRESS || "").trim();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<div style="background:#F5F0E8;padding:24px 12px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#2B2620">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E3DACB;border-radius:16px;padding:24px">
<div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8C8273">Leo</div>
<h1 style="font-size:22px;margin:8px 0 14px">${member ? "Welcome to Leo membership" : "You are on the list"}</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${esc(hi)}</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${esc(what)}</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 18px">Every call Leo makes is graded in public, misses included: <a href="${SITE}/" style="color:#1F2A44;font-weight:700">ndhorizon.com</a>.</p>
<p style="font-size:12px;line-height:1.6;color:#8C8273;border-top:1px solid #E3DACB;padding-top:14px;margin:0">
Leo provides analysis and education only, not betting advice. 21+. If you or someone you know has a gambling problem, call 1-800-MY-RESET (1-800-697-3738).<br>
${addr ? esc(addr) + "<br>" : ""}You are getting this because this address was entered at ndhorizon.com. Not you, or changed your mind? <a href="${unsub}" style="color:#8C8273">Unsubscribe</a>.</p>
</div></div>`;
  const text = [hi, "", what, "", `Every call Leo makes is graded in public, misses included: ${SITE}/`, "",
    "Analysis and education only, not betting advice. 21+. 1-800-MY-RESET (1-800-697-3738).", ...(addr ? [addr] : []),
    `Unsubscribe: ${unsub}`].join("\n");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM, to: [row.email], reply_to: "support@ndhorizon.com",
      subject: member ? "Welcome to Leo membership" : "You are on the Leo list",
      html, text,
      headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    })
  });
  if (!res.ok) console.error("Confirmation email failed: HTTP " + res.status);
  return res.ok;
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
// members.csv columns: subscription_id, status, email, name, plan_id, updated_at, last_event, unsub_token
const PAYPAL_API = "https://api-m.paypal.com";
const MEMBERS_PATH = "signups/members.csv";
const MEMBERS_HEADER = "subscription_id,status,email,name,plan_id,updated_at,last_event,unsub_token";
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
    lines[0] = MEMBERS_HEADER;
    const at = lines.findIndex((l, i) => i > 0 && parseCsvLine(l)[0] === row.subscription_id);
    const old = at > 0 ? parseCsvLine(lines[at]) : [];
    const merged = [
      row.subscription_id,
      row.status || old[1] || "",
      row.email || old[2] || "",
      row.name || old[3] || "",
      row.plan_id || old[4] || "",
      new Date().toISOString(),
      row.event,
      old[7] || newToken()
    ].map(csv).join(",");
    if (at > 0) lines[at] = merged; else lines.push(merged);
    fillTokens(lines, 7);
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

    const pathname = new URL(request.url).pathname;
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin, allowedOrigin) });
    if (pathname === "/unsubscribe" && (request.method === "GET" || request.method === "POST")) return handleUnsubscribe(request, env);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (pathname === "/paypal") return handlePaypal(request, env);

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

    let emailed = false;
    try {
      const saved = await saveSignup(env, LISTS[list], row);
      // Signing up again cancels an earlier unsubscribe.
      const wasOff = await setUnsubscribed(env, email, false);
      if (saved.added || wasOff) {
        try { emailed = await sendConfirmation(env, row, saved.token); }
        catch (e) { console.error("Confirmation email error: " + String(e.message || e)); }
      }
    } catch (err) {
      console.error(String(err && err.message || err));   // never logs the person's details
      return respond(wantsJson, origin, allowedOrigin, 502, { ok: false, error: "Sign up failed, try again shortly." });
    }
    return respond(wantsJson, origin, allowedOrigin, 200, { ok: true, emailed }, "You are on the list.");
  }
};
