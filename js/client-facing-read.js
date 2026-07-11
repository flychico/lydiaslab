(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyDiaRead = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function pct(v) {
    return typeof v === "number" && Number.isFinite(v) ? (v * 100).toFixed(1) + "%" : "-";
  }

  function odds(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return "-";
    return v > 0 ? "+" + Math.round(v) : String(Math.round(v));
  }

  function labRating(v) {
    return typeof v === "number" && Number.isFinite(v) ? (v / 10).toFixed(1) + "/10" : "-";
  }

  function opponentName(g) {
    if (!g) return "Opponent";
    if (g.pick_team === g.away_team) return g.home_team || "Opponent";
    if (g.pick_team === g.home_team) return g.away_team || "Opponent";
    return "Opponent";
  }

  function bullpenAnalysis(g) {
    const bp = (g && g.bullpen) || {};
    const pick = bp.pick_team || null;
    const opp = bp.opponent || null;

    if (!pick || !opp || typeof pick.score !== "number" || typeof opp.score !== "number") {
      return "Bullpen workload data is unavailable.";
    }

    const team = g.pick_team || "LyDia's side";
    const opponent = opponentName(g);
    const ten = x => (x / 10).toFixed(1) + "/10";
    const pickScore = Math.round(pick.score);
    const oppScore = Math.round(opp.score);
    const pickIp = typeof pick.last3_bp_ip === "number" ? pick.last3_bp_ip.toFixed(1) : null;
    const oppIp = typeof opp.last3_bp_ip === "number" ? opp.last3_bp_ip.toFixed(1) : null;
    const pickRuns = typeof pick.last3_bp_runs === "number" ? pick.last3_bp_runs : null;
    const oppRuns = typeof opp.last3_bp_runs === "number" ? opp.last3_bp_runs : null;
    const pickB2b = Number(pick.back_to_back_arms || 0);
    const oppB2b = Number(opp.back_to_back_arms || 0);

    if (pickScore >= 82 && oppScore >= 82) {
      return `Both bullpens are high risk. ${team} is ${(pickScore/10).toFixed(1)}/10 and ${opponent} is ${(oppScore/10).toFixed(1)}/10, so the late innings carry meaningful volatility on both sides.`;
    }

    if (pickScore + 15 < oppScore) {
      const facts = [];
      if (oppIp !== null) facts.push(`${oppIp} relief innings over the last three days`);
      if (oppB2b) facts.push(`${oppB2b} back-to-back arm${oppB2b === 1 ? "" : "s"}`);
      if (oppRuns !== null && oppRuns >= 6) facts.push(`${oppRuns} bullpen runs allowed`);
      return `${team} has the fresher bullpen, ${(pickScore/10).toFixed(1)}/10 versus ${(oppScore/10).toFixed(1)}/10. ${opponent}${facts.length ? " has " + facts.join(", ") + "." : " carries the heavier recent workload."}`;
    }

    if (pickScore > oppScore + 15) {
      const facts = [];
      if (pickIp !== null) facts.push(`${pickIp} relief innings over the last three days`);
      if (pickB2b) facts.push(`${pickB2b} back-to-back arm${pickB2b === 1 ? "" : "s"}`);
      if (pickRuns !== null && pickRuns >= 6) facts.push(`${pickRuns} bullpen runs allowed`);
      return `${team} carries the heavier bullpen workload, ${(pickScore/10).toFixed(1)}/10 versus ${(oppScore/10).toFixed(1)}/10, which adds late-game risk.${facts.length ? " Recent context: " + facts.join(", ") + "." : ""}`;
    }

    if (pickScore >= 62 || oppScore >= 62) {
      return `Bullpen workload is elevated but not decisive. ${team} is ${(pickScore/10).toFixed(1)}/10 and ${opponent} is ${(oppScore/10).toFixed(1)}/10.`;
    }

    return `No meaningful bullpen fatigue edge. ${team} is ${(pickScore/10).toFixed(1)}/10 and ${opponent} is ${(oppScore/10).toFixed(1)}/10.`;
  }

  function pitcherSentence(g) {
    const p = (g && g.pitcher_edge) || {};
    if (!p.team || p.team === "No clear SP edge") {
      return "The starting pitching matchup does not create a clear advantage.";
    }
    if (p.team === g.pick_team) {
      return `${g.pick_team} has the stronger starting pitcher matchup${p.gap ? ` by ${p.gap} rating points` : ""}.`;
    }
    return `${p.team} has the starting pitcher advantage${p.gap ? ` by ${p.gap} rating points` : ""}, which works against LyDia's side.`;
  }

  function clientRead(g) {
    const market = (g && g.market) || {};
    const team = (g && g.pick_team) || "This side";
    const modelProb = pct(g && g.model_probability);
    const marketProb = pct(market.no_vig_probability);
    const price = odds(market.best_price);
    const pitcher = pitcherSentence(g || {});
    const bullpen = bullpenAnalysis(g || {});
    const rating = labRating(g && g.lab_score);

    if (g && g.status === "official_pick") {
      return `${team} is an official moneyline pick because LyDia gives it a ${modelProb} chance to win, compared with the market's ${marketProb} no-vig probability. The full setup earned a ${rating} Lab Rating. ${pitcher} ${bullpen} At ${price}, the price still offers enough value for the play to qualify as official.`;
    }

    if (g && g.status === "value_watch") {
      return `${team} grades as a strong value setup with ${modelProb} model win probability against a ${marketProb} market number and a ${rating} Lab Rating. ${pitcher} ${bullpen} It remains a value watch because it does not clear every official-pick requirement, including the 72% probability gate.`;
    }

    if (g && g.status === "watchlist") {
      return `${team} is worth monitoring, but it does not clear every requirement for an official pick. LyDia projects ${modelProb} win probability, the market is at ${marketProb}, and the setup carries a ${rating} Lab Rating. ${pitcher} ${bullpen}`;
    }

    return (g && g.pass_reason) || `${team} does not have a strong enough overall setup for an official pick.`;
  }

  return {
    pct,
    odds,
    labRating,
    opponentName,
    bullpenAnalysis,
    pitcherSentence,
    clientRead
  };
});
