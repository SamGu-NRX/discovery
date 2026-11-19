-- docs/CONTRACT.md as of 10b06ac. Additive only.

-- One row per ingested batch_id. The ingest batch inserts these first, with a
-- random id for the request (request_id); every later statement in the same
-- D1 batch only processes batches whose row carries that request_id. A
-- replayed batch_id keeps its first request_id, so a retry writes no
-- sightings and moves no counter.
CREATE TABLE x_ingest_batches (
  batch_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  account TEXT NOT NULL,
  session_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

ALTER TABLE x_sightings ADD COLUMN batch_id TEXT;

-- Random per claim; a reclaim replaces it, so only the current lease holder
-- can complete. NULL when the candidate is not claimed.
ALTER TABLE candidates ADD COLUMN lease_token TEXT;
