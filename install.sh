#!/usr/bin/env bash
# Install tiantasks (and the `tt` alias) onto PATH, plus the Claude Code skill.
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

"$dest/tiantasks" claude-setup
