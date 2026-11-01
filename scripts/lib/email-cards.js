/**
 * Leo email game cards: the scoreboard card for inboxes (DEC-20261101-04).
 *
 * Builds on scripts/lib/email-theme.js (shell, header, hero, tiles, panel,
 * footer) with the pieces the NFL emails need: the team-colour stripe, logo
 * tiles, the win-chance bar, the three market boxes, small status pills, and
 * a compact "Leo's calls" table. Tables and inline styles only.
 */
'use strict';
const TH = require("./email-theme");
const { T, SANS, esc, tbl } = TH;
const X = { line: "#E6DCCB", awayRow: "#F1EEE7", homeRow: "#F8F3E6", box: "#F7F2E7", boxGold: "#F9F3E5", boxSteel: "#F1EEE6",
  goodBg: "#E2EDE4", dangerBg: "#F6E3DF" };
const F = `font-family:${SANS}`;

const TONE = { good: [X.goodBg, T.good], gold: ["#F4EBD2", T.goldDeep], navy: ["#E4E6EA", T.navy], live: [X.dangerBg, T.danger], muted: [T.elev, T.dim] };
function pill(text, tone = "navy") {
  const [bg, fg] = TONE[tone] || TONE.navy;
  return `<span style="${F};display:inline-block;background:${bg};color:${fg};border-radius:999px;padding:5px 10px;font-size:11px;line-height:1;font-weight:800;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap">${text}</span>`;
}

function teamRow(t, home) {
  return tbl(`<tr>
    <td width="42" style="padding:7px 0 7px 8px">${tbl(`<tr><td align="center" valign="middle" width="40" height="40">${t.logo ? `<img src="${t.logo}" width="32" height="32" alt="${esc(t.abbr)}" style="display:block;border:0;width:32px;height:32px;${F};font-size:11px;color:${T.dim}">` : esc(t.abbr)}</td></tr>`, `background:${T.card};border:1px solid #E3DED4;border-radius:12px`)}</td>
    <td style="padding:7px 10px;${F}"><div style="font-size:16px;font-weight:800;line-height:1.2;color:${T.text}">${esc(t.name)}</div>${t.sub ? `<div style="font-size:12px;color:${T.dim};margin-top:2px">${t.sub}</div>` : ""}</td>
    <td align="right" style="padding:7px 10px 7px 0;${F};white-space:nowrap"><div style="font-size:16px;font-weight:900;color:${T.text}">${t.right}</div>${t.rightSub ? `<div style="font-size:11px;color:${T.dim};margin-top:2px">${t.rightSub}</div>` : ""}</td>
  </tr>`, `background:${home ? X.homeRow : X.awayRow};border-radius:14px;margin:0 0 6px`);
}

function probBar(p) {
  const a = Math.max(2, Math.min(98, Math.round(p.away * 100))), h = 100 - a;
  return tbl(`<tr><td style="${F};font-size:12px;color:${T.dim};padding:4px 0 6px">${p.label}</td><td align="right" style="${F};font-size:12px;color:${T.dim};padding:4px 0 6px">${p.text}</td></tr>`) +
    tbl(`<tr><td width="${a}%" height="8" style="height:8px;line-height:8px;font-size:0;background:${p.awayColor};border-radius:999px 0 0 999px">&nbsp;</td><td width="${h}%" height="8" style="height:8px;line-height:8px;font-size:0;background:${p.homeColor};border-radius:0 999px 999px 0">&nbsp;</td></tr>`, "margin:0 0 12px");
}

function boxes(items) {
  const bg = { gold: [X.boxGold, "#EADDB8"], steel: [X.boxSteel, "#D9DDE2"], good: [X.goodBg, "#BFD8C6"], muted: [T.elev, "#DCD6CA"] };
  return tbl(`<tr>${items.map((b, i) => {
    const [fill, edge] = bg[b.tone] || [X.box, "#DCD6CA"];
    return `<td width="${Math.floor(100 / items.length)}%" valign="top" style="padding:0 ${i === items.length - 1 ? 0 : 4}px 0 ${i === 0 ? 0 : 4}px">${tbl(`<tr><td align="center" style="padding:10px 6px;${F}">
      <div style="font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${T.dim}">${b.label}</div>
      <div style="font-size:16px;font-weight:900;color:${b.tone === "muted" ? T.dim : T.text};margin:4px 0 3px;white-space:nowrap">${b.value}</div>
      <div style="font-size:11px;color:${T.dim}">${b.sub || "&nbsp;"}</div></td></tr>`, `background:${fill};border:1px solid ${edge};border-radius:13px`)}</td>`;
  }).join("")}</tr>`);
}

/** One game, like the scoreboard card. */
function gameCard(g) {
  const notes = (g.notes || []).filter(Boolean).map(n => `<div style="${F};font-size:13px;line-height:1.55;color:${T.dim};border-top:1px solid ${X.line};margin-top:12px;padding-top:10px">${n}</div>`).join("");
  return tbl(`
  <tr><td style="padding:0;font-size:0;line-height:0">${tbl(`<tr><td width="50%" height="6" style="height:6px;font-size:0;line-height:6px;background:${g.awayColor};border-radius:20px 0 0 0">&nbsp;</td><td width="50%" height="6" style="height:6px;font-size:0;line-height:6px;background:${g.homeColor};border-radius:0 20px 0 0">&nbsp;</td></tr>`)}</td></tr>
  <tr><td style="padding:14px 16px 16px">
    ${tbl(`<tr><td style="${F}"><div style="font-size:15px;font-weight:900;color:${T.text}">${g.time}</div><div style="font-size:12px;color:${T.dim};margin-top:2px">${g.venue || ""}</div></td><td align="right" valign="top">${(g.badges || []).join(" ")}</td></tr>`, "margin:0 0 10px")}
    ${teamRow(g.away, false)}${teamRow(g.home, true)}
    ${g.prob ? `<div style="height:6px;line-height:6px;font-size:0">&nbsp;</div>${probBar({ ...g.prob, awayColor: g.awayColor, homeColor: g.homeColor })}` : ""}
    ${g.boxes ? boxes(g.boxes) : ""}
    ${notes}
    ${g.cta ? `<div style="margin-top:14px">${tbl(`<tr><td style="${F};font-size:13px;font-weight:800"><a href="${g.href}" style="color:${T.navy};text-decoration:none">${g.cta}</a></td><td align="right" style="${F};font-size:16px;font-weight:800"><a href="${g.href}" style="color:${T.navy};text-decoration:none">&rarr;</a></td></tr>`)}</div>` : ""}
  </td></tr>`, `background:${T.card};border:1px solid #D3D3D3;border-radius:20px;overflow:hidden;margin:0 0 16px`);
}

/** Rows for TH.panel(): [[leftHtml, rightHtml], ...] as a two-column table. */
function rows(list, empty) {
  if (!list.length) return `<div style="${F};font-size:14px;color:${T.dim}">${empty}</div>`;
  return tbl(list.map(([l, r]) => `<tr><td style="${F};font-size:15px;padding:6px 0;color:${T.text};border-top:1px solid ${X.line}">${l}</td><td align="right" style="${F};font-size:12px;padding:6px 0;color:${T.dim};border-top:1px solid ${X.line}">${r}</td></tr>`).join(""));
}

const NFL_COLORS = { ARI: "#97233F", ATL: "#A71930", BAL: "#241773", BUF: "#00338D", CAR: "#0085CA", CHI: "#0B162A", CIN: "#FB4F14", CLE: "#FF3C00", DAL: "#002244", DEN: "#FB4F14", DET: "#0076B6", GB: "#203731", HOU: "#03202F", IND: "#002C5F", JAX: "#006778", KC: "#E31837", LA: "#003594", LAC: "#007BC7", LV: "#000000", MIA: "#008E97", MIN: "#4F2683", NE: "#002244", NO: "#D3BC8D", NYG: "#0B2265", NYJ: "#125740", PHI: "#004C54", PIT: "#FFB612", SEA: "#002244", SF: "#AA0000", TB: "#D50A0A", TEN: "#4B92DB", WAS: "#5A1414" };
function pairColors(map, away, home) {
  const a = map[away] || T.navy; let h = map[home] || T.gold;
  if (a.toLowerCase() === h.toLowerCase()) h = T.gold;
  return [a, h];
}

module.exports = { ...TH, X, pill, gameCard, rows, NFL_COLORS, pairColors };
