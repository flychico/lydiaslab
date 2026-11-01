/**
 * Leo NBA: ESPN's per-game summary, the source for box scores and the
 * closing spread (NBA-H15).
 *
 *   site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=<id>
 *
 * The scoreboard drops the betting line once a game is final, so the close
 * comes from the summary's `pickcenter` (one row per book; `spread` is the
 * home team's line, negative = home favoured). The box score is
 * `boxscore.players[]`: per team, `statistics[0].keys` names the columns and
 * each athlete carries `stats` in that order plus starter / didNotPlay /
 * reason / ejected. Field names follow sportsdataverse (hoopR and
 * sportsdataverse-py), which parse the same payload.
 *
 * Tests: NBA_FIXTURES=<dir> serves summary_<id>.json from disk.
 * The line is used only for grading and closing line value, never as an input.
 */
const fs = require("fs");
const path = require("path");

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

async function fetchSummary(id, tries = 3) {
  if (process.env.NBA_FIXTURES) {
    const f = path.join(process.env.NBA_FIXTURES, `summary_${id}.json`);
    if (!fs.existsSync(f)) throw new Error("no fixture " + f);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${ESPN}/summary?event=${id}`, { headers: { "user-agent": "leo-nba/1.0" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(`summary ${id}: ${e.message}`);
      await new Promise(s => setTimeout(s, 1500 * i));
    }
  }
}

const num = v => { const x = parseFloat(String(v ?? "").replace(/^\+/, "")); return Number.isFinite(x) ? x : null; };

/** Closing home spread: DraftKings if ESPN lists it, else the first book with a spread. */
function closeSpread(summary) {
  const rows = (summary && summary.pickcenter) || [];
  const withSpread = rows.filter(r => num(r.spread) != null);
  const dk = withSpread.find(r => /draftkings/i.test((r.provider && r.provider.name) || ""));
  const r = dk || withSpread[0];
  return r ? { home_spread: num(r.spread), provider: (r.provider && r.provider.name) || "", total: num(r.overUnder) } : null;
}

/** Every player line for both teams, including did-not-play rows. */
function boxScore(summary) {
  const out = [];
  for (const team of ((summary && summary.boxscore) || {}).players || []) {
    const abbr = (team.team && team.team.abbreviation) || "";
    for (const block of team.statistics || []) {
      const keys = block.keys || block.names || block.labels || [];
      for (const a of block.athletes || []) {
        const ath = a.athlete || {}, st = {};
        (a.stats || []).forEach((v, i) => { if (keys[i]) st[keys[i]] = v; });
        out.push({
          team: abbr, id: String(ath.id || ""), name: ath.displayName || "",
          starter: !!a.starter, dnp: !!a.didNotPlay, reason: a.reason || "", ejected: !!a.ejected,
          minutes: a.didNotPlay ? 0 : (num(st.minutes) ?? 0), stats: st
        });
      }
    }
  }
  return out;
}

module.exports = { fetchSummary, closeSpread, boxScore };
