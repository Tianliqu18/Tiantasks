#!/usr/bin/env bash
# Pull the page, login page, schema and CLI out of ../tiantasks so there's one source of truth.
set -euo pipefail
cd "$(dirname "$0")"
python3 - <<'PY'
import runpy
g = runpy.run_path("../tiantasks")  # run_path doesn't trigger main()
open("src/page.html", "w").write(g["PAGE"])
open("src/login.html", "w").write(g["LOGIN_PAGE"])
open("schema.sql", "w").write(g["SCHEMA"].strip() + "\n")
PY
cp ../tiantasks src/tiantasks.txt
