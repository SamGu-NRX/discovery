-- Times are Unix epoch milliseconds.

CREATE TABLE watchers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('atom', 'greenhouse', 'hn', 'page', 'youtube_page')),
  url TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  -- Hash of the sorted item ids (feeds) or of the normalized visible text (pages).
  -- NULL until the first successful fetch seeds state.
  fingerprint TEXT,
  next_check_at INTEGER NOT NULL,
  interval_s INTEGER NOT NULL,
  hot_interval_s INTEGER NOT NULL,
  -- How long a hot trigger keeps the short interval.
  hot_window_s INTEGER NOT NULL,
  hot_until INTEGER,
  -- Case-insensitive regex tested against new item titles or changed page text.
  hot_rule TEXT,
  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'hot')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Per-item identity, so a feed that reorders or rewrites old entries emits nothing.
CREATE TABLE seen_items (
  watcher_id TEXT NOT NULL REFERENCES watchers(id),
  item_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (watcher_id, item_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  -- Poll and push paths build the same key for the same item, so a second
  -- delivery fails the insert and nothing downstream runs.
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  input TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed', 'done', 'failed')),
  owner TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  output TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX jobs_claimable ON jobs (type, state, lease_until);

-- One triage job per event, in the same transaction as the event insert. An
-- INSERT OR IGNORE that hits the dedupe_key constraint inserts no row, so it
-- fires nothing.
CREATE TRIGGER events_enqueue AFTER INSERT ON events
BEGIN
  INSERT INTO jobs (type, input, created_at) VALUES ('triage', json_object('event_id', NEW.id), NEW.ts);
END;

CREATE TABLE fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('alarm', 'manual', 'backstop', 'push')),
  -- HTTP status of the source response; 0 for a network error; NULL for push deliveries.
  status INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  -- 1 when the request carried If-None-Match or If-Modified-Since.
  conditional INTEGER NOT NULL DEFAULT 0,
  -- seeded | not_modified | same_fingerprint | changed | error | bad_signature | delivered
  outcome TEXT NOT NULL,
  changed INTEGER NOT NULL,
  items_seen INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  -- Every outbound request made during this check, counted at the single fetch wrapper.
  subrequests INTEGER NOT NULL DEFAULT 0,
  -- Outbound requests whose host is a model API. Measured, not assumed.
  model_calls INTEGER NOT NULL DEFAULT 0,
  next_interval_s INTEGER,
  mode TEXT,
  error TEXT
);
CREATE INDEX fetch_log_watcher ON fetch_log (watcher_id, ts);

CREATE TABLE websub_subscriptions (
  watcher_id TEXT PRIMARY KEY REFERENCES watchers(id),
  topic TEXT NOT NULL,
  hub TEXT NOT NULL,
  callback TEXT NOT NULL,
  -- pending_subscribe | subscribed | pending_unsubscribe | unsubscribed
  state TEXT NOT NULL,
  lease_until INTEGER,
  updated_at INTEGER NOT NULL
);
