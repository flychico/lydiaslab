/**
 * Who gets Leo's emails.
 *
 * 2026-11-13 (launch plan day 3): the list lives in the PRIVATE repository
 * flychico/leo-signups, written by the leo-signup Cloudflare Worker
 * (cloudflare-worker/signup-worker.js). The send scripts read it here with
 * the LEO_SIGNUPS_TOKEN secret (fine-grained, leo-signups only, Contents:
 * Read). Files:
 *   signups/free.csv          free card list (newsletter, free-preview forms)
 *   signups/member.csv        the email a member typed after paying, with the
 *                             PayPal subscription ID
 *   signups/members.csv       PayPal's own record per subscription (status)
 *   signups/unsubscribed.csv  addresses that unsubscribed; never mailed
 * Members are the subscriptions PayPal reports as active; the address used is
 * the one the member typed (member.csv) when there is one, else PayPal's.
 *
 * During the move off Buttondown, BUTTONDOWN_API_KEY (if still set) adds its
 * active subscribers to the free list. Without LEO_SIGNUPS_TOKEN the old
 * Buttondown-only reading is used, so nothing breaks before the secret exists.
 *
 * Unsubscribe links: every row carries an unsub_token. personalize() puts the
 * reader's own link in an email's footer and adds the List-Unsubscribe headers
 * mail apps use for their one-click unsubscribe button.
 */
const OWNER = "flychico", REPO = "leo-signups", BRANCH = "main";
const WORKER = "https://leo-signup.lynoldmercado.workers.dev";
const BD_API = "https://api.buttondown.com/v1/subscribers";
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
const norm = e => String(e || "").trim().toLowerCase();

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

async function readCsv(token, path) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json", "User-Agent": "leo-send-scripts", "X-GitHub-Api-Version": "2022-11-28" }
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`leo-signups ${path}: HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = parseCsvLine(lines[0]);
  return lines.slice(1).map(l => { const f = parseCsvLine(l); const o = {}; head.forEach((h, i) => { o[h] = (f[i] || "").trim(); }); return o; });
}

let bdCache = null;
async function buttondownActive(key) {
  if (bdCache) return bdCache;
  const out = [];
  let url = `${BD_API}?type=regular`;
  for (let page = 0; url && page < 200; page++) {
    const res = await fetch(url, { headers: { Authorization: `Token ${key}` } });
    if (!res.ok) throw new Error(`Buttondown HTTP ${res.status}`);
    const body = await res.json();
    for (const s of body.results || []) {
      const type = s.type || s.subscriber_type || "regular";
      if (!["regular", "premium"].includes(type)) continue;
      const email = norm(s.email_address || s.email);
      if (isEmail(email)) out.push({ email, tags: (s.tags || []).map(t => String(t.name || t)) });
    }
    url = body.next || null;
  }
  return (bdCache = out);
}

const tokens = new Map();   // email -> unsub_token, filled when a list is read
let lists = null;           // { free: [...], member: [...] }

async function loadPrivate(token) {
  const [free, member, members, unsub] = await Promise.all(
    ["signups/free.csv", "signups/member.csv", "signups/members.csv", "signups/unsubscribed.csv"].map(p => readCsv(token, p)));
  const off = new Set(unsub.map(r => norm(r.email)));
  const remember = (email, t) => { if (t && !tokens.has(email)) tokens.set(email, t); };

  const memberSet = new Set();
  const typedBySub = new Map(member.filter(r => r.subscription_id).map(r => [r.subscription_id, r]));
  for (const m of members) {
    if (m.status !== "active") continue;
    const typed = typedBySub.get(m.subscription_id);
    const email = norm(typed ? typed.email : m.email);
    if (!isEmail(email) || off.has(email)) continue;
    memberSet.add(email);
    remember(email, typed ? typed.unsub_token : m.unsub_token);
  }

  const freeSet = new Set();
  for (const r of free) {
    const email = norm(r.email);
    if (!isEmail(email) || off.has(email)) continue;
    freeSet.add(email);
    remember(email, r.unsub_token);
  }
  const bdKey = (process.env.BUTTONDOWN_API_KEY || "").trim();
  if (bdKey) {
    try {
      for (const s of await buttondownActive(bdKey)) {
        if (s.tags.includes("member-email") || off.has(s.email)) continue;   // members come from PayPal now
        freeSet.add(s.email);
      }
    } catch (e) { console.warn(`  Buttondown list unavailable: ${e.message}`); }
  }
  return { free: [...freeSet], member: [...memberSet] };
}

/** Active addresses on one list ("free-preview" or "member-email"). Never throws. */
async function getList(name) {
  const token = (process.env.LEO_SIGNUPS_TOKEN || "").trim();
  try {
    if (token) {
      if (!lists) lists = await loadPrivate(token);
      return name === "member-email" ? lists.member : lists.free;
    }
    const key = (process.env.BUTTONDOWN_API_KEY || "").trim();
    if (!key) return [];
    const subs = await buttondownActive(key);
    return subs.filter(s => s.tags.includes(name) || (name === "free-preview" && !s.tags.length)).map(s => s.email);
  } catch (e) { console.warn(`  subscriber list "${name}" unavailable: ${e.message}`); return []; }
}

/** The reader's own unsubscribe link, or "" when the address has no token. */
function unsubUrl(email) {
  const t = tokens.get(norm(email));
  return t ? `${WORKER}/unsubscribe?e=${encodeURIComponent(norm(email))}&t=${t}` : "";
}

/**
 * Takes the JSON body for Resend's /emails call and returns it with this
 * reader's unsubscribe link in place of the footer's "reply with
 * unsubscribe" line (html and text), plus List-Unsubscribe headers.
 * Without a link the body is returned unchanged.
 */
function personalize(body) {
  const to = Array.isArray(body.to) ? body.to[0] : body.to;
  const url = unsubUrl(to);
  if (!url) return body;
  const out = { ...body, headers: { ...(body.headers || {}), "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  if (out.html) out.html = String(out.html).replace(/To unsubscribe, reply with &ldquo;unsubscribe&rdquo;\./g,
    `<a href="${url}" style="color:inherit">Unsubscribe</a>.`);
  if (out.text) out.text = String(out.text).replace(/Reply "unsubscribe" to stop these\./g, `Unsubscribe: ${url}`);
  return out;
}

module.exports = { getList, unsubUrl, personalize };
