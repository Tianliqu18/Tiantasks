#!/usr/bin/env bash
# Deploy (or redeploy) the shared Tiantasks board to Cloudflare Workers + D1 (free plan).
# First run: creates the database and login tokens, deploys, and signs your `tt` in.
# Later runs: rebuild from ../tiantasks and ship. Safe to rerun if a step fails.
set -euo pipefail
cd "$(dirname "$0")"
wr() { npx --no-install wrangler "$@"; }

[[ -d node_modules ]] || npm install --no-fund --no-audit
./build.sh

if ! wr whoami 2>/dev/null | grep -qi "logged in"; then
  echo "Sign in to Cloudflare first (opens your browser):  npx wrangler login"
  exit 1
fi

# 1. Database: reuse an existing "tiantasks" D1 database or create one.
if grep -q REPLACE_ME wrangler.toml; then
  id="$(wr d1 list --json 2>/dev/null | python3 -c '
import json, sys
dbs = [d for d in json.load(sys.stdin) if d.get("name") == "tiantasks"]
print(dbs[0]["uuid"] if dbs else "")' || true)"
  if [[ -z "$id" ]]; then
    echo "Creating D1 database…"
    id="$(wr d1 create tiantasks </dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  fi
  [[ -n "$id" ]] || { echo "Couldn't create or find the D1 database."; exit 1; }
  sed -i '' "s/REPLACE_ME/$id/" wrangler.toml
fi
wr d1 execute tiantasks --remote --file schema.sql --yes >/dev/null   # idempotent

# 2. Ship the Worker.
if ! out="$(wr deploy 2>&1 | tee /dev/stderr; exit "${PIPESTATUS[0]}")"; then
  if grep -q "workers.dev subdomain" <<<"$out"; then
    echo
    echo "One-time step: run  npx wrangler deploy  and choose a workers.dev subdomain when asked,"
    echo "then run ./deploy.sh again."
  fi
  exit 1
fi
url="$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' <<<"$out" | head -1)"

# 3. Login tokens: made on first run (or with --reset-tokens). Tokens only go to Cloudflare and
#    to private files here; your own file is deleted once `tt login` succeeds.
if [[ "${1:-}" == "--reset-tokens" ]] || ! wr secret list --format json 2>/dev/null | grep -q TIANTASKS_USERS; then
  me_token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  oliver_token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  printf '%s' "tianli:$me_token,oliver:$oliver_token" | wr secret put TIANTASKS_USERS >/dev/null
  (umask 077; printf '%s\n' "$me_token" > tianli-token.txt; printf '%s\n' "$oliver_token" > oliver-token.txt)
  echo "Created new login tokens."
fi

# 4. Sign your `tt` in (waits for a brand-new workers.dev address to get its certificate).
if [[ -f tianli-token.txt ]]; then
  me_token="$(cat tianli-token.txt)"
  echo "Waiting for $url to come online…"
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $me_token" "$url/api/me" || true)"
    [[ "$code" == 200 ]] && break
    sleep 5
  done
  if TIANTASKS_TOKEN="$me_token" tt login "$url"; then
    rm -f tianli-token.txt
  else
    echo "Couldn't sign in yet. Your token is kept in cloudflare/tianli-token.txt; rerun ./deploy.sh in a few minutes."
    exit 1
  fi
fi
if [[ -f oliver-token.txt ]]; then
  echo
  echo "Oliver's token is in cloudflare/oliver-token.txt. Send it to him privately, then delete the file."
fi

echo
echo "Board: $url"
