// Device-signed approval requests (docs/APPROVALS.md, "Approval requests"
// and "Deciding"). A proposal whose final step is irreversible gets one
// request once any device has been enrolled. Deciding it needs an ECDSA
// P-256 signature from an enrolled, unrevoked device's Secure Enclave key
// over the request id, inputs_hash, decision, nonce and signing time. No
// bearer token can stand in for that signature.

import { apnsConfigured, push } from "./apns";
import type { Env } from "./check";
import { ExecError, openPr, validatePrSpec } from "./executor";
import { HttpError, intParam, isoUtc, isoUtcOrNull, json, oneOf, randomHex, readText } from "./http";
import { inputsHash } from "./inputs";
import { fromBase64, importDeviceKey, verifyDer } from "./p256";

export const SIGNATURE_SKEW_S = 300;
const ACTION_LABELS: Record<string, string> = {
  submit: "Submit",
  send: "Send",
  post: "Post",
  pay: "Pay",
  rsvp: "RSVP",
  delete: "Delete",
  accept_terms: "Accept terms",
  push: "Push",
  open_pr: "Open PR",
};
const TITLE_MAX = 80;
const LINE_MAX = 110;

interface ProposalForRequest {
  id: string;
  title: string;
  why: string;
  final_step_kind: string | null;
  final_step: string | null;
  inputs_json: string;
  inputs_hash: string;
  expires_at: number | null;
}

interface RequestRow {
  id: string;
  proposal_id: string;
  inputs_hash: string;
  title: string;
  body: string;
  action_label: string;
  project: string | null;
  nonce: string;
  state: string;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  device_id: string | null;
  outcome: string | null;
  result_url: string | null;
  error: string | null;
  stake_json: string | null;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
};

// What the approval puts at stake, as fields the app draws (docs/APPROVALS.md,
// "Wire details" 10). Every value comes from the proposal's inputs, which
// inputs_hash binds, and only in the exact shape listed; anything else is
// left out rather than guessed. For a PR the Worker knows the repository,
// branches and file count before anything is written, but not the diff
// against base, so additions and deletions are not sent.
export interface Stake {
  kind: "pr" | "pay" | "send" | "other";
  repo?: string;
  additions?: number;
  deletions?: number;
  files?: number;
  head?: string;
  base?: string;
  amount?: string;
  currency?: string;
  recipient?: { name: string; handle?: string; avatar_url?: string };
}

function recipientOf(v: unknown): Stake["recipient"] | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 80) return undefined;
  const out: NonNullable<Stake["recipient"]> = { name: r.name };
  if (typeof r.handle === "string" && /^@?[A-Za-z0-9_.-]{1,64}$/.test(r.handle)) out.handle = r.handle;
  if (typeof r.avatar_url === "string" && r.avatar_url.length <= 500 && /^https:\/\/[^\s"<>]+$/.test(r.avatar_url)) out.avatar_url = r.avatar_url;
  return out;
}

export function stakeOf(finalStepKind: string | null, inputs: unknown): Stake {
  const i = (typeof inputs === "object" && inputs !== null && !Array.isArray(inputs) ? inputs : {}) as Record<string, unknown>;
  if (finalStepKind === "open_pr") {
    // createProposal has already run validatePrSpec on these.
    return {
      kind: "pr",
      repo: i.repo as string,
      head: i.head_branch as string,
      base: i.base as string,
      ...(Array.isArray(i.files) ? { files: i.files.length } : {}),
    };
  }
  if (finalStepKind !== "pay" && finalStepKind !== "send") return { kind: "other" };
  const stake: Stake = { kind: finalStepKind };
  if (finalStepKind === "pay" && typeof i.amount === "string" && /^\d{1,12}(\.\d{1,2})?$/.test(i.amount)) stake.amount = i.amount;
  if (finalStepKind === "pay" && typeof i.currency === "string" && /^[A-Z]{3}$/.test(i.currency)) stake.currency = i.currency;
  const recipient = recipientOf(i.recipient);
  if (recipient) stake.recipient = recipient;
  return stake;
}

// APNs refuses a payload over 4096 bytes. The text fields are capped well
// under that; this drops the avatar, then the whole stake, if they ever
// aren't (the app reads the queue for the full request).
export const APNS_MAX_BYTES = 4096;
export function fitPayload(payload: Record<string, unknown> & { stake?: Stake }): Record<string, unknown> {
  const size = (p: unknown) => new TextEncoder().encode(JSON.stringify(p)).byteLength;
  if (size(payload) <= APNS_MAX_BYTES) return payload;
  if (payload.stake?.recipient?.avatar_url) {
    const { avatar_url: _drop, ...recipient } = payload.stake.recipient;
    const smaller = { ...payload, stake: { ...payload.stake, recipient } };
    if (size(smaller) <= APNS_MAX_BYTES) return smaller;
  }
  const { stake: _stake, ...rest } = payload;
  return rest;
}

// The title and at most 3 short lines a lock-screen alert can show. For a PR
// the third line names the repository and branches, so Sam sees where the
// change lands without opening anything.
function describe(p: ProposalForRequest) {
  const kind = p.final_step_kind ?? "";
  const lines = [oneLine(p.why.split("\n")[0], LINE_MAX)];
  if (p.final_step) lines.push(oneLine(p.final_step, LINE_MAX));
  let project: string | null = null;
  if (kind === "open_pr") {
    const i = JSON.parse(p.inputs_json) as { repo: string; base: string; head_branch: string };
    project = i.repo.split("/")[1];
    lines.push(oneLine(`${i.repo}: ${i.head_branch} into ${i.base}`, LINE_MAX));
  }
  return {
    title: oneLine(p.title, TITLE_MAX),
    body: lines.filter(Boolean).slice(0, 3).join("\n"),
    action_label: ACTION_LABELS[kind] ?? kind,
    project,
    stake: stakeOf(p.final_step_kind, JSON.parse(p.inputs_json)),
  };
}

// An INSERT for p's request, taking effect only while some device has been
// enrolled and the proposal is still waiting. Safe to run twice: one request
// per proposal.
export function requestInsert(env: Env, p: ProposalForRequest, now: number) {
  const d = describe(p);
  return env.DB.prepare(
    `INSERT OR IGNORE INTO approval_requests (id, proposal_id, inputs_hash, title, body, action_label, project, nonce, state, created_at, expires_at, stake_json)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11
     WHERE EXISTS (SELECT 1 FROM devices)
       AND EXISTS (SELECT 1 FROM proposals WHERE id = ?2 AND state = 'awaiting_approval' AND inputs_hash = ?3)
     RETURNING *`,
  ).bind("ar_" + randomHex(12), p.id, p.inputs_hash, d.title, d.body, d.action_label, d.project, randomHex(16), now, p.expires_at ?? now, JSON.stringify(d.stake));
}

// Proposals that were waiting before the first device enrolled get their
// requests without a push: they were notified, or capped, the old way.
export async function backfillApprovalRequests(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT p.* FROM proposals p
     WHERE p.state = 'awaiting_approval' AND p.expires_at > ?1 AND p.final_step_kind IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM approval_requests r WHERE r.proposal_id = p.id)
     ORDER BY p.created_at LIMIT 20`,
  )
    .bind(now)
    .all<ProposalForRequest>();
  if (rows.results.length === 0) return 0;
  const done = await env.DB.batch(rows.results.map((p) => requestInsert(env, p, now)));
  return done.filter((r) => r.results.length > 0).length;
}

export async function expireApprovalRequests(env: Env, now: number): Promise<number> {
  const r = await env.DB.prepare("UPDATE approval_requests SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?").bind(now).run();
  return r.meta.changes;
}

export const anyDeviceEver = (env: Env) =>
  env.DB.prepare("SELECT EXISTS (SELECT 1 FROM devices) AS any").first<{ any: number }>().then((r) => r?.any === 1);

// Sends one alert per enrolled, unrevoked device with a live push token.
// Returns sent when at least one device accepted it.
export async function pushRequest(env: Env, r: RequestRow): Promise<"sent" | "failed" | "no_apns"> {
  if (!apnsConfigured(env)) return "no_apns";
  const devices = await env.DB.prepare(
    "SELECT id, apns_token, apns_env FROM devices WHERE revoked_at IS NULL AND apns_invalid_at IS NULL ORDER BY enrolled_at",
  ).all<{ id: string; apns_token: string; apns_env: "development" | "production" }>();
  if (devices.results.length === 0) return "failed";
  const payload = fitPayload({
    aps: {
      alert: { title: r.title, body: r.body },
      category: "APPROVAL",
      "interruption-level": "time-sensitive",
      "mutable-content": 1,
    },
    request_id: r.id,
    inputs_hash: r.inputs_hash,
    nonce: r.nonce,
    expires_at: isoUtc(r.expires_at),
    ...(r.stake_json ? { stake: JSON.parse(r.stake_json) as Stake } : {}),
  });
  const results = await Promise.all(devices.results.map((d) => push(env, d, payload, { expiresAtMs: r.expires_at, collapseId: r.id })));
  const now = Date.now();
  await env.DB.batch([
    ...devices.results.map((d, i) =>
      env.DB.prepare(
        `INSERT INTO approval_pushes (request_id, device_id, status, apns_id, reason, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (request_id, device_id) DO UPDATE SET status = ?3, apns_id = ?4, reason = ?5, sent_at = ?6`,
      ).bind(r.id, d.id, results[i].status, results[i].apnsId, results[i].reason, now),
    ),
    ...devices.results.flatMap((d, i) =>
      results[i].deadToken
        ? [env.DB.prepare("UPDATE devices SET apns_invalid_at = ?2, apns_invalid_reason = ?3 WHERE id = ?1").bind(d.id, now, results[i].reason ?? "Unregistered")]
        : [],
    ),
  ]);
  const ok = results.some((x) => x.status === 200);
  console.log(`[approvals] push ${r.id} to ${devices.results.length} devices: ${results.map((x) => x.status).join(",")}`);
  return ok ? "sent" : "failed";
}


export function presentRequest(r: RequestRow) {
  return {
    id: r.id,
    proposal_id: r.proposal_id,
    inputs_hash: r.inputs_hash,
    title: r.title,
    body: r.body,
    action_label: r.action_label,
    project: r.project,
    stake: r.stake_json ? (JSON.parse(r.stake_json) as Stake) : { kind: "other" },
    nonce: r.nonce,
    state: r.state,
    created_at: isoUtc(r.created_at),
    expires_at: isoUtc(r.expires_at),
    decided_at: isoUtcOrNull(r.decided_at),
    outcome: r.outcome,
    result_url: r.result_url,
    error: r.error,
  };
}

const REQUEST_STATES = ["pending", "approved", "denied", "expired"] as const;

export async function listApprovals(env: Env, url: URL) {
  const state = oneOf(url.searchParams.get("state") ?? "pending", REQUEST_STATES, "state");
  const limit = intParam(url, "limit", 50, 200);
  const now = Date.now();
  // A pending request past its expiry is not pending, even before the cron
  // has marked it.
  const rows = await (state === "pending"
    ? env.DB.prepare("SELECT * FROM approval_requests WHERE state = 'pending' AND expires_at > ?1 ORDER BY created_at LIMIT ?2").bind(now, limit)
    : env.DB.prepare("SELECT * FROM approval_requests WHERE state = ?1 ORDER BY created_at DESC LIMIT ?2").bind(state, limit)
  ).all<RequestRow>();
  return { approvals: rows.results.map(presentRequest) };
}

export async function getApproval(env: Env, id: string) {
  const r = await env.DB.prepare("SELECT * FROM approval_requests WHERE id = ?").bind(id).first<RequestRow>();
  if (!r) throw new HttpError(404, `approval request ${id} not found`);
  return presentRequest(r);
}

// The exact bytes the device signs: UTF-8, fields joined by \n, no trailing
// newline.
export const signedMessage = (requestId: string, inputsHashHex: string, decision: string, nonce: string, signedAt: number) =>
  ["discovery-approval-v1", requestId, inputsHashHex, decision, nonce, String(signedAt)].join("\n");

// A refused decision is { error, message } (docs/APPROVALS.md, "Wire
// details"): error is a machine code naming the failed check, message one
// sentence. Codes, in the order the checks run: bad_request, device_unknown,
// device_revoked, request_not_found, already_decided, request_expired,
// clock_skew, bad_signature, request_not_pending, inputs_changed, then
// already_decided again for a race lost in the final UPDATE.
const refuse = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);

// What an app whose first answer was lost needs to show the outcome.
const decidedExtra = (r: RequestRow) => ({ state: r.state, outcome: r.outcome, ...(r.result_url ? { result_url: r.result_url } : {}) });

function signedAtOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^[1-9][0-9]{0,11}$/.test(v)) return Number(v);
  return null;
}

export async function decideApproval(env: Env, requestId: string, req: Request): Promise<Response> {
  try {
    return await decideChecked(env, requestId, req);
  } catch (e) {
    if (e instanceof HttpError) return refuse(e.status, e.status === 413 ? "body_too_large" : "bad_request", e.message);
    const requestRef = randomHex(8);
    console.error(`[error] ${requestRef} POST /approvals/<id>/decide`, e);
    return refuse(500, "internal_error", `The Worker failed while deciding; quote ${requestRef} when reporting it.`, { request_id: requestRef });
  }
}

async function decideChecked(env: Env, requestId: string, req: Request): Promise<Response> {
  const text = await readText(req, 4096);
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(text);
  } catch {
    return refuse(400, "bad_request", "The body must be a JSON object.");
  }
  if (typeof b !== "object" || b === null || Array.isArray(b)) return refuse(400, "bad_request", "The body must be a JSON object.");
  const extra = Object.keys(b).find((k) => !["device_id", "decision", "signed_at", "signature_der_b64"].includes(k));
  if (extra) return refuse(400, "bad_request", `${extra} is not a field of a decision (allowed: device_id, decision, signed_at, signature_der_b64).`);
  if (typeof b.device_id !== "string" || !/^d_[0-9a-f]{16}$/.test(b.device_id)) return refuse(400, "bad_request", "device_id must be the device_id enrollment returned.");
  if (b.decision !== "approve" && b.decision !== "deny") return refuse(400, "bad_request", 'decision must be "approve" or "deny".');
  const signedAt = signedAtOf(b.signed_at);
  if (signedAt === null) return refuse(400, "bad_request", "signed_at must be Unix seconds, as an integer.");
  const der = typeof b.signature_der_b64 === "string" ? fromBase64(b.signature_der_b64) : null;
  if (!der) return refuse(400, "bad_request", "signature_der_b64 must be the DER signature in standard base64.");
  const decision = b.decision;

  const [devQ, reqQ] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT id, public_key_spki_b64, revoked_at FROM devices WHERE id = ?").bind(b.device_id),
    env.DB.prepare("SELECT * FROM approval_requests WHERE id = ?").bind(requestId),
  ]);
  const device = devQ.results[0] as { id: string; public_key_spki_b64: string; revoked_at: number | null } | undefined;
  const r = reqQ.results[0] as unknown as RequestRow | undefined;
  const now = Date.now();

  // 1. The device exists and is not revoked.
  if (!device) return refuse(403, "device_unknown", `Device ${b.device_id} is not enrolled.`);
  if (device.revoked_at !== null) return refuse(403, "device_revoked", `Device ${b.device_id} was revoked.`);
  // 2. The request exists, is pending and has not expired.
  if (!r) return refuse(404, "request_not_found", `Approval request ${requestId} does not exist.`);
  if (r.state === "approved" || r.state === "denied") return refuse(409, "already_decided", `Approval request ${requestId} was already ${r.state}.`, decidedExtra(r));
  if (r.state === "expired" || r.expires_at <= now) return refuse(410, "request_expired", `Approval request ${requestId} expired at ${isoUtc(r.expires_at)}.`);
  // 3. The signature is fresh.
  const skew = Math.abs(Math.floor(now / 1000) - signedAt);
  if (skew > SIGNATURE_SKEW_S) return refuse(401, "clock_skew", `signed_at is ${skew} s from the Worker's clock; the limit is ${SIGNATURE_SKEW_S} s.`);
  // 4. The signature is valid over the exact message with the stored key.
  const key = await importDeviceKey(device.public_key_spki_b64);
  const message = signedMessage(r.id, r.inputs_hash, decision, r.nonce, signedAt);
  if (!key || !(await verifyDer(key, der, message))) return refuse(401, "bad_signature", "The signature does not verify over this request, decision, nonce and signed_at with the device's key.");

  // The proposal must still be waiting, with exactly the inputs the request binds.
  const p = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(r.proposal_id).first<ProposalForRequest & { state: string }>();
  if (!p || p.state !== "awaiting_approval") return refuse(409, "request_not_pending", `The proposal behind ${requestId} is ${p?.state ?? "gone"}, so nothing can be decided.`);
  if (p.inputs_hash !== r.inputs_hash || (await inputsHash(p.final_step_kind, p.final_step, JSON.parse(p.inputs_json))) !== r.inputs_hash) {
    return refuse(409, "inputs_changed", "The proposal's inputs no longer match the request's inputs_hash; nothing was recorded.");
  }

  // 5. One transaction: the request is decided and its nonce spent only if it
  // is still pending, so a replay or a second device gets 409; the proposal
  // follows only if this UPDATE won.
  // The device must still be unrevoked and the request unexpired when the
  // write happens, not only when the checks above ran: a revoke or an expiry
  // that lands during verification wins.
  const state = decision === "approve" ? "approved" : "denied";
  const at = Date.now();
  const [won, followed] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `UPDATE approval_requests SET state = ?2, decided_at = ?3, device_id = ?4, signed_at = ?5, signature_der_b64 = ?6, nonce_used_at = ?3,
         outcome = CASE WHEN ?2 = 'approved' THEN 'running' END
       WHERE id = ?1 AND state = 'pending' AND expires_at > ?3 AND nonce = ?7 AND inputs_hash = ?8
         AND EXISTS (SELECT 1 FROM devices WHERE id = ?4 AND revoked_at IS NULL)
       RETURNING id`,
    ).bind(r.id, state, at, device.id, signedAt, b.signature_der_b64, r.nonce, r.inputs_hash),
    env.DB.prepare(
      `UPDATE proposals SET state = ?2, decided_at = ?3, result_json = ?4
       WHERE id = ?1 AND state = 'awaiting_approval' AND inputs_hash = ?5 AND expires_at > ?3
         AND EXISTS (SELECT 1 FROM approval_requests WHERE id = ?6 AND decided_at = ?3 AND device_id = ?7 AND signature_der_b64 = ?8)
       RETURNING id`,
    ).bind(
      r.proposal_id,
      state === "approved" ? "approved" : "skipped",
      at,
      JSON.stringify({ decision, inputs_hash: r.inputs_hash, via: "device", device_id: device.id, request_id: r.id }),
      r.inputs_hash,
      r.id,
      device.id,
      b.signature_der_b64,
    ),
  ]);
  if (won.results.length === 0) {
    const [cur, dev] = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare("SELECT * FROM approval_requests WHERE id = ?").bind(r.id),
      env.DB.prepare("SELECT revoked_at FROM devices WHERE id = ?").bind(device.id),
    ]);
    const current = cur.results[0] as unknown as RequestRow | undefined;
    if ((dev.results[0] as { revoked_at: number | null } | undefined)?.revoked_at != null) return refuse(403, "device_revoked", `Device ${device.id} was revoked while deciding.`);
    if (current && current.state === "pending") return refuse(410, "request_expired", `Approval request ${r.id} expired while deciding.`);
    return refuse(409, "already_decided", `Approval request ${r.id} was decided by another call.`, current ? decidedExtra(current) : {});
  }
  console.log(`[approvals] ${r.id} ${state} by ${device.id}`);
  if (state === "denied") return json({ state: "denied" });
  if (followed.results.length === 0) {
    // The proposal changed between the check above and the UPDATE.
    await finish(env, r.id, r.proposal_id, "failed", null, "the proposal was no longer awaiting approval", false);
    return json({ state: "approved", outcome: "failed", outcome_error: "the proposal was no longer awaiting approval" });
  }
  return json(await execute(env, r, p));
}

async function finish(env: Env, requestId: string, proposalId: string, outcome: string, url: string | null, error: string | null, touchProposal = true) {
  const now = Date.now();
  const proposalState = { executed: "executed", failed: "failed", outcome_unknown: "outcome_unknown" }[outcome];
  await env.DB.batch([
    env.DB.prepare("UPDATE approval_requests SET outcome = ?2, result_url = ?3, error = ?4, finished_at = ?5 WHERE id = ?1").bind(requestId, outcome, url, error, now),
    ...(touchProposal && proposalState
      ? [
          env.DB.prepare(
            `UPDATE proposals SET state = ?2, result_json = json_set(coalesce(result_json, '{}'), '$.outcome', ?2, '$.result_url', ?3, '$.error', ?4)
             WHERE id = ?1 AND state = 'approved'`,
          ).bind(proposalId, proposalState, url, error),
        ]
      : []),
  ]);
}

// Runs the proposal's executor once, after the UPDATE that decided the
// request. Only open_pr has one; any other approved step waits, as before.
// The answer's state is the decision, "approved"; outcome says what the
// executor did: executed (with result_url), no_executor, failed (nothing was
// written) or outcome_unknown (a write may have happened).
async function execute(env: Env, r: RequestRow, p: ProposalForRequest): Promise<{ state: "approved"; outcome: string; result_url?: string; outcome_error?: string }> {
  if (p.final_step_kind !== "open_pr") {
    await finish(env, r.id, r.proposal_id, "no_executor", null, null, false);
    return { state: "approved", outcome: "no_executor" };
  }
  try {
    const url = await openPr(env, validatePrSpec(JSON.parse(p.inputs_json)));
    await finish(env, r.id, r.proposal_id, "executed", url, null);
    console.log(`[approvals] ${r.id} executed: ${url}`);
    return { state: "approved", outcome: "executed", result_url: url };
  } catch (e) {
    const wrote = e instanceof ExecError && e.wrote;
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    const outcome = wrote ? "outcome_unknown" : "failed";
    await finish(env, r.id, r.proposal_id, outcome, null, msg);
    console.log(`[approvals] ${r.id} ${outcome}: ${msg}`);
    return { state: "approved", outcome, outcome_error: msg };
  }
}
