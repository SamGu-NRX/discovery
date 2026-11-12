-- Hermes Agent (Nous Research): Sam's always-on texting assistant, reached
-- over iMessage. A mailbox agent beside dot, t3 and grok. Additive only.
--
-- Hermes reads hostile text from iMessage, so it gets the dot's caps (the
-- other texting assistant: 30 wakes and 10 new conversations a UTC day) and
-- only these routes: hermes <-> t3 and hermes <-> dot. Nothing it can send
-- reaches an executor: the only executor runs after a device-signed approval
-- (docs/APPROVALS.md), and no mailbox route, tool or token of Hermes'
-- decides one. Like every agent, its body text may not carry /a/ links or
-- token-shaped strings (capability_leak).
--
-- Woken by its webhook adapter: a POST signed X-Hub-Signature-256 (HMAC-
-- SHA256 of the raw body, hex, prefixed sha256=), keyed by
-- MAIL_HERMES_WAKE_SECRET (src/mailbox.ts, webhookFor).
INSERT INTO mail_agents (name, wake_kind, may_create_root, daily_wake_cap, daily_root_cap) VALUES ('hermes', 'webhook', 1, 30, 10);

INSERT INTO mail_routes (from_agent, to_agent) VALUES
  ('hermes', 't3'), ('hermes', 'dot'),
  ('t3', 'hermes'), ('dot', 'hermes');
