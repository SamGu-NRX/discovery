-- The daily loop (docs/KNOWLEDGE.md, "Daily loop"): POST /k/intake files
-- one save, kworker reads it in full, and GET /k/digest returns each
-- finished save's card. Numbered 0021, inside knowledge's 0020+ range.

-- A save's card: the compact summary GET /k/digest returns, at most 4 KiB of
-- JSON, written by kworker with the bundle. Stored as text so the digest
-- concatenates cards without parsing them (Workers Free: 10 ms CPU).
ALTER TABLE bundles ADD COLUMN card_json TEXT;
CREATE INDEX bundles_created ON bundles (created_at);

-- A request to run a job again that arrives while the job is claimed (a new
-- intake body, a bundle whose children changed). completeJob queues it in
-- the same batch that finishes the running attempt, so it is never
-- acknowledged and then lost.
ALTER TABLE knowledge_jobs ADD COLUMN pending_payload TEXT;
ALTER TABLE knowledge_jobs ADD COLUMN pending_deps TEXT;

-- The newest intake of each save: what the daily job posted, by whom, when.
CREATE TABLE intake (
  post_id TEXT PRIMARY KEY,
  intake_sha TEXT NOT NULL CHECK (length(intake_sha) = 64 AND intake_sha NOT GLOB '*[^0-9a-f]*'),
  account TEXT NOT NULL,
  run_id TEXT NOT NULL,
  posts INTEGER NOT NULL CHECK (posts >= 0),
  received_at INTEGER NOT NULL,
  first_received_at INTEGER NOT NULL
);

-- One model call per save, at the end of its bundle job: a label, why it
-- matters to Sam, and one action. Haiku first, as the gate is.
INSERT INTO capabilities (step, rank, provider, model, runs_on, quota_per_day, prompt_v, enabled, note) VALUES
  ('save_verdict', 1, 'cliproxy', 'claude-haiku-5-5', 'kworker', NULL, 'save-verdict-v1', 1, NULL),
  ('save_verdict', 2, 'gemini', 'gemini-3.5-flash-lite', 'worker', 500, 'save-verdict-v1', 1, 'free-tier quota unverified');
