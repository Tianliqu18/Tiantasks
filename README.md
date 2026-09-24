# Tiantasks

Task and issue queues for people and their Claude Code sessions. There's a live web board, a
`tt` CLI, and a shared board hosted free on Cloudflare Workers + D1. Tickets live in a database
instead of your repos, so there's nothing to commit.

## Layout

| Path | What it is |
|---|---|
| `tiantasks` | The whole CLI, local server and web page (Python 3, standard library only) |
| `board/` | `tt board`, the terminal kanban (React + Ink), bundled into `dist/board.mjs` (Node 18+) |
| `install.sh` | Installs `tiantasks` and the `tt` alias onto your PATH, the board app, and the Claude Code skill |
| `cloudflare/` | The shared board: Worker (`src/worker.js`), config, `deploy.sh`, `tokens` |

## Using it

```bash
tt                      # open issues and tasks for the current repo's project
tt add "Write docs" -p high -t docs
tt issue "Login broken" -p crit -d "repro steps" --to claude-tianli
tt resolve I-3 -m "fixed in auth.py"
tt comment I-3 -r 12 "reply to comment c12"
tt ui                   # open the web board (Add form, screenshots, comment threads, light/dark)
tt board                # terminal kanban: OPEN → IN PROGRESS → DONE (press ? for keys)
tt help                 # every command
```

In Claude Code, assign items to `claude-<you>`, then ask it to "work through your Tiantasks queue".

## Agent teams

Give each Claude Code session a name (`TIANTASKS_AGENT=builder-1 claude`). A lead agent reads the
whole board with `tt brief` and hands out work with `tt add "…" --to builder-1 -d "<instructions>"`.
Workers run `tt next --wait --start`, which waits for assigned work and claims it (two agents can
never claim the same item), then `tt resolve ID -m "…"`. The Claude Code skill installed by
`install.sh` teaches agents both roles.

## Shared board (Cloudflare)

```bash
cd cloudflare
npx wrangler login      # once
./deploy.sh             # first run creates the D1 database and login tokens; later runs ship changes
./tokens add NAME       # give someone access (also: list, copy, reset, remove)
```

People listed in `TIANTASKS_ADMINS` (in `wrangler.toml`) can delete comments; agents never can.

A new teammate installs the CLI from the board and signs in:

```bash
mkdir -p ~/.local/bin && curl -fsSL https://<board>/tiantasks -o ~/.local/bin/tt && chmod +x ~/.local/bin/tt
tt login https://<board>
tt claude-setup
```

Tokens are kept in `cloudflare/users.json` and the board's `TIANTASKS_USERS` secret. Both are
git-ignored and never committed.
