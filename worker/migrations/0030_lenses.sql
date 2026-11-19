-- Lenses (docs/LENS.md): an account read by an agent against a one-sentence
-- charter, so X's ranker learns from the reading and the feed it serves back
-- can be measured. Numbered 0030 because the hub branch takes 0009 onward and
-- the knowledge branch 0020 onward.

-- Which lens session saw a sighting, and whether the account follows the
-- author (from X's user object). Both NULL for captures outside a lens.
ALTER TABLE x_sightings ADD COLUMN lens_id TEXT;
ALTER TABLE x_sightings ADD COLUMN author_followed INTEGER;

CREATE TABLE lenses (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  charter TEXT NOT NULL,
  exemplar_ids_json TEXT NOT NULL,
  -- Mean of the exemplars' embeddings, unit length.
  centroid_json TEXT NOT NULL,
  embed_model TEXT NOT NULL,
  -- Cosine to the centroid at or above which a post is opened, glanced at,
  -- and counted as near for purity. From the exemplars' own cosines (median
  -- and 10th percentile); see lens.ts.
  open_at REAL NOT NULL,
  glance_at REAL NOT NULL,
  project_terms_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per post the reader skimmed in a session.
CREATE TABLE reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lens_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('skip', 'glance', 'open')),
  dwell_ms INTEGER NOT NULL,
  taste REAL,
  novelty REAL,
  project REAL,
  -- model or centroid: which labeler decided the action.
  label_source TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE (session_id, post_id)
);
CREATE INDEX reads_lens ON reads (lens_id, at);

-- Metric re-polls for flagged (opened) posts: 1 h, 6 h, 24 h, 72 h and 7 d
-- after the read.
CREATE TABLE lens_repolls (
  lens_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('1h', '6h', '24h', '72h', '7d')),
  due_at INTEGER NOT NULL,
  done_at INTEGER,
  PRIMARY KEY (lens_id, post_id, step)
);
CREATE INDEX lens_repolls_due ON lens_repolls (done_at, due_at);

-- The untouched For You top 100 of a lens account before any steering.
CREATE TABLE lens_baselines (
  lens_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  post_ids_json TEXT NOT NULL,
  tastes_json TEXT NOT NULL,
  purity REAL NOT NULL,
  PRIMARY KEY (lens_id, session_id)
);
