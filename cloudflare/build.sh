#!/usr/bin/env bash
# Pull the page, login page, agent guide, schema and CLI out of ../tiantasks so there's one source of truth.
set -euo pipefail
cd "$(dirname "$0")"
python3 - <<'PY'
import runpy
g = runpy.run_path("../tiantasks")  # run_path doesn't trigger main()
open("src/page.html", "w").write(g["PAGE"])
open("src/login.html", "w").write(g["LOGIN_PAGE"])
open("schema.sql", "w").write(g["SCHEMA"].strip() + "\n" + g["LEGACY_COMMENTS_SQL"].strip() + "\n")
open("src/llms.txt", "w").write(g["AGENT_GUIDE"])
worker = open("src/worker.js").read()
if f'const VERSION = "{g["VERSION"]}";' not in worker:
    raise SystemExit(f"src/worker.js VERSION doesn't match tiantasks ({g['VERSION']}); bump both")
PY
cp ../tiantasks src/tiantasks.txt
# The `tt board` app, served at /board.mjs so teammates' `tt board` can download it.
if [[ ! -f ../board/dist/board.mjs || ../board/src/board.jsx -nt ../board/dist/board.mjs ]]; then
  (cd ../board && { [[ -d node_modules ]] || npm install --no-fund --no-audit >/dev/null; } && npm run --silent build >/dev/null)
fi
cp ../board/dist/board.mjs src/board.mjs.txt
