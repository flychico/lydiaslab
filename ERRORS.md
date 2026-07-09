# ERRORS

## 2026-07-08 publish workflow date mismatch

### Symptom
`publish-picks.yml` failed during preview rendering with:

```text
Error: Missing data/published-picks/2026-07-08.json. Run scripts/generate-member-lab.js first.
```

### Cause
The workflow did not pass one resolved date to every step. On GitHub Actions, the runner uses UTC. Around late evening Eastern, `generate-member-lab.js` defaulted to the UTC date while `generate-previews.js` defaulted to America/New_York. That made the first step create one date and the second step look for another.

### Fix
Resolve the publish date once in the workflow using America/New_York, then pass that same date into `generate-member-lab.js`, `generate-previews.js`, verification, commit message, and email sending.

Also changed `generate-member-lab.js` so its default date is America/New_York instead of runner-local time.
