/** SQLite schema for the control plane. Idempotent DDL (safe to run on every open). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task (
  id          TEXT PRIMARY KEY,
  definition  TEXT NOT NULL,
  state       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_state ON task(state);

-- Append-only audit + recovery spine. Never UPDATE or DELETE rows here.
CREATE TABLE IF NOT EXISTS task_event (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  TEXT NOT NULL,
  at       INTEGER NOT NULL,
  type     TEXT NOT NULL,
  data     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_task ON task_event(task_id);

CREATE TABLE IF NOT EXISTS run (
  run_id        TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  worker_id     TEXT NOT NULL,
  backend_id    TEXT NOT NULL,
  run_spec      TEXT NOT NULL,
  native_handle TEXT,            -- JSON; NULL while 'dispatching' (handle not captured yet)
  state         TEXT NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_task ON run(task_id);
CREATE INDEX IF NOT EXISTS idx_run_state ON run(state);

CREATE TABLE IF NOT EXISTS run_result (
  run_id    TEXT PRIMARY KEY,
  result    TEXT NOT NULL,
  stored_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  reviewer_worker_id TEXT,
  verdict            TEXT NOT NULL,
  findings           TEXT NOT NULL,
  at                 INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS escalation (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  raised_to  TEXT NOT NULL,
  status     TEXT NOT NULL,
  resolution TEXT,
  at         INTEGER NOT NULL
);

-- Durable per-task operator/retry state (preferred worker, revision notes,
-- revise branch, operator notes). Lives here -- not in control-plane memory --
-- so it survives a daemon restart ("the platform is the source of truth").
CREATE TABLE IF NOT EXISTS task_meta (
  task_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, key)
);

CREATE TABLE IF NOT EXISTS metric (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  name   TEXT NOT NULL,
  value  REAL NOT NULL,
  labels TEXT
);
`;
