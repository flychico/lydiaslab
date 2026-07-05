/* MLB Edge — shared utilities */

// ---------- Odds math ----------
const Odds = {
  // American odds -> decimal
  amToDec(am) {
    am = Number(am);
    return am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
  },
  // Decimal -> American
  decToAm(dec) {
    dec = Number(dec);
    return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
  },
  // American odds -> implied probability (0..1)
  amToProb(am) {
    am = Number(am);
    return am > 0 ? 100 / (am + 100) : Math.abs(am) / (Math.abs(am) + 100);
  },
  // Probability -> fair American odds
  probToAm(p) {
    return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
  },
  fmtAm(am) {
    am = Math.round(Number(am));
    return am > 0 ? "+" + am : String(am);
  },
  fmtPct(p, dp = 1) {
    return (p * 100).toFixed(dp) + "%";
  },
  // Two-way no-vig: returns {p1, p2, vig}
  noVig(am1, am2) {
    const q1 = this.amToProb(am1), q2 = this.amToProb(am2);
    const total = q1 + q2;
    return { p1: q1 / total, p2: q2 / total, vig: total - 1 };
  },
  // EV per $1 staked given your win probability and American odds
  ev(prob, am) {
    const dec = this.amToDec(am);
    return prob * (dec - 1) - (1 - prob);
  },
  // Full Kelly fraction
  kelly(prob, am) {
    const b = this.amToDec(am) - 1;
    return (prob * b - (1 - prob)) / b;
  }
};

// ---------- API key storage (The Odds API) ----------
const ApiKey = {
  KEY: "mlbedge_odds_api_key",
  get() { try { return localStorage.getItem(this.KEY) || ""; } catch (e) { return ""; } },
  set(v) { try { localStorage.setItem(this.KEY, v.trim()); } catch (e) {} },
  clear() { try { localStorage.removeItem(this.KEY); } catch (e) {} }
};

// ---------- Nav ----------
function renderNav(active) {
  const links = [
    ["index.html", "Home"],
    ["dashboard.html", "Dashboard"],
    ["picks.html", "Picks"],
    ["previews/", "Previews"],
    ["results.html", "Results"],
    ["odds.html", "Odds"],
    ["tools.html", "Tools"],
    ["stats.html", "Stats"],
    ["recaps.html", "Recap"],
    ["articles.html", "Articles"],
    ["membership.html", "Membership"]
  ];
  const el = document.getElementById("nav");
  if (!el) return;
  el.innerHTML = '<div class="nav-inner">'
    + '<a class="brand" href="index.html"><span class="brand-ly">Ly</span><span class="brand-dia">Dia</span> Picks</a>'
    + links.map(function (l) {
        return '<a class="navlink' + (l[0] === active ? ' active' : '') + '" href="' + l[0] + '">' + l[1] + '</a>';
      }).join("")
    + '</div>';
}

function renderFooter() {
  const el = document.getElementById("footer");
  if (!el) return;
  el.innerHTML = "MLB Edges — analysis and education only, not betting advice. "
    + "Odds and stats can change quickly; always verify with your sportsbook. "
    + "Please bet responsibly. If gambling stops being fun, call 1-800-GAMBLER.";
}

function escapeHtml(s) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, function (c) { return map[c]; });
}

// ---------- Ballparks (home team -> park, coords, run environment) ----------
const Parks = {
  "Arizona Diamondbacks": { park: "Chase Field", lat: 33.445, lon: -112.067, roof: true, env: "neutral" },
  "Atlanta Braves": { park: "Truist Park", lat: 33.891, lon: -84.468, roof: false, env: "hitter-friendly" },
  "Baltimore Orioles": { park: "Camden Yards", lat: 39.284, lon: -76.622, roof: false, env: "neutral" },
  "Boston Red Sox": { park: "Fenway Park", lat: 42.346, lon: -71.097, roof: false, env: "hitter-friendly" },
  "Chicago Cubs": { park: "Wrigley Field", lat: 41.948, lon: -87.655, roof: false, env: "wind-dependent" },
  "Chicago White Sox": { park: "Rate Field", lat: 41.830, lon: -87.634, roof: false, env: "hitter-friendly" },
  "Cincinnati Reds": { park: "Great American Ball Park", lat: 39.097, lon: -84.507, roof: false, env: "hitter-friendly" },
  "Cleveland Guardians": { park: "Progressive Field", lat: 41.496, lon: -81.685, roof: false, env: "neutral" },
  "Colorado Rockies": { park: "Coors Field", lat: 39.756, lon: -104.994, roof: false, env: "extreme hitter's park" },
  "Detroit Tigers": { park: "Comerica Park", lat: 42.339, lon: -83.049, roof: false, env: "pitcher-friendly" },
  "Houston Astros": { park: "Daikin Park", lat: 29.757, lon: -95.355, roof: true, env: "neutral" },
  "Kansas City Royals": { park: "Kauffman Stadium", lat: 39.051, lon: -94.480, roof: false, env: "pitcher-friendly" },
  "Los Angeles Angels": { park: "Angel Stadium", lat: 33.800, lon: -117.883, roof: false, env: "neutral" },
  "Los Angeles Dodgers": { park: "Dodger Stadium", lat: 34.074, lon: -118.240, roof: false, env: "pitcher-friendly" },
  "Miami Marlins": { park: "loanDepot park", lat: 25.778, lon: -80.220, roof: true, env: "pitcher-friendly" },
  "Milwaukee Brewers": { park: "American Family Field", lat: 43.028, lon: -87.971, roof: true, env: "neutral" },
  "Minnesota Twins": { park: "Target Field", lat: 44.982, lon: -93.278, roof: false, env: "neutral" },
  "New York Mets": { park: "Citi Field", lat: 40.757, lon: -73.846, roof: false, env: "pitcher-friendly" },
  "New York Yankees": { park: "Yankee Stadium", lat: 40.829, lon: -73.926, roof: false, env: "hitter-friendly" },
  "Athletics": { park: "Sutter Health Park", lat: 38.580, lon: -121.513, roof: false, env: "neutral" },
  "Philadelphia Phillies": { park: "Citizens Bank Park", lat: 39.906, lon: -75.166, roof: false, env: "hitter-friendly" },
  "Pittsburgh Pirates": { park: "PNC Park", lat: 40.447, lon: -80.006, roof: false, env: "pitcher-friendly" },
  "San Diego Padres": { park: "Petco Park", lat: 32.707, lon: -117.157, roof: false, env: "pitcher-friendly" },
  "San Francisco Giants": { park: "Oracle Park", lat: 37.778, lon: -122.389, roof: false, env: "strong pitcher's park" },
  "Seattle Mariners": { park: "T-Mobile Park", lat: 47.591, lon: -122.332, roof: true, env: "strong pitcher's park" },
  "St. Louis Cardinals": { park: "Busch Stadium", lat: 38.622, lon: -90.193, roof: false, env: "pitcher-friendly" },
  "Tampa Bay Rays": { park: "home park", lat: 27.768, lon: -82.653, roof: true, env: "neutral" },
  "Texas Rangers": { park: "Globe Life Field", lat: 32.747, lon: -97.084, roof: true, env: "neutral" },
  "Toronto Blue Jays": { park: "Rogers Centre", lat: 43.641, lon: -79.389, roof: true, env: "hitter-friendly" },
  "Washington Nationals": { park: "Nationals Park", lat: 38.873, lon: -77.007, roof: false, env: "neutral" }
};

function windCompass(deg) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

// Forecast at first pitch from Open-Meteo (free, no key). Returns null on any failure.
const _wxCache = {};
async function gameWeather(homeTeam, gameIso) {
  const pk = Parks[homeTeam];
  if (!pk) return null;
  try {
    if (!_wxCache[homeTeam]) {
      const res = await fetch("https://api.open-meteo.com/v1/forecast?latitude=" + pk.lat +
        "&longitude=" + pk.lon +
        "&hourly=temperature_2m,wind_speed_10m,wind_direction_10m" +
        "&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3&timezone=auto");
      if (!res.ok) return null;
      _wxCache[homeTeam] = await res.json();
    }
    const h = _wxCache[homeTeam].hourly;
    if (!h || !h.time) return null;
    const target = new Date(gameIso).getTime();
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < h.time.length; i++) {
      const diff = Math.abs(new Date(h.time[i]).getTime() - target);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return {
      temp: Math.round(h.temperature_2m[best]),
      wind: Math.round(h.wind_speed_10m[best]),
      dir: windCompass(h.wind_direction_10m[best])
    };
  } catch (e) { return null; }
}
