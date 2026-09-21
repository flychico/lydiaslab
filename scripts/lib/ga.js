// Single source for the Google Analytics tag. Every page template includes
// GA_HEAD right after <head>, so a page is tracked the moment it is written,
// not only after normalize-public-shell.js runs. (2026-09-21: backfill-recaps
// regenerated the 9/20 MLB pages after the normalizer ran, and 15 pages
// shipped untracked.)
const GA_ID = "G-XVWTMDNBJK";
const GA_HEAD = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA_ID}');
</script>`;
module.exports = { GA_ID, GA_HEAD };
