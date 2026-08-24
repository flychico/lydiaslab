(function () {
  const root = document.getElementById("live-pick-results");
  if (!root) return;

  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[c]));

  const fmtAm = am => {
    if (am === null || am === undefined || Number.isNaN(Number(am))) return "";
    const n = Math.round(Number(am));
    return n > 0 ? `+${n}` : String(n);
  };

  const fmtTime = iso => {
    if (!iso) return "TBD";
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York"
    });
  };

  const localISODate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  function playList(pick) {
    const plays = [];
    if (pick.moneyline && pick.moneyline.pick && !pick.moneyline.isPass) {
      plays.push({ market: "ML", pick: pick.moneyline.pick, side: pick.moneyline.side, price: pick.moneyline.bestAm });
    }
    if (pick.total && pick.total.pick) {
      plays.push({ market: "Total", pick: `${pick.total.pick} ${pick.total.line}`, side: pick.total.pick, line: Number(pick.total.line), price: pick.total.bestAm });
    }
    for (const k of pick.strikeouts || []) {
      plays.push({ market: "K Prop", pick: `${k.pitcher} ${k.pick} ${k.line}`, pitcher: k.pitcher, side: k.pick, line: Number(k.line), price: k.bestAm });
    }
    if (pick.runLine && pick.runLine.pick) {
      plays.push({ market: "RL", pick: `${pick.runLine.pick} ${Number(pick.runLine.point) > 0 ? "+" : ""}${pick.runLine.point}`, team: pick.runLine.pick, point: Number(pick.runLine.point), price: pick.runLine.bestAm });
    }
    return plays;
  }

  // Pulls the current strikeout count for a pitcher out of a boxscore payload.
  // Returns null if that pitcher hasn't thrown a pitch yet (or the box has no
  // data for him at all) — distinct from 0 K's, which is a real, known count.
  function currentKs(box, pitcherName) {
    if (!box) return null;
    for (const side of ["away", "home"]) {
      const players = (box.teams && box.teams[side] && box.teams[side].players) || {};
      for (const player of Object.values(players)) {
        if (player.person && player.person.fullName === pitcherName
          && player.stats && player.stats.pitching && player.stats.pitching.inningsPitched !== undefined) {
          return Number(player.stats.pitching.strikeOuts) || 0;
        }
      }
    }
    return null;
  }

  function gradePlay(play, pick, game) {
    const awayScore = game && game.teams && game.teams.away ? game.teams.away.score : undefined;
    const homeScore = game && game.teams && game.teams.home ? game.teams.home.score : undefined;
    const state = game && game.status ? game.status.abstractGameState : "Preview";

    // 2026-08-24: K props used to be gated behind "state === Final" just like
    // every other market, so a live game showed nothing for a strikeout prop
    // until it ended — even once the pitcher had already blown past the line
    // and the bet was mathematically decided. A strikeout count only ever
    // goes up during a start, so once it clears the line, that side is
    // locked in early: Over is a lock win, Under is a lock loss. This branch
    // runs for K Prop regardless of game state (Preview/Live/Final) so that
    // locked-in read shows immediately; every other market keeps requiring
    // Final, since a moneyline/total/run-line result can still flip until
    // the last out.
    if (play.market === "K Prop") {
      const actual = currentKs(game && game._box, play.pitcher);
      if (actual === null) {
        // No box data yet for this pitcher (game hasn't started, or he hasn't
        // been fetched/thrown a pitch). Final with still nothing on file for
        // him is a real VOID (e.g. scratched); anything before Final is just
        // "nothing to show yet," not a graded result.
        return state === "Final" ? { result: "VOID", cls: "", actual: null } : { result: "", cls: "", actual: null };
      }
      const clinched = actual > play.line; // can only grow from here, so this is final regardless of game state
      if (clinched) {
        const won = play.side === "Over";
        return { result: won ? "W" : "L", cls: won ? "pos-text" : "neg-text", actual, live: state !== "Final" };
      }
      if (state === "Final") {
        if (actual === play.line) return { result: "PUSH", cls: "", actual };
        const won = play.side === "Over" ? actual > play.line : actual < play.line;
        return { result: won ? "W" : "L", cls: won ? "pos-text" : "neg-text", actual };
      }
      // Still live, not yet clinched either way — show the running count with
      // no letter grade rather than pretending it's decided.
      return { result: "", cls: "", actual, live: true };
    }

    if (state !== "Final" || awayScore === undefined || homeScore === undefined) return { result: "", cls: "" };

    const homeWon = homeScore > awayScore;
    const totalRuns = awayScore + homeScore;
    const margin = homeScore - awayScore;

    if (play.market === "ML") {
      const won = (play.side === "home") === homeWon;
      return { result: won ? "W" : "L", cls: won ? "pos-text" : "neg-text" };
    }
    if (play.market === "Total") {
      if (totalRuns === play.line) return { result: "PUSH", cls: "" };
      const won = play.side === "Over" ? totalRuns > play.line : totalRuns < play.line;
      return { result: won ? "W" : "L", cls: won ? "pos-text" : "neg-text" };
    }
    if (play.market === "RL") {
      const pickedHome = play.team === pick.home;
      const adjusted = pickedHome ? margin + play.point : -margin + play.point;
      if (adjusted === 0) return { result: "PUSH", cls: "" };
      const won = adjusted > 0;
      return { result: won ? "W" : "L", cls: won ? "pos-text" : "neg-text" };
    }
    return { result: "", cls: "" };
  }

  function gameStatus(game, pick) {
    if (!game) return { label: "Waiting", detail: fmtTime(pick.time), bucket: "pending" };
    const state = game.status ? game.status.abstractGameState : "Preview";
    const detailed = game.status ? game.status.detailedState : "Scheduled";
    const awayScore = game.teams && game.teams.away ? game.teams.away.score : undefined;
    const homeScore = game.teams && game.teams.home ? game.teams.home.score : undefined;
    const hasScore = awayScore !== undefined && homeScore !== undefined;
    if (state === "Final") return { label: "Final", detail: hasScore ? `${awayScore}-${homeScore}` : detailed, bucket: "final" };
    if (state === "Live") return { label: "Live", detail: hasScore ? `${awayScore}-${homeScore} · ${detailed}` : detailed, bucket: "live" };
    return { label: detailed || "Scheduled", detail: fmtTime(pick.time), bucket: "pending" };
  }

  function renderRows(picks, gamesByPk) {
    let wins = 0, losses = 0, pushes = 0, live = 0, pending = 0, finals = 0;
    const rows = picks.map(pick => {
      const game = gamesByPk.get(Number(pick.gamePk));
      const status = gameStatus(game, pick);
      if (status.bucket === "final") finals++;
      if (status.bucket === "live") live++;
      if (status.bucket === "pending") pending++;
      const plays = playList(pick);
      const playHtml = plays.length ? plays.map(play => {
        const grade = gradePlay(play, pick, game);
        // Only count toward the FINALED PLAYS tally once it's truly Final —
        // a live-clinched K prop shows its W/L inline below but doesn't
        // inflate a KPI card labeled "finaled."
        if (!grade.live) {
          if (grade.result === "W") wins++;
          if (grade.result === "L") losses++;
          if (grade.result === "PUSH") pushes++;
        }
        const price = fmtAm(play.price);
        // K props get a running strikeout count once the game's live, shown
        // alongside the line so "6 K (line 5.5)" is visible before any
        // letter grade is decided, and a live-clinched W/L is visibly
        // tagged "(live)" since the game itself isn't over yet.
        const kCount = play.market === "K Prop" && grade.actual !== null && grade.actual !== undefined
          ? ` · <span class="${grade.live && !grade.result ? 'dim' : (grade.cls || '')}">${grade.actual} K</span>`
          : "";
        const resultTag = grade.result
          ? ` · <span class="${grade.cls}">${grade.result}${grade.live ? " (live)" : ""}</span>`
          : "";
        return `<div><b>${esc(play.market)}</b> ${esc(play.pick)}${price ? ` (${esc(price)})` : ""}${kCount}${resultTag}</div>`;
      }).join("") : `<span class="dim small">No official play</span>`;
      const statusClass = status.bucket === "final" ? "pos-text" : status.bucket === "live" ? "neg-text" : "dim";
      return `<tr>
        <td>${esc(pick.away)} @ ${esc(pick.home)}</td>
        <td>${playHtml}</td>
        <td class="${statusClass}"><b>${esc(status.label)}</b><br><span class="small">${esc(status.detail)}</span></td>
      </tr>`;
    }).join("");
    return { rows, wins, losses, pushes, live, pending, finals };
  }

  async function fetchFirstJson(urls) {
    let lastErr = null;
    for (const url of urls) {
      try {
        const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`, { cache: "no-store" });
        if (res.ok) return await res.json();
        lastErr = new Error(`${url} HTTP ${res.status}`);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("No published picks file found.");
  }

  function inlinePicksFor(date) {
    const el = document.getElementById("results-inline-picks");
    if (!el) return null;
    try {
      const d = JSON.parse(el.textContent);
      return d && d.date === date && Array.isArray(d.picks) ? d : null;
    } catch (e) { return null; }
  }

  async function loadLiveResults() {
    const today = localISODate(new Date());

    // Server-baked picks (known at publish time) render immediately —
    // no scores/status yet, but the page never shows a bare "Loading..."
    // placeholder while the live scoreboard call is in flight below.
    const inline = inlinePicksFor(today);
    if (inline && inline.picks.length) {
      const quick = renderRows(inline.picks, new Map());
      root.innerHTML = `<h2 style="margin-top:0">Today's Pick Status</h2>
        <p class="dim small" style="margin-top:-4px">Checking live status for ${esc(today)}…</p>
        <div style="overflow-x:auto">
          <table>
            <thead><tr><th>Game</th><th>Pick</th><th>Status / Score</th></tr></thead>
            <tbody>${quick.rows}</tbody>
          </table>
        </div>`;
    } else if (inline) {
      // Zero official picks is a known, valid, ALREADY-known state (strict
      // probability gate) — show it immediately, no live fetch needed.
      root.innerHTML = `<h2 style="margin-top:0">Today's Pick Status</h2><p class="dim">No official published picks are available yet.</p>`;
      return;
    } else {
      root.innerHTML = `<h2 style="margin-top:0">Today's Pick Status</h2><div class="loading">Loading live pick results...</div>`;
    }

    const picksFile = await fetchFirstJson([
      "/data/published-picks/today.json",
      `/data/published-picks/${today}.json`,
      "/data/picks/today.json"
    ]);
    const date = picksFile.date;
    const picks = Array.isArray(picksFile.picks) ? picksFile.picks : [];

    if (!date || !picks.length) {
      root.innerHTML = `<h2 style="margin-top:0">Today's Pick Status</h2><p class="dim">No official published picks are available yet.</p>`;
      return;
    }

    const schedRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(date)}&v=${Date.now()}`, { cache: "no-store" });
    if (!schedRes.ok) throw new Error(`Could not load MLB scoreboard: HTTP ${schedRes.status}`);
    const schedule = await schedRes.json();
    const games = ((((schedule.dates || [])[0]) || {}).games || []);
    // 2026-08-24: was Final-only, so a K prop showed nothing while its game
    // was still being played — the whole point of a live strikeout read.
    // Now also fetches for Live games; Preview/Scheduled games still skip
    // the fetch since there's no boxscore data worth pulling yet.
    await Promise.all(games.map(async game => {
      const pick = picks.find(p => Number(p.gamePk) === Number(game.gamePk));
      const state = game.status && game.status.abstractGameState;
      if (!pick || !(pick.strikeouts || []).length || (state !== "Final" && state !== "Live")) return;
      try {
        const res = await fetch(`https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore?v=${Date.now()}`, { cache: "no-store" });
        if (res.ok) game._box = await res.json();
      } catch (e) {}
    }));
    const gamesByPk = new Map(games.map(g => [Number(g.gamePk), g]));
    const summary = renderRows(picks, gamesByPk);
    const checked = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

    root.innerHTML = `<h2 style="margin-top:0">Today's Pick Status</h2>
      <p class="dim small" style="margin-top:-4px">Live browser check for ${esc(date)}. Source: published-picks. Last checked ${esc(checked)} ET.</p>
      <div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:12px 0 16px">
        <div class="card"><div class="dim small">FINALED PLAYS</div><div style="font-size:1.3rem;font-weight:800">${summary.wins}-${summary.losses}${summary.pushes ? `-${summary.pushes}P` : ""}</div></div>
        <div class="card"><div class="dim small">FINAL GAMES</div><div style="font-size:1.3rem;font-weight:800">${summary.finals}</div></div>
        <div class="card"><div class="dim small">LIVE</div><div style="font-size:1.3rem;font-weight:800">${summary.live}</div></div>
        <div class="card"><div class="dim small">PENDING</div><div style="font-size:1.3rem;font-weight:800">${summary.pending}</div></div>
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Game</th><th>Pick</th><th>Status / Score</th></tr></thead>
          <tbody>${summary.rows}</tbody>
        </table>
      </div>`;
  }

  loadLiveResults().catch(err => {
    root.innerHTML = `<h2 style="margin-top:0">Today's Pick Status</h2><div class="notice warn">Live pick results could not load: ${esc(err.message)}</div>`;
  });
})();
