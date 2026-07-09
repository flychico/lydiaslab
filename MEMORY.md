# MEMORY

## 2026-07-08

Implemented publish-date consistency for LyDia.

Decision:
- The publish workflow must resolve one effective date in America/New_York and pass it to every command.
- `generate-member-lab.js` must default to America/New_York when no date is passed.

Reason:
- GitHub Actions runners use UTC, which caused member-lab and preview rendering to disagree on the target date during late evening Eastern runs.

Files:
- `.github/workflows/publish-picks.yml`
- `scripts/generate-member-lab.js`
- `ERRORS.md`
