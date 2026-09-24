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
