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

  function playList(pick) {
    const plays = [];
    if (pick.moneyline && pick.moneyline.pick && !pick.moneyline.isPass) {
      plays.push({
        market: "ML",
        pick: pick.moneyline.pick,
        side: pick.moneyline.side,
        price: pick.moneyline.bestAm
      });
    }
    if (pick.total && pick.total.pick) {
      plays.push({
        market: "Total",
        pick: `${pick.total.pick} ${pick.total.line}`,
        side: pick.total.pick,
        line: Number(pick.total.line),
        price: pick.total.bestAm
      });
    }
    if (pick.runLine && pick.runLine.pick) {
      plays.push({
        market: "RL",
        pick: `${pick.runLine.pick} ${Number(pick.runLine.point) > 0 ? "+" : ""}${pick.runLine.point}`,
        team: pick.runLine.pick,
        point: Number(pick.runLine.point),
        price: pick.runLine.bestAm
      });
    }
    return plays;
  }

  function gradePlay(play, pick, game) {
    const awayScore = game && game.teams && game.teams.away ? game.teams.away.score : undefined;
    const homeScore = game && game.teams && game.teams.home ? game.teams.home.score : undefined;
    const state = game && game.status ? game.status.abstractGameState : "Preview";

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

    if (state === "Final") {
      return { label: "Final", detail: hasScore ? `${awayScore}-${homeScore}` : detailed, bucket: "final" };
    }
    if (state === "Live") {
      return { label: "Live", detail: hasScore ? `${awayScore}-${homeScore} · ${detailed}` : detailed, bucket: "live" };
    }
    return { label: detailed || "Scheduled", detail: fmtTime(pick.time), bucket: "pending" };
  }

  function renderRows(picks, gamesByPk) {
    let wins = 0;
    let losses = 0;
    let pushes = 0;
    let live = 0;
    let pending = 0;
    let finals = 0;

    const rows = picks.map(pick => {
      const game = gamesByPk.get(Number(pick.gamePk));
      const status = gameStatus(game, pick);

      if (status.bucket === "final") finals++;
      if (status.bucket === "live") live++;
      if (status.bucket === "pending") pending++;

      const plays = playList(pick);
      const playHtml = plays.length ? plays.map(play => {
        const grade = gradePlay(play, pick, game);
        if (grade.result === "W") wins++;
        if (grade.result === "L") losses++;
        if (grade.result === "PUSH") pushes++;
        const price = fmtAm(play.price);
        return `<div><b>${esc(play.market)}</b> ${esc(play.pick)}${price ? ` (${esc(price)})` : ""}${grade.result ? ` · <span class="${grade.cls}">${grade.result}</span>` : ""}</div>`;
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

  async function loadLiveResults() {
    root.innerHTML = `<h2 style="margin-top:0">Today's Pick Status</h2><div class="loading">Loading live pick results...</div>`;

    const picksRes = await fetch(`/data/picks/today.json?v=${Date.now()}`, { cache: "no-store" });
    if (!picksRes.ok) throw new Error(`Could not load today's picks file: HTTP ${picksRes.status}`);
    const picksFile = await picksRes.json();
    const date = picksFile.date;
    const picks = Array.isArray(picksFile.picks) ? picksFile.picks : [];

    if (!date || !picks.length) {
      root.innerHTML = `<h2 style="margin-top:0">Today's Pick Status</h2><p class="dim">No official picks file is available yet.</p>`;
      return;
    }

    const schedRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(date)}&v=${Date.now()}`, { cache: "no-store" });
    if (!schedRes.ok) throw new Error(`Could not load MLB scoreboard: HTTP ${schedRes.status}`);
    const schedule = await schedRes.json();
    const games = ((((schedule.dates || [])[0]) || {}).games || []);
    const gamesByPk = new Map(games.map(g => [Number(g.gamePk), g]));

    const summary = renderRows(picks, gamesByPk);
    const checked = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

    root.innerHTML = `<h2 style="margin-top:0">Today's Pick Status</h2>
      <p class="dim small" style="margin-top:-4px">Live browser check for ${esc(date)}. Official record still commits to GitHub after games finish. Last checked ${esc(checked)} ET.</p>
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
