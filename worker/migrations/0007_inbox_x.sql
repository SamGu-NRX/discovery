-- POST /inbox/x (docs/CONTRACT.md, "POST /inbox/x"): posts a scheduled
-- GrokBot run reads through its X plugin. Additive only. These rows never
-- reach x_posts, x_sightings or candidates; for now they are read only through
-- GET /admin/inbox/x.

-- One row per accepted request. (run_id, part) is the idempotency key: a
-- repeat inserts nothing here, and the item insert only copies items from a
-- row carrying this request's request_id, so a repeat writes no items either.
-- body is the request exactly as received, so anything the item columns lose
-- can still be read back.
CREATE TABLE inbox_x_parts (
  run_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  parts INTEGER NOT NULL,
  account TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  body_bytes INTEGER NOT NULL,
  -- SHA-256 hex of the body, so a repeat with different content can be told
  -- apart from a plain retry.
  body_sha256 TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (run_id, part)
);
CREATE INDEX inbox_x_parts_received ON inbox_x_parts (received_at);

CREATE TABLE inbox_x_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('bookmarks', 'home', 'thread')),
  -- On surface 'thread' only, how the post relates to the bookmark: self (the
  -- author's self-thread), reply, quote, or link (it links the status URL).
  relation TEXT CHECK (relation IS NULL OR relation IN ('reply', 'quote', 'link', 'self')),
  position INTEGER NOT NULL,
  post_id TEXT NOT NULL,
  url TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  author_name TEXT NOT NULL,
  -- As sent: an ISO 8601 time with a zone, checked by the Worker.
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  quoted_id TEXT,
  -- NULL when the item carried no metrics.
  metrics_json TEXT,
  -- Set only on surface 'thread': the bookmark this post belongs to.
  thread_root_id TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX inbox_x_items_run ON inbox_x_items (run_id, part);
CREATE INDEX inbox_x_items_received ON inbox_x_items (received_at);

-- Requests from the inbox token that were refused (400 or 413), and repeats of
-- an accepted (run_id, part) whose body differs from the stored one (status
-- 200, nothing written). body holds at most the first 64 KB; body_bytes is
-- the full size as far as it was read. run_id and part are filled when the
-- body got far enough to name them.
CREATE TABLE inbox_x_rejects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  status INTEGER NOT NULL,
  error TEXT NOT NULL,
  run_id TEXT,
  part INTEGER,
  body_bytes INTEGER NOT NULL,
  body_truncated INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX inbox_x_rejects_received ON inbox_x_rejects (received_at);

-- GET /admin/x/sightings reads the extension's sightings by seen_at.
CREATE INDEX x_sightings_seen ON x_sightings (seen_at, id);

-- The posts X recommended under a permalink ("Discover more"), in X's order,
-- from the extension's TweetDetail thread. NULL when the extension did not
-- report them. Never part of op_self_thread_ids or reply_ids.
ALTER TABLE x_threads ADD COLUMN related_ids_json TEXT;
