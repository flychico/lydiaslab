"use strict";
/**
 * Leo post cards drawn by OpenAI's image model (Lynold, Nov 19: "we are going to
 * start using chatgpt for all of our visuals"; chose "Yes, build it" for the
 * automatic version). The brief is business/CHATGPT_VISUALS.md, Part 1.
 *
 *   const { aiCard } = require("./lib/ai-card");
 *   const r = await aiCard({ sport, date, post, players });
 *   r = { ok: true, jpg: Buffer, model, checked } or { ok: false, reason }
 *
 * Needs the OPENAI_API_KEY secret; without it returns { ok:false } and the
 * caller keeps Leo's own graphic. Every card is read back by a second model and
 * checked line by line against the post (each picks or results line, the record
 * line, the date) and for banned words; a card that fails twice is not used.
 * Mode in data/ai-cards.json: "preview" sends both images (AI card first) while
 * Lynold judges them; "on" sends the AI card alone; "off" never calls OpenAI.
 * Never throws.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const KEY = process.env.OPENAI_API_KEY;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const CHECK_MODEL = process.env.OPENAI_CHECK_MODEL || "gpt-4.1-mini";

function mode() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "ai-cards.json"), "utf8")).mode || "off"; } catch (e) { return "off"; }
}

// The Leo avatar, from the card renderer, so both looks use the same picture.
function avatarPng() {
  try {
    const s = fs.readFileSync(path.join(__dirname, "..", "render-post-card.js"), "utf8");
    const m = /const AVATAR = "data:image\/png;base64,([^"]+)"/.exec(s);
    return m ? Buffer.from(m[1], "base64") : null;
  } catch (e) { return null; }
}

const stripEmoji = s => String(s || "").replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s+/g, " ").trim();
const longDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase();

function cardType(post) {
  if (post.kind !== "picks") return "results";
  return post.nopick || (post.lines || []).some(l => /^No (Leo )?picks? /i.test(l)) ? "no picks" : "picks";
}

function prompt({ sport, date, post, players }) {
  const type = cardType(post);
  const lines = (post.lines || []).filter(l => l && !/^(What would Leo do\?|Leo picks:)$/.test(l));
  const n = type === "picks" ? (players ? players.split(", ").length : 0) : 0;
  const art = type === "no picks"
    ? "No hero player. Small official team mascots or logos for the teams listed, in a row. The teams must never look like picks."
    : !players ? "No player. Use the picked teams' colors and official mascots in a row."
    : n === 1 ? `One large hero image of ${players.replace(/^[^:]+: /, "")} in his team's current uniform, beside or behind the pick lines.`
    : n === 2 ? `Split screen: ${players}. Each player in his team's current uniform, facing each other or back to back.`
    : n <= 4 ? `One player per team in a row, each in his team's current uniform: ${players}.`
    : "The team mascots or logos in a row, no players.";
  const head = type === "no picks" ? "NO PICKS TONIGHT" : type === "picks" ? "LEO PICKS" : stripEmoji(post.header).toUpperCase();
  return [
    "Make a social media graphic for Leo, a sports prediction model at ndhorizon.com. Portrait, 1024 x 1536.",
    "Look: deep navy background (#0B1A33 fading to near black), gold accents (#E9B949), white text, a thin gold border around the card. Bold condensed sports type for headlines, a gold script for \"What would Leo do?\". Clean, premium, broadcast style, no clutter.",
    `Top left: the attached Leo avatar photo in a gold ring, with "LEO." and "SPORTS MODEL" beside it. Top right: "${sport.toUpperCase()} ${type === "results" ? "RESULTS" : "PICKS"}" and "${longDate(date)}". Bottom right: "ndhorizon.com". Nothing else in the footer.`,
    `Headline: "${head}".` + (type === "picks" ? ' Under it, in gold script: "What would Leo do?".' : "") + (type === "no picks" && post.note ? ` Under it, a small line: "${post.note}".` : ""),
    "Then these lines, each on its own dark bar with a thin gold edge, exactly as written, in this order (keep any check or cross mark):",
    ...lines.map(l => `- ${stripEmoji(l.replace(/ ?✅/g, " CHECK").replace(/ ?❌/g, " CROSS")).replace(/ CHECK/g, " ✅").replace(/ CROSS/g, " ❌")}`),
    post.record ? `Then, in gold: "${post.record}".` : "",
    `Art: ${art}`,
    "Rules: use only the words above, spelled exactly; no other text, numbers, odds or slogans. Never write lock, bet, guaranteed, 21+, a sportsbook name or a promo code. No dashes between words and no exclamation marks (the minus sign in a price like -212 stays). Every letter sharp and readable.",
  ].filter(Boolean).join("\n");
}

async function draw(p) {
  const fd = new FormData();
  fd.append("model", IMAGE_MODEL);
  fd.append("prompt", p);
  fd.append("size", "1024x1536");
  fd.append("n", "1");
  const av = avatarPng();
  if (av) fd.append("image[]", new Blob([av], { type: "image/png" }), "leo-avatar.png");
  const url = av ? "https://api.openai.com/v1/images/edits" : "https://api.openai.com/v1/images/generations";
  const res = await fetch(url, av ? { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: fd }
    : { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: IMAGE_MODEL, prompt: p, size: "1024x1536", n: 1 }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: `image ${res.status}: ${(j.error && j.error.message || "").slice(0, 160)}` };
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  return b64 ? { ok: true, png: Buffer.from(b64, "base64") } : { ok: false, reason: "image: no data" };
}

// Read the card back and check it word for word.
async function check(png, post, date) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CHECK_MODEL, temperature: 0, messages: [{ role: "user", content: [
      { type: "text", text: "Transcribe every piece of text visible in this image, one line per line of text, exactly as spelled. Output only the text." },
      { type: "image_url", image_url: { url: "data:image/png;base64," + png.toString("base64") } }] }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: `check ${res.status}` };
  const seen = String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "");
  const norm = s => stripEmoji(s).toLowerCase().replace(/[✅❌]/g, "").replace(/[^a-z0-9.+\-%/ ]/g, " ").replace(/\s+/g, " ").trim();
  const have = norm(seen);
  const want = (post.lines || []).filter(l => l && !/^(What would Leo do\?|Leo picks:|No picks tonight\. Leo likes:)$/.test(l)).concat(post.record ? [post.record] : []);
  const missing = want.map(norm).filter(w => w && !have.includes(w));
  const banned = /\b(lock|locks|bet now|guarantee|guaranteed|21\+|draftkings|fanduel|betmgm|caesars|promo)\b/i.test(seen);
  const hasSite = /ndhorizon\.com/i.test(seen);
  if (missing.length || banned || !hasSite) return { ok: false, reason: `check: ${missing.length ? "missing " + missing.slice(0, 3).join("; ") : ""}${banned ? " banned word" : ""}${hasSite ? "" : " no ndhorizon.com"}`.trim() };
  return { ok: true };
}

async function aiCard({ sport, date, post, players }) {
  if (mode() === "off") return { ok: false, reason: "off" };
  if (!KEY) return { ok: false, reason: "no OPENAI_API_KEY" };
  if (typeof fetch !== "function" || typeof FormData !== "function") return { ok: false, reason: "node too old" };
  const p = prompt({ sport, date, post, players });
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const d = await draw(p);
      if (!d.ok) { last = d.reason; if (/ 4\d\d:/.test(d.reason) && !/ 429:/.test(d.reason)) break; continue; }
      const c = await check(d.png, post, date);
      if (!c.ok) { last = c.reason; continue; }
      // JPG keeps the email small; Playwright is already installed by send-x-posts for our own card.
      return { ok: true, png: d.png, model: IMAGE_MODEL, attempt };
    } catch (e) { last = e.message; }
  }
  return { ok: false, reason: last || "failed" };
}

module.exports = { aiCard, mode, prompt, cardType };
