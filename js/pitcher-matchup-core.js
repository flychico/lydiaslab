"use strict";

(function attachPitcherCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LyDiaPitcherCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildPitcherCore() {
  const VERSION = "pitcher-matchup-core-v1";
  const LEAGUE_ERA = 4.20;
  const LEAGUE_WHIP = 1.30;

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function num(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function ipToNum(ip) {
    if (!ip || ip === "-.--") return 0;
    const [whole, fraction] = String(ip).split(".");
    return Number(whole || 0) + Number(fraction || 0) / 3;
  }

  function seasonFromDate(date) {
    return Number(String(date || "").slice(0, 4)) || new Date().getFullYear();
  }

  async function fetchStarterUsage(id, season, getJson) {
    try {
      const data = await getJson(
        `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=${season}`
      );
      const splits = (((data.stats || [])[0] || {}).splits || []);
      let starterIp = 0;
      let starterGames = 0;

      for (const split of splits) {
        const stat = split && split.stat ? split.stat : {};
        const started = num(stat.gamesStarted, 0);
        if (started <= 0) continue;
        starterIp += ipToNum(stat.inningsPitched);
        starterGames += started;
      }

      return starterGames > 0 ? { starterIp, starterGames } : null;
    } catch (_) {
      return null;
    }
  }

  async function fetchPitchers(ids, date, getJson) {
    const out = {};
    if (!Array.isArray(ids) || !ids.length) return out;
    if (typeof getJson !== "function") throw new Error("fetchPitchers requires getJson(url)");

    const data = await getJson(
      `https://statsapi.mlb.com/api/v1/people?personIds=${ids.join(",")}&hydrate=stats(group=[pitching],type=[season])`
    );
    const mixedRoleIds = [];

    for (const person of data.people || []) {
      const split = (((person.stats || [])[0] || {}).splits || [])[0];
      const stat = split && split.stat ? split.stat : {};
      const ip = ipToNum(stat.inningsPitched);
      const gamesStarted = num(stat.gamesStarted, 0);
      const gamesPitched = num(stat.gamesPitched, null);

      out[person.id] = {
        id: person.id,
        name: person.fullName,
        hand: (person.pitchHand || {}).code || null,
        era: num(stat.era),
        whip: num(stat.whip),
        ip,
        so: num(stat.strikeOuts, 0),
        bb: num(stat.baseOnBalls, 0),
        hr: num(stat.homeRuns, 0),
        gs: gamesStarted,
        gp: gamesPitched,
        w: num(stat.wins, 0),
        l: num(stat.losses, 0),
        bf: num(stat.battersFaced, 0),
        go: num(stat.groundOuts, 0),
        ao: num(stat.airOuts, 0),
        h: num(stat.hits, 0),
        ab: num(stat.atBats, 0),
        sf: num(stat.sacFlies, 0),
        starterIp: gamesStarted > 0 && gamesPitched === gamesStarted ? ip : null,
        starterGames: gamesStarted > 0 && gamesPitched === gamesStarted ? gamesStarted : null
      };

      // Dividing total season innings by starts is valid only when every
      // appearance was a start. Mixed-role pitchers need starter-only game logs.
      if (gamesStarted > 0 && gamesPitched !== gamesStarted) mixedRoleIds.push(person.id);
    }

    if (mixedRoleIds.length) {
      const season = seasonFromDate(date);
      const rows = await Promise.all(
        mixedRoleIds.map(async id => [id, await fetchStarterUsage(id, season, getJson)])
      );

      for (const [id, usage] of rows) {
        if (!usage || !out[id]) continue;
        out[id].starterIp = usage.starterIp;
        out[id].starterGames = usage.starterGames;
      }
    }

    return out;
  }

  function scorePitcher(stat) {
    if (!stat || stat.missing || !Number.isFinite(stat.era)) {
      return {
        ...(stat || {}),
        score: 50,
        grade: "Unknown",
        note: "season stats unavailable; neutral score used",
        k9: null,
        bb9: null,
        kbbPct: null,
        gbPct: null,
        babip: null,
        hr9: null,
        ipStart: null
      };
    }

    const era = stat.era || LEAGUE_ERA;
    const whip = Number.isFinite(stat.whip) ? stat.whip : LEAGUE_WHIP;
    const ip = stat.ip || 0;
    const k9 = ip ? (stat.so / ip) * 9 : null;
    const bb9 = ip ? (stat.bb / ip) * 9 : null;

    const eraScore = clamp(100 - (era - 2.00) * 16, 20, 92);
    const whipScore = clamp(100 - (whip - 0.90) * 90, 20, 92);
    const kbbScore = k9 !== null && bb9 !== null
      ? clamp(50 + (k9 - 8.0) * 4 - (bb9 - 3.0) * 6, 20, 90)
      : 50;
    const sampleScore = clamp(35 + Math.min(ip, 100) * 0.35, 35, 70);
    const score = Math.round(
      eraScore * 0.40 +
      whipScore * 0.25 +
      kbbScore * 0.20 +
      sampleScore * 0.15
    );

    let grade = "Average";
    if (score >= 75) grade = "Strong";
    else if (score >= 65) grade = "Above avg";
    else if (score < 45) grade = "Weak";
    else if (score < 55) grade = "Below avg";

    const note = ip < 20 ? "limited innings; treat score with caution" : null;
    const kbbPct = stat.bf ? (stat.so - stat.bb) / stat.bf : null;
    const gbPct = stat.go + stat.ao ? stat.go / (stat.go + stat.ao) : null;
    const babipDen = stat.ab - stat.so - stat.hr + (stat.sf || 0);
    const babip = babipDen > 0 ? (stat.h - stat.hr) / babipDen : null;
    const hr9 = ip ? (stat.hr / ip) * 9 : null;
    const ipStart = stat.starterGames ? stat.starterIp / stat.starterGames : null;

    return {
      ...stat,
      score,
      grade,
      note,
      k9,
      bb9,
      kbbPct,
      gbPct,
      babip,
      hr9,
      ipStart
    };
  }

  function pitcherForSide(side, stats) {
    const probable = side && side.probablePitcher;
    if (!probable) return scorePitcher({ name: "TBD", missing: true });
    const stat = stats[probable.id] || { id: probable.id, name: probable.fullName, missing: true };
    return scorePitcher(stat);
  }

  function matchupData(game, stats) {
    const away = pitcherForSide(game.teams.away, stats);
    const home = pitcherForSide(game.teams.home, stats);
    const gap = Math.abs(home.score - away.score);

    let strength = "No clear edge";
    if (gap >= 14) strength = "Strong";
    else if (gap >= 8) strength = "Moderate";
    else if (gap >= 4) strength = "Slight";

    const edgeTeam = gap < 4
      ? "No clear SP edge"
      : home.score > away.score
        ? game.teams.home.team.name
        : game.teams.away.team.name;

    return {
      game_pk: game.gamePk,
      game: `${game.teams.away.team.name} @ ${game.teams.home.team.name}`,
      away_team: game.teams.away.team.name,
      home_team: game.teams.home.team.name,
      away,
      home,
      gap,
      strength,
      edge_team: edgeTeam
    };
  }

  async function buildSource({ date, games, getJson, generatedAt }) {
    const ids = [...new Set(
      (games || []).flatMap(game =>
        ["away", "home"]
          .map(side => game.teams[side].probablePitcher && game.teams[side].probablePitcher.id)
          .filter(Boolean)
      )
    )];

    const pitchersById = await fetchPitchers(ids, date, getJson);
    const rows = (games || []).map(game => matchupData(game, pitchersById));
    const gamesByPk = Object.fromEntries(rows.map(row => [String(row.game_pk), row]));

    return {
      date,
      generated_at: generatedAt || new Date().toISOString(),
      source_of_truth: "LyDia Pitcher Matchup Tool",
      source_version: VERSION,
      method: "Season pitching stats plus starter-only game logs for mixed-role pitchers. The Pitcher Matchup Tool and matchup pages read this same source.",
      pitchers_by_id: pitchersById,
      games: gamesByPk
    };
  }

  async function browserGetJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
  }

  async function loadPitchersForDate(ids, date, getJson = browserGetJson) {
    try {
      const canonical = await getJson(`/data/pitcher-matchups/${date}.json?v=${Date.now()}`);
      if (
        canonical &&
        canonical.date === date &&
        canonical.source_version === VERSION &&
        canonical.pitchers_by_id
      ) {
        const hasEveryRequestedPitcher = ids.every(id => canonical.pitchers_by_id[id]);
        if (hasEveryRequestedPitcher) return canonical.pitchers_by_id;
      }
    } catch (_) {
      // Generated data may not exist for an unprocessed future date.
    }

    return fetchPitchers(ids, date, getJson);
  }

  return {
    VERSION,
    LEAGUE_ERA,
    LEAGUE_WHIP,
    clamp,
    num,
    ipToNum,
    fetchStarterUsage,
    fetchPitchers,
    scorePitcher,
    pitcherForSide,
    matchupData,
    buildSource,
    loadPitchersForDate
  };
});
