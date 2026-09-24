#!/usr/bin/env bash
# Install tiantasks (and the `tt` alias) onto PATH, the `tt board` app, and the Claude Code skill.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

dest=""
for d in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
  if [[ ":$PATH:" == *":$d:"* && -d "$d" && -w "$d" ]]; then dest="$d"; break; fi
done
if [[ -z "$dest" ]]; then
  echo "No writable directory on PATH found. Copy ./tiantasks somewhere on your PATH manually." >&2
  exit 1
fi

cp "$here/tiantasks" "$dest/tiantasks"
chmod +x "$dest/tiantasks"
ln -sf "$dest/tiantasks" "$dest/tt"
echo "installed $dest/tiantasks and $dest/tt"

# `tt board` (React + Ink) is bundled into one file; rebuild it if the source is newer.
board="$here/board"
if command -v npm >/dev/null && [[ -d "$board" ]]; then
  if [[ ! -f "$board/dist/board.mjs" || "$board/src/board.jsx" -nt "$board/dist/board.mjs" ]]; then
    (cd "$board" && { [[ -d node_modules ]] || npm install --no-fund --no-audit >/dev/null; } && npm run --silent build >/dev/null)
  fi
fi
if [[ -f "$board/dist/board.mjs" ]]; then
  mkdir -p "$HOME/.tiantasks" && cp "$board/dist/board.mjs" "$HOME/.tiantasks/board.mjs"
  echo "installed the board app (tt board)"
fi

"$dest/tiantasks" claude-setup
