/**
 * Leo email theme: the website's look, built for inboxes.
 *
 * Colours and type come from css/style.css and css/scoreboard.css (cream
 * ground, navy, gold; Onest for text, EB Garamond for headlines). Inboxes
 * strip <style>, <link> and most CSS, so everything here is tables with
 * inline styles, and each web font names a safe fallback (Gmail shows
 * Helvetica/Arial and Georgia; Apple Mail loads the web fonts).
 *
 * Pieces: shell(), header(), hero(), tiles(), panel(), footer().
 * The footer's mailing address comes from the EMAIL_POSTAL_ADDRESS secret
 * (CAN-SPAM requires a physical postal address in commercial email); until it
 * is set the line is left out.
 */
const T = {
  bg: "#F5F0E8", card: "#FDFBF7", elev: "#EDE6D9", border: "#DED4C2", text: "#2A2620", dim: "#675D4F",
  gold: "#C9A84C", navy: "#1A2535", steel: "#4A6478", goldDeep: "#7A5D14", good: "#2F6E4A", danger: "#A63A2E",
  heroBg: "#F3ECDE", leanBg: "#E2EFE6", noBg: "#ECE6DA"
};
const SANS = `'Onest',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif`;
const SERIF = `'EB Garamond',Georgia,'Times New Roman',serif`;
const SITE = "https://ndhorizon.com";
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tbl = (inner, style = "", attrs = "") => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ${attrs} style="border-collapse:separate;${style}">${inner}</table>`;

/** The whole email: cream page, 600px column, hidden preheader. */
function shell({ title, preheader, body }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;600;800&family=EB+Garamond:wght@600&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${T.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${T.bg}">${esc(preheader || "")}</div>
${tbl(`<tr><td align="center" style="padding:18px 10px 28px">
${tbl(`<tr><td>${body}</td></tr>`, "max-width:600px", 'align="center"')}
</td></tr>`, `background:${T.bg}`)}
</body></html>`;
}

/** Leo wordmark and the sport, like the site's nav bar. */
function header(sport) {
  return tbl(`<tr>
    <td style="padding:2px 4px 14px;font-family:${SANS};font-size:24px;font-weight:800;letter-spacing:-.02em;color:${T.gold}"><a href="${SITE}/" style="color:${T.gold};text-decoration:none">Leo</a></td>
    <td align="right" style="padding:2px 4px 14px;font-family:${SANS}"><span style="display:inline-block;font-size:12px;font-weight:700;padding:5px 12px;border-radius:9px;background:${T.gold};color:#ffffff">${esc(sport)}</span></td>
  </tr>`);
}

/** The headline panel (.score-hero): eyebrow, serif headline, subtitle, chips. */
function hero({ eyebrow, title, subtitle, chips = [] }) {
  const chipHtml = chips.map(c => `<span style="display:inline-block;margin:0 6px 6px 0;padding:6px 11px;border:1px solid ${T.border};border-radius:999px;background:${T.card};font-family:${SANS};font-size:12px;font-weight:600;color:${T.text}">${c}</span>`).join("");
  return tbl(`<tr><td style="padding:24px 22px 18px;font-family:${SANS}">
    <div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${T.goldDeep}">${eyebrow}</div>
    <div style="font-family:${SERIF};font-size:32px;line-height:1.05;font-weight:600;color:${T.text};margin:8px 0 10px">${title}</div>
    <div style="font-size:15px;line-height:1.55;color:${T.dim}">${subtitle}</div>
    ${chipHtml ? `<div style="margin-top:14px">${chipHtml}</div>` : ""}
  </td></tr>`, `background-color:${T.heroBg};background-image:linear-gradient(135deg,#FBF7EF 0%,#F3ECDE 52%,#EDE3CE 100%);border:1px solid rgba(26,37,53,.25);border-radius:22px;margin:0 0 14px`);
}

/** Summary tiles (.kpi), two per row so they read on a phone. */
function tiles(items) {
  const cell = it => `<td width="50%" valign="top" style="padding:5px">${tbl(`<tr><td style="padding:13px 14px;font-family:${SANS}">
    <div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${T.dim}">${it.label}</div>
    <div style="font-size:22px;font-weight:800;letter-spacing:-.02em;color:${T.text};margin-top:4px">${it.value}</div>
    <div style="font-size:12px;color:${T.dim};margin-top:3px">${it.sub || "&nbsp;"}</div></td></tr>`, `background:${T.card};border:1px solid ${T.border};border-radius:16px`)}</td>`;
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(`<tr>${cell(items[i])}${items[i + 1] ? cell(items[i + 1]) : '<td width="50%"></td>'}</tr>`);
  return tbl(rows.join(""), "margin:0 0 12px");
}

/** A plain white panel with a small uppercase label (used for the leans list). */
function panel(label, inner) {
  return tbl(`<tr><td style="padding:14px 16px;font-family:${SANS}">
    <div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${T.dim};margin-bottom:6px">${label}</div>${inner}</td></tr>`,
    `background:${T.card};border:1px solid ${T.border};border-radius:16px;margin:0 0 16px`);
}

/** Links, the record promise, responsible gambling, address, unsubscribe. */
function footer({ links = [], note = "" } = {}) {
  const addr = (process.env.EMAIL_POSTAL_ADDRESS || "").trim();
  return tbl(`<tr><td style="padding:6px 4px 0;font-family:${SANS}">
    <div style="font-size:14px;margin-bottom:16px">${links.map(([h, t], i) => `<a href="${h}" style="color:${T.navy};font-weight:${i ? 600 : 800};text-decoration:none">${t} &rarr;</a>`).join(" &nbsp;&nbsp; ")}</div>
    <div style="font-size:12px;line-height:1.6;color:#8C8273;border-top:1px solid ${T.border};padding-top:14px">
      ${note ? note + "<br>" : ""}Leo provides analysis and education only, not betting advice. 21+. If you or someone you know has a gambling problem, call 1-800-MY-RESET (1-800-697-3738).<br>
      ${addr ? esc(addr) + "<br>" : ""}You are getting this because you signed up at ndhorizon.com. To unsubscribe, reply with &ldquo;unsubscribe&rdquo;.
    </div></td></tr>`);
}

module.exports = { T, SANS, SERIF, SITE, esc, tbl, shell, header, hero, tiles, panel, footer };
