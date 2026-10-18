/**
 * Who gets Leo's emails (DEC-20261017-11).
 *
 * Signups moved to Buttondown, a hosted email-list service: the site's forms
 * post straight to it (js/app.js), it stores the addresses, sends the
 * confirmation email and honours unsubscribes. The send scripts read the
 * list here through Buttondown's API with the BUTTONDOWN_API_KEY secret.
 * Lists are Buttondown tags: "free-preview" (the free card) and
 * "member-email" (paying members). Only active subscribers are returned:
 * unconfirmed and unsubscribed addresses never get mail.
 *
 * Without BUTTONDOWN_API_KEY it falls back to the old CSVs on the repo's
 * "signups" branch (written by the Cloudflare Worker, which never recorded
 * a signup), so nothing breaks before the key is added.
 */
const API = "https://api.buttondown.com/v1/subscribers";
const CSV = "https://raw.githubusercontent.com/flychico/lydiaslab/signups/data/signups";
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

let cache = null;
async function allButtondown(key) {
  if (cache) return cache;
  const out = [];
  let url = `${API}?type=regular`;
  for (let page = 0; url && page < 200; page++) {
    const res = await fetch(url, { headers: { Authorization: `Token ${key}` } });
    if (!res.ok) throw new Error(`Buttondown HTTP ${res.status}`);
    const body = await res.json();
    for (const s of body.results || []) {
      const type = s.type || s.subscriber_type || "regular";
      if (!["regular", "premium"].includes(type)) continue;
      const email = String(s.email_address || s.email || "").trim().toLowerCase();
      if (isEmail(email)) out.push({ email, tags: (s.tags || []).map(t => String(t.name || t)) });
    }
    url = body.next || null;
  }
  return (cache = out);
}

/** Active addresses on one list ("free-preview" or "member-email"). Never throws. */
async function getList(name) {
  const key = (process.env.BUTTONDOWN_API_KEY || "").trim();
  try {
    if (key) {
      const subs = await allButtondown(key);
      // A subscriber with no tag joined through a plain form: treat as the free list.
      return subs.filter(s => s.tags.includes(name) || (name === "free-preview" && !s.tags.length)).map(s => s.email);
    }
    const res = await fetch(`${CSV}/${name}.csv?_=${Date.now()}`);
    if (!res.ok) return [];
    return (await res.text()).split(/\r?\n/).slice(1).map(l => (l.split(",")[0] || "").trim().toLowerCase()).filter(isEmail);
  } catch (e) { console.warn(`  subscriber list "${name}" unavailable: ${e.message}`); return []; }
}

module.exports = { getList };
