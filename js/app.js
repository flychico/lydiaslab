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
    ["odds.html", "Live Odds"],
    ["tools.html", "Value Tools"],
    ["stats.html", "Team Stats"],
    ["recaps.html", "Daily Recap"],
    ["articles.html", "Articles"]
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
