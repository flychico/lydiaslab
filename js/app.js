/* LyDia — shared utilities */

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
  },
  // Standard-normal CDF (Zelen & Severo approximation) — used for total-runs
  // and run-line probability estimates from a projected mean and std dev.
  normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    if (z > 0) p = 1 - p;
    return p;
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
// Tab order is deliberate: Scoreboard, Picks, Pitchers, Lab, Stats, Results,
// Recaps. There is no Home tab — the LyDia wordmark is the route home. Picks
// points at /previews/, the unified picks product; /picks/ redirects there and
// is still matched for the active state so older pages highlight correctly.
function renderNav(active) {
  const links = [
    ["/dashboard/", "Scoreboard"],
    ["/previews/", "Picks"],
    ["/tools/strikeout-projections/", "Pitchers"],
    ["/tools/", "Lab"],
    ["/stats/", "Stats"],
    ["/results/", "Results"],
    ["/recaps/", "Recaps"]
  ];
  // A page may report an old or more specific path than the tab it belongs to.
  const ALIASES = {
    "/picks/": "/previews/",
    "/articles/": null,
    "/": null
  };
  const current = Object.prototype.hasOwnProperty.call(ALIASES, active) ? ALIASES[active] : active;
  const isActive = href => href === current
    || (href === "/tools/strikeout-projections/" && current === "/tools/strikeout-projections/");

  const el = document.getElementById("nav");
  if (!el) return;
  el.innerHTML = '<div class="nav-inner">'
    + '<a class="brand" href="/" aria-label="LyDia home"><span class="brand-ly">Ly</span><span class="brand-dia">Dia</span></a>'
    + links.map(function (l) {
        if (l[0] === "/tools/") {
          var tools = [
            ["/member-brief/", "Daily Member Brief"],
            ["/tools/offense-matchups/", "Offense Matchup"],
            ["/tools/pitcher-matchups/", "Pitcher Matchup"],
            ["/tools/bullpen-fatigue/", "Bullpen Fatigue"],
            ["/tools/strikeout-projections/", "Strikeout Projections"],
            ["/tools/totals-projections/", "Totals Projections"]
          ];
          return '<span class="nav-drop' + (current === "/tools/" ? ' active-wrap' : '') + '">'
            + '<a class="navlink nav-drop-toggle' + (current === "/tools/" ? ' active' : '') + '" href="/tools/">Lab ▾</a>'
            + '<span class="nav-drop-menu">'
            + tools.map(function (t) { return '<a href="' + t[0] + '">' + t[1] + '</a>'; }).join("")
            + '</span></span>';
        }
        return '<a class="navlink' + (isActive(l[0]) ? ' active' : '') + '" href="' + l[0] + '">' + l[1] + '</a>';
      }).join("")
    + '<a class="navlink navlink-cta' + (current === "/membership/" ? ' active' : '') + '" href="/membership/">Join $30/mo</a>'
    + '</div>';

  // Mobile/touch: first tap on "Lab ▾" opens the menu instead of navigating;
  // tapping elsewhere closes it. Desktop hover keeps working via CSS.
  var toggle = el.querySelector(".nav-drop-toggle");
  var drop = el.querySelector(".nav-drop");
  if (toggle && drop) {
    toggle.addEventListener("click", function (e) {
      if (!drop.classList.contains("open")) {
        e.preventDefault();
        drop.classList.add("open");
      }
      // second tap (menu already open) follows the link to /tools/
    });
    document.addEventListener("click", function (e) {
      if (!drop.contains(e.target)) drop.classList.remove("open");
    });
  }
}

// ---------- Signup forms (Cloudflare Worker — replaces Netlify Forms) ----------
// 2026-08-24: GitHub Pages has no server-side form processing, so the old
// data-netlify="true" forms (footer, matchup pages, previews, membership page)
// stopped working the moment DNS cut over from Netlify. This Worker receives
// the POST instead and appends the signup to a CSV file on the repo's
// "signups" branch — see cloudflare-worker/signup-worker.js and DEPLOY.md in
// this same delivery folder for the full design and why it's a separate branch.
//
// If you deploy the Worker at a different URL than the one below (e.g. you
// skip the custom-domain step in DEPLOY.md and use the default *.workers.dev
// address instead), this is the one line to change.
const SIGNUP_ENDPOINT = "https://signup.lydiaslab.com/";

// Wires every <form class="lydia-signup-form"> on the page (static ones already
// in the HTML, e.g. matchup pages, previews, membership — plus any injected
// later, e.g. the footer form built by renderFooter() below). Safe to call more
// than once: already-wired forms are skipped via a data attribute flag.
//
// Expected markup on the form:
//   <form class="lydia-signup-form" data-list="newsletter" data-thanks="...">
//     <input type="email" name="email" required>
//     <input type="hidden" name="bot-field">      (optional honeypot, left empty by humans)
//     <input type="hidden" name="subscription-id"> (optional, membership page only)
//     <button type="submit">...</button>
//   </form>
function wireAllSignupForms(root) {
  const scope = root || document;
  const forms = scope.querySelectorAll("form.lydia-signup-form:not([data-signup-wired])");
  forms.forEach(function (form) {
    form.setAttribute("data-signup-wired", "1");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const emailEl = form.querySelector('[name="email"]');
      const email = emailEl ? emailEl.value.trim() : "";
      if (!email) return;

      const botEl = form.querySelector('[name="bot-field"]');
      const subIdEl = form.querySelector('[name="subscription-id"]');
      const list = form.getAttribute("data-list") || "newsletter";
      const thanks = form.getAttribute("data-thanks")
        || "You’re on the list — first card arrives tomorrow morning. ⚾";
      const errorEl = form.querySelector(".signup-error");
      const submitBtn = form.querySelector('button[type="submit"]');

      if (errorEl) errorEl.textContent = "";
      if (submitBtn) submitBtn.disabled = true;

      try {
        const res = await fetch(SIGNUP_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
          body: new URLSearchParams({
            email: email,
            list: list,
            "bot-field": botEl ? botEl.value : "",
            "subscription-id": subIdEl ? subIdEl.value : ""
          }).toString()
        });

        if (res.ok) {
          form.outerHTML = '<div class="small" style="color:#2f9e44;font-weight:600">' + thanks + '</div>';
          return;
        }

        let message = "Signup failed — try again shortly.";
        try {
          const body = await res.json();
          if (body && body.error) message = body.error;
        } catch (_) { /* non-JSON error response, keep default message */ }

        if (errorEl) {
          errorEl.textContent = message;
        } else {
          form.insertAdjacentHTML("beforeend", '<div class="signup-error small" style="color:#c0392b;margin-top:6px">' + message + '</div>');
        }
      } catch (err) {
        const message = "Signup hiccup — check your connection and try again.";
        if (errorEl) {
          errorEl.textContent = message;
        } else {
          form.insertAdjacentHTML("beforeend", '<div class="signup-error small" style="color:#c0392b;margin-top:6px">' + message + '</div>');
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  });
}

function renderFooter() {
  const el = document.getElementById("footer");
  if (!el) return;
  el.innerHTML = '<div style="max-width:420px;margin:0 auto 14px">'
    + '<form class="lydia-signup-form" data-list="free-preview" style="display:flex;gap:8px">'
    + '<input type="email" name="email" required placeholder="you@email.com" style="flex:1;min-width:0">'
    + '<input type="hidden" name="bot-field">'
    + '<button class="btn blue" type="submit">Free daily card</button>'
    + '</form>'
    + '<div class="dim small" style="margin-top:5px">The morning slate and model reads, free by email. Unsubscribe anytime.</div>'
    + '</div>'
    + "LyDia — analysis and education only, not betting advice. "
    + "Odds and stats can change quickly; always verify with your sportsbook. "
    + "Please bet responsibly. If gambling stops being fun, call 1-800-GAMBLER.";
  wireAllSignupForms(el);
}

function escapeHtml(s) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, function (c) { return map[c]; });
}

// ---------- Permanent matchup URLs ----------
// Every Lab tool links its game headings to the permanent matchup page. The
// function lived nowhere, so `permanentMatchupUrl is not defined` was thrown by
// the Offense Matchup tool (caught, and the raw message shown to users) and by
// the Pitcher Matchup tool (uncaught, leaving it stuck on "Loading…" forever).
//
// The slug must match scripts/generate-matchup-pages.js exactly:
//   {away-short}-vs-{home-short}-prediction-odds-{date}
// with split doubleheaders ordered by first pitch and game 2+ suffixed.
function matchupShortTeam(name) {
  const twoWord = ["Red Sox", "White Sox", "Blue Jays"];
  const s = String(name || "").trim();
  for (const t of twoWord) if (s.endsWith(t)) return t;
  return s.split(" ").pop();
}
function matchupSlugify(v) {
  return String(v).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function permanentMatchupUrl(game, allGames, date) {
  // Never throw: a broken link is a nuisance, an exception takes the page down.
  try {
    const away = game.teams.away.team.name;
    const home = game.teams.home.team.name;
    const day = date || game.officialDate || String(game.gameDate || "").slice(0, 10);
    if (!away || !home || !day) return "/mlb/matchups/";
    const base = matchupSlugify(matchupShortTeam(away)) + "-vs-"
      + matchupSlugify(matchupShortTeam(home)) + "-prediction-odds-" + day;

    // Split doubleheaders share a slug, so schedule order decides the suffix.
    let gameNumber = null;
    if (Array.isArray(allGames) && allGames.length > 1) {
      const key = g => matchupShortTeam(g.teams.away.team.name) + "|" + matchupShortTeam(g.teams.home.team.name);
      const mine = key(game);
      const sameMatchup = allGames.filter(function (g) {
        return g && g.teams && g.teams.away && g.teams.home && key(g) === mine;
      });
      if (sameMatchup.length > 1) {
        sameMatchup.sort(function (a, b) {
          return String(a.gameDate || "").localeCompare(String(b.gameDate || ""));
        });
        const index = sameMatchup.findIndex(function (g) { return g.gamePk === game.gamePk; });
        if (index >= 0) gameNumber = index + 1;
      }
    }
    return "/mlb/" + base + (gameNumber && gameNumber > 1 ? "-game-" + gameNumber : "") + "/";
  } catch (e) {
    return "/mlb/matchups/";
  }
}

// Fetch the public results record for trust badges on the homepage / membership page.
// Returns null on any failure so callers can render a graceful fallback.
async function fetchRecord() {
  try {
    const res = await fetch("/data/results.json", { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const days = Object.values(data.days || {});
    if (!days.length) return null;
    let w = 0, l = 0;
    for (const d of days) { w += d.wins; l += d.losses; }
    return { wins: w, losses: l, days: days.length, pct: w + l ? w / (w + l) : null };
  } catch (e) { return null; }
}

// ---------- Ballparks (home team -> park, coords, run environment) ----------
const Parks = {
  "Arizona Diamondbacks": { park: "Chase Field", lat: 33.445, lon: -112.067, roof: true, env: "neutral", runFactor: 1.02 },
  "Atlanta Braves": { park: "Truist Park", lat: 33.891, lon: -84.468, roof: false, env: "hitter-friendly", runFactor: 1.05 },
  "Baltimore Orioles": { park: "Camden Yards", lat: 39.284, lon: -76.622, roof: false, env: "neutral", runFactor: 1.00 },
  "Boston Red Sox": { park: "Fenway Park", lat: 42.346, lon: -71.097, roof: false, env: "hitter-friendly", runFactor: 1.06 },
  "Chicago Cubs": { park: "Wrigley Field", lat: 41.948, lon: -87.655, roof: false, env: "wind-dependent", runFactor: 1.02 },
  "Chicago White Sox": { park: "Rate Field", lat: 41.830, lon: -87.634, roof: false, env: "hitter-friendly", runFactor: 1.04 },
  "Cincinnati Reds": { park: "Great American Ball Park", lat: 39.097, lon: -84.507, roof: false, env: "hitter-friendly", runFactor: 1.07 },
  "Cleveland Guardians": { park: "Progressive Field", lat: 41.496, lon: -81.685, roof: false, env: "neutral", runFactor: 0.99 },
  "Colorado Rockies": { park: "Coors Field", lat: 39.756, lon: -104.994, roof: false, env: "extreme hitter's park", runFactor: 1.18 },
  "Detroit Tigers": { park: "Comerica Park", lat: 42.339, lon: -83.049, roof: false, env: "pitcher-friendly", runFactor: 0.95 },
  "Houston Astros": { park: "Daikin Park", lat: 29.757, lon: -95.355, roof: true, env: "neutral", runFactor: 0.99 },
  "Kansas City Royals": { park: "Kauffman Stadium", lat: 39.051, lon: -94.480, roof: false, env: "pitcher-friendly", runFactor: 0.96 },
  "Los Angeles Angels": { park: "Angel Stadium", lat: 33.800, lon: -117.883, roof: false, env: "neutral", runFactor: 1.00 },
  "Los Angeles Dodgers": { park: "Dodger Stadium", lat: 34.074, lon: -118.240, roof: false, env: "pitcher-friendly", runFactor: 0.94 },
  "Miami Marlins": { park: "loanDepot park", lat: 25.778, lon: -80.220, roof: true, env: "pitcher-friendly", runFactor: 0.93 },
  "Milwaukee Brewers": { park: "American Family Field", lat: 43.028, lon: -87.971, roof: true, env: "neutral", runFactor: 1.00 },
  "Minnesota Twins": { park: "Target Field", lat: 44.982, lon: -93.278, roof: false, env: "neutral", runFactor: 0.99 },
  "New York Mets": { park: "Citi Field", lat: 40.757, lon: -73.846, roof: false, env: "pitcher-friendly", runFactor: 0.96 },
  "New York Yankees": { park: "Yankee Stadium", lat: 40.829, lon: -73.926, roof: false, env: "hitter-friendly", runFactor: 1.05 },
  "Athletics": { park: "Sutter Health Park", lat: 38.580, lon: -121.513, roof: false, env: "neutral", runFactor: 1.01 },
  "Philadelphia Phillies": { park: "Citizens Bank Park", lat: 39.906, lon: -75.166, roof: false, env: "hitter-friendly", runFactor: 1.06 },
  "Pittsburgh Pirates": { park: "PNC Park", lat: 40.447, lon: -80.006, roof: false, env: "pitcher-friendly", runFactor: 0.97 },
  "San Diego Padres": { park: "Petco Park", lat: 32.707, lon: -117.157, roof: false, env: "pitcher-friendly", runFactor: 0.93 },
  "San Francisco Giants": { park: "Oracle Park", lat: 37.778, lon: -122.389, roof: false, env: "strong pitcher's park", runFactor: 0.91 },
  "Seattle Mariners": { park: "T-Mobile Park", lat: 47.591, lon: -122.332, roof: true, env: "strong pitcher's park", runFactor: 0.92 },
  "St. Louis Cardinals": { park: "Busch Stadium", lat: 38.622, lon: -90.193, roof: false, env: "pitcher-friendly", runFactor: 0.97 },
  "Tampa Bay Rays": { park: "home park", lat: 27.768, lon: -82.653, roof: true, env: "neutral", runFactor: 0.98 },
  "Texas Rangers": { park: "Globe Life Field", lat: 32.747, lon: -97.084, roof: true, env: "neutral", runFactor: 1.00 },
  "Toronto Blue Jays": { park: "Rogers Centre", lat: 43.641, lon: -79.389, roof: true, env: "hitter-friendly", runFactor: 1.03 },
  "Washington Nationals": { park: "Nationals Park", lat: 38.873, lon: -77.007, roof: false, env: "neutral", runFactor: 0.98 }
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

// Wire any signup forms already present in the static HTML (matchup pages,
// preview pages, membership page). Safe no-op if none exist on this page.
// This script tag is placed at the end of <body>, after the page's own HTML,
// so the forms are already in the DOM by the time this line runs.
wireAllSignupForms();
