# MEMORY.md

## 2026-07-08 - LyDia full cleanup decision

The repo had a working locked-picks concept, but July 8 was run after games were no longer in Preview state. The engine created empty public artifacts for a real slate. That is not acceptable.

Decision: LyDia must not create or publish official pick records after games have started. If a slate has games but none are still in Preview state, the publish workflow must fail loudly and write nothing.

Decision: public pages must not expose internal script names, internal file paths, raw ISO timestamps, or implementation labels. Public wording should say LyDia Daily Engine and use reader-friendly Eastern time.

Decision: clean generated site artifacts with a maintenance workflow instead of hand-editing files. Empty generated slates are deleted from generated data folders, preview archive, and sitemap. Results history is not deleted by this cleanup.

Decision: shared navigation belongs in js/app.js. Generated recap, preview, and results pages should render nav and footer through js/app.js instead of hardcoded nav HTML.
