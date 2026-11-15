/**
 * One Resend send for the NBA emails, with the reason kept when it fails
 * (NBA-H33). Nov 13 and Nov 14 each logged "failed 1" with no reason; the
 * run log showed only "HTTP 422".
 *
 *   sendOne(body, { key }) -> { ok, status, name, message }
 *
 * Retries once after 2 seconds on 429 or 5xx (rate limit or Resend down);
 * a 4xx such as 422 (Resend refused the message, usually the address) is
 * not retried. The reason is Resend's own error name and message with any
 * email address replaced by "<address>", so the public log never holds one.
 */
const EMAIL_RX = /[^\s"'<>(),;:]+@[^\s"'<>(),;:]+/g;
const redact = s => String(s || "").replace(EMAIL_RX, "<address>").slice(0, 200);

async function post(body, key) {
  return fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
}

async function sendOne(body, { key }) {
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { res = await post(body, key); }
    catch (e) { res = { ok: false, status: 0, text: async () => JSON.stringify({ name: "network_error", message: e.message }) }; }
    if (res.ok) return { ok: true, status: res.status };
    if (!(res.status === 429 || res.status === 0 || res.status >= 500) || attempt === 1) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  let name = "", message = "";
  try { const t = await res.text(); try { const j = JSON.parse(t); name = j.name || j.error || ""; message = j.message || t; } catch (e) { message = t; } } catch (e) {}
  return { ok: false, status: res.status, name: redact(name), message: redact(message) };
}

module.exports = { sendOne, redact };
