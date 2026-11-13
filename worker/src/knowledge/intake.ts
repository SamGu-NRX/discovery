// The daily loop's two ends (docs/KNOWLEDGE.md, "Daily loop").
//
// POST /k/intake: the extension's daily job posts one save at a time
// (schema kintake/1). The Worker checks the shape, stores the body as a
// blob, and files one `save` job per post for kworker. One save per request
// keeps JSON.parse and the hash well inside 10 ms of CPU.
//
// GET /k/digest: each finished save's card since a time, for the morning
// brief. Cards are stored as JSON text and concatenated, never parsed.

import type { Env } from "../check";
import { json, randomHex, readText } from "../http";
import { storeBytes } from "./blobs";
import { postId } from "./bundles";
import { invalid, KError, list, obj, sha256Hex, text } from "./common";

export const INTAKE_MAX_BYTES = 192 * 1024;
const CONTEXT_MAX = 120;
const DIGEST_MAX_BYTES = 30 * 1024;
const DIGEST_LIMIT = 100;

function checkPost(v: unknown, field: string, needsText = true) {
  const p = obj(v, field);
  postId(p.id, `${field}.id`);
  text(p.url, `${field}.url`, 2000);
  text(p.author_handle, `${field}.author_handle`, 100);
  if (needsText && typeof p.text !== "string") invalid(`${field}.text must be a string (empty when the post has none)`);
  if (p.media !== undefined) {
    list(p.media, `${field}.media`, 20, 0).forEach((m, i) => {
      const o = obj(m, `${field}.media[${i}]`);
      if (!["photo", "video", "gif"].includes(o.kind as string)) invalid(`${field}.media[${i}].kind must be photo|video|gif`);
      text(o.url, `${field}.media[${i}].url`, 2000);
    });
  }
  if (p.links !== undefined) list(p.links, `${field}.links`, 50, 0).forEach((l, i) => text(obj(l, `${field}.links[${i}]`).url, `${field}.links[${i}].url`, 2000));
  if (p.quoted !== undefined && p.quoted !== null) checkPost(p.quoted, `${field}.quoted`);
  return p;
}

export async function intake(env: Env, req: Request): Promise<Response> {
  const raw = await readText(req, INTAKE_MAX_BYTES);
  let b: Record<string, unknown>;
  try {
    b = obj(JSON.parse(raw), "body");
  } catch (e) {
    if (e instanceof KError) throw e;
    invalid("body must be JSON");
  }
  if (b.schema !== "kintake/1") invalid('schema must be "kintake/1"');
  const runId = text(b.run_id, "run_id", 100);
  const account = text(b.account, "account", 50);
  const post = checkPost(b.post, "post");
  const id = post.id as string;
  const thread = b.thread === undefined ? [] : list(b.thread, "thread", 50, 0).map((t, i) => checkPost(t, `thread[${i}]`));
  const upstream = b.upstream === undefined ? [] : list(b.upstream, "upstream", 20, 0).map((t, i) => checkPost(t, `upstream[${i}]`));
  const context = b.context === undefined ? [] : list(b.context, "context", CONTEXT_MAX, 0);
  context.forEach((c, i) => {
    const o = obj(c, `context[${i}]`);
    postId(o.id, `context[${i}].id`);
    text(o.author_handle, `context[${i}].author_handle`, 100);
    if (typeof o.text !== "string") invalid(`context[${i}].text must be a string`);
  });

  const bytes = new TextEncoder().encode(raw);
  const sha = await sha256Hex(bytes);
  await storeBytes(env, sha, bytes, "application/json");
  const now = Date.now();
  const posts = 1 + thread.length + upstream.length + context.length;
  await env.DB.prepare(
    `INSERT INTO intake (post_id, intake_sha, account, run_id, posts, received_at, first_received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT (post_id) DO UPDATE SET intake_sha = ?2, account = ?3, run_id = ?4, posts = ?5, received_at = ?6`,
  )
    .bind(id, sha, account, runId, posts, now)
    .run();

  const payload = JSON.stringify({ post_id: id, intake_sha: sha });
  const job = await env.DB.prepare(
    `INSERT INTO knowledge_jobs (id, kind, key, payload, deps, state, created_at, updated_at)
     VALUES (?1, 'save', ?2, ?3, '[]', 'queued', ?4, ?4)
     ON CONFLICT (kind, key) DO NOTHING RETURNING id, state`,
  )
    .bind(randomHex(16), id, payload, now)
    .first<{ id: string; state: string }>();
  if (job) return json({ post_id: id, intake_sha: sha, job: { id: job.id, state: job.state, created: true, requeued: false } }, 201);

  // The same save again. A new body runs it again unless it is running now;
  // the same body changes nothing.
  const updated = await env.DB.prepare(
    `UPDATE knowledge_jobs SET payload = ?2, deps = '[]', updated_at = ?3,
       state = 'queued', runs = runs + (state IN ('done', 'failed')), expired_leases = 0, result = NULL, error = NULL
     WHERE kind = 'save' AND key = ?1 AND state != 'claimed' AND json_extract(payload, '$.intake_sha') IS NOT ?4
     RETURNING id, state`,
  )
    .bind(id, payload, now, sha)
    .first<{ id: string; state: string }>();
  const row = updated ?? (await env.DB.prepare("SELECT id, state FROM knowledge_jobs WHERE kind = 'save' AND key = ?").bind(id).first<{ id: string; state: string }>())!;
  return json({ post_id: id, intake_sha: sha, job: { id: row.id, state: row.state, created: false, requeued: updated !== null } });
}

function sinceParam(url: URL): number {
  const raw = url.searchParams.get("since");
  if (raw === null || raw === "") invalid("since must be set: an ISO time or epoch milliseconds");
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n)) invalid("since must be an ISO time or epoch milliseconds");
  return n;
}

interface CardRow {
  post_id: string;
  version: number;
  created_at: number;
  completeness: string;
  missing_json: string;
  card_json: string | null;
}

export async function digest(env: Env, url: URL): Promise<Response> {
  const since = sinceParam(url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > DIGEST_LIMIT) invalid(`limit must be an integer from 1 to ${DIGEST_LIMIT}`);
  const db = env.DB;
  const [rows, pending] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT post_id, version, created_at, completeness, missing_json, card_json FROM bundles b
         WHERE created_at >= ?1 AND version = (SELECT max(version) FROM bundles WHERE post_id = b.post_id)
         ORDER BY created_at, post_id LIMIT ?2`,
      )
      .bind(since, limit + 1),
    db.prepare("SELECT count(*) AS n FROM knowledge_jobs WHERE kind = 'save' AND state IN ('queued', 'claimed')"),
  ]);
  const found = rows.results as unknown as CardRow[];
  const cards: string[] = [];
  let bytes = 0;
  let nextSince: number | null = null;
  for (const [i, r] of found.entries()) {
    // A bundle registered before cards existed gets the fields its row has.
    const card = r.card_json ?? JSON.stringify({ post_id: r.post_id, status: r.completeness, missing: JSON.parse(r.missing_json), card: null });
    const withMeta = `{"version":${r.version},"finished_at":${JSON.stringify(new Date(r.created_at).toISOString())},"card":${card}}`;
    if (i >= limit || bytes + withMeta.length > DIGEST_MAX_BYTES) {
      nextSince = r.created_at;
      break;
    }
    cards.push(withMeta);
    bytes += withMeta.length + 1;
  }
  const head = {
    since: new Date(since).toISOString(),
    until: new Date().toISOString(),
    count: cards.length,
    truncated: nextSince !== null,
    next_since: nextSince === null ? null : new Date(nextSince).toISOString(),
    pending_saves: (pending.results[0] as { n: number }).n,
  };
  const headJson = JSON.stringify(head);
  return new Response(`${headJson.slice(0, -1)},"saves":[${cards.join(",")}]}`, { headers: { "content-type": "application/json" } });
}
