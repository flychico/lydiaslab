# ERRORS.md

## Empty official pick lock after closed slate

Problem: A manual publish was run after the July 8 slate had already started or finished. MLB API no longer returned games in Preview state, so the source engine produced zero games and locked an empty published-picks file.

Fix: generate-member-lab.js now has a closed-slate guard. If the date has scheduled games but none are in Preview state, the script throws and writes no files. Empty member briefs and empty official pick locks are invalid artifacts.

## Internal implementation language on public pages

Problem: picks/index.html displayed implementation details such as script paths and raw timestamps.

Fix: public pages now display customer-facing labels only, such as LyDia Daily Engine and formatted Eastern time. assert-public-clean.js fails if generated public HTML contains internal script paths, internal data paths, or raw generated timestamps.

## Recap nav drift

Problem: generate-recap.js hardcoded nav HTML and could fall behind the shared site navigation.

Fix: generated recap pages now use <nav id="nav"></nav>, /js/app.js, renderNav('/recaps/'), and renderFooter().
