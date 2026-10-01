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
tt attach I-3 shot.png  # add screenshots (also: tt issue "…" -f shot.png)
tt files I-3 --save /tmp/i3   # download them (how Claude looks at a ticket's screenshots)
tt ui                   # open the web board: Queues and Board tabs, click a ticket for its full view
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

Agents that talk HTTP instead of using `tt` can read the API guide at `/llms.txt` on the board.

## People, agents and initiatives

Every agent works for a person: the login it acts under. The **Team** tab shows each person's
agents (working, waiting, idle), what they're doing, and the initiatives they run. Inside tmux,
Claude Code sessions are named after their session automatically (`master-app-billing`), so
nothing needs configuring.

- **Progress:** `tt progress ID "Harness runs end to end" --link <preview>` posts a milestone. The
  latest one shows on the card, and the ticket opens with a progress summary.
- **Flags:** anyone can flag an item, initiative or agent ("skip the CSV export"). It shows
  sent → delivered → acknowledged; the agent answers with `tt ack F-12 "what I'll do"`.
- **Asks:** `tt ask "rerun or skip?" --on ID` lands in the person's *Needs you* list, and their
  answer goes straight back to the agent.
- **Directives:** `--directive "their exact words"` on any write records that a person asked for
  it; an adapter can check the quote against the agent's conversation.
- **Custom fields:** `tt edit ID --field preview=https://…` or `--initiative app/billing`.
- **Cleanup:** a person can remove their own agents and initiatives (`DELETE /api/agents/NAME`,
  `DELETE /api/initiatives/SLUG`); an adapter does this when something goes out of scope.

Delivering flags into chats, reporting agent status and posting automatic milestones is the job
of a small adapter for your own setup; it only uses the HTTP API above (`/llms.txt`).

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

## Command reference

Every `tt` command, with all its options. `tt <command> -h` shows the same from the terminal.

### Conventions

- **IDs:** tasks are `T-n`, issues are `I-n`. Any of `T-3`, `t3`, `#T-3` works. Comments are
  `c12` (use the number: `-r 12`), flags and asks are `F-12`.
- **Project:** commands work on the current git repo's project (its folder name). Override with
  `--project NAME` or `TIANTASKS_PROJECT`; `-A` / `--all-projects` widens views to every project.
- **`--json`:** most commands accept it and print machine-readable output, which is the format
  agents should use.
- **Options every command accepts:**

| Option | Meaning |
|---|---|
| `--project NAME` | Project to use (default: the git repo's folder name) |
| `--as NAME` | Who is making the change, on a private board (default: you, or `claude` inside Claude Code). Ignored on a shared board, where your token decides |
| `--directive "QUOTE"` | Agents: the instruction from your person this change carries out, quoted exactly |

### Viewing

**`tt`** / **`tt list`** (alias `ls`): the issue and task queues for this project; open items by default.

| Option | Meaning |
|---|---|
| `-a`, `--all` | Include resolved items |
| `-r`, `--resolved` | Only resolved items |
| `-A`, `--all-projects` | Every project |
| `--tasks` / `--issues` | Only one kind |
| `--for NAME` | Only items assigned to NAME (`me`, `claude`, `nobody`, or any name) |
| `-g`, `--grep TEXT` | Search titles, descriptions and notes |
| `--json` | Machine-readable output |

**`tt show ID`**: everything about one item: description, screenshot names, comment threads (with
comment IDs for replying) and history. `--json` includes the comment list (`comment_list`) and history.

**`tt projects`**: every project with its open and total counts.

**`tt log`**: recent activity, oldest first. `-n N` for how many (default 20), `-A` for every project.

**`tt team`** (alias `agents`): people, their agents, and what each agent is working on. `--json`.

**`tt initiatives`**: initiatives and who runs them. `--json`.

**`tt brief`**: a one-read snapshot for a lead agent: unassigned work, each agent's queue, what's in
progress, what just finished (with notes) and which agents are idle.

| Option | Meaning |
|---|---|
| `-A`, `--all-projects` | Every project |
| `--done N` | How many recently finished items to include (default 10) |
| `--json` | Machine-readable output |

**`tt whoami`**: which board `tt` is using (shared board URL or local database) and who you are on it.

### Creating and changing items

**`tt add "TITLE"`** (aliases `task`, `new`) and **`tt issue "TITLE"`** (alias `bug`): create a task
or an issue.

| Option | Meaning |
|---|---|
| `-p`, `--priority crit\|high\|med\|low` | Priority |
| `-t`, `--tag TAG` | Tag it (repeatable) |
| `-d`, `--desc "TEXT"` | Longer description (Markdown on the web board) |
| `--to NAME` | Assign it (`me`, `claude-<you>`, a teammate, an agent name) |
| `-f`, `--file FILE` | Attach a screenshot (repeatable) |
| `--initiative SLUG` | Put it in an initiative, e.g. `court/eval-flows` |
| `--field KEY=VALUE` | Set a custom field (repeatable) |
| `-i`, `--issue` | (`tt add` only) make it an issue |
| `--json` | Print the new item as JSON |

**`tt edit ID ["NEW TITLE"]`**: change an item.

| Option | Meaning |
|---|---|
| `-p`, `--priority crit\|high\|med\|low\|none` | Set or clear the priority |
| `-d`, `--desc "TEXT"` | Replace the description |
| `-t`, `--tag TAG` / `--untag TAG` | Add / remove a tag (repeatable) |
| `--move PROJECT` | Move it to another project |
| `--field KEY=VALUE` | Set a custom field; an empty value removes it |
| `--initiative SLUG` | Put it in an initiative (`''` takes it out) |
| `--json` | Print the item as JSON |

**`tt assign ID [ID…] NAME`**: assign items. NAME can be `me`, `nobody`, `claude-<you>`, a teammate
or an agent name.

**`tt remove ID`** (alias `rm`): delete an item permanently.

### Status

**`tt start ID [ID…]`**: mark in progress; assigns you if nobody has it.

**`tt stop ID [ID…]`**: move back to open (not started).

**`tt resolve ID [ID…] -m "NOTE"`** (aliases `done`, `close`, `fix`): mark done, with a one-line
resolution note saying what was done. Shown checked and struck through.

**`tt reopen ID [ID…]`**: undo a resolve.

All four accept `--json`.

**`tt next`**: the top item for you: your in-progress work first, then open items by priority. A
named agent session (e.g. a tmux session) also takes open work queued for `claude-<you>`.

| Option | Meaning |
|---|---|
| `--start` | Claim it and mark it in progress. Safe with several agents: two can never claim the same item |
| `--any` | If nothing is assigned to you, take unassigned work |
| `--wait` | If there's nothing, wait until something is assigned |
| `--timeout SECS` | With `--wait`, give up after this long (agents: use about 500, below Claude Code's command limit) |
| `--interval SECS` | With `--wait`, how often to check (default 2 s locally, 5 s on a shared board) |
| `--for NAME` | Someone else's queue |
| `-A`, `--all-projects` | Look in every project |
| `--json` | The item as JSON (`null` when there's nothing) |

### Comments

**`tt comment ID "TEXT"`**: add a comment.

| Option | Meaning |
|---|---|
| `-r`, `--reply CID` | Reply to comment `cCID` (IDs are shown by `tt show`); replies join that thread |
| `--delete CID` | Delete a comment (admins only; agents never can). Replies to it stay |

### Screenshots

**`tt attach ID FILE…`**: attach screenshots (PNG, JPEG, WebP or GIF, up to 1.9 MB each). `--json`.

**`tt files ID`**: list an item's screenshots. `--save DIR` downloads them and prints the paths (this
is how Claude looks at a ticket's screenshots). `--json`.

### Agents and coordination

**`tt progress [ID] "MILESTONE"`**: post a one-line milestone on an item (or on an initiative with
`--initiative SLUG` and no ID). The latest shows on the card and in the Team view.

| Option | Meaning |
|---|---|
| `--initiative SLUG` | Post it on an initiative instead of an item |
| `--link URL` | Preview, PR or doc the milestone produced |
| `--shot FILE` | Attach a screenshot with it |
| `--json` | Machine-readable output |

**`tt flag "TEXT"`**: send a note that must reach whoever runs an item or initiative (a change of
plan, a correction). Tracked from sent → delivered → acknowledged.

**`tt ask "QUESTION"`**: agents ask their person for a decision. It lands in that person's
*Needs you* list (web Team tab, `tt board` → Team, `tt flags`), and the answer comes back as a flag.

Both take:

| Option | Meaning |
|---|---|
| `--on ID` | The item it's about |
| `--initiative SLUG` | The initiative it's about |
| `--to NAME` | Who gets it. Default for a flag: the item's assignee or the initiative's owner; for an ask: your person |
| `--urgent` | Also tell their person right away |
| `--json` | Machine-readable output |

**`tt flags`**: flags and asks waiting for you.

| Option | Meaning |
|---|---|
| `--to NAME` | Someone else's |
| `--all` | Everyone's open flags |
| `--on ID` | Only those about one item |
| `--history` | Include acknowledged and closed ones |
| `--json` | Machine-readable output |

**`tt ack F-ID "WHAT YOU'LL DO"`**: acknowledge a flag in one line. `--close` closes it instead
(no longer relevant).

### Boards and accounts

**`tt ui`**: open the web board in your browser (starts the local server first if you're on a
private board). `--port N`, `--no-open`, `--stop` (stop the local server).

**`tt board`**: the terminal board (Node.js 18+). `--port N` for a local board; `--update`
re-downloads the board app from the shared board. Keys are listed below.

**`tt serve`**: run the board's web server in the foreground. `--port N`; `--host ADDR` (anything
other than localhost requires `TIANTASKS_USERS` logins).

**`tt login URL`**: use a shared board; asks for your token (or reads `TIANTASKS_TOKEN`).

**`tt logout`**: go back to your private local board.

**`tt claude-setup`**: install the Claude Code skill (`~/.claude/skills/tiantasks`). `--repo` adds a
short note to the current repo's `CLAUDE.md` instead.

**`tt help`**: list every command. `tt --version` prints the version.

### `tt board` keys

| Where | Key | Does |
|---|---|---|
| Everywhere | `Tab` | Switch between Board and Team |
| | `t` | Dark / light theme |
| | `?` | Help |
| | `q` | Quit |
| Board | `←` `→` / `h` `l` | Switch column |
| | `↑` `↓` / `k` `j` | Select a card |
| | `⏎` | Open the card's details |
| | `n` | New task (`Tab` in the box switches to issue) |
| | `a` | Assign (pick someone, or type a new name) |
| | `s` | Start: move to In progress |
| | `d` | Done, with an optional note |
| | `>` `<` (or `⇧→` `⇧←`) | Move the card right / left |
| | `c` / `p` / `x` | Comment / cycle priority / delete (asks first) |
| | `f` / `/` / `r` | Cycle project filter / search / refresh |
| Details | `↑` `↓` | Select screenshots and comments (`J` `K` scroll the page) |
| | `o` (or `⏎` on a screenshot) | Open the screenshot full size |
| | `r` (or `⏎` on a comment) | Reply |
| | `⏎` on "N replies" | Expand / collapse the thread |
| | `⌫` | Delete the selected comment (admins) |
| | `Esc` | Leave the selection, then close |
| Team | `↑` `↓` | Select an ask, agent, folded group or initiative |
| | `a` (or `⏎`) / `d` | Answer an ask (goes back to the agent) / mark it handled |
| | `f` | Flag the selected agent or initiative (`Tab` in the box: urgent) |
| | `⏎` | Open the agent's ticket in progress, the initiative's first open ticket, or expand a group |

### Environment variables

| Variable | Effect |
|---|---|
| `TIANTASKS_URL`, `TIANTASKS_TOKEN` | Use this shared board and token, overriding `tt login` |
| `TIANTASKS_DB` | Use this local database file (always wins over a saved shared board) |
| `TIANTASKS_PROJECT` | Default project |
| `TIANTASKS_AGENT` | This session's agent name, e.g. `builder-1` (inside tmux the session name is used automatically) |
| `TIANTASKS_ACTOR` | Who is acting, on a private board |
| `TIANTASKS_DIRECTIVE` | Default `--directive` quote |
| `TIANTASKS_PORT` | Local board port (default 7777) |
| `NO_COLOR` | Turn off colors |
| `TIANTASKS_USERS`, `TIANTASKS_ADMINS` | Server side: the board's logins (`name:token,…`) and who can delete comments |

### Board admin (in `cloudflare/`)

| Command | Does |
|---|---|
| `./deploy.sh` | Ship the current code to the shared board |
| `./tokens list` | Who has access |
| `./tokens add NAME` | Give someone access (prints their token and the setup commands) |
| `./tokens copy NAME` | Copy someone's token to the clipboard |
| `./tokens reset NAME` | New token for someone; the old one stops working |
| `./tokens remove NAME` | Take away someone's access |
