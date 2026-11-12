-- Routing for Sam's thoughts and the structured stake of an approval
-- (docs/APPROVALS.md, "Wire details" 10 to 13). Additive only.

-- The routing the Worker chose for a device's thought, direction or task:
-- {agent, model, effort, project, kind} as JSON. routing_source is spoken
-- (Sam named the model or effort), table (the routing table chose them) or
-- person (Sam corrected it with POST /inbox/:id/route).
ALTER TABLE inbox_items ADD COLUMN routing_json TEXT;
ALTER TABLE inbox_items ADD COLUMN routing_source TEXT CHECK (routing_source IN ('spoken', 'table', 'person'));
ALTER TABLE inbox_items ADD COLUMN routed_at INTEGER;
-- Set once, by POST /inbox/:id/dispatch, with the mailbox task it filed.
ALTER TABLE inbox_items ADD COLUMN dispatched_at INTEGER;
ALTER TABLE inbox_items ADD COLUMN dispatch_task_id TEXT;

-- What an approval puts at stake, as JSON: {kind, repo?, files?, head?,
-- base?, amount?, currency?, recipient?}. Built from the proposal's inputs,
-- the values its inputs_hash binds.
ALTER TABLE approval_requests ADD COLUMN stake_json TEXT;
