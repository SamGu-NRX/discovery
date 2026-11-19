-- Device-signed approvals, the unified inbox, voice notes and the agent
-- bridge (docs/APPROVALS.md). Additive only. Times are Unix epoch ms.

-- An iPhone enrolled with a Secure Enclave P-256 key. Its private key never
-- leaves the phone; only the public key is here.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- DER SubjectPublicKeyInfo of an uncompressed P-256 key, base64.
  public_key_spki_b64 TEXT NOT NULL,
  apns_token TEXT NOT NULL,
  apns_env TEXT NOT NULL CHECK (apns_env IN ('development', 'production')),
  -- SHA-256 of the low-risk bearer token. The token itself is returned once.
  device_token_hash TEXT NOT NULL UNIQUE,
  enrolled_at INTEGER NOT NULL,
  revoked_at INTEGER,
  apns_token_updated_at INTEGER NOT NULL,
  -- Set when APNs said the token is dead (410, or 400 BadDeviceToken);
  -- cleared by the next POST /devices/:id/apns-token.
  apns_invalid_at INTEGER,
  apns_invalid_reason TEXT,
  -- For v1.1 remote Live Activity starts; stored, not used yet.
  push_to_start_token TEXT,
  push_to_start_env TEXT CHECK (push_to_start_env IN ('development', 'production')),
  push_to_start_updated_at INTEGER
);

-- One-time enrollment codes, stored as SHA-256 hashes.
CREATE TABLE device_enroll_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  device_id TEXT
);

-- One per proposal whose final step is irreversible, created while at least
-- one device has been enrolled. A decision needs a device signature over
-- (id, inputs_hash, decision, nonce, signed_at).
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  inputs_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  -- At most 3 short lines joined by \n.
  body TEXT NOT NULL,
  action_label TEXT NOT NULL,
  -- The repository or other project the decision belongs to, for the brief.
  project TEXT,
  nonce TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  device_id TEXT,
  signed_at INTEGER,
  signature_der_b64 TEXT,
  -- Set in the same UPDATE that decides, so a nonce works once.
  nonce_used_at INTEGER,
  -- After an approve: running, executed, no_executor, failed (nothing was
  -- written) or outcome_unknown (a write may have happened).
  outcome TEXT CHECK (outcome IN ('running', 'executed', 'no_executor', 'failed', 'outcome_unknown')),
  result_url TEXT,
  error TEXT,
  finished_at INTEGER
);
CREATE INDEX approval_requests_state ON approval_requests (state, expires_at);

-- One APNs attempt per request and device.
CREATE TABLE approval_pushes (
  request_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  -- HTTP status; 0 for a network error.
  status INTEGER NOT NULL,
  apns_id TEXT,
  reason TEXT,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, device_id)
);

-- Which channel a proposal's notification used: webhook (T3, before any
-- device) or apns.
ALTER TABLE proposals ADD COLUMN notify_channel TEXT;

-- The unified inbox. text is stored exactly as sent. source comes from the
-- token (device:<id>, admin, dot, t3, grok); claimed_source is whatever the
-- body said, kept as data.
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('thought', 'direction', 'task', 'reply', 'agent_push')),
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  claimed_source TEXT,
  refs_json TEXT NOT NULL DEFAULT '[]',
  audio_id TEXT,
  -- For a reply: the inbox item it answers.
  reply_to TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX inbox_items_created ON inbox_items (created_at);
CREATE INDEX inbox_items_reply_to ON inbox_items (reply_to) WHERE reply_to IS NOT NULL;

-- Voice notes. The audio is in R2 (VOICE) under r2_key.
CREATE TABLE voice_notes (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'transcribing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  transcript TEXT,
  error TEXT,
  inbox_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX voice_notes_due ON voice_notes (state, updated_at);

-- The OpenAI-compatible bridge (POST /v1/chat/completions) files its tasks
-- as this agent. It is never woken (it waits on a Durable Object instead),
-- so its results go to nobody's claim. The root cap is a first guess with
-- no traffic behind it; grok's own wake cap (6 a day) still applies.
INSERT INTO mail_agents (name, wake_kind, may_create_root, daily_wake_cap, daily_root_cap) VALUES ('bridge', 'none', 1, 0, 20);
INSERT INTO mail_routes (from_agent, to_agent) VALUES ('bridge', 'dot'), ('bridge', 'grok');
