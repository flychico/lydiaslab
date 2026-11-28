/*
 * One conversion line for NFL pages (Lynold, 2026-11-27, five-page rewrite: "one consistent conversion line near the
 * top and again near the bottom"). Copy kept without a dash (house rule): "Free daily card by email: every game with
 * Leo's win chance. Full brief for members."
 *
 * Browser: <div data-leo-cta></div> anywhere on a page, then <script src="/js/leo-cta.js"></script>; each placeholder
 * is filled. Node: require("../../js/leo-cta.js").html() for page builders.
 */
(function (root) {
  "use strict";
  var CSS = ".leo-cta{margin:14px 0;padding:12px 14px;border:1px solid var(--border,#e2d9c8);border-left:4px solid #C9A84C;border-radius:12px;background:var(--bg-elev,#fbf8f2);font-size:.95rem;line-height:1.5}"
    + ".leo-cta a{font-weight:700}";
  function html() {
    return '<p class="leo-cta"><a href="/membership/#free">Free daily card</a> by email: every game with Leo\'s win chance. '
      + 'Full brief for <a href="/membership/">members</a>.</p>';
  }
  function style() { return "<style>" + CSS + "</style>"; }
  var api = { html: html, style: style, CSS: CSS };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof document !== "undefined") {
    var fill = function () {
      if (!document.getElementById("leo-cta-css")) { var s = document.createElement("style"); s.id = "leo-cta-css"; s.textContent = CSS; document.head.appendChild(s); }
      var els = document.querySelectorAll("[data-leo-cta]");
      for (var i = 0; i < els.length; i++) if (!els[i].getAttribute("data-filled")) { els[i].innerHTML = html(); els[i].setAttribute("data-filled", "1"); }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fill); else fill();
    root.LEO_CTA = api;
  }
})(typeof window !== "undefined" ? window : this);
