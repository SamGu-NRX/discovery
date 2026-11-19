-- X knowledge store (docs/KNOWLEDGE.md, "D1 tables"). Numbered from 0020
-- because the hub branch takes 0009 onward. Every byte lives in R2
-- (binding KNOWLEDGE, bucket x-knowledge); these tables index it.

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK (size >= 0),
  mime TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  -- A later Drive copy of a video master; nothing reads it.
  cold_ref TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE fetches (
  url_hash TEXT PRIMARY KEY CHECK (length(url_hash) = 64 AND url_hash NOT GLOB '*[^0-9a-f]*'),
  canonical_url TEXT NOT NULL,
  final_url TEXT,
  etag TEXT,
  last_modified TEXT,
  content_sha TEXT REFERENCES blobs (sha256),
  mime TEXT,
  http_status INTEGER,
  rung INTEGER NOT NULL CHECK (rung BETWEEN 0 AND 7),
  status TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'blocked', 'error')),
  immutable INTEGER NOT NULL DEFAULT 0 CHECK (immutable IN (0, 1)),
  note TEXT,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE derivations (
  input_sha TEXT NOT NULL CHECK (length(input_sha) = 64 AND input_sha NOT GLOB '*[^0-9a-f]*'),
  step TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_v TEXT NOT NULL,
  output_sha TEXT NOT NULL REFERENCES blobs (sha256),
  input_tokens INTEGER,
  output_tokens INTEGER,
  ms INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (input_sha, step, provider, model, prompt_v)
);
-- used_today: derivations per provider and model since the UTC day began.
CREATE INDEX derivations_usage ON derivations (provider, model, created_at);

CREATE TABLE verdicts (
  item_kind TEXT NOT NULL CHECK (item_kind IN ('reply', 'quote', 'upstream', 'linking', 'link')),
  item_id TEXT NOT NULL,
  save_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('keep', 'drop')),
  reason TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('rule', 'embed', 'model')),
  score REAL,
  text_sha TEXT NOT NULL,
  gate_v TEXT NOT NULL,
  pack_sha TEXT,
  pack_row INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_kind, item_id, gate_v)
);

-- "jobs" is the watcher queue (0001).
CREATE TABLE knowledge_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('save', 'link', 'image', 'video', 'bundle')),
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  -- JSON array of job ids that must be done or failed before a claim.
  deps TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed', 'done', 'failed')),
  owner TEXT,
  lease_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  expired_leases INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 1,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, key)
);
CREATE INDEX knowledge_jobs_claim ON knowledge_jobs (state, kind, attempts, created_at);
CREATE INDEX knowledge_jobs_lease ON knowledge_jobs (state, lease_until);

CREATE TABLE bundles (
  post_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  r2_key TEXT NOT NULL,
  json_key TEXT NOT NULL,
  md_sha TEXT NOT NULL REFERENCES blobs (sha256),
  json_sha TEXT NOT NULL REFERENCES blobs (sha256),
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial')),
  missing_json TEXT NOT NULL DEFAULT '[]',
  saved_by TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, version)
);

-- One row per post, the latest version's text. rowid is the numeric post id,
-- so replacing a post's row is a rowid lookup rather than a scan.
CREATE VIRTUAL TABLE bundle_search USING fts5 (post_id UNINDEXED, author, body, tokenize = 'porter unicode61 remove_diacritics 2');

CREATE TABLE capabilities (
  step TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  runs_on TEXT NOT NULL CHECK (runs_on IN ('worker', 'kworker')),
  quota_per_day INTEGER CHECK (quota_per_day IS NULL OR quota_per_day >= 0),
  prompt_v TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  note TEXT,
  PRIMARY KEY (step, rank)
);

-- Model ids are from Google's model list on 2026-11-12 (gemini-3.6-flash and
-- gemini-3.5-flash-lite stable; the 2.5 models are deprecated). Google does
-- not publish free-tier daily limits for these models, so every Gemini
-- quota_per_day below is a placeholder, not a measured limit. The workers-ai
-- quota is likewise a guess at a share of the 10,000 daily neurons.
INSERT INTO capabilities (step, rank, provider, model, runs_on, quota_per_day, prompt_v, enabled, note) VALUES
  ('embed', 1, 'workers-ai', '@cf/baai/bge-base-en-v1.5', 'worker', 5000, 'v1', 1, 'POST /embed'),
  ('embed', 2, 'fastembed', 'BAAI/bge-base-en-v1.5', 'kworker', NULL, 'v1', 1, 'local ONNX'),
  ('gate_band', 1, 'cliproxy', 'claude-haiku-5-5', 'kworker', NULL, 'gate-band-v1', 1, NULL),
  ('gate_band', 2, 'gemini', 'gemini-3.5-flash-lite', 'worker', 500, 'gate-band-v1', 1, 'free-tier quota unverified'),
  ('image_read', 1, 'gemini', 'gemini-3.5-flash-lite', 'worker', 500, 'image-read-v1', 1, 'free-tier quota unverified'),
  ('image_read', 2, 'cliproxy', 'claude-haiku-5-5', 'kworker', NULL, 'image-read-v1', 1, NULL),
  ('image_second_read', 1, 'cliproxy', 'gpt-6-luna', 'kworker', NULL, 'image-read-v1', 1, NULL),
  ('image_second_read', 2, 'gemini', 'gemini-3.6-flash', 'worker', 200, 'image-read-v1', 1, 'free-tier quota unverified'),
  ('video_read', 1, 'gemini', 'gemini-3.6-flash', 'worker', 200, 'video-read-v1', 1, 'reads the file; free-tier quota unverified'),
  ('video_read', 2, 'cliproxy', 'claude-haiku-5-5', 'kworker', NULL, 'video-frames-v1', 1, 'reads key frames and transcript, not the file'),
  ('transcribe', 1, 'faster-whisper', 'large-v3-turbo', 'kworker', NULL, 'whisper-v1', 1, NULL);

CREATE TABLE domain_policy (
  host TEXT PRIMARY KEY,
  start_rung INTEGER NOT NULL CHECK (start_rung BETWEEN 0 AND 7),
  notes TEXT,
  updated_at INTEGER NOT NULL
);
