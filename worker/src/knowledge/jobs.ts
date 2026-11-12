// kworker's job queue. The lease is the pattern in src/candidates.ts: one
// UPDATE picks and leases rows under a fresh random lease_token, an expired
// lease goes to the next claimant with a new token, completing needs the
// current token, and the third expired lease fails the job instead of
// handing it out again.

import type { Env } from "../check";
import { json, randomHex } from "../http";
import { choice, invalid, jsonField, KError, list, optText, parsed, text } from "./common";

const KINDS = ["save", "link", "image", "video", "bundle"] as const;
const COMPLETE_STATES = ["done", "failed", "queued"] as const;
const STATES = ["queued", "claimed", "done", "failed"] as const;

const MAX_EXPIRED_LEASES = 3;
const MAX_TTL_S = 3600;
const MAX_CLAIM = 10;
const MAX_DEPS = 100;
const PAYLOAD_MAX = 32 * 1024;
const RESULT_MAX = 32 * 1024;

interface JobRow {
  id: string;
  kind: string;
  key: string;
  payload: string;
  deps: string;
  state: string;
  owner: string | null;
  lease_token: string | null;
  lease_until: number | null;
  attempts: number;
  expired_leases: number;
  runs: number;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

// The lease token goes only to the claimant, in the claim response.
function present(row: JobRow) {
  const { lease_token, payload, deps, result, ...rest } = row;
  return { ...rest, payload: parsed(payload), deps: parsed(deps), result: parsed(result) };
}

function ttl(v: unknown): number {
  if (typeof v !== "number" || !(v > 0) || v > MAX_TTL_S) invalid(`ttl_s must be a number in (0, ${MAX_TTL_S}]`);
  return v;
}

export async function createJob(env: Env, b: Record<string, unknown>): Promise<Response> {
  const kind = choice(b.kind, KINDS, "kind");
  const key = text(b.key, "key", 512);
  if (b.payload === undefined) invalid("payload must be set (any JSON value)");
  const payload = jsonField(b.payload, "payload", PAYLOAD_MAX);
  const deps = (b.deps === undefined ? [] : list(b.deps, "deps", MAX_DEPS, 0)).map((d, i) => text(d, `deps[${i}]`, 64));
  if (b.again !== undefined && typeof b.again !== "boolean") invalid("again must be true or false");
  const depsJson = JSON.stringify(deps);

  if (deps.length) {
    const unknown = await env.DB.prepare("SELECT value FROM json_each(?1) WHERE value NOT IN (SELECT id FROM knowledge_jobs)").bind(depsJson).all<{ value: string }>();
    if (unknown.results.length) throw new KError(422, "unknown_dep", `deps names jobs that do not exist: ${unknown.results.map((r) => r.value).join(", ")}`);
  }

  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT INTO knowledge_jobs (id, kind, key, payload, deps, state, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6)
     ON CONFLICT (kind, key) DO NOTHING RETURNING *`,
  )
    .bind(randomHex(16), kind, key, payload, depsJson, now)
    .first<JobRow>();
  if (inserted) return json({ created: true, requeued: false, job: present(inserted) }, 201);

  const existing = (await env.DB.prepare("SELECT * FROM knowledge_jobs WHERE kind = ? AND key = ?").bind(kind, key).first<JobRow>())!;
  if (b.again !== true || (existing.state !== "done" && existing.state !== "failed")) return json({ created: false, requeued: false, job: present(existing) });
  if (deps.includes(existing.id)) throw new KError(422, "dep_cycle", `deps must not name the job itself (${existing.id})`);
  // expired_leases restarts, or a job failed for lease expiry would fail at
  // its next expiry. attempts keeps counting across runs.
  const requeued = await env.DB.prepare(
    `UPDATE knowledge_jobs SET state = 'queued', payload = ?2, deps = ?3, runs = runs + 1, expired_leases = 0,
       owner = NULL, lease_token = NULL, lease_until = NULL, result = NULL, error = NULL, updated_at = ?4
     WHERE id = ?1 AND state IN ('done', 'failed') RETURNING *`,
  )
    .bind(existing.id, payload, depsJson, now)
    .first<JobRow>();
  // Null only if another request requeued it between the two statements.
  const row = requeued ?? (await env.DB.prepare("SELECT * FROM knowledge_jobs WHERE id = ?").bind(existing.id).first<JobRow>())!;
  return json({ created: false, requeued: requeued !== null, job: present(row) });
}

export async function claimJobs(env: Env, b: Record<string, unknown>) {
  const owner = text(b.owner, "owner", 200);
  const kinds = list(b.kinds, "kinds", KINDS.length).map((k, i) => choice(k, KINDS, `kinds[${i}]`));
  const ttlMs = Math.round(ttl(b.ttl_s) * 1000);
  const limit = b.limit === undefined ? 1 : b.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_CLAIM) invalid(`limit must be an integer from 1 to ${MAX_CLAIM}`);
  const now = Date.now();
  const db = env.DB;
  // A dep that is neither done nor failed (or is missing) holds the job back.
  // Least-attempted first, so a job handed back with state "queued" goes
  // behind ones never tried.
  const [, claimed] = await db.batch<JobRow>([
    db
      .prepare(
        `UPDATE knowledge_jobs SET state = 'failed', owner = NULL, lease_until = NULL, lease_token = NULL, updated_at = ?1,
           expired_leases = expired_leases + 1, error = 'lease expired ' || (expired_leases + 1) || ' times'
         WHERE state = 'claimed' AND lease_until < ?1 AND expired_leases + 1 >= ?2`,
      )
      .bind(now, MAX_EXPIRED_LEASES),
    db
      .prepare(
        `UPDATE knowledge_jobs SET state = 'claimed', owner = ?1, lease_until = ?2, attempts = attempts + 1, updated_at = ?3,
           lease_token = lower(hex(randomblob(16))), expired_leases = expired_leases + (state = 'claimed')
         WHERE id IN (
           SELECT j.id FROM knowledge_jobs j
           WHERE (j.state = 'queued' OR (j.state = 'claimed' AND j.lease_until < ?3))
             AND j.kind IN (SELECT value FROM json_each(?5))
             AND NOT EXISTS (
               SELECT 1 FROM json_each(j.deps) d LEFT JOIN knowledge_jobs dj ON dj.id = d.value
               WHERE dj.state IS NULL OR dj.state NOT IN ('done', 'failed'))
           ORDER BY j.attempts, j.created_at, j.id
           LIMIT ?4)
         RETURNING *`,
      )
      .bind(owner, now + ttlMs, now, limit, JSON.stringify(kinds)),
  ]);
  const jobs = claimed.results
    .sort((a, b) => a.attempts - b.attempts || a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
    .map((r) => ({ id: r.id, kind: r.kind, key: r.key, payload: parsed(r.payload), lease_token: r.lease_token, lease_until: r.lease_until, attempts: r.attempts, runs: r.runs }));
  return { jobs };
}

async function leaseRefusal(env: Env, id: string, owner: string): Promise<never> {
  const row = await env.DB.prepare("SELECT state, owner FROM knowledge_jobs WHERE id = ?").bind(id).first<{ state: string; owner: string | null }>();
  if (!row) throw new KError(404, "job_missing", `job ${id} does not exist`);
  throw new KError(409, "lease_lost", `lease_token is not the current lease of job ${id} for owner ${owner} (state ${row.state}${row.owner ? `, owner ${row.owner}` : ""})`);
}

// Extends the lease while the token is still current, which includes an
// expired lease nobody has reclaimed yet: refusing that would make a slow
// kworker drop work nobody else has taken.
export async function heartbeatJob(env: Env, id: string, b: Record<string, unknown>) {
  const owner = text(b.owner, "owner", 200);
  const token = text(b.lease_token, "lease_token", 64);
  const now = Date.now();
  const row = await env.DB.prepare(
    `UPDATE knowledge_jobs SET lease_until = ?4, updated_at = ?5
     WHERE id = ?1 AND owner = ?2 AND lease_token = ?3 AND state = 'claimed' RETURNING id, lease_until`,
  )
    .bind(id, owner, token, now + Math.round(ttl(b.ttl_s) * 1000), now)
    .first<{ id: string; lease_until: number }>();
  return row ?? leaseRefusal(env, id, owner);
}

export async function completeJob(env: Env, id: string, b: Record<string, unknown>) {
  const owner = text(b.owner, "owner", 200);
  const token = text(b.lease_token, "lease_token", 64);
  const state = choice(b.state, COMPLETE_STATES, "state");
  const result = b.result === undefined ? null : jsonField(b.result, "result", RESULT_MAX);
  const error = optText(b.error, "error", 4000);
  // "queued" hands the job back: it clears the owner and keeps attempts. A
  // final state keeps who finished it.
  const row = await env.DB.prepare(
    `UPDATE knowledge_jobs SET state = ?3, result = ?4, error = ?5, owner = CASE WHEN ?3 = 'queued' THEN NULL ELSE ?2 END,
       lease_until = NULL, lease_token = NULL, updated_at = ?6
     WHERE id = ?1 AND owner = ?2 AND lease_token = ?7 AND state = 'claimed' RETURNING *`,
  )
    .bind(id, owner, state, result, error, Date.now(), token)
    .first<JobRow>();
  return row ? present(row) : leaseRefusal(env, id, owner);
}

export async function listJobs(env: Env, url: URL) {
  const q = (name: string) => {
    const v = url.searchParams.get(name);
    return v === null || v === "" ? null : v;
  };
  const kind = q("kind");
  const state = q("state");
  if (kind !== null) choice(kind, KINDS, "kind");
  if (state !== null) choice(state, STATES, "state");
  const rows = await env.DB.prepare(
    `SELECT * FROM knowledge_jobs WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR state = ?2) AND (?3 IS NULL OR key = ?3)
     ORDER BY created_at DESC, id LIMIT 200`,
  )
    .bind(kind, state, q("key"))
    .all<JobRow>();
  return { jobs: rows.results.map(present) };
}

