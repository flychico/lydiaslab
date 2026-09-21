#!/usr/bin/env bash
# Fails the run if any tracked file still contains git merge-conflict markers.
# Why: on 2026-09-20 a local merge committed <<<<<<< markers into
# data/member-brief and data/bullpen JSON, and daily-recap died later with
# "Unexpected token '<'". This names the files up front instead.
# Fix when it fires: keep the side with the later generated_at, or regenerate.
# Never hand-merge generated data.
set -euo pipefail
hits=$(git grep -lE '^(<<<<<<< |>>>>>>> [0-9a-f]{7,}|>>>>>>> [A-Za-z])' -- . ':!*.md' ':!scripts/check-conflict-markers.sh' || true)
if [ -n "$hits" ]; then
  echo "::error::Merge-conflict markers found. Resolve (take the later snapshot) and push:"
  echo "$hits"
  exit 1
fi
echo "No merge-conflict markers."
