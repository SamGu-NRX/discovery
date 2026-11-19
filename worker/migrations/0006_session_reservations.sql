-- docs/CONTRACT.md 36fbd71: POST /x/sessions/start reserves an active
-- session. reserved_at is set only by that route, so passive ingest sessions
-- (which also write x_sessions rows without a status) never look like a
-- crashed reservation. A reservation with no status 30 minutes later is
-- recorded as status 'crash' at the time it is detected.
ALTER TABLE x_sessions ADD COLUMN reserved_at INTEGER;
CREATE INDEX x_sessions_open_reservations ON x_sessions (account, reserved_at) WHERE reserved_at IS NOT NULL AND status IS NULL;
