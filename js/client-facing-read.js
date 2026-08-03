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
    // Risk index blends fatigue (workload) with efficiency (how well the pen
    // has actually pitched) — this is what the model itself uses, so the
    // client-side comparison bands need to match, not just raw workload.
    const pickRisk = Math.round(typeof pick.risk_index === "number" ? pick.risk_index : pick.score);
    const oppRisk = Math.round(typeof opp.risk_index === "number" ? opp.risk_index : opp.score);
    const pickIp = typeof pick.last7_bp_ip === "number" ? pick.last7_bp_ip.toFixed(1) : null;
    const oppIp = typeof opp.last7_bp_ip === "number" ? opp.last7_bp_ip.toFixed(1) : null;
    const pickB2b = Number(pick.back_to_back_arms || 0);
    const oppB2b = Number(opp.back_to_back_arms || 0);
    const effNote = t => (t && t.efficiency_label) ? `${t === pick ? team : opponent}'s pen has been ${t.efficiency_label.toLowerCase()} lately (${(t.efficiency_score/10).toFixed(1)}/10 efficiency).` : "";

    if (pickRisk >= 82 && oppRisk >= 82) {
      return `Both bullpens carry high risk. ${team} is ${(pickRisk/10).toFixed(1)}/10 and ${opponent} is ${(oppRisk/10).toFixed(1)}/10, so the late innings carry meaningful volatility on both sides.`;
    }

    if (pickRisk + 15 < oppRisk) {
      const facts = [];
      if (oppIp !== null) facts.push(`${oppIp} relief innings over the last 7 days`);
      if (oppB2b) facts.push(`${oppB2b} back-to-back arm${oppB2b === 1 ? "" : "s"}`);
      return `${team} has the lower-risk bullpen, ${(pickRisk/10).toFixed(1)}/10 versus ${(oppRisk/10).toFixed(1)}/10. ${opponent}${facts.length ? " has " + facts.join(", ") + "." : " carries the heavier recent workload."} ${effNote(opp)}`.trim();
    }

    if (pickRisk > oppRisk + 15) {
      const facts = [];
      if (pickIp !== null) facts.push(`${pickIp} relief innings over the last 7 days`);
      if (pickB2b) facts.push(`${pickB2b} back-to-back arm${pickB2b === 1 ? "" : "s"}`);
      return `${team} carries the higher-risk bullpen, ${(pickRisk/10).toFixed(1)}/10 versus ${(oppRisk/10).toFixed(1)}/10.${facts.length ? " Recent context: " + facts.join(", ") + "." : ""} ${effNote(pick)}`.trim();
    }

    if (pickRisk >= 62 || oppRisk >= 62) {
      return `Bullpen risk is elevated but not decisive. ${team} is ${(pickRisk/10).toFixed(1)}/10 and ${opponent} is ${(oppRisk/10).toFixed(1)}/10.`;
    }

    return `No meaningful bullpen risk edge — both pens come in comparable (${team} ${(pickRisk/10).toFixed(1)}/10, ${opponent} ${(oppRisk/10).toFixed(1)}/10${pickRisk < 35 && oppRisk < 35 ? ", both fresh" : ""}).`;
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
    // Disclose when bullpen fatigue meaningfully moved the win probability
    // itself (not just Lab Rating) — only surfaced when the shift is real.
    const bullpenProbNote = (() => {
      const pre = g && g.model_probability_pre_bullpen;
      if (typeof pre !== "number" || typeof (g && g.model_probability) !== "number") return "";
      const shift = (g.model_probability - pre) * 100;
      if (Math.abs(shift) < 1) return "";
      const dir = shift > 0 ? "up" : "down";
      return ` Bullpen fatigue moved this probability ${dir} ${Math.abs(shift).toFixed(1)} points from ${pct(pre)} (starting pitcher and team strength only) to ${modelProb}.`;
    })();

    if (g && g.status === "official_pick") {
      return `${team} is an official moneyline pick because LyDia gives it a ${modelProb} chance to win, compared with the market's ${marketProb} no-vig probability. The full setup earned a ${rating} Lab Rating. ${pitcher} ${bullpen}${bullpenProbNote} At ${price}, the price still offers enough value for the play to qualify as official.`;
    }

    if (g && g.status === "value_watch") {
      const gate = (g && g.official_pick_gate) || {};
      const failedGates = [];
      if (gate.model_probability_passed === false) failedGates.push(`model win probability is ${modelProb}, below the ${pct(gate.minimum_model_probability)} official-pick gate`);
      if (gate.lab_score_passed === false) failedGates.push(`Lab Rating is ${rating}, below the ${labRating(gate.minimum_lab_score)} official-pick gate`);
      if (g.pitcher_edge && g.pitcher_edge.conflict) failedGates.push("the starting pitcher edge conflicts with the model side");
      const gateLine = failedGates.length
        ? `It stayed a value watch because ${failedGates.join("; and ")}.`
        : "It stayed a value watch under the stricter official-pick review.";
      return `${team} grades as a strong value setup with ${modelProb} model win probability against a ${marketProb} market number and a ${rating} Lab Rating. ${pitcher} ${bullpen}${bullpenProbNote} ${gateLine}`;
    }

    if (g && g.status === "watchlist") {
      return `${team} is worth monitoring, but it does not clear every requirement for an official pick. LyDia projects ${modelProb} win probability, the market is at ${marketProb}, and the setup carries a ${rating} Lab Rating. ${pitcher} ${bullpen}${bullpenProbNote}`;
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
