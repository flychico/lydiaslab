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
  const previousManifest = readJsonSafe(MANIFEST_PATH) || { pages: [] };
  const previousBySlug = new Map((previousManifest.pages || []).map(page => [page.slug, page]));
  const schedule = args.offline ? null : await fetchSchedule(DATE);
  const scheduleByPk = new Map((((schedule && schedule.dates || [])[0] || {}).games || []).map(game => [String(game.gamePk), game]));

  fs.mkdirSync(MATCHUP_ROOT, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });

  const pages = [];
  for (const game of brief.games) {
    const slug = matchupSlug(game);
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
      urlPath
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

function renderMatchupPage(context) {
  const { brief, game, scheduleGame, totalsGame, pitcherGame, resultGame, weather, venue, quality, slug, urlPath } = context;
  const awayShort = shortTeam(game.away_team);
  const homeShort = shortTeam(game.home_team);
  const titleDate = niceDate(DATE);
  const title = `${awayShort} vs ${homeShort} Prediction, Odds and Model Pick | ${DATE}`;
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
    name: `${game.away_team} at ${game.home_team}`,
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
.matchup-head{margin-bottom:18px}.matchup-head h1{margin-bottom:6px}.byline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.byline img{width:42px;height:42px;border-radius:50%;object-fit:cover;border:1px solid var(--border)}.status-badge{display:inline-block;color:#fff;font-size:.76rem;font-weight:800;padding:4px 10px;border-radius:20px;background:var(--accent2)}.status-badge.official{background:var(--good)}.status-badge.pass{background:var(--text-dim)}.status-badge.watch{background:var(--accent2)}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin:14px 0}.metric{background:var(--bg-elev);border:1px solid var(--border);border-radius:var(--radius);padding:12px}.metric .label{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)}.metric .value{font-size:1.15rem;font-weight:800;margin-top:2px}.matchup-table{width:100%;border-collapse:collapse;font-size:.88rem}.matchup-table th,.matchup-table td{padding:8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}.matchup-table th:not(:first-child),.matchup-table td:not(:first-child){text-align:right}.section-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.decision-card{border-color:var(--accent2)}.decision-card.official{border-color:var(--good)}.quality-list{columns:2;column-gap:24px}.quality-list li{break-inside:avoid;margin-bottom:5px}.result-win{border-color:var(--good)}.result-loss{border-color:var(--bad)}@media(max-width:640px){.quality-list{columns:1}.matchup-table{font-size:.8rem}.matchup-table th,.matchup-table td{padding:6px 4px}}
</style>
<script type="application/ld+json">${jsonScript(articleSchema)}</script>
<script type="application/ld+json">${jsonScript(eventSchema)}</script>
</head>
<body>
<nav id="nav"></nav>
<main>
  <div class="matchup-head">
    <p class="eyebrow">MLB matchup analysis</p>
    <h1>${esc(awayShort)} vs ${esc(homeShort)} Prediction, Odds and Model Pick</h1>
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
    <h3>Why LyDia made this decision</h3>
    <p>${esc(decisionExplanation(game))}</p>
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
      </tbody>
    </table>
  </section>

  <section class="card">
    <h2>Starting pitcher matchup</h2>
    ${renderPitcherTable(game, pitcherGame)}
    <p class="small dim">Pitcher ratings and advanced metrics come directly from the canonical data source used by LyDia\'s Pitcher Matchup Tool.</p>
  </section>

  <section class="card">
    <h2>Offense and recent form</h2>
    ${renderOffenseTable(game)}
  </section>

  <section class="card">
    <h2>Bullpen matchup</h2>
    ${renderBullpenTable(game, bullpen)}
    <p class="small dim">Fatigue measures workload. Efficiency measures recent run prevention. Combined risk is what the moneyline and totals systems use.</p>
  </section>

  ${renderTotals(totalsGame)}

  <section class="card">
    <h2>Weather and venue</h2>
    <p>${esc(weatherText(weather, venue))}</p>
  </section>

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

  return `<table class="matchup-table" data-pitcher-source="${esc(p.source_version || "pitcher-matchup-core-v1")}" data-away-ip-start="${esc(awayIpStart)}" data-home-ip-start="${esc(homeIpStart)}">
    <thead><tr><th>Metric</th><th>${esc(shortTeam(game.away_team))}</th><th>${esc(shortTeam(game.home_team))}</th></tr></thead>
    <tbody>
      <tr><th>Probable pitcher</th><td>${esc(away.name || "TBD")}</td><td>${esc(home.name || "TBD")}</td></tr>
      <tr><th>LyDia pitcher score</th><td>${esc(known(away.score) ? away.score : "Not available")}</td><td>${esc(known(home.score) ? home.score : "Not available")}</td></tr>
      <tr><th>ERA</th><td>${esc(oneDecimal(away.era))}</td><td>${esc(oneDecimal(home.era))}</td></tr>
      <tr><th>WHIP</th><td>${esc(typeof away.whip === "number" ? away.whip.toFixed(2) : "Not available")}</td><td>${esc(typeof home.whip === "number" ? home.whip.toFixed(2) : "Not available")}</td></tr>
      <tr><th>K-BB%</th><td>${esc(pct(away.kbbPct))}</td><td>${esc(pct(home.kbbPct))}</td></tr>
      <tr><th>Ground-ball rate</th><td>${esc(pct(away.gbPct))}</td><td>${esc(pct(home.gbPct))}</td></tr>
      <tr><th>HR/9</th><td>${esc(oneDecimal(away.hr9))}</td><td>${esc(oneDecimal(home.hr9))}</td></tr>
      <tr><th>IP per start</th><td>${esc(awayIpStart)}</td><td>${esc(homeIpStart)}</td></tr>
    </tbody>
  </table>
  <p><strong>Pitcher edge:</strong> ${esc(p.edge_team || "No clear starting pitcher edge")}${p.gap ? ` by ${esc(p.gap)} points` : ""}.</p>`;
}

function renderOffenseTable(game) {
  const offense = game.offense_form || {};
  const away = offense.away || {};
  const home = offense.home || {};
  return `<table class="matchup-table">
    <thead><tr><th>Metric</th><th>${esc(shortTeam(game.away_team))}</th><th>${esc(shortTeam(game.home_team))}</th></tr></thead>
    <tbody>
      <tr><th>Record</th><td>${esc(game.away_record || "Not available")}</td><td>${esc(game.home_record || "Not available")}</td></tr>
      <tr><th>Last 10</th><td>${esc(game.away_l10 || "Not available")}</td><td>${esc(game.home_l10 || "Not available")}</td></tr>
      <tr><th>OPS, last 15 days</th><td>${esc(typeof away.ops_15d === "number" ? away.ops_15d.toFixed(3) : "Not available")}</td><td>${esc(typeof home.ops_15d === "number" ? home.ops_15d.toFixed(3) : "Not available")}</td></tr>
      <tr><th>Season OPS</th><td>${esc(typeof away.season_ops === "number" ? away.season_ops.toFixed(3) : "Not available")}</td><td>${esc(typeof home.season_ops === "number" ? home.season_ops.toFixed(3) : "Not available")}</td></tr>
      <tr><th>OPS change</th><td>${esc(typeof away.delta_ops === "number" ? signedDecimal(away.delta_ops, 3) : "Not available")}</td><td>${esc(typeof home.delta_ops === "number" ? signedDecimal(home.delta_ops, 3) : "Not available")}</td></tr>
      <tr><th>Runs per game, last 15 days</th><td>${esc(oneDecimal(away.rpg_15d))}</td><td>${esc(oneDecimal(home.rpg_15d))}</td></tr>
      <tr><th>OPS vs opposing hand</th><td>${esc(typeof away.ops_vs_opp_hand === "number" ? away.ops_vs_opp_hand.toFixed(3) : "Not available")}</td><td>${esc(typeof home.ops_vs_opp_hand === "number" ? home.ops_vs_opp_hand.toFixed(3) : "Not available")}</td></tr>
    </tbody>
  </table>`;
}

function signedDecimal(value, digits) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function renderBullpenTable(game, bullpen) {
  const away = bullpen.away || {};
  const home = bullpen.home || {};
  return `<table class="matchup-table">
    <thead><tr><th>Metric</th><th>${esc(shortTeam(game.away_team))}</th><th>${esc(shortTeam(game.home_team))}</th></tr></thead>
    <tbody>
      <tr><th>Fatigue</th><td>${esc(scoreAndLabel(away.score, away.label))}</td><td>${esc(scoreAndLabel(home.score, home.label))}</td></tr>
      <tr><th>Efficiency</th><td>${esc(scoreAndLabel(away.efficiency_score, away.efficiency_label))}</td><td>${esc(scoreAndLabel(home.efficiency_score, home.efficiency_label))}</td></tr>
      <tr><th>Combined risk</th><td>${esc(scoreAndLabel(away.risk_index, away.risk_label))}</td><td>${esc(scoreAndLabel(home.risk_index, home.risk_label))}</td></tr>
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
  if (!total) return `<section class="card"><h2>Run total projection</h2><p>A verified LyDia totals projection was not available when this page was generated.</p></section>`;
  const difference = typeof total.projection === "number" && typeof total.line === "number" ? total.projection - total.line : null;
  const context = difference === null
    ? "The current model and market total cannot be compared yet."
    : Math.abs(difference) < 0.5
      ? "The model and market are close."
      : `The model projects ${Math.abs(difference).toFixed(1)} runs ${difference > 0 ? "above" : "below"} the market total.`;
  return `<section class="card">
    <h2>Run total projection</h2>
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

  const rows = allPages.map(page => `<article class="card matchup-row">
    <div><a href="${esc(new URL(page.url).pathname)}"><strong>${esc(page.game)}</strong></a></div>
    <div class="small dim">${esc(niceDate(page.date))} · ${esc(decisionLabel(page.status))} · ${page.indexable ? "Search ready" : "Analysis building"}</div>
  </article>`).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MLB Matchup Predictions and Odds Archive | LyDia</title>
<meta name="description" content="LyDia MLB matchup pages with model probabilities, odds, starting pitchers, offense form, bullpen risk and public results.">
<link rel="canonical" href="${SITE}/mlb/matchups/">
<link rel="stylesheet" href="/css/style.css"><style>.matchup-row{margin:10px 0}</style></head>
<body><nav id="nav"></nav><main><p class="eyebrow">LyDia matchup archive</p><h1>MLB Matchup Predictions and Odds</h1><p class="subtitle">Permanent matchup pages generated from LyDia's daily model card. Complete pages are submitted for indexing. Pages with missing inputs remain available but are held out of search.</p>${rows || '<div class="notice">No matchup pages have been generated yet.</div>'}</main><footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/picks/");renderFooter();</script></body></html>`;
  fs.writeFileSync(path.join(ARCHIVE_DIR, "index.html"), html, "utf8");
}

function updateSitemap(manifest) {
  const archiveUrl = `${SITE}/mlb/matchups/`;
  let urls = [];
  if (fs.existsSync(SITEMAP_PATH)) {
    const existing = fs.readFileSync(SITEMAP_PATH, "utf8");
    urls = [...existing.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].trim());
  }

  const dateSuffix = `-prediction-odds-${DATE}/`;
  urls = urls.filter(url => !(url.startsWith(`${SITE}/mlb/`) && url.endsWith(dateSuffix)));
  urls.push(archiveUrl);
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
  return "/mlb/" + pageSlug(away) + "-vs-" + pageSlug(home) + "-prediction-odds-" + date + "/";
}

`;

    html = html.replace(renderAnchor, helper + renderAnchor);
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
