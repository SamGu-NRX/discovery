-- Agent mailbox (docs/CONTRACT.md, "Mailbox"). Additive only. Times are
-- Unix epoch milliseconds. 0007 is taken by the capture-eval branch.
--
-- The Worker is the switchboard: a wake carries only a task id, the woken
-- agent fetches work with mailbox_claim and returns it with mailbox_complete.

CREATE TABLE mail_agents (
  name TEXT PRIMARY KEY,
  -- How the Worker tells this agent there is mail. none: it is never woken.
  wake_kind TEXT NOT NULL CHECK (wake_kind IN ('none', 'mcp_event', 'webhook')),
  -- 1: may send a task with no parent (start a conversation).
  may_create_root INTEGER NOT NULL DEFAULT 0,
  -- Wakes sent to this agent per UTC day, task and result wakes together.
  daily_wake_cap INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Last mailbox_claim by this agent; the probe's evidence that a wake worked.
  last_claim_at INTEGER
);

-- Allowed sender -> receiver pairs. Results do not use routes: they go back
-- to the task's reply_to.
CREATE TABLE mail_routes (
  from_agent TEXT NOT NULL REFERENCES mail_agents(name),
  to_agent TEXT NOT NULL REFERENCES mail_agents(name),
  PRIMARY KEY (from_agent, to_agent)
);

CREATE TABLE mail_tasks (
  id TEXT PRIMARY KEY,
  -- The root task's id.
  conversation_id TEXT NOT NULL,
  parent_id TEXT,
  -- 1 for a root task, parent's hop + 1 below it.
  hop INTEGER NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  -- Who receives the result; NULL when nobody does.
  reply_to TEXT,
  -- Untrusted text, at most 8 KB of UTF-8.
  body TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'done', 'failed', 'declined', 'expired')),
  lease_token TEXT,
  lease_until INTEGER,
  -- Claims so far. A task whose third lease expires becomes 'expired'.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Untrusted text, at most 16 KB of UTF-8.
  result TEXT,
  -- Set when mailbox_claim handed the result to reply_to.
  result_delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (from_agent, idempotency_key)
);
CREATE INDEX mail_tasks_inbox ON mail_tasks (to_agent, state, created_at);
CREATE INDEX mail_tasks_results ON mail_tasks (reply_to, updated_at) WHERE result_delivered_at IS NULL;
CREATE INDEX mail_tasks_conversation ON mail_tasks (conversation_id, created_at);

-- One row per wake: 'task' tells to_agent a task is waiting, 'result' tells
-- reply_to a result is. The brief kept wake columns on mail_tasks; a task
-- can need two wakes to two agents, and the daily cap counts both, so they
-- live here. id is the event id the receiver deduplicates on.
CREATE TABLE mail_wakes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'result')),
  -- pending: not tried yet (also while the mailbox is paused). sending: a
  -- dispatcher holds it. sent | failed | dead (failed MAX times) | capped
  -- (the agent's daily cap was full; never sent, not counted).
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'dead', 'capped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  -- HTTP status of the last attempt; 0 for a network error.
  last_status INTEGER,
  error TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mail_wakes_agent_day ON mail_wakes (agent, created_at);
CREATE INDEX mail_wakes_due ON mail_wakes (state, updated_at);

-- MCP Events subscriptions (developers.openai.com/plugins/build/mcp-events).
-- The secret is ChatGPT's whsec_ signing key, supplied at subscribe time,
-- so it lives here rather than in a Worker secret.
CREATE TABLE mcp_subscriptions (
  -- Derived from agent, url, event name and arguments, as the page asks.
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  event_name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  arguments_json TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (agent, event_name, url)
);

-- A new task wakes its receiver, in the same transaction as the insert.
CREATE TRIGGER mail_task_wake AFTER INSERT ON mail_tasks
BEGIN
  INSERT INTO mail_wakes (id, task_id, agent, kind, state, created_at, updated_at)
  VALUES (NEW.id, NEW.id, NEW.to_agent, 'task', 'pending', NEW.created_at, NEW.created_at);
END;

-- A finished task wakes reply_to, unless that agent's daily cap is full; the
-- result then waits for its next claim. The cap counts every wake this UTC
-- day except capped ones.
CREATE TRIGGER mail_result_wake AFTER UPDATE OF state ON mail_tasks
WHEN NEW.state IN ('done', 'failed', 'declined', 'expired') AND OLD.state = 'claimed' AND NEW.reply_to IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO mail_wakes (id, task_id, agent, kind, state, created_at, updated_at)
  SELECT NEW.id || '_result', NEW.id, a.name, 'result',
         CASE WHEN (SELECT count(*) FROM mail_wakes w
                    WHERE w.agent = a.name AND w.state != 'capped'
                      AND w.created_at >= CAST(strftime('%s', date(NEW.updated_at / 1000, 'unixepoch')) AS INTEGER) * 1000) >= a.daily_wake_cap
              THEN 'capped' ELSE 'pending' END,
         NEW.updated_at, NEW.updated_at
  FROM mail_agents a WHERE a.name = NEW.reply_to AND a.wake_kind != 'none';
END;

-- Caps: no run or incident backs these numbers; they are first guesses from
-- the brief (dot 30, t3 20, grok 6 wakes a day). sam is the admin token and
-- is never woken. grok reads hostile X text, so it may start nothing and no
-- route leaves it.
INSERT INTO mail_agents (name, wake_kind, may_create_root, daily_wake_cap) VALUES
  ('sam', 'none', 1, 0),
  ('dot', 'mcp_event', 1, 30),
  ('t3', 'webhook', 1, 20),
  ('grok', 'webhook', 0, 6);

INSERT INTO mail_routes (from_agent, to_agent) VALUES
  ('sam', 'dot'), ('sam', 't3'),
  ('dot', 't3'), ('dot', 'grok'),
  ('t3', 'grok'), ('t3', 'dot');

-- Starts paused, so deploying opens nothing until the director unpauses.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('mailbox_paused', '1', 0);
