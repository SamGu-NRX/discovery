// Candidates are the runner's work queue. A claim leases rows the way jobs
// are leased (src/index.ts claimJob): one UPDATE picks and takes them, an
// expired lease can be taken by the next claimant, and only the current
// lease holder can complete.

import type { Env } from "./check";
import { fail, HttpError, isStr, oneOf, optStr, str, utcDayStart } from "./http";

const KINDS = ["x_post", "watcher_event"] as const;
const FINAL_STATES = ["proposed", "done", "skipped", "failed"] as const;

// docs/CONTRACT.md, "Scoring and candidates": unbookmarked candidates are
// capped at 15 a day. Enforced here as well as in the runner, so a runner bug
// cannot flood the queue.
export const UNBOOKMARKED_DAILY_CAP = 15;

// A candidate whose lease has expired this many times is failed instead of
// handed out again, so one input that kills the runner cannot loop forever.
export const MAX_ATTEMPTS = 3;

const MAX_LIMIT = 10;
const MAX_TTL_S = 3600;

interface CandidateRow {
  id: string;
  kind: string;
  ref: string;
  title: string;
  url: string | null;
  score: number | null;
  score_parts_json: string | null;
  state: string;
  owner: string | null;
  lease_until: number | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  note: string | null;
  origin: string;
}

export function present(row: CandidateRow) {
  const { score_parts_json, ...rest } = row;
  return { ...rest, score_parts: score_parts_json ? JSON.parse(score_parts_json) : null };
}

export async function createCandidate(env: Env, b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const kind = oneOf(b.kind, KINDS, "kind");
  const ref = str(b.ref, "ref", 300);
  const title = str(b.title, "title", 500);
  const url = optStr(b.url, "url", 2000);
  if (b.score !== undefined && b.score !== null && typeof b.score !== "number") fail("score must be a number or null");
  const score = (b.score as number | null | undefined) ?? null;
  const parts = b.score_parts === undefined ? null : JSON.stringify(b.score_parts);
  const now = Date.now();

  let bookmarked = true;
  if (kind === "x_post") {
    const post = await env.DB.prepare("SELECT bookmarked FROM x_posts WHERE id = ?").bind(ref).first<{ bookmarked: number }>();
    if (!post) throw new HttpError(404, `x_post candidate ref ${ref} is not an ingested post`);
    bookmarked = post.bookmarked === 1;
  }
  const capped = kind === "x_post" && !bookmarked;

  // One statement: the cap check and the insert cannot interleave with
  // another claimant's insert.
  const row = await env.DB.prepare(
    `INSERT INTO candidates (id, kind, ref, title, url, score, score_parts_json, state, created_at, updated_at, origin)
     SELECT lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, 'new', ?7, ?7, 'runner'
     WHERE NOT ?8 OR (SELECT count(*) FROM candidates c
                      WHERE c.origin = 'runner' AND c.kind = 'x_post' AND c.created_at >= ?9
                        AND NOT EXISTS (SELECT 1 FROM x_posts p WHERE p.id = c.ref AND p.bookmarked = 1)) < ?10
     ON CONFLICT (kind, ref) DO NOTHING
     RETURNING *`,
  )
    .bind(kind, ref, title, url, score, parts, now, capped ? 1 : 0, utcDayStart(now), UNBOOKMARKED_DAILY_CAP)
    .first<CandidateRow>();
  if (row) return { status: 201, body: { created: true, candidate: present(row) } };

  const existing = await env.DB.prepare("SELECT * FROM candidates WHERE kind = ? AND ref = ?").bind(kind, ref).first<CandidateRow>();
  if (existing) return { status: 200, body: { created: false, candidate: present(existing) } };
  throw new HttpError(429, `daily cap reached: ${UNBOOKMARKED_DAILY_CAP} unbookmarked x_post candidates already created today (UTC)`);
}

export async function claimCandidates(env: Env, b: Record<string, unknown>) {
  const owner = str(b.owner, "owner", 200);
  const ttl = b.ttl_s;
  if (typeof ttl !== "number" || !(ttl > 0) || ttl > MAX_TTL_S) fail(`ttl_s must be a number in (0, ${MAX_TTL_S}]`);
  const limit = b.limit === undefined ? 1 : b.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) fail("limit must be a positive integer");
  const now = Date.now();
  const db = env.DB;
  // Explicit signals (bookmarks, watcher matches) have no score and go
  // first, then the highest scores, oldest first within each.
  const [, claimed] = await db.batch<CandidateRow>([
    db
      .prepare(
        `UPDATE candidates SET state = 'failed', owner = NULL, lease_until = NULL, updated_at = ?1,
           note = 'lease expired after ' || attempts || ' attempts'
         WHERE state = 'claimed' AND lease_until < ?1 AND attempts >= ?2`,
      )
      .bind(now, MAX_ATTEMPTS),
    db
      .prepare(
        `UPDATE candidates SET state = 'claimed', owner = ?1, lease_until = ?2, attempts = attempts + 1, updated_at = ?3
         WHERE id IN (
           SELECT id FROM candidates
           WHERE state = 'new' OR (state = 'claimed' AND lease_until < ?3)
           ORDER BY score IS NOT NULL, score DESC, created_at, id
           LIMIT ?4)
         RETURNING *`,
      )
      .bind(owner, now + ttl * 1000, now, Math.min(limit, MAX_LIMIT)),
  ]);
  return { candidates: claimed.results.map(present) };
}

export async function completeCandidate(env: Env, id: string, b: Record<string, unknown>) {
  const owner = str(b.owner, "owner", 200);
  const state = oneOf(b.state, FINAL_STATES, "state");
  const note = optStr(b.note, "note", 2000);
  const row = await env.DB.prepare(
    `UPDATE candidates SET state = ?3, note = coalesce(?4, note), owner = ?2, lease_until = NULL, updated_at = ?5
     WHERE id = ?1 AND owner = ?2 AND state = 'claimed'
     RETURNING *`,
  )
    .bind(id, owner, state, note, Date.now())
    .first<CandidateRow>();
  if (row) return present(row);
  const exists = await env.DB.prepare("SELECT state, owner FROM candidates WHERE id = ?").bind(id).first<{ state: string; owner: string | null }>();
  if (!exists) throw new HttpError(404, `candidate ${id} not found`);
  throw new HttpError(409, `candidate ${id} is not claimed by ${owner} (state ${exists.state}${exists.owner ? `, owner ${exists.owner}` : ""})`);
}

export async function listCandidates(env: Env, url: URL) {
  const state = url.searchParams.get("state");
  const kind = url.searchParams.get("kind");
  if (state !== null && !isStr(state)) fail("state must be non-empty");
  const rows = await env.DB.prepare(
    `SELECT * FROM candidates WHERE (?1 IS NULL OR state = ?1) AND (?2 IS NULL OR kind = ?2)
     ORDER BY created_at DESC, id LIMIT 500`,
  )
    .bind(state, kind)
    .all<CandidateRow>();
  return { candidates: rows.results.map(present) };
}
