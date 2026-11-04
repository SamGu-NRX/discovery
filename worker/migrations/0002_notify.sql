-- Rule-matched events become notifications to the T3 webhook. Approvals are
-- meant to be rare, so a daily cap and a pause switch sit in front of the POST.

-- Case-insensitive regex tested against new item titles, seeded item titles
-- and changed page text. A match notifies but does not shorten the interval;
-- hot_rule does that (and a hot_rule match also notifies).
ALTER TABLE watchers ADD COLUMN notify_rule TEXT;

-- 1: every new item notifies (YouTube uploads). Unlike notify_rule, this
-- does not apply to seeded items; "30 videos already exist" is not news.
ALTER TABLE watchers ADD COLUMN notify_all_new INTEGER NOT NULL DEFAULT 0;

-- Tried when url fails (non-2xx, non-304, or a network error). Used for
-- YouTube: the channel Atom feed has returned 404 since 2026-11-04, so the
-- watcher falls back to the /videos tab. Both produce "yt:video:<id>" items
-- and only unseen ids emit, so switching sources is mostly silent. The feed
-- also lists Shorts, which the /videos tab omits, so the first fetch after
-- the feed recovers can emit recent Shorts.
ALTER TABLE watchers ADD COLUMN fallback_url TEXT;
ALTER TABLE watchers ADD COLUMN fallback_kind TEXT;

-- 'primary' or 'fallback': which URL produced this row's status and bytes.
ALTER TABLE fetch_log ADD COLUMN source TEXT;

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Sent as body.event_id; the T3 task deduplicates on it. Derived from the
  -- included events' dedupe keys, so it survives a database rebuild.
  event_id TEXT NOT NULL UNIQUE,
  watcher_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  -- UTC date, for the daily cap.
  day TEXT NOT NULL,
  -- pending | sent | failed | capped | paused
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- HTTP status of the most recent POST; 0 for a network error.
  last_status INTEGER,
  last_error TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_day ON notifications (day, state);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  cron TEXT NOT NULL,
  overdue_checked INTEGER NOT NULL,
  notifications_retried INTEGER NOT NULL
);
