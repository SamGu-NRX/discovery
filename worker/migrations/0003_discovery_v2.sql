-- Discovery v2 (docs/CONTRACT.md, "Tables (additions)"). Additive only: no
-- existing table is dropped or rewritten. Times the Worker sets are Unix epoch
-- milliseconds, like 0001 and 0002; x_posts.created_at is X's own ISO time.

CREATE TABLE x_posts (
  id TEXT PRIMARY KEY,
  author_handle TEXT NOT NULL,
  author_name TEXT,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  lang TEXT,
  conversation_id TEXT,
  in_reply_to_id TEXT,
  quoted_id TEXT,
  retweet_of_id TEXT,
  urls_json TEXT NOT NULL DEFAULT '[]',
  media_json TEXT NOT NULL DEFAULT '[]',
  -- Always the latest values an ingest carried.
  metrics_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  -- One per sighting row.
  seen_count INTEGER NOT NULL DEFAULT 0,
  -- 1 once the post has been seen on the bookmarks surface; never cleared.
  bookmarked INTEGER NOT NULL DEFAULT 0,
  score REAL,
  score_parts_json TEXT,
  scored_at INTEGER
);
CREATE INDEX x_posts_unscored ON x_posts (first_seen_at) WHERE score IS NULL;

CREATE TABLE x_sightings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  account TEXT NOT NULL,
  surface TEXT NOT NULL,
  position INTEGER,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  metrics_json TEXT
);
-- The latest sighting of a post is max(id) for its post_id.
CREATE INDEX x_sightings_post ON x_sightings (post_id, id);
CREATE INDEX x_sightings_account ON x_sightings (account, post_id);

CREATE TABLE x_threads (
  root_id TEXT PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  account TEXT NOT NULL,
  op_self_thread_ids_json TEXT NOT NULL,
  -- Reply ids in the order X's server returned them.
  reply_ids_json TEXT NOT NULL
);

CREATE TABLE x_sessions (
  session_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  mode TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  -- NULL while ingesting; ok | login_wall | rate_limited | challenge | error once reported.
  status TEXT,
  detail TEXT,
  posts INTEGER NOT NULL DEFAULT 0,
  screens INTEGER
);
CREATE INDEX x_sessions_account_status ON x_sessions (account, status, ended_at);

CREATE TABLE positives (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  author_handle TEXT,
  source TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  -- x_post | watcher_event
  kind TEXT NOT NULL CHECK (kind IN ('x_post', 'watcher_event')),
  -- x_post: the post id. watcher_event: "<watcher>:<item id>", the same key
  -- the item's event uses, or the event's dedupe_key for a page change.
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  score REAL,
  score_parts_json TEXT,
  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'claimed', 'proposed', 'done', 'skipped', 'failed')),
  owner TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  note TEXT,
  -- Not in the contract's column list. bookmark: ingest saw the post on the
  -- bookmarks surface. watcher: a watcher rule matched. runner: POST
  -- /candidates; the daily cap of 15 unbookmarked candidates counts these.
  origin TEXT NOT NULL CHECK (origin IN ('bookmark', 'watcher', 'runner')),
  UNIQUE (kind, ref)
);
CREATE INDEX candidates_claimable ON candidates (state, lease_until);
CREATE INDEX candidates_origin_day ON candidates (origin, created_at);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  candidate_ids_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  prepared_json TEXT NOT NULL,
  -- NULL when the proposal has no irreversible step; it is then 'done'.
  final_step_kind TEXT CHECK (final_step_kind IS NULL OR final_step_kind IN
    ('submit', 'send', 'post', 'pay', 'rsvp', 'delete', 'accept_terms', 'push', 'open_pr')),
  final_step TEXT,
  -- Not in the contract's column list: the inputs themselves, so an executor
  -- can act on exactly what was approved and the hash can be re-checked.
  inputs_json TEXT NOT NULL,
  -- SHA-256 of the canonical JSON of {final_step_kind, final_step, inputs}.
  inputs_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('done', 'awaiting_approval', 'approved', 'skipped', 'later', 'expired', 'executed', 'outcome_unknown', 'failed')),
  -- SHA-256 of the approval token. The token itself is never stored.
  approval_token_hash TEXT UNIQUE,
  expires_at INTEGER,
  notified_at INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  result_json TEXT,
  -- Not in the contract's column list. notify_state: pending | sent | failed
  -- | capped | paused | no_webhook, NULL when nothing is awaiting approval.
  -- notify_day is the UTC date of the attempt; pending, sent and failed
  -- count against the daily cap of 3.
  notify_state TEXT,
  notify_day TEXT,
  notify_status INTEGER,
  notify_error TEXT
);
CREATE INDEX proposals_state ON proposals (state, created_at);
CREATE INDEX proposals_notify_day ON proposals (notify_day, notify_state);

-- Backfill: rule matches already recorded become watcher_event candidates,
-- one per matched item, keyed like the events the watcher writes.
INSERT OR IGNORE INTO candidates (id, kind, ref, title, url, state, created_at, updated_at, origin, note)
SELECT lower(hex(randomblob(16))), 'watcher_event', e.watcher_id || ':' || json_extract(i.value, '$.id'),
       coalesce(nullif(json_extract(i.value, '$.title'), ''), json_extract(i.value, '$.url'), e.dedupe_key),
       json_extract(i.value, '$.url'), 'new', e.ts, e.ts, 'watcher', 'backfilled from event ' || e.id
FROM events e, json_each(e.payload, '$.items') i
WHERE e.kind = 'seed.match' AND json_extract(i.value, '$.id') IS NOT NULL;

-- A page watcher's seed match has no item ids.
INSERT OR IGNORE INTO candidates (id, kind, ref, title, url, state, created_at, updated_at, origin, note)
SELECT lower(hex(randomblob(16))), 'watcher_event', e.dedupe_key,
       coalesce(nullif(json_extract(e.payload, '$.items[0].title'), ''), e.dedupe_key), json_extract(e.payload, '$.items[0].url'),
       'new', e.ts, e.ts, 'watcher', 'backfilled from event ' || e.id
FROM events e
WHERE e.kind = 'seed.match' AND json_extract(e.payload, '$.items[0].id') IS NULL;

INSERT OR IGNORE INTO candidates (id, kind, ref, title, url, state, created_at, updated_at, origin, note)
SELECT lower(hex(randomblob(16))), 'watcher_event', e.dedupe_key,
       coalesce(nullif(json_extract(e.payload, '$.title'), ''), json_extract(e.payload, '$.url'), e.dedupe_key),
       json_extract(e.payload, '$.url'), 'new', e.ts, e.ts, 'watcher', 'backfilled from event ' || e.id
FROM events e
WHERE e.kind IN ('item.new', 'page.changed') AND json_extract(e.payload, '$.notify') = 1;
