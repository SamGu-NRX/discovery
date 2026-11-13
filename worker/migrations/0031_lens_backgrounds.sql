-- Lens scoring subtracts a background mean before the cosine (docs/LENS.md,
-- "Measured on captured posts"): raw bge cosines put every captured post
-- between about 0.67 and 0.84, so half of all posts sat near two unrelated
-- lenses. One background per account, the mean unit embedding of posts it
-- saw, versioned so each lens records the one its centroid and thresholds
-- were fitted against. Refreshed daily from the account's own posts.
CREATE TABLE lens_backgrounds (
  account TEXT NOT NULL,
  version INTEGER NOT NULL,
  mean_json TEXT NOT NULL,
  -- Posts the mean was taken over, whose sightings, since when.
  posts INTEGER NOT NULL,
  source_account TEXT NOT NULL,
  since INTEGER NOT NULL,
  embed_model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account, version)
);

-- The cron's last background attempt per account, and its error if it
-- failed. The cron tries the account attempted longest ago first, so one
-- that keeps failing does not hold the others back.
CREATE TABLE lens_background_attempts (
  account TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  error TEXT,
  -- D1 calls the cron run made, this attempt's write included (Free allows
  -- 50 per invocation; src/lens-budget.ts).
  d1_calls INTEGER NOT NULL
);

-- The background a lens's centroid and thresholds were fitted against, and
-- where its thresholds came from: 'baseline' (the day-1 For You top 100) or
-- 'exemplars' (before any baseline).
ALTER TABLE lenses ADD COLUMN background_version INTEGER;
ALTER TABLE lenses ADD COLUMN thresholds_source TEXT NOT NULL DEFAULT 'exemplars';

-- The baseline's post texts, so its tastes can be recomputed when the
-- background changes.
ALTER TABLE lens_baselines ADD COLUMN texts_json TEXT;
