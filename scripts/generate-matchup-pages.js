#!/usr/bin/env node
"use strict";

/*
  LyDia matchup-page generator.

  Purpose
  - Generate one permanent page for every MLB matchup in the daily member brief.
  - Apply an indexing quality gate. Complete pages use index,follow. Incomplete
    pages still publish for users and internal links, but use noindex,follow.
  - Add indexable matchup pages to sitemap.xml.
  - Build /mlb/matchups/ as the permanent matchup archive.
  - Add links from the dated daily preview to each matchup page.
  - Reuse the same URL after the game and add the final score and official grade.

  Usage
    node scripts/generate-matchup-pages.js [YYYY-MM-DD]
    node scripts/generate-matchup-pages.js 2026-07-21 --skip-weather
    node scripts/generate-matchup-pages.js 2026-07-21 --root /tmp/test-repo --offline
*/

const fs = require("fs");
const path = require("path");

const SITE = "https://lydiaslab.com";
const AUTHOR_URL = `${SITE}/writers/lynold/`;
const AUTHOR_ID = `${AUTHOR_URL}#person`;
const DEFAULT_ROOT = path.join(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root || DEFAULT_ROOT);
const DATE = args.date || easternDate();

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  fail(`Invalid date: ${DATE}. Expected YYYY-MM-DD.`);
}

const MEMBER_BRIEF_PATH = path.join(ROOT, "data", "member-brief", `${DATE}.json`);
const TOTALS_PATH = path.join(ROOT, "data", "totals", `${DATE}.json`);
const PITCHER_PATH = path.join(ROOT, "data", "pitcher-matchups", `${DATE}.json`);
const RESULTS_PATH = path.join(ROOT, "data", "results.json");
const MANIFEST_DIR = path.join(ROOT, "data", "matchup-pages");
const MANIFEST_PATH = path.join(MANIFEST_DIR, `${DATE}.json`);
const MATCHUP_ROOT = path.join(ROOT, "mlb");
const ARCHIVE_DIR = path.join(MATCHUP_ROOT, "matchups");
const PREVIEW_PATH = path.join(ROOT, "previews", `${DATE}.html`);
const PICKS_PATH = path.join(ROOT, "picks", "index.html");
const SITEMAP_PATH = path.join(ROOT, "sitemap.xml");

const TEAM_SHORT = {
  "Arizona Diamondbacks": "Diamondbacks",
  "Athletics": "Athletics",
  "Atlanta Braves": "Braves",
  "Baltimore Orioles": "Orioles",
  "Boston Red Sox": "Red Sox",
  "Chicago Cubs": "Cubs",
  "Chicago White Sox": "White Sox",
  "Cincinnati Reds": "Reds",
  "Cleveland Guardians": "Guardians",
  "Colorado Rockies": "Rockies",
  "Detroit Tigers": "Tigers",
  "Houston Astros": "Astros",
  "Kansas City Royals": "Royals",
  "Los Angeles Angels": "Angels",
  "Los Angeles Dodgers": "Dodgers",
  "Miami Marlins": "Marlins",
  "Milwaukee Brewers": "Brewers",
  "Minnesota Twins": "Twins",
  "New York Mets": "Mets",
  "New York Yankees": "Yankees",
  "Philadelphia Phillies": "Phillies",
  "Pittsburgh Pirates": "Pirates",
  "San Diego Padres": "Padres",
  "San Francisco Giants": "Giants",
  "Seattle Mariners": "Mariners",
  "St. Louis Cardinals": "Cardinals",
  "Tampa Bay Rays": "Rays",
  "Texas Rangers": "Rangers",
  "Toronto Blue Jays": "Blue Jays",
  "Washington Nationals": "Nationals"
};

const PARKS = {
  "Arizona Diamondbacks": { venue: "Chase Field", lat: 33.445, lon: -112.067, roof: true },
  "Athletics": { venue: "Sutter Health Park", lat: 38.580, lon: -121.514, roof: false },
  "Atlanta Braves": { venue: "Truist Park", lat: 33.891, lon: -84.468, roof: false },
  "Baltimore Orioles": { venue: "Oriole Park at Camden Yards", lat: 39.284, lon: -76.622, roof: false },
  "Boston Red Sox": { venue: "Fenway Park", lat: 42.346, lon: -71.097, roof: false },
  "Chicago Cubs": { venue: "Wrigley Field", lat: 41.948, lon: -87.655, roof: false },
  "Chicago White Sox": { venue: "Rate Field", lat: 41.830, lon: -87.634, roof: false },
  "Cincinnati Reds": { venue: "Great American Ball Park", lat: 39.097, lon: -84.507, roof: false },
  "Cleveland Guardians": { venue: "Progressive Field", lat: 41.496, lon: -81.685, roof: false },
  "Colorado Rockies": { venue: "Coors Field", lat: 39.756, lon: -104.994, roof: false },
  "Detroit Tigers": { venue: "Comerica Park", lat: 42.339, lon: -83.049, roof: false },
  "Houston Astros": { venue: "Daikin Park", lat: 29.757, lon: -95.355, roof: true },
  "Kansas City Royals": { venue: "Kauffman Stadium", lat: 39.051, lon: -94.480, roof: false },
  "Los Angeles Angels": { venue: "Angel Stadium", lat: 33.800, lon: -117.883, roof: false },
  "Los Angeles Dodgers": { venue: "Dodger Stadium", lat: 34.074, lon: -118.240, roof: false },
  "Miami Marlins": { venue: "loanDepot park", lat: 25.778, lon: -80.220, roof: true },
  "Milwaukee Brewers": { venue: "American Family Field", lat: 43.028, lon: -87.971, roof: true },
  "Minnesota Twins": { venue: "Target Field", lat: 44.981, lon: -93.278, roof: false },
  "New York Mets": { venue: "Citi Field", lat: 40.757, lon: -73.845, roof: false },
  "New York Yankees": { venue: "Yankee Stadium", lat: 40.829, lon: -73.926, roof: false },
  "Philadelphia Phillies": { venue: "Citizens Bank Park", lat: 39.906, lon: -75.166, roof: false },
  "Pittsburgh Pirates": { venue: "PNC Park", lat: 40.447, lon: -80.006, roof: false },
  "San Diego Padres": { venue: "Petco Park", lat: 32.707, lon: -117.157, roof: false },
  "San Francisco Giants": { venue: "Oracle Park", lat: 37.778, lon: -122.389, roof: false },
  "Seattle Mariners": { venue: "T-Mobile Park", lat: 47.591, lon: -122.333, roof: true },
  "St. Louis Cardinals": { venue: "Busch Stadium", lat: 38.623, lon: -90.193, roof: false },
  "Tampa Bay Rays": { venue: "George M. Steinbrenner Field", lat: 27.980, lon: -82.507, roof: false },
  "Texas Rangers": { venue: "Globe Life Field", lat: 32.747, lon: -97.083, roof: true },
  "Toronto Blue Jays": { venue: "Rogers Centre", lat: 43.641, lon: -79.389, roof: true },
  "Washington Nationals": { venue: "Nationals Park", lat: 38.873, lon: -77.007, roof: false }
};

main().catch(error => fail(error.stack || error.message));

async function main() {
  if (!fs.existsSync(MEMBER_BRIEF_PATH)) {
    throw new Error(`Missing ${relative(MEMBER_BRIEF_PATH)}. Run the LyDia source engine first.`);
  }

  const brief = readJson(MEMBER_BRIEF_PATH);
  if (!Array.isArray(brief.games) || brief.games.length === 0) {
    throw new Error(`Member brief ${DATE} has no games. Refusing to create empty matchup pages.`);
  }

  const totals = readJsonSafe(TOTALS_PATH) || { games: {} };
  const pitcherSource = readJsonSafe(PITCHER_PATH);
  if (!pitcherSource || !pitcherSource.games) {
    throw new Error(`Missing canonical pitcher source ${relative(PITCHER_PATH)}. Run generate-pitcher-matchup-data.js first.`);
  }
  const results = readJsonSafe(RESULTS_PATH) || { days: {} };
  const kprops = readJsonSafe(path.join(ROOT, "data", "k-props", `${DATE}.json`));
  const teamHitting = args.offline ? { season: {}, recent: {} } : await fetchTeamHitting(DATE);
  const previousManifest = readJsonSafe(MANIFEST_PATH) || { pages: [] };
  const previousBySlug = new Map((previousManifest.pages || []).map(page => [page.slug, page]));
  const schedule = args.offline ? null : await fetchSchedule(DATE);
  const scheduleByPk = new Map((((schedule && schedule.dates || [])[0] || {}).games || []).map(game => [String(game.gamePk), game]));

  fs.mkdirSync(MATCHUP_ROOT, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });

  // Doubleheaders: two games, same teams, same date, collide on one slug and
  // the second page silently overwrites the first. The 2026-07-22 Orioles at
  // Red Sox split doubleheader proved it. Number games by start time and
  // suffix every game after the first.
  const slugGroups = new Map();
  for (const game of brief.games) {
    const base = matchupSlug(game);
    if (!slugGroups.has(base)) slugGroups.set(base, []);
    slugGroups.get(base).push(game);
  }
  const dhNumber = new Map();
  for (const [, group] of slugGroups) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(a.game_time_iso || a.time || "").localeCompare(String(b.game_time_iso || b.time || "")));
    group.forEach((game, index) => dhNumber.set(String(game.game_pk), index + 1));
  }

  const pages = [];
  for (const game of brief.games) {
    const gameNumber = dhNumber.get(String(game.game_pk)) || null;
    const slug = matchupSlug(game) + (gameNumber && gameNumber > 1 ? `-game-${gameNumber}` : "");
    const urlPath = `/mlb/${slug}/`;
    const scheduleGame = scheduleByPk.get(String(game.game_pk)) || null;
    const totalsGame = (totals.games && totals.games[String(game.game_pk)]) || null;
    const rawPitcherGame = (pitcherSource.games && pitcherSource.games[String(game.game_pk)]) || null;
    const pitcherGame = rawPitcherGame ? { ...rawPitcherGame, source_version: pitcherSource.source_version || null } : null;
    const resultGame = findResult(results, DATE, game);
    const previous = previousBySlug.get(slug) || null;
    const weather = args.skipWeather
      ? (previous && previous.weather) || null
      : await weatherForGame(game, scheduleGame, previous && previous.weather);
    const venue = venueForGame(game, scheduleGame);
    const quality = qualityGate(game, pitcherGame);
    const outputDir = path.join(MATCHUP_ROOT, slug);
    const outputPath = path.join(outputDir, "index.html");

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, renderMatchupPage({
      brief,
      game,
      scheduleGame,
      totalsGame,
      pitcherGame,
      resultGame,
      weather,
      venue,
      quality,
      slug,
      urlPath,
      kprops,
      teamHitting,
      gameNumber
    }), "utf8");

    pages.push({
      date: DATE,
      game_pk: game.game_pk,
      game: game.game,
      away_team: game.away_team,
      home_team: game.home_team,
      slug,
      url: `${SITE}${urlPath}`,
      output: relative(outputPath),
      status: game.status,
      indexable: quality.indexable,
      quality_score: quality.score,
      quality_total: quality.total,
      missing: quality.missing,
      generated_at: new Date().toISOString(),
      weather,
      pitcher_source_version: pitcherSource.source_version || null,
      final: finalSummary(scheduleGame, resultGame)
    });
  }

  const manifest = {
    date: DATE,
    generated_at: new Date().toISOString(),
    source: relative(MEMBER_BRIEF_PATH),
    pitcher_source: relative(PITCHER_PATH),
    pitcher_source_version: pitcherSource.source_version || null,
    total_pages: pages.length,
    indexable_pages: pages.filter(page => page.indexable).length,
    noindex_pages: pages.filter(page => !page.indexable).length,
    indexing_rule: "Pages are indexable only when verified starters, model, market, pitcher, bullpen, offense and decision data are complete.",
    pages
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  buildArchive();
  updateSitemap(manifest);
  linkDailyPreview(manifest);
  linkPicksPage();

  console.log(`Generated ${pages.length} matchup pages for ${DATE}.`);
  console.log(`Indexable: ${manifest.indexable_pages}. Noindex: ${manifest.noindex_pages}.`);
  console.log(`Manifest: ${relative(MANIFEST_PATH)}`);
}

function parseArgs(argv) {
  const out = { date: null, root: null, offline: false, skipWeather: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg) && !out.date) out.date = arg;
    else if (arg === "--root") out.root = argv[++i];
    else if (arg === "--offline") out.offline = true;
    else if (arg === "--skip-weather") out.skipWeather = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/generate-matchup-pages.js [YYYY-MM-DD] [--root PATH] [--offline] [--skip-weather]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function easternDate() {
  const date = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonSafe(file) {
  try { return readJson(file); } catch (_) { return null; }
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function jsonScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function shortTeam(team) {
  return TEAM_SHORT[team] || team;
}

function matchupSlug(game) {
  return `${slugify(shortTeam(game.away_team))}-vs-${slugify(shortTeam(game.home_team))}-prediction-odds-${DATE}`;
}

function niceDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });
}

function prettyDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: "America/New_York", timeZoneName: "short"
  });
}

function pct(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "Not available";
}

function signedPct(value, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not available";
  const n = value * 100;
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function odds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not available";
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function oneDecimal(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "Not available";
}

function rating(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value / 10).toFixed(1)}/10` : "Not available";
}

function known(value) {
  return value !== null && value !== undefined && value !== "";
}

function validPitcher(name) {
  return known(name) && !/^tbd$/i.test(String(name).trim()) && !/unknown/i.test(String(name));
}

function qualityGate(game, pitcherGame) {
  const pitcher = pitcherGame || {};
  const market = game.market || {};
  const bullpen = game.bullpen || {};
  const offense = game.offense_form || {};
  const decisionText = game.read || game.pass_reason;
  const checks = {
    teams: Boolean(game.away_team && game.home_team),
    game_time: Boolean(game.game_time_iso || game.time),
    probable_pitchers: validPitcher(pitcher.away && pitcher.away.name) && validPitcher(pitcher.home && pitcher.home.name),
    pitcher_stats: [pitcher.away, pitcher.home].every(side =>
      side && typeof side.era === "number" && Number.isFinite(side.era) && typeof side.whip === "number" && Number.isFinite(side.whip)
    ),
    model_probability: typeof game.model_probability === "number" && Number.isFinite(game.model_probability),
    market_probability: typeof market.no_vig_probability === "number" && Number.isFinite(market.no_vig_probability),
    market_price: typeof market.best_price === "number" && Number.isFinite(market.best_price) && Number(market.books || 0) >= 3,
    lab_rating: typeof game.lab_score === "number" && Number.isFinite(game.lab_score),
    decision: ["official_pick", "value_watch", "watchlist", "pass"].includes(game.status) && typeof decisionText === "string" && decisionText.trim().length >= 40,
    bullpen: Boolean(bullpen.pick_team && bullpen.opponent) && [bullpen.pick_team, bullpen.opponent].every(side =>
      side && typeof (side.risk_index ?? side.score) === "number" && typeof side.efficiency_score === "number"
    ),
    offense_form: Boolean(offense.away && offense.home) && [offense.away, offense.home].every(side =>
      side && (typeof side.ops_15d === "number" || typeof side.rpg_15d === "number") && typeof side.season_ops === "number"
    )
  };
  const required = Object.keys(checks);
  const passed = required.filter(key => checks[key]);
  const missing = required.filter(key => !checks[key]);
  return {
    checks,
    score: passed.length,
    total: required.length,
    missing,
    indexable: missing.length === 0
  };
}

async function fetchTeamHitting(date) {
  // Team offense rates plus standings-based run environment. Same StatsAPI the
  // public Stats page uses. Failure degrades to "Not available" and never
  // affects the indexing quality gate.
  const year = Number(String(date).slice(0, 4));
  const start = (() => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 15); return d.toISOString().slice(0, 10); })();
  const out = { season: {}, recent: {}, recentDetail: {}, standings: {} };
  const grab = async (url, handler) => {
    const response = await fetch(url, { headers: { "user-agent": "LyDia matchup generator" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    handler(await response.json());
  };
  const hitSplits = (data, apply) => {
    for (const split of (((data.stats || [])[0] || {}).splits || [])) {
      const teamName = split.team && split.team.name;
      if (teamName) apply(teamName, split.stat || {});
    }
  };
  try {
    await grab(`https://statsapi.mlb.com/api/v1/teams/stats?sportId=1&group=hitting&season=${year}&stats=season`, data =>
      hitSplits(data, (team, stat) => {
        const pa = Number(stat.plateAppearances), so = Number(stat.strikeOuts);
        if (pa > 0 && Number.isFinite(so)) out.season[team] = so / pa;
      }));
  } catch (error) { console.warn(`Team season hitting unavailable: ${error.message}`); }
  try {
    await grab(`https://statsapi.mlb.com/api/v1/teams/stats?sportId=1&group=hitting&season=${year}&stats=byDateRange&startDate=${start}&endDate=${date}`, data =>
      hitSplits(data, (team, stat) => {
        const pa = Number(stat.plateAppearances), so = Number(stat.strikeOuts);
        const games = Number(stat.gamesPlayed), hr = Number(stat.homeRuns);
        if (pa > 0 && Number.isFinite(so)) out.recent[team] = so / pa;
        out.recentDetail[team] = {
          hr_pg: games > 0 && Number.isFinite(hr) ? hr / games : null
        };
      }));
  } catch (error) { console.warn(`Team recent hitting unavailable: ${error.message}`); }
  try {
    await grab(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${year}&standingsTypes=regularSeason`, data => {
      for (const record of (data.records || [])) {
        for (const teamRecord of (record.teamRecords || [])) {
          const teamName = teamRecord.team && teamRecord.team.name;
          const games = Number(teamRecord.gamesPlayed);
          if (!teamName || !(games > 0)) continue;
          out.standings[teamName] = {
            run_diff_pg: Number.isFinite(Number(teamRecord.runDifferential)) ? Number(teamRecord.runDifferential) / games : null,
            rs_pg: Number.isFinite(Number(teamRecord.runsScored)) ? Number(teamRecord.runsScored) / games : null,
            ra_pg: Number.isFinite(Number(teamRecord.runsAllowed)) ? Number(teamRecord.runsAllowed) / games : null
          };
        }
      }
    });
  } catch (error) { console.warn(`Standings unavailable: ${error.message}`); }
  return out;
}

async function fetchSchedule(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(date)}&hydrate=probablePitcher,venue,linescore,broadcasts`;
  try {
    const response = await fetch(url, { headers: { "user-agent": "LyDia matchup generator" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn(`Schedule enrichment unavailable for ${date}: ${error.message}`);
    return null;
  }
}

function venueForGame(game, scheduleGame) {
  const fromSchedule = scheduleGame && scheduleGame.venue && scheduleGame.venue.name;
  const park = PARKS[game.home_team] || null;
  return {
    name: fromSchedule || (park && park.venue) || "Venue not confirmed",
    roof: park ? park.roof : null,
    lat: park ? park.lat : null,
    lon: park ? park.lon : null
  };
}

async function weatherForGame(game, scheduleGame, previousWeather) {
  const park = PARKS[game.home_team];
  const gameTime = game.game_time_iso || (scheduleGame && scheduleGame.gameDate);
  if (!park || !gameTime) return previousWeather || null;

  const gameDate = new Date(gameTime);
  const now = new Date();
  const ageDays = (now - gameDate) / 86400000;
  if (ageDays > 2) return previousWeather || null;

  const params = new URLSearchParams({
    latitude: String(park.lat),
    longitude: String(park.lon),
    hourly: "temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,weather_code",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "UTC",
    forecast_days: "7"
  });

  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
      headers: { "user-agent": "LyDia matchup generator" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const hourly = data.hourly || {};
    const times = hourly.time || [];
    if (!times.length) return previousWeather || null;
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
      const diff = Math.abs(new Date(`${times[i]}Z`) - gameDate);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return {
      source: "Open-Meteo forecast",
      forecast_time_utc: times[best],
      temperature_f: numberAt(hourly.temperature_2m, best),
      precipitation_probability: numberAt(hourly.precipitation_probability, best),
      wind_mph: numberAt(hourly.wind_speed_10m, best),
      wind_direction_degrees: numberAt(hourly.wind_direction_10m, best),
      weather_code: numberAt(hourly.weather_code, best),
      roof: park.roof
    };
  } catch (error) {
    console.warn(`Weather unavailable for ${game.game}: ${error.message}`);
    return previousWeather || null;
  }
}

function numberAt(array, index) {
  const value = Array.isArray(array) ? Number(array[index]) : NaN;
  return Number.isFinite(value) ? value : null;
}

function weatherText(weather, venue) {
  if (!weather) {
    return venue.roof === true
      ? "This venue has a roof. The roof status still needs confirmation before first pitch."
      : "A verified game-time weather forecast was not available when this page was generated.";
  }
  const pieces = [];
  if (typeof weather.temperature_f === "number") pieces.push(`${Math.round(weather.temperature_f)}°F`);
  if (typeof weather.precipitation_probability === "number") pieces.push(`${Math.round(weather.precipitation_probability)}% precipitation chance`);
  if (typeof weather.wind_mph === "number") pieces.push(`${Math.round(weather.wind_mph)} mph wind${windDirection(weather.wind_direction_degrees)}`);
  let text = pieces.length ? `Game-time forecast: ${pieces.join(", ")}.` : "Game-time forecast details are limited.";
  if (venue.roof === true) text += " This venue has a roof, but the roof status is not confirmed.";
  return text;
}

function windDirection(degrees) {
  if (typeof degrees !== "number") return "";
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return ` from ${directions[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]}`;
}

function findResult(results, date, game) {
  const day = results && results.days && results.days[date];
  if (!day || !Array.isArray(day.picks)) return null;
  return day.picks.find(pick =>
    String(pick.gamePk || pick.game_pk) === String(game.game_pk) ||
    (pick.away === game.away_team && pick.home === game.home_team)
  ) || null;
}

function finalSummary(scheduleGame, resultGame) {
  const awayScore = scheduleGame && scheduleGame.teams && scheduleGame.teams.away && scheduleGame.teams.away.score;
  const homeScore = scheduleGame && scheduleGame.teams && scheduleGame.teams.home && scheduleGame.teams.home.score;
  const status = scheduleGame && scheduleGame.status && scheduleGame.status.abstractGameState;
  const gradedResult = resultGame && (
    known(resultGame.finalAway) || known(resultGame.finalHome) ||
    ["W", "L", "VOID"].includes(resultGame.mlResult)
  );
  if (status !== "Final" && !gradedResult) return null;
  return {
    away_score: known(awayScore) ? awayScore : resultGame && resultGame.finalAway,
    home_score: known(homeScore) ? homeScore : resultGame && resultGame.finalHome,
    moneyline_result: resultGame && resultGame.mlResult,
    void_reason: resultGame && resultGame.voidReason
  };
}

function mapBullpen(game) {
  const bullpen = game.bullpen || {};
  if (!bullpen.pick_team || !bullpen.opponent) return { away: null, home: null };
  if (game.pick_team === game.away_team) return { away: bullpen.pick_team, home: bullpen.opponent };
  if (game.pick_team === game.home_team) return { away: bullpen.opponent, home: bullpen.pick_team };
  return { away: null, home: null };
}

function decisionLabel(status) {
  if (status === "official_pick") return "Official Pick";
  if (status === "value_watch") return "Value Watch";
  if (status === "watchlist") return "Watchlist";
  return "Pass";
}

function decisionClass(status) {
  if (status === "official_pick") return "official";
  if (status === "pass") return "pass";
  return "watch";
}

function decisionHeadline(game) {
  if (game.status === "pass") return `LyDia decision: Pass on ${shortTeam(game.away_team)} vs ${shortTeam(game.home_team)}`;
  return `LyDia prediction: ${game.pick_team} moneyline`;
}

function decisionExplanation(game) {
  if (typeof game.read === "string" && game.read.trim()) return game.read.trim();
  if (game.status === "pass" && game.pass_reason) return game.pass_reason;
  const gate = game.official_pick_gate || {};
  const failed = [];
  if (gate.model_probability_passed === false) failed.push(`model probability is below ${pct(gate.minimum_model_probability)}`);
  if (gate.lab_score_passed === false) failed.push(`Lab Rating is below ${rating(gate.minimum_lab_score)}`);
  if (gate.edge_passed === false) failed.push(`model edge is below ${pct(gate.minimum_edge)}`);
  if (failed.length) return `${game.pick_team} does not qualify as an official pick because ${failed.join(" and ")}.`;
  return `${game.pick_team || "This matchup"} does not clear every LyDia official-pick requirement.`;
}


/* ---------- Insight engine: turn the metric soup into an argument ---------- */
function pickSideBullpen(game) {
  const bullpen = game.bullpen || {};
  return { pick: bullpen.pick_team || null, opp: bullpen.opponent || null };
}
function riskOf(side) {
  if (!side) return null;
  const value = side.risk_index ?? side.score;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function pickOffense(game) {
  const offense = game.offense_form || {};
  if (game.pick_team === game.away_team) return { pick: offense.away || null, opp: offense.home || null };
  if (game.pick_team === game.home_team) return { pick: offense.home || null, opp: offense.away || null };
  return { pick: null, opp: null };
}
function buildInsights(game, pitcherGame) {
  const market = game.market || {};
  const gate = game.official_pick_gate || {};
  const pitcher = pitcherGame || {};
  const pens = pickSideBullpen(game);
  const off = pickOffense(game);
  const pickRisk = riskOf(pens.pick);
  const oppRisk = riskOf(pens.opp);
  const caseFor = [];
  const concerns = [];

  if (typeof game.edge === "number" && game.edge >= 0.03 && known(market.no_vig_probability)) {
    caseFor.push({ title: `Market mispricing: ${signedPct(game.edge)}`, detail: `LyDia makes ${game.pick_team} ${pct(game.model_probability)} to win. The no-vig market says ${pct(market.no_vig_probability)}. That gap is the entire reason this game is on the board.` });
  }
  if (pitcher.edge_team && pitcher.edge_team === game.pick_team && Number(pitcher.gap) >= 8) {
    caseFor.push({ title: `Starting pitcher edge: ${pitcher.gap} points`, detail: `${pitcher.edge_team} sends the clearly better starter by LyDia's pitcher score. Gaps this size are one of the model's strongest inputs.` });
  }
  if (pickRisk !== null && oppRisk !== null && oppRisk - pickRisk >= 15) {
    caseFor.push({ title: `Late-inning bullpen advantage`, detail: `${game.pick_team}'s pen carries ${ (pickRisk/10).toFixed(1) }/10 risk against ${ (oppRisk/10).toFixed(1) }/10 for the other side. If this is close after six, the risk profile favors the pick.` });
  }
  if (off.pick && typeof off.pick.delta_ops === "number" && off.pick.delta_ops >= 0.03) {
    caseFor.push({ title: `Bats are hot: ${signedDecimal(off.pick.delta_ops, 3)} OPS`, detail: `${game.pick_team} is outhitting its own season form over the last 15 days. Recent form is context, not a model input, but it points the same way here.` });
  }

  if (gate.model_probability_passed === false) {
    concerns.push({ title: `Below the ${pct(gate.minimum_model_probability)} official gate`, detail: `Win probability is ${pct(game.model_probability)}. LyDia does not make a game official below ${pct(gate.minimum_model_probability)}, no matter how good the price is. This is a value spot, not a high-confidence winner.` });
  }
  if (gate.lab_score_passed === false) {
    concerns.push({ title: `Setup quality below the bar`, detail: `Lab Rating is ${rating(game.lab_score)}, under the ${rating(gate.minimum_lab_score)} required for an official pick.` });
  }
  if (gate.edge_passed === false) {
    concerns.push({ title: `Not enough market edge`, detail: `The model and the market are too close for the price to matter.` });
  }
  if (pitcher.edge_team && pitcher.edge_team !== game.pick_team && pitcher.edge_team !== "No clear SP edge" && Number(pitcher.gap) >= 8) {
    concerns.push({ title: `Pitcher edge points the other way`, detail: `${pitcher.edge_team} has the better starter by ${pitcher.gap} points, and that is not the side the model likes. When the model and the mound disagree, tread carefully.` });
  }
  if (pickRisk !== null && pickRisk >= 60) {
    concerns.push({ title: `Own bullpen carries risk: ${(pickRisk/10).toFixed(1)}/10`, detail: `${game.pick_team}'s pen comes in ${pens.pick && pens.pick.risk_label ? String(pens.pick.risk_label).toLowerCase() : "elevated"}. A lead after six innings is less safe than usual.` });
  }
  if (off.opp && typeof off.opp.delta_ops === "number" && off.opp.delta_ops >= 0.05) {
    concerns.push({ title: `Opponent is swinging it`, detail: `The other lineup is ${signedDecimal(off.opp.delta_ops, 3)} OPS above its season form over the last 15 days.` });
  }
  if (off.pick && typeof off.pick.delta_ops === "number" && off.pick.delta_ops <= -0.03) {
    concerns.push({ title: `Cold stretch at the plate`, detail: `${game.pick_team} is ${signedDecimal(off.pick.delta_ops, 3)} OPS below its own season form.` });
  }

  let verdict;
  if (game.status === "official_pick") {
    verdict = `LyDia backs ${game.pick_team} at ${odds(market.best_price)}. ${pct(game.model_probability)} to win against a market implying ${pct(market.no_vig_probability)} - the model sees value and the setup clears every gate.`;
  } else if (game.status === "value_watch") {
    const lead = concerns.length ? concerns[0].title.charAt(0).toLowerCase() + concerns[0].title.slice(1) : "the stricter official review";
    verdict = `Real value, not an official bet. The ${signedPct(game.edge)} edge on ${game.pick_team} is genuine, but ${lead}. If you play it, you are taking on risk LyDia's official card will not.`;
  } else if (game.status === "watchlist") {
    verdict = `Worth monitoring, nothing more. The setup has pieces but does not add up to a bet at today's price.`;
  } else {
    verdict = game.pass_reason ? `LyDia passes. ${game.pass_reason}` : `LyDia passes. Nothing about this matchup clears the bar, and passing is a position.`;
  }

  return { caseFor: caseFor.slice(0, 3), concerns: concerns.slice(0, 3), verdict };
}

function renderInsights(game, pitcherGame) {
  const insights = buildInsights(game, pitcherGame);
  const forCards = insights.caseFor.map(item => `<div class="callout for"><div class="co-title">${esc(item.title)}</div><div class="co-detail">${esc(item.detail)}</div></div>`).join("");
  const conCards = insights.concerns.map(item => `<div class="callout against"><div class="co-title">${esc(item.title)}</div><div class="co-detail">${esc(item.detail)}</div></div>`).join("");
  return `
    ${insights.caseFor.length ? `<h3 class="co-head for">The case for ${esc(game.pick_team || "this side")}</h3><div class="callout-grid">${forCards}</div>` : ""}
    ${insights.concerns.length ? `<h3 class="co-head against">${game.status === "official_pick" ? "What to watch" : "Why it is not official"}</h3><div class="callout-grid">${conCards}</div>` : ""}
    <div class="verdict"><span class="v-label">The verdict</span> ${esc(insights.verdict)}</div>`;
}

/* ---------- Probability bar: model vs market, one glance ---------- */
function renderEdgeBar(game) {
  const market = game.market || {};
  if (!known(game.model_probability) || !known(market.no_vig_probability)) return "";
  const model = Math.max(0, Math.min(100, game.model_probability * 100));
  const mkt = Math.max(0, Math.min(100, market.no_vig_probability * 100));
  return `<div class="edgebar">
    <div class="eb-row"><span class="eb-name">LyDia model</span><div class="eb-track"><div class="eb-fill model" style="width:${model.toFixed(1)}%"></div></div><span class="eb-val">${pct(game.model_probability)}</span></div>
    <div class="eb-row"><span class="eb-name">Market</span><div class="eb-track"><div class="eb-fill mkt" style="width:${mkt.toFixed(1)}%"></div></div><span class="eb-val">${pct(market.no_vig_probability)}</span></div>
  </div>`;
}

/* ---------- Bullpen gauges ---------- */
function gaugeColor(score) {
  if (score >= 82) return "var(--bad)";
  if (score >= 62) return "#e08726";
  if (score < 35) return "var(--good)";
  return "var(--accent2)";
}
function renderGauge(label, score, text, higherIsBetter) {
  if (typeof score !== "number") return "";
  const width = Math.max(2, Math.min(100, score));
  const color = gaugeColor(higherIsBetter ? 100 - score : score);
  return `<div class="gauge-row"><span class="g-label">${esc(label)}</span><div class="g-track"><div class="g-fill" style="width:${width}%;background:${color}"></div></div><span class="g-val">${(score/10).toFixed(1)}${text ? ` ${esc(text)}` : ""}</span></div>`;
}

/* ---------- The mini Map: every team on today\'s slate, two axes ---------- */
function teamWinPct(record) {
  const match = /^(\d+)-(\d+)$/.exec(String(record || "").trim());
  if (!match) return null;
  const wins = Number(match[1]), losses = Number(match[2]);
  return wins + losses > 0 ? wins / (wins + losses) : null;
}
function renderTeamMap(brief, game, teamHitting) {
  const hit = teamHitting || { season: {}, recent: {}, recentDetail: {}, standings: {} };
  const standings = hit.standings || {};
  const recentDetail = hit.recentDetail || {};
  const teams = [];
  const push = (team, record, off, pen) => {
    if (!team || teams.some(t => t.team === team)) return;
    const standing = standings[team] || standings[shortTeam(team)] || {};
    const detail = recentDetail[team] || {};
    teams.push({
      team,
      short: shortTeam(team),
      wpct: teamWinPct(record),
      run_diff_pg: typeof standing.run_diff_pg === "number" ? standing.run_diff_pg : null,
      rs_pg: typeof standing.rs_pg === "number" ? standing.rs_pg : null,
      ra_pg: typeof standing.ra_pg === "number" ? standing.ra_pg : null,
      delta_ops: off && typeof off.delta_ops === "number" ? off.delta_ops : null,
      ops_15d: off && typeof off.ops_15d === "number" ? off.ops_15d : null,
      rpg_15d: off && typeof off.rpg_15d === "number" ? off.rpg_15d : null,
      hr_pg: typeof detail.hr_pg === "number" ? detail.hr_pg : null,
      risk: riskOf(pen),
      kpct_15d: typeof hit.recent[team] === "number" ? hit.recent[team] : null
    });
  };
  for (const row of brief.games || []) {
    const offense = row.offense_form || {};
    const pens = { away: null, home: null };
    const bullpen = row.bullpen || {};
    if (bullpen.pick_team && bullpen.opponent) {
      if (row.pick_team === row.away_team) { pens.away = bullpen.pick_team; pens.home = bullpen.opponent; }
      else if (row.pick_team === row.home_team) { pens.home = bullpen.pick_team; pens.away = bullpen.opponent; }
    }
    push(row.away_team, row.away_record, offense.away, pens.away);
    push(row.home_team, row.home_record, offense.home, pens.home);
  }
  const usable = teams.filter(t => typeof t.wpct === "number");
  if (usable.length < 8) return "";

  // Axes a bettor would actually cross-reference. Run differential is the
  // cleanest single measure of team quality. Runs allowed is run prevention.
  // The recent windows separate what a team IS from what it is doing lately.
  const axes = [
    ["run_diff_pg", "Run differential per game", "sdec2"],
    ["ra_pg", "Runs allowed per game", "dec2"],
    ["rs_pg", "Runs scored per game", "dec2"],
    ["wpct", "Win %", "pct"],
    ["rpg_15d", "Runs per game, last 15", "dec1"],
    ["ops_15d", "OPS, last 15 days", "dec3"],
    ["delta_ops", "OPS vs own season form", "delta3"],
    ["hr_pg", "Home runs per game, last 15", "dec2"],
    ["kpct_15d", "K% last 15 days", "pct"],
    ["risk", "Bullpen risk", "score10"]
  ].filter(([key]) => teams.filter(t => typeof t[key] === "number").length >= 8);
  if (axes.length < 2) return "";

  const payload = { teams, away: game.away_team, home: game.home_team, axes };
  const options = axes.map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join("");

  return `<section class="card">
    <div class="sec-head"><h2>The Map</h2><a class="tool-link" href="/stats/">Full interactive map &rarr;</a></div>
    <p class="small dim" style="margin-top:0">Every team on today's slate, on any two axes you pick. <span style="color:var(--accent2);font-weight:700">${esc(shortTeam(game.away_team))}</span> and <span style="color:var(--good);font-weight:700">${esc(shortTeam(game.home_team))}</span> are highlighted.</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px">
      <label class="small dim">Horizontal <select id="map-x" onchange="drawMatchupMap()">${options}</select></label>
      <label class="small dim">Vertical <select id="map-y" onchange="drawMatchupMap()">${options}</select></label>
    </div>
    <div id="matchup-map"></div>
    <script type="application/json" id="map-data">${jsonScript(payload)}</script>
    <script>
    (function () {
      const data = JSON.parse(document.getElementById("map-data").textContent);
      const fmts = {
        pct: v => (v * 100).toFixed(1) + "%",
        delta3: v => (v >= 0 ? "+" : "") + v.toFixed(3),
        sdec2: v => (v >= 0 ? "+" : "") + v.toFixed(2),
        dec3: v => v.toFixed(3),
        dec2: v => v.toFixed(2),
        dec1: v => v.toFixed(1),
        score10: v => (v / 10).toFixed(1) + "/10"
      };
      const selX = document.getElementById("map-x");
      const selY = document.getElementById("map-y");
      const has = key => data.axes.some(a => a[0] === key);
      selX.value = has("run_diff_pg") ? "run_diff_pg" : "wpct";
      selY.value = has("delta_ops") ? "delta_ops" : data.axes[0][0];
      window.drawMatchupMap = function () {
        const xKey = selX.value, yKey = selY.value;
        const xAxis = data.axes.find(a => a[0] === xKey), yAxis = data.axes.find(a => a[0] === yKey);
        const pts = data.teams.filter(t => typeof t[xKey] === "number" && typeof t[yKey] === "number");
        if (pts.length < 4) { document.getElementById("matchup-map").innerHTML = '<p class="small dim">Not enough data for this pair of axes today.</p>'; return; }
        const W = 720, H = 400, PL = 56, PR = 20, PT = 24, PB = 46;
        const xs = pts.map(t => t[xKey]), ys = pts.map(t => t[yKey]);
        const xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
        const yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
        const xPad = (xMax - xMin || 1) * 0.06, yPad = (yMax - yMin || 1) * 0.1;
        const X = v => PL + (v - xMin + xPad) / ((xMax - xMin) + 2 * xPad) * (W - PL - PR);
        const Y = v => PT + (yMax + yPad - v) / ((yMax - yMin) + 2 * yPad) * (H - PT - PB);
        const xMid = (xMin + xMax) / 2, yMid = (yMin + yMax) / 2;
        let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" role="img">';
        svg += '<line x1="' + PL + '" y1="' + Y(yMid).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(yMid).toFixed(1) + '" stroke="var(--border)" stroke-dasharray="4 4"/>';
        svg += '<line x1="' + X(xMid).toFixed(1) + '" y1="' + PT + '" x2="' + X(xMid).toFixed(1) + '" y2="' + (H - PB) + '" stroke="var(--border)" stroke-dasharray="4 4"/>';
        for (const t of pts) {
          const cx = X(t[xKey]).toFixed(1), cy = Y(t[yKey]).toFixed(1);
          const isAway = t.team === data.away, isHome = t.team === data.home;
          if (!isAway && !isHome) {
            svg += '<circle cx="' + cx + '" cy="' + cy + '" r="5" fill="var(--text-dim)" opacity="0.35"><title>' + t.short + ": " + fmts[xAxis[2]](t[xKey]) + " / " + fmts[yAxis[2]](t[yKey]) + '</title></circle>';
          } else {
            const color = isAway ? "var(--accent2)" : "var(--good)";
            const anchor = Number(cx) > W - 130 ? "end" : "start";
            const dx = anchor === "end" ? -10 : 10;
            svg += '<circle cx="' + cx + '" cy="' + cy + '" r="8" fill="' + color + '"/>';
            svg += '<text x="' + (Number(cx) + dx).toFixed(1) + '" y="' + (Number(cy) + 4).toFixed(1) + '" text-anchor="' + anchor + '" font-size="13" font-weight="800" fill="' + color + '">' + t.short + " (" + fmts[xAxis[2]](t[xKey]) + ", " + fmts[yAxis[2]](t[yKey]) + ")</text>";
          }
        }
        svg += '<text x="' + (W - PR) + '" y="' + (H - 8) + '" text-anchor="end" font-size="11" fill="var(--text-dim)">Higher ' + xAxis[1] + ' &#8594;</text>';
        svg += '<text x="16" y="' + PT + '" font-size="11" fill="var(--text-dim)" transform="rotate(-90 16 ' + PT + ')" text-anchor="end">Higher ' + yAxis[1] + ' &#8594;</text>';
        svg += "</svg>";
        document.getElementById("matchup-map").innerHTML = svg;
      };
      drawMatchupMap();
    })();
    </script>
  </section>`;
}

function renderMatchupPage(context) {
  const { brief, game, scheduleGame, totalsGame, pitcherGame, resultGame, weather, venue, quality, slug, urlPath, kprops, teamHitting, gameNumber } = context;
  const dhSuffix = gameNumber ? ` (Game ${gameNumber})` : "";
  const awayShort = shortTeam(game.away_team);
  const homeShort = shortTeam(game.home_team);
  const titleDate = niceDate(DATE);
  const title = `${awayShort} vs ${homeShort}${dhSuffix} Prediction, Odds and Model Pick | ${DATE}`;
  const description = `${awayShort} vs ${homeShort} prediction for ${titleDate}: LyDia model probability, moneyline odds, starting pitchers, offense form, bullpen risk, Lab Rating and pass or pick decision.`;
  const canonical = `${SITE}${urlPath}`;
  const robots = quality.indexable ? "index,follow,max-image-preview:large" : "noindex,follow";
  const pitcher = pitcherGame || {};
  const market = game.market || {};
  const bullpen = mapBullpen(game);
  const offense = game.offense_form || {};
  const generatedAt = brief.generated_at || new Date().toISOString();
  const gameTime = game.game_time_iso || (scheduleGame && scheduleGame.gameDate);
  const final = finalSummary(scheduleGame, resultGame);
  const relatedPreview = `/previews/${DATE}.html`;

  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": `${canonical}#article`,
    headline: title,
    description,
    url: canonical,
    datePublished: generatedAt,
    dateModified: new Date().toISOString(),
    author: { "@type": "Person", "@id": AUTHOR_ID, name: "Lynold Mercado", url: AUTHOR_URL },
    publisher: { "@type": "Organization", "@id": `${SITE}/#organization`, name: "LyDia", url: `${SITE}/` },
    mainEntityOfPage: canonical,
    isAccessibleForFree: true,
    about: { "@id": `${canonical}#event` }
  };

  const eventSchema = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    "@id": `${canonical}#event`,
    name: `${game.away_team} at ${game.home_team}${dhSuffix}`,
    startDate: gameTime || DATE,
    eventStatus: eventStatusSchema(scheduleGame),
    location: { "@type": "Place", name: venue.name },
    competitor: [
      { "@type": "SportsTeam", name: game.away_team },
      { "@type": "SportsTeam", name: game.home_team }
    ],
    url: canonical
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="LyDia">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${SITE}/img/og-card.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:creator" content="@Kid_lynold">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}/img/og-card.png">
<link rel="stylesheet" href="/css/style.css">
<style>
.matchup-head{margin-bottom:18px}.matchup-head h1{margin-bottom:6px}.byline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.byline img{width:42px;height:42px;border-radius:50%;object-fit:cover;border:1px solid var(--border)}.status-badge{display:inline-block;color:#fff;font-size:.76rem;font-weight:800;padding:4px 10px;border-radius:20px;background:var(--accent2)}.status-badge.official{background:var(--good)}.status-badge.pass{background:var(--text-dim)}.status-badge.watch{background:var(--accent2)}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin:14px 0}.metric{background:var(--bg-elev);border:1px solid var(--border);border-radius:var(--radius);padding:12px}.metric .label{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)}.metric .value{font-size:1.15rem;font-weight:800;margin-top:2px}.matchup-table{width:100%;border-collapse:collapse;font-size:.88rem}.matchup-table th,.matchup-table td{padding:8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}.matchup-table th:not(:first-child),.matchup-table td:not(:first-child){text-align:right}.section-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.decision-card{border-color:var(--accent2)}.decision-card.official{border-color:var(--good)}.quality-list{columns:2;column-gap:24px}.quality-list li{break-inside:avoid;margin-bottom:5px}.result-win{border-color:var(--good)}.result-loss{border-color:var(--bad)}.sec-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}.sec-head h2{margin-bottom:6px}.tool-link{font-size:.82rem;font-weight:700;white-space:nowrap}.co-head{margin:16px 0 8px;font-size:.95rem}.co-head.for{color:var(--good)}.co-head.against{color:#e08726}.callout-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}.callout{border:1px solid var(--border);border-left:4px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg-elev)}.callout.for{border-left-color:var(--good)}.callout.against{border-left-color:#e08726}.co-title{font-weight:800;margin-bottom:4px}.co-detail{font-size:.86rem;color:var(--text);line-height:1.5}.verdict{margin-top:14px;padding:14px;border:1px solid var(--accent2);border-radius:var(--radius);background:var(--bg-elev);font-size:.95rem;line-height:1.55}.verdict .v-label{display:inline-block;font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--accent2);margin-right:8px}.full-read summary{cursor:pointer;font-weight:700;color:var(--text-dim);font-size:.85rem;margin-top:12px}.full-read p{font-size:.86rem;color:var(--text-dim);line-height:1.55}.edgebar{margin:12px 0 4px}.eb-row{display:flex;align-items:center;gap:10px;margin:6px 0}.eb-name{width:92px;font-size:.78rem;color:var(--text-dim);text-align:right}.eb-track{flex:1;height:14px;background:var(--bg-elev);border:1px solid var(--border);border-radius:7px;overflow:hidden}.eb-fill{height:100%;border-radius:7px}.eb-fill.model{background:var(--accent2)}.eb-fill.mkt{background:var(--text-dim)}.eb-val{width:56px;font-size:.82rem;font-weight:800;font-variant-numeric:tabular-nums}.gauge-row{display:flex;align-items:center;gap:10px;margin:6px 0}.g-label{width:120px;font-size:.78rem;color:var(--text-dim);text-align:right}.g-track{flex:1;height:11px;background:var(--bg-elev);border:1px solid var(--border);border-radius:6px;overflow:hidden}.g-fill{height:100%;border-radius:6px}.g-val{width:110px;font-size:.8rem;font-weight:700;font-variant-numeric:tabular-nums}.pen-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:10px}.pen-side{background:var(--bg-elev);border:1px solid var(--border);border-radius:var(--radius);padding:12px}.pen-side b{display:block;margin-bottom:6px}.adv{color:var(--good);font-weight:800}.k-lean{font-size:.98rem;font-weight:800;margin:6px 0 4px;padding:5px 10px;border-radius:6px;display:inline-block}.k-lean.over{background:rgba(30,142,62,.12);color:var(--good)}.k-lean.under{background:rgba(207,34,46,.10);color:var(--bad)}.k-lean.flat{background:var(--bg-card);color:var(--text-dim);font-weight:700}@media(max-width:640px){.quality-list{columns:1}.matchup-table{font-size:.8rem}.matchup-table th,.matchup-table td{padding:6px 4px}}
</style>
<script type="application/ld+json">${jsonScript(articleSchema)}</script>
<script type="application/ld+json">${jsonScript(eventSchema)}</script>
</head>
<body>
<nav id="nav"></nav>
<main>
  <div class="matchup-head">
    <p class="eyebrow">MLB matchup analysis</p>
    <h1>${esc(awayShort)} vs ${esc(homeShort)}${esc(dhSuffix)} Prediction, Odds and Model Pick</h1>
    <p class="subtitle">${esc(titleDate)} at ${esc(venue.name)}${game.time ? ` · ${esc(game.time)} ET` : ""}</p>
    <div class="byline">
      <img src="/img/lynold-mercado-headshot.jpg" alt="Lynold Mercado">
      <div class="small"><strong><a href="/writers/lynold/">Lynold Mercado</a></strong><br><span class="dim">Founder and Model Developer · Updated ${esc(prettyDateTime(generatedAt))}</span></div>
    </div>
  </div>

  ${quality.indexable ? "" : renderQualityNotice(quality)}

  <section class="card decision-card ${decisionClass(game.status)}">
    <span class="status-badge ${decisionClass(game.status)}">${esc(decisionLabel(game.status))}</span>
    <h2>${esc(decisionHeadline(game))}</h2>
    <div class="metric-grid">
      <div class="metric"><div class="label">Lab Rating</div><div class="value">${esc(rating(game.lab_score))}</div></div>
      <div class="metric"><div class="label">Model probability</div><div class="value">${esc(pct(game.model_probability))}</div></div>
      <div class="metric"><div class="label">Market probability</div><div class="value">${esc(pct(market.no_vig_probability))}</div></div>
      <div class="metric"><div class="label">Model edge</div><div class="value">${esc(signedPct(game.edge))}</div></div>
      <div class="metric"><div class="label">Best moneyline</div><div class="value">${esc(odds(market.best_price))}</div></div>
      <div class="metric"><div class="label">Sportsbooks checked</div><div class="value">${esc(known(market.books) ? market.books : "Not available")}</div></div>
    </div>
    ${renderEdgeBar(game)}
    ${renderInsights(game, pitcherGame)}
    <details class="full-read"><summary>Read the full model output</summary><p>${esc(decisionExplanation(game))}</p></details>
  </section>

  ${renderFinal(final, game)}

  <section class="card">
    <h2>Game information</h2>
    <table class="matchup-table">
      <tbody>
        <tr><th>Matchup</th><td>${esc(game.away_team)} at ${esc(game.home_team)}</td></tr>
        <tr><th>Date</th><td>${esc(titleDate)}</td></tr>
        <tr><th>First pitch</th><td>${esc(game.time ? `${game.time} ET` : prettyDateTime(gameTime) || "Not confirmed")}</td></tr>
        <tr><th>Venue</th><td>${esc(venue.name)}</td></tr>
        <tr><th>Starting pitchers</th><td>${esc((pitcher.away && pitcher.away.name) || "TBD")} vs ${esc((pitcher.home && pitcher.home.name) || "TBD")}</td></tr>
        <tr><th>Weather</th><td>${esc(weatherText(weather, venue))}</td></tr>
      </tbody>
    </table>
  </section>

  <section class="card">
    <div class="sec-head"><h2>Starting pitcher matchup</h2><a class="tool-link" href="/tools/pitcher-matchups/">Full Pitcher Matchup Tool &rarr;</a></div>
    ${renderPitcherTable(game, pitcherGame)}
    ${renderStrikeoutProjections(game, pitcherGame, kprops)}
    <p class="small dim">Same data source as the <a href="/tools/pitcher-matchups/">Pitcher Matchup Tool</a>, where every starter on the slate is compared side by side.</p>
  </section>

  <section class="card">
    <div class="sec-head"><h2>Offense and recent form</h2><a class="tool-link" href="/stats/">Full Stats page &rarr;</a></div>
    ${renderOffenseTable(game, teamHitting)}
    <p class="small dim">Season and 15-day splits for all 30 teams live on the <a href="/stats/">Stats page</a>, including hot and cold streaks and the run environment table.</p>
  </section>

  ${renderTeamMap(brief, game, teamHitting)}

  <section class="card">
    <div class="sec-head"><h2>Bullpen matchup</h2><a class="tool-link" href="/tools/bullpen-fatigue/">Full Bullpen Fatigue Index &rarr;</a></div>
    ${renderBullpenGauges(game, bullpen)}
    ${renderBullpenTable(game, bullpen)}
    <p class="small dim">Fatigue measures workload. Efficiency measures recent run prevention. Combined risk is what the moneyline and totals systems use.</p>
  </section>

  ${renderTotals(totalsGame)}

  <section class="card">
    <h2>What could change the prediction</h2>
    <ul>
      <li>A listed starting pitcher is scratched or replaced.</li>
      <li>The moneyline moves enough to remove the current model edge.</li>
      <li>A confirmed lineup materially changes the offensive matchup.</li>
      <li>Late bullpen availability differs from the recent workload data.</li>
      <li>Weather or roof conditions change before first pitch.</li>
    </ul>
  </section>

  <div class="lead-box">
    <h3 style="margin:0 0 4px">Get tomorrow's MLB model card free</h3>
    <p class="dim small" style="margin:0">One email each morning with the featured game and the previous day's graded result.</p>
    <form name="newsletter" method="POST" data-netlify="true" netlify-honeypot="bot-field" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <p style="display:none"><input name="bot-field"></p>
      <input type="hidden" name="form-name" value="newsletter">
      <input type="email" name="email" required placeholder="you@example.com" style="flex:1;min-width:200px">
      <button type="submit" class="secondary">Subscribe free</button>
    </form>
  </div>

  <div class="lead-box" style="border-color:var(--accent2);margin-top:14px">
    <h3 style="margin:0 0 4px">Open the full LyDia card</h3>
    <p class="dim small" style="margin:0">See every official pick, value watch, watchlist and pass from this slate.</p>
    <p style="margin-top:10px"><a class="btn blue" href="/picks/">Today's picks</a> <a class="btn secondary" href="${relatedPreview}">Full daily preview</a></p>
  </div>

  <p class="small dim" style="margin-top:18px">Model outputs are not guarantees. LyDia provides analysis and education only. Every official pick remains visible on the <a href="/results/">Results page</a>. 21+. If you or someone you know has a gambling problem, call 1-800-GAMBLER.</p>
</main>
<footer id="footer"></footer>
<script src="/js/app.js"></script>
<script>renderNav("/picks/"); renderFooter();</script>
</body>
</html>`;
}

function renderQualityNotice(quality) {
  const labels = quality.missing.map(key => key.replace(/_/g, " "));
  return `<div class="notice" style="margin-bottom:16px"><strong>Analysis still building.</strong> This page is available to users but is not submitted for search indexing until these inputs are complete: ${esc(labels.join(", "))}.</div>`;
}

function renderPitcherTable(game, pitcherGame) {
  const p = pitcherGame || {};
  const away = p.away || {};
  const home = p.home || {};
  const awayIpStart = oneDecimal(away.ipStart);
  const homeIpStart = oneDecimal(home.ipStart);

  // Every stat declares its direction and a materiality threshold. A cell only
  // lights up when the gap actually matters, so a 2-run ERA edge is called out
  // and a 0.1 K/9 difference is not.
  const rows = [
    { label: "LyDia pitcher score", a: away.score, h: home.score, better: "high", gap: 8, fmt: v => String(v) },
    { label: "ERA", a: away.era, h: home.era, better: "low", gap: 0.5, fmt: v => v.toFixed(2) },
    { label: "WHIP", a: away.whip, h: home.whip, better: "low", gap: 0.15, fmt: v => v.toFixed(2) },
    { label: "K/9", a: away.k9, h: home.k9, better: "high", gap: 1.0, fmt: v => v.toFixed(1) },
    { label: "BB/9", a: away.bb9, h: home.bb9, better: "low", gap: 1.0, fmt: v => v.toFixed(1) },
    { label: "K-BB%", a: away.kbbPct, h: home.kbbPct, better: "high", gap: 0.04, fmt: v => (v * 100).toFixed(1) + "%" },
    { label: "HR/9", a: away.hr9, h: home.hr9, better: "low", gap: 0.4, fmt: v => v.toFixed(1) },
    { label: "Ground-ball rate", a: away.gbPct, h: home.gbPct, better: null, gap: 0, fmt: v => (v * 100).toFixed(1) + "%" },
    { label: "IP per start", a: away.ipStart, h: home.ipStart, better: "high", gap: 0.6, fmt: v => v.toFixed(1) }
  ];

  const dirTag = better => better === "low" ? ' <span class="dim" style="font-weight:400">(lower is better)</span>'
    : better === "high" ? ' <span class="dim" style="font-weight:400">(higher is better)</span>' : "";
  const cellPair = row => {
    const bothNumbers = typeof row.a === "number" && typeof row.h === "number";
    let advAway = "", advHome = "";
    if (bothNumbers && row.better && Math.abs(row.a - row.h) >= row.gap) {
      const awayWins = row.better === "high" ? row.a > row.h : row.a < row.h;
      if (awayWins) advAway = "adv"; else advHome = "adv";
    }
    const show = v => typeof v === "number" ? row.fmt(v) : "Not available";
    return `<td class="${advAway}">${esc(show(row.a))}</td><td class="${advHome}">${esc(show(row.h))}</td>`;
  };

  return `<table class="matchup-table" data-pitcher-source="${esc(p.source_version || "pitcher-matchup-core-v1")}" data-away-ip-start="${esc(awayIpStart)}" data-home-ip-start="${esc(homeIpStart)}">
    <thead><tr><th>Metric</th><th>${esc(shortTeam(game.away_team))}</th><th>${esc(shortTeam(game.home_team))}</th></tr></thead>
    <tbody>
      <tr><th>Probable pitcher</th><td>${esc(away.name || "TBD")}</td><td>${esc(home.name || "TBD")}</td></tr>
      <tr><th>Throws</th><td>${esc(away.hand || "Not available")}</td><td>${esc(home.hand || "Not available")}</td></tr>
      ${rows.map(row => `<tr><th>${esc(row.label)}${dirTag(row.better)}</th>${cellPair(row)}</tr>`).join("\n      ")}
    </tbody>
  </table>
  <p><strong>Pitcher edge:</strong> ${esc(p.edge_team || "No clear starting pitcher edge")}${p.gap ? ` by ${esc(p.gap)} points` : ""}.</p>
  <p class="small dim"><strong>How to read this:</strong> highlighted cells mark a gap big enough to matter, not just any difference. K-BB% is strikeouts minus walks per batter faced, one of the most predictive skill stats in pitching. HR/9 is home runs allowed per nine innings. Ground-ball rate is neither good nor bad on its own: high ground-ball pitchers trade strikeouts for double plays and fewer home runs.</p>`;
}

function kpropFor(kprops, name) {
  if (!kprops || !kprops.pitchers || !name) return null;
  return kprops.pitchers[String(name).trim().toLowerCase()] || null;
}
function renderStrikeoutProjections(game, pitcherGame, kprops) {
  const p = pitcherGame || {};
  const rows = [
    { team: game.away_team, pitcher: p.away },
    { team: game.home_team, pitcher: p.home }
  ].map(entry => ({ ...entry, prop: kpropFor(kprops, entry.pitcher && entry.pitcher.name) }))
   .filter(entry => entry.prop);
  if (!rows.length) return "";
  const cells = rows.map(entry => {
    const prop = entry.prop;
    const hasLine = typeof prop.line === "number";
    const lean = hasLine && typeof prop.projection === "number" ? prop.projection - prop.line : null;
    let leanHtml = "";
    if (lean !== null && Math.abs(lean) >= 0.3) {
      leanHtml = `<div class="k-lean ${lean > 0 ? "over" : "under"}">LyDia leans ${lean > 0 ? "OVER" : "UNDER"} ${esc(oneDecimal(prop.line))}K by ${Math.abs(lean).toFixed(1)}</div>`;
    } else if (lean !== null) {
      leanHtml = `<div class="k-lean flat">Model and market agree</div>`;
    }
    const marketLine = hasLine
      ? `Market ${esc(oneDecimal(prop.line))}K &middot; O ${esc(odds(prop.over))} / U ${esc(odds(prop.under))} &middot; ${esc(prop.books)} book${prop.books === 1 ? "" : "s"}`
      : `No strikeout line posted when this page was generated`;
    return `<div class="metric"><div class="label">${esc(entry.pitcher.name)} strikeouts</div><div class="value">${esc(oneDecimal(prop.projection))} <span class="dim small">projected</span></div>${leanHtml}<div class="small dim">${marketLine}</div></div>`;
  }).join("");
  return `<h3 style="margin:16px 0 4px">Strikeout projections <a class="tool-link" style="font-size:.78rem" href="/tools/strikeout-projections/">Full K board &rarr;</a></h3>
  <div class="metric-grid">${cells}</div>
  <p class="small dim">Projections are self-calibrated against graded results${kprops && kprops.learned_n ? ` (${esc(kprops.learned_n)} graded starts)` : ""}. Leans are context, not official picks.</p>`;
}

function renderOffenseTable(game, teamHitting) {
  const offense = game.offense_form || {};
  const away = offense.away || {};
  const home = offense.home || {};
  const hit = teamHitting || { season: {}, recent: {} };
  const awayKSeason = hit.season[game.away_team], homeKSeason = hit.season[game.home_team];
  const awayKRecent = hit.recent[game.away_team], homeKRecent = hit.recent[game.home_team];
  const kCell = (mine, theirs) => typeof mine === "number" && typeof theirs === "number" && mine < theirs ? "adv" : "";
  return `<table class="matchup-table">
    <thead><tr><th>Metric</th><th>${esc(shortTeam(game.away_team))}</th><th>${esc(shortTeam(game.home_team))}</th></tr></thead>
    <tbody>
      <tr><th>Record</th><td>${esc(game.away_record || "Not available")}</td><td>${esc(game.home_record || "Not available")}</td></tr>
      <tr><th>Last 10</th><td>${esc(game.away_l10 || "Not available")}</td><td>${esc(game.home_l10 || "Not available")}</td></tr>
      <tr><th>OPS, last 15 days</th><td class="${typeof away.ops_15d === "number" && typeof home.ops_15d === "number" && away.ops_15d > home.ops_15d ? "adv" : ""}">${esc(typeof away.ops_15d === "number" ? away.ops_15d.toFixed(3) : "Not available")}</td><td class="${typeof away.ops_15d === "number" && typeof home.ops_15d === "number" && home.ops_15d > away.ops_15d ? "adv" : ""}">${esc(typeof home.ops_15d === "number" ? home.ops_15d.toFixed(3) : "Not available")}</td></tr>
      <tr><th>Season OPS</th><td>${esc(typeof away.season_ops === "number" ? away.season_ops.toFixed(3) : "Not available")}</td><td>${esc(typeof home.season_ops === "number" ? home.season_ops.toFixed(3) : "Not available")}</td></tr>
      <tr><th>OPS change</th><td>${esc(typeof away.delta_ops === "number" ? signedDecimal(away.delta_ops, 3) : "Not available")}</td><td>${esc(typeof home.delta_ops === "number" ? signedDecimal(home.delta_ops, 3) : "Not available")}</td></tr>
      <tr><th>Runs per game, last 15 days</th><td>${esc(oneDecimal(away.rpg_15d))}</td><td>${esc(oneDecimal(home.rpg_15d))}</td></tr>
      <tr><th>K% season <span class="dim" style="font-weight:400">(lower is better)</span></th><td class="${kCell(awayKSeason, homeKSeason)}">${esc(pct(awayKSeason))}</td><td class="${kCell(homeKSeason, awayKSeason)}">${esc(pct(homeKSeason))}</td></tr>
      <tr><th>K% last 15 days</th><td class="${kCell(awayKRecent, homeKRecent)}">${esc(pct(awayKRecent))}</td><td class="${kCell(homeKRecent, awayKRecent)}">${esc(pct(homeKRecent))}</td></tr>
      <tr><th>OPS vs opposing hand</th><td>${esc(typeof away.ops_vs_opp_hand === "number" ? away.ops_vs_opp_hand.toFixed(3) : "Not available")}</td><td>${esc(typeof home.ops_vs_opp_hand === "number" ? home.ops_vs_opp_hand.toFixed(3) : "Not available")}</td></tr>
    </tbody>
  </table>`;
}

function signedDecimal(value, digits) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function renderBullpenGauges(game, bullpen) {
  const away = bullpen.away || {}, home = bullpen.home || {};
  const awayRisk = away.risk_index ?? away.score, homeRisk = home.risk_index ?? home.score;
  if (typeof awayRisk !== "number" && typeof homeRisk !== "number") return "";
  const side = (team, pen, risk) => `<div class="pen-side"><b>${esc(shortTeam(team))}</b>
    ${renderGauge("Combined risk", risk, pen.risk_label || "")}
    ${renderGauge("Fatigue", typeof pen.score === "number" ? pen.score : null, pen.label || "")}
    ${renderGauge("Efficiency", typeof pen.efficiency_score === "number" ? pen.efficiency_score : null, pen.efficiency_label || "", true)}
  </div>`;
  return `<div class="pen-pair">${side(game.away_team, away, awayRisk)}${side(game.home_team, home, homeRisk)}</div>
  <p class="small dim" style="margin-top:8px">Risk is what the model actually uses: fatigue blended with how well the pen has pitched. High fatigue with high efficiency is a tired pen that is still getting outs.</p>`;
}

function renderBullpenTable(game, bullpen) {
  const away = bullpen.away || {};
  const home = bullpen.home || {};
  return `<table class="matchup-table">
    <thead><tr><th>Metric</th><th>${esc(shortTeam(game.away_team))}</th><th>${esc(shortTeam(game.home_team))}</th></tr></thead>
    <tbody>
      <tr><th>Fatigue</th><td>${esc(scoreAndLabel(away.score, away.label))}</td><td>${esc(scoreAndLabel(home.score, home.label))}</td></tr>
      <tr><th>Efficiency</th><td>${esc(scoreAndLabel(away.efficiency_score, away.efficiency_label))}</td><td>${esc(scoreAndLabel(home.efficiency_score, home.efficiency_label))}</td></tr>
      <tr><th>Combined risk</th><td class="${typeof away.risk_index === "number" && typeof home.risk_index === "number" && away.risk_index < home.risk_index ? "adv" : ""}">${esc(scoreAndLabel(away.risk_index, away.risk_label))}</td><td class="${typeof away.risk_index === "number" && typeof home.risk_index === "number" && home.risk_index < away.risk_index ? "adv" : ""}">${esc(scoreAndLabel(home.risk_index, home.risk_label))}</td></tr>
      <tr><th>Relief innings, last 3 days</th><td>${esc(oneDecimal(away.last3_bp_ip))}</td><td>${esc(oneDecimal(home.last3_bp_ip))}</td></tr>
      <tr><th>Back-to-back arms</th><td>${esc(known(away.back_to_back_arms) ? away.back_to_back_arms : "Not available")}</td><td>${esc(known(home.back_to_back_arms) ? home.back_to_back_arms : "Not available")}</td></tr>
      <tr><th>3-day ERA</th><td>${esc(typeof away.era_3d === "number" ? away.era_3d.toFixed(2) : "Not available")}</td><td>${esc(typeof home.era_3d === "number" ? home.era_3d.toFixed(2) : "Not available")}</td></tr>
      <tr><th>3-day WHIP</th><td>${esc(typeof away.whip_3d === "number" ? away.whip_3d.toFixed(2) : "Not available")}</td><td>${esc(typeof home.whip_3d === "number" ? home.whip_3d.toFixed(2) : "Not available")}</td></tr>
    </tbody>
  </table>`;
}

function scoreAndLabel(score, label) {
  if (typeof score !== "number") return "Not available";
  return `${(score / 10).toFixed(1)}/10${label ? `, ${label}` : ""}`;
}

function renderTotals(total) {
  if (!total) return `<section class="card"><div class="sec-head"><h2>Run total projection</h2><a class="tool-link" href="/tools/totals-projections/">Full Totals Projections &rarr;</a></div><p>A verified LyDia totals projection was not available when this page was generated. Every game\'s projection lives on the <a href="/tools/totals-projections/">Totals Projections tool</a>.</p></section>`;
  const difference = typeof total.projection === "number" && typeof total.line === "number" ? total.projection - total.line : null;
  const context = difference === null
    ? "The current model and market total cannot be compared yet."
    : Math.abs(difference) < 0.5
      ? "The model and market are close."
      : `The model projects ${Math.abs(difference).toFixed(1)} runs ${difference > 0 ? "above" : "below"} the market total.`;
  return `<section class="card">
    <div class="sec-head"><h2>Run total projection</h2><a class="tool-link" href="/tools/totals-projections/">Full Totals Projections &rarr;</a></div>
    <div class="metric-grid">
      <div class="metric"><div class="label">LyDia projection</div><div class="value">${esc(oneDecimal(total.projection))}</div></div>
      <div class="metric"><div class="label">Market total</div><div class="value">${esc(oneDecimal(total.line))}</div></div>
      <div class="metric"><div class="label">Projected away runs</div><div class="value">${esc(oneDecimal(total.proj_away))}</div></div>
      <div class="metric"><div class="label">Projected home runs</div><div class="value">${esc(oneDecimal(total.proj_home))}</div></div>
      <div class="metric"><div class="label">Over price</div><div class="value">${esc(odds(total.over))}</div></div>
      <div class="metric"><div class="label">Under price</div><div class="value">${esc(odds(total.under))}</div></div>
    </div>
    <p>${esc(context)} This projection is matchup context, not an official total pick unless LyDia explicitly labels it as one.</p>
  </section>`;
}

function renderFinal(final, game) {
  if (!final) return "";
  const scoreKnown = known(final.away_score) && known(final.home_score);
  const result = final.moneyline_result || "NG";
  const resultText = result === "W" ? "Win" : result === "L" ? "Loss" : result === "VOID" ? "Void" : "Not graded";
  const css = result === "W" ? "result-win" : result === "L" ? "result-loss" : "";
  return `<section class="card ${css}">
    <h2>Final result</h2>
    <div class="metric-grid">
      <div class="metric"><div class="label">Final score</div><div class="value">${scoreKnown ? `${esc(shortTeam(game.away_team))} ${esc(final.away_score)}, ${esc(shortTeam(game.home_team))} ${esc(final.home_score)}` : "Score unavailable"}</div></div>
      <div class="metric"><div class="label">Official moneyline grade</div><div class="value">${esc(resultText)}</div></div>
    </div>
    ${final.void_reason ? `<p><strong>Void reason:</strong> ${esc(final.void_reason)}</p>` : ""}
    <p class="small dim">The pregame analysis remains on this URL. Postgame information is added without rewriting the original decision.</p>
  </section>`;
}

function eventStatusSchema(scheduleGame) {
  const state = scheduleGame && scheduleGame.status && scheduleGame.status.abstractGameState;
  if (state === "Final") return "https://schema.org/EventCompleted";
  if (state === "Live") return "https://schema.org/EventInProgress";
  const detail = scheduleGame && scheduleGame.status && scheduleGame.status.detailedState;
  if (/postponed|cancelled/i.test(detail || "")) return "https://schema.org/EventPostponed";
  return "https://schema.org/EventScheduled";
}

function buildArchive() {
  const manifests = fs.existsSync(MANIFEST_DIR)
    ? fs.readdirSync(MANIFEST_DIR).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map(name => readJsonSafe(path.join(MANIFEST_DIR, name))).filter(Boolean)
    : [];
  const allPages = manifests.flatMap(manifest => manifest.pages || []).sort((a, b) =>
    b.date.localeCompare(a.date) || String(a.game || "").localeCompare(String(b.game || ""))
  );

  // Group by date so the page reads like a dated set of daily analyses.
  const byDate = new Map();
  for (const page of allPages) {
    if (!byDate.has(page.date)) byDate.set(page.date, []);
    byDate.get(page.date).push(page);
  }
  const dateSections = [...byDate.keys()].sort((a, b) => b.localeCompare(a)).map(date => {
    const rows = byDate.get(date).map(page => `<article class="card matchup-row">
      <div><a href="${esc(new URL(page.url).pathname)}"><strong>${esc(page.game)}</strong></a></div>
      <div class="small dim">${esc(decisionLabel(page.status))}${page.indexable ? "" : " · analysis building"}</div>
    </article>`).join("\n");
    return `<h2 style="margin-top:22px">${esc(niceDate(date))}</h2>${rows}`;
  }).join("\n");
  const body = dateSections || '<div class="notice">No matchup analyses have been published yet.</div>';

  const page = (canonical, navActive, eyebrow, h1, sub) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(h1)} | LyDia</title>
<meta name="description" content="LyDia MLB matchup analysis: model probability, moneyline odds, starting pitchers, offense form, bullpen risk and public grading for every game.">
<link rel="canonical" href="${SITE}${canonical}">
<link rel="stylesheet" href="/css/style.css"><style>.matchup-row{margin:8px 0}</style></head>
<body><nav id="nav"></nav><main><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(h1)}</h1><p class="subtitle">${esc(sub)}</p>${body}
<div class="lead-box" style="border-color:var(--accent2);margin-top:22px"><h3 style="margin:0 0 4px">Get tomorrow's MLB model card free</h3><p class="dim small" style="margin:0">One email each morning with the featured game and the previous day's graded result.</p><p style="margin-top:10px"><a class="btn blue" href="/membership/#free">Get the free card &rarr;</a></p></div>
</main><footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("${navActive}");renderFooter();</script></body></html>`;

  const sub = "Every game gets its own permanent analysis page built from LyDia's model: win probability, market odds, starting pitchers, offense form, bullpen risk and final grading. These are LyDia's own analyses, not aggregated from other sites.";

  // Canonical archive stays at /mlb/matchups/.
  fs.writeFileSync(path.join(ARCHIVE_DIR, "index.html"),
    page("/mlb/matchups/", "/articles/", "LyDia matchup archive", "MLB Matchup Predictions and Odds", sub), "utf8");

  // The Articles tab now shows LyDia's own matchup analyses instead of scraped
  // outside content. This runs after the Research Desk step in the workflow, so
  // it overwrites that page. External aggregation is dropped from what users see.
  const articlesDir = path.join(ROOT, "articles");
  fs.mkdirSync(articlesDir, { recursive: true });
  fs.writeFileSync(path.join(articlesDir, "index.html"),
    page("/articles/", "/articles/", "LyDia analysis", "MLB Matchup Analysis", sub), "utf8");
}

function updateSitemap(manifest) {
  const archiveUrl = `${SITE}/mlb/matchups/`;
  const authorUrl = `${SITE}/writers/lynold/`;
  let urls = [];
  if (fs.existsSync(SITEMAP_PATH)) {
    const existing = fs.readFileSync(SITEMAP_PATH, "utf8");
    urls = [...existing.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].trim());
  }

  const dateSuffix = `-prediction-odds-${DATE}/`;
  urls = urls.filter(url => !(url.startsWith(`${SITE}/mlb/`) && url.endsWith(dateSuffix)));
  urls.push(archiveUrl);
  urls.push(authorUrl);
  for (const page of manifest.pages.filter(page => page.indexable)) urls.push(page.url);
  urls = [...new Set(urls)].sort();

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(url => `  <url><loc>${escXml(url)}</loc></url>`).join("\n")}\n</urlset>\n`;
  fs.writeFileSync(SITEMAP_PATH, sitemap, "utf8");
}

function escXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}


function linkPicksPage() {
  if (!fs.existsSync(PICKS_PATH)) return;

  let html = fs.readFileSync(PICKS_PATH, "utf8");
  let changed = false;

  const renderAnchor = "function renderGame(g) {";
  const helperMarker = "function matchupPageUrl(g) {";

  if (!html.includes(helperMarker)) {
    if (!html.includes(renderAnchor)) {
      throw new Error("Could not find renderGame() in picks/index.html.");
    }

    const helper = `const MATCHUP_TEAM_SHORT = {"Arizona Diamondbacks":"Diamondbacks","Athletics":"Athletics","Atlanta Braves":"Braves","Baltimore Orioles":"Orioles","Boston Red Sox":"Red Sox","Chicago Cubs":"Cubs","Chicago White Sox":"White Sox","Cincinnati Reds":"Reds","Cleveland Guardians":"Guardians","Colorado Rockies":"Rockies","Detroit Tigers":"Tigers","Houston Astros":"Astros","Kansas City Royals":"Royals","Los Angeles Angels":"Angels","Los Angeles Dodgers":"Dodgers","Miami Marlins":"Marlins","Milwaukee Brewers":"Brewers","Minnesota Twins":"Twins","New York Mets":"Mets","New York Yankees":"Yankees","Philadelphia Phillies":"Phillies","Pittsburgh Pirates":"Pirates","San Diego Padres":"Padres","San Francisco Giants":"Giants","Seattle Mariners":"Mariners","St. Louis Cardinals":"Cardinals","Tampa Bay Rays":"Rays","Texas Rangers":"Rangers","Toronto Blue Jays":"Blue Jays","Washington Nationals":"Nationals"};

function matchupPageUrl(g) {
  const date = (PICKS_DATA && PICKS_DATA.date) || datePick.value || localISODate(new Date());
  const away = MATCHUP_TEAM_SHORT[g.away_team] || g.away_team || "";
  const home = MATCHUP_TEAM_SHORT[g.home_team] || g.home_team || "";
  const pageSlug = value => String(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  let url = "/mlb/" + pageSlug(away) + "-vs-" + pageSlug(home) + "-prediction-odds-" + date + "/";
  const games = (PICKS_DATA && PICKS_DATA.games) || [];
  const same = games.filter(x => x.away_team === g.away_team && x.home_team === g.home_team);
  if (same.length > 1) {
    same.sort((a, b) => String(a.game_time_iso || a.time || "").localeCompare(String(b.game_time_iso || b.time || "")));
    const n = same.findIndex(x => String(x.game_pk) === String(g.game_pk)) + 1;
    if (n > 1) url = url.slice(0, -1) + "-game-" + n + "/";
  }
  return url;
}

`;

    // Inject at the TOP of the page script, right after PICKS_DATA is declared,
    // NOT before renderGame. The initial inline render runs synchronously at the
    // top of the script; a MATCHUP_TEAM_SHORT const declared lower down is still
    // in the temporal dead zone at that point, so the first paint throws and the
    // page shows empty until a manual refresh.
    const topAnchor = "let PICKS_DATA = null;";
    if (html.includes(topAnchor)) {
      html = html.replace(topAnchor, topAnchor + "\n" + helper);
    } else {
      html = html.replace(renderAnchor, helper + renderAnchor);
    }
    changed = true;
  }

  // Upgrade a previously baked helper to the doubleheader-aware version.
  const legacyReturn = 'return "/mlb/" + pageSlug(away) + "-vs-" + pageSlug(home) + "-prediction-odds-" + date + "/";';
  if (html.includes(legacyReturn)) {
    const dhReturn = [
      'let url = "/mlb/" + pageSlug(away) + "-vs-" + pageSlug(home) + "-prediction-odds-" + date + "/";',
      'const gms = (PICKS_DATA && PICKS_DATA.games) || [];',
      'const same = gms.filter(function (x) { return x.away_team === g.away_team && x.home_team === g.home_team; });',
      'if (same.length > 1) { same.sort(function (a, b) { return String(a.game_time_iso || a.time || "").localeCompare(String(b.game_time_iso || b.time || "")); }); var n = same.findIndex(function (x) { return String(x.game_pk) === String(g.game_pk); }) + 1; if (n > 1) url = url.slice(0, -1) + "-game-" + n + "/"; }',
      'return url;'
    ].join("\n  ");
    html = html.replace(legacyReturn, dhReturn);
    changed = true;
  }

  const plainTitle = '<span class="matchup">${escapeHtml(g.game || "")}</span>';
  const linkedTitle = '<a class="matchup" href="${matchupPageUrl(g)}">${escapeHtml(g.game || "")}</a>';

  if (html.includes(plainTitle)) {
    html = html.replace(plainTitle, linkedTitle);
    changed = true;
  } else if (!html.includes(linkedTitle)) {
    throw new Error("Could not find the Picks matchup title markup.");
  }

  if (changed) fs.writeFileSync(PICKS_PATH, html, "utf8");
}

function linkDailyPreview(manifest) {
  if (!fs.existsSync(PREVIEW_PATH)) return;
  let html = fs.readFileSync(PREVIEW_PATH, "utf8");
  let changed = false;
  for (const page of manifest.pages) {
    const gameText = esc(page.game);
    const unlinked = `<h2>${gameText}</h2>`;
    const linked = `<h2><a href="${new URL(page.url).pathname}">${gameText}</a></h2>`;
    if (html.includes(unlinked)) {
      html = html.replace(unlinked, linked);
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(PREVIEW_PATH, html, "utf8");
}
