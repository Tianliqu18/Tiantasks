#!/usr/bin/env bash
# Pull the page, login page, agent guide, schema and CLI out of ../tiantasks so there's one source of truth.
set -euo pipefail
cd "$(dirname "$0")"
python3 - <<'PY'
import runpy
# Cloudflare's Python (3.13.3) ships without _sqlite3. tiantasks only touches sqlite3 inside
# functions (Store.__init__), never at import time, so a stub module is enough to run_path it.
try:
    import sqlite3  # noqa: F401
except ImportError:
    import sys, types
    sys.modules["sqlite3"] = types.ModuleType("sqlite3")
g = runpy.run_path("../tiantasks")  # run_path doesn't trigger main()
open("src/page.html", "w").write(g["PAGE"])
open("src/login.html", "w").write(g["LOGIN_PAGE"])
open("schema.sql", "w").write(g["SCHEMA"].strip() + "\n" + g["LEGACY_COMMENTS_SQL"].strip() + "\n")
open("src/llms.txt", "w").write(g["AGENT_GUIDE"])
open("src/schema.txt", "w").write(g["SCHEMA"])  # the Worker creates missing tables itself on start
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
