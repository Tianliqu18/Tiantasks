CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('task', 'issue')),
  num         INTEGER NOT NULL,
  project     TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'doing', 'done')),
  priority    TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  assignee    TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (kind, num)
);
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  ref     TEXT NOT NULL,
  title   TEXT NOT NULL,
  project TEXT NOT NULL,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_item ON events (item_id);
CREATE INDEX IF NOT EXISTS events_ref ON events (ref);
CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_item ON attachments (item_id);
CREATE TABLE IF NOT EXISTS comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL,
  ref             TEXT NOT NULL,
  parent_id       INTEGER,
  author          TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  deleted_at      TEXT,
  deleted_by      TEXT,
  legacy_event_id INTEGER UNIQUE
);
CREATE INDEX IF NOT EXISTS comments_ref ON comments (ref);
-- Agents (chats, bots) and the person each one works for. Reported by the agents themselves or
-- by an adapter that watches them; the principal always comes from the login that reported it.
CREATE TABLE IF NOT EXISTS agents (
  name        TEXT PRIMARY KEY,
  principal   TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '',
  host        TEXT NOT NULL DEFAULT '',
  project     TEXT NOT NULL DEFAULT '',
  initiative  TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT '',
  doing       TEXT NOT NULL DEFAULT '',
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  state_since TEXT
);
-- Initiatives: bigger pieces of work, each owned by an agent that runs it.
CREATE TABLE IF NOT EXISTS initiatives (
  slug       TEXT PRIMARY KEY,
  project    TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active',
  owner      TEXT NOT NULL DEFAULT '',
  principal  TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Free-form fields on items (e.g. initiative, preview, pr), so integrations need no schema change.
CREATE TABLE IF NOT EXISTS item_fields (
  item_id INTEGER NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (item_id, key)
);
-- Checkpoints: short milestone updates on an item and/or an initiative.
CREATE TABLE IF NOT EXISTS checkpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ref        TEXT NOT NULL DEFAULT '',
  initiative TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL,
  principal  TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  link       TEXT NOT NULL DEFAULT '',
  attachment INTEGER,
  source     TEXT NOT NULL DEFAULT 'agent',
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_ref ON checkpoints (ref);
CREATE INDEX IF NOT EXISTS checkpoints_initiative ON checkpoints (initiative);
-- Flags (a note that must reach whoever runs something) and asks (an agent needs a person),
-- with delivery receipts: sent -> delivered -> acked.
CREATE TABLE IF NOT EXISTS flags (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL DEFAULT 'flag',
  ref            TEXT NOT NULL DEFAULT '',
  initiative     TEXT NOT NULL DEFAULT '',
  to_name        TEXT NOT NULL,
  from_actor     TEXT NOT NULL,
  from_principal TEXT NOT NULL DEFAULT '',
  text           TEXT NOT NULL,
  urgent         INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'sent',
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  delivered_at   TEXT,
  acked_at       TEXT,
  escalated_at   TEXT
);
CREATE INDEX IF NOT EXISTS flags_to ON flags (to_name, status);
-- "A person told me to": the quoted instruction an agent acted on, checked against its chat.
CREATE TABLE IF NOT EXISTS directives (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  principal  TEXT NOT NULL DEFAULT '',
  ref        TEXT NOT NULL DEFAULT '',
  what       TEXT NOT NULL DEFAULT '',
  quote      TEXT NOT NULL,
  verified   INTEGER,
  checked_at TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS directives_ref ON directives (ref);
-- Bumped by writes that don't add an event, so /api/version still moves.
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO comments (item_id, ref, author, body, created_at, legacy_event_id)
  SELECT item_id, ref, actor, detail, at, id FROM events WHERE action = 'commented';
