// The daily loop's two ends (docs/KNOWLEDGE.md, "Daily loop").
//
// POST /k/intake: the extension's daily job posts one save at a time
// (schema kintake/1). The Worker checks the shape, stores the body as a
// blob, and files one `save` job per post for kworker. One save per request
// is meant to keep JSON.parse and the hash inside Workers Free's 10 ms of
// CPU. That is not measured: once deployed, the lead times a 192 KiB intake
// in production with `wrangler tail` (cpuTime per request), and if it goes
// over, INTAKE_MAX_BYTES comes down to what fits.
//
// GET /k/digest: each finished save's card, for the morning brief. Cards are
// stored as JSON text and concatenated, never parsed.

import type { Env } from "../check";
import { json, randomHex, readText } from "../http";
import { storeBytes } from "./blobs";
import { postId } from "./bundles";
import { invalid, KError, list, obj, sha256Hex, text } from "./common";
import { runAgain } from "./jobs";

export const INTAKE_MAX_BYTES = 192 * 1024;
const CONTEXT_MAX = 120;
const DIGEST_MAX_BYTES = 30 * 1024;
const DIGEST_LIMIT = 100;
// The largest epoch milliseconds a JavaScript Date holds.
const DATE_MAX_MS = 8.64e15;
// The documented ISO form: date, T, time with optional fraction, Z or an offset.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR = /^(\d{1,16})\.([1-9][0-9]{0,18})$/;

function checkPost(v: unknown, field: string) {
  const p = obj(v, field);
  postId(p.id, `${field}.id`);
  text(p.url, `${field}.url`, 2000);
  text(p.author_handle, `${field}.author_handle`, 100);
  if (typeof p.text !== "string") invalid(`${field}.text must be a string (empty when the post has none)`);
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
  if (job) return json({ post_id: id, intake_sha: sha, job: { id: job.id, state: job.state, created: true, requeued: false, replaced: false, deferred: false } }, 201);

  // The same save again. The same body changes nothing. A new body runs the
  // save again: at once if it is finished or waiting, after the running
  // attempt if it is claimed (runAgain keeps it pending), so it is never
  // acknowledged and then dropped.
  const existing = (await env.DB.prepare("SELECT id, state, payload, pending_payload FROM knowledge_jobs WHERE kind = 'save' AND key = ?").bind(id).first<{ id: string; state: string; payload: string; pending_payload: string | null }>())!;
  const current = existing.pending_payload ?? existing.payload;
  if ((JSON.parse(current) as { intake_sha?: string }).intake_sha === sha) {
    return json({ post_id: id, intake_sha: sha, job: { id: existing.id, state: existing.state, created: false, requeued: false, replaced: false, deferred: false } });
  }
  const again = await runAgain(env, existing.id, payload, "[]", now);
  return json({ post_id: id, intake_sha: sha, job: { id: existing.id, state: again.row.state, created: false, ...again.how } });
}

// The digest's arguments, as GET /k/digest's query string carries them
// (strings) or as the knowledge_digest tool's JSON does (since may be a
// number, limit must be one).
export interface DigestArgs {
  since: unknown;
  cursor?: unknown;
  limit?: unknown;
}

// since: epoch milliseconds or the documented ISO form, inside Date's range.
function sinceMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") invalid("since must be set: an ISO time (2026-11-13T07:00:00Z) or epoch milliseconds");
  let ms: number;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) invalid("since in epoch milliseconds must be a whole number of at least 0");
    ms = raw;
  } else if (typeof raw !== "string") invalid("since must be an ISO time string or epoch milliseconds");
  else if (/^\d{1,16}$/.test(raw)) ms = Number(raw);
  else if (ISO.test(raw)) ms = Date.parse(raw);
  else invalid("since must be an ISO time like 2026-11-13T07:00:00Z or epoch milliseconds");
  if (!Number.isFinite(ms) || ms > DATE_MAX_MS) invalid("since is outside the range a date can hold");
  return ms;
}

function limitOf(raw: unknown): number {
  if (raw === undefined || raw === null) return 50;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > DIGEST_LIMIT) invalid(`limit must be an integer from 1 to ${DIGEST_LIMIT}`);
  return raw;
}

function cursorOf(raw: unknown): [number, string] | null {
  if (raw === undefined || raw === null) return null;
  const m = typeof raw === "string" ? CURSOR.exec(raw) : null;
  if (!m) invalid("cursor must be the next_cursor of an earlier page");
  return [Number(m[1]), m[2]];
}

interface CardRow {
  post_id: string;
  version: number;
  created_at: number;
  completeness: string;
  missing_json: string;
  card_json: string | null;
}

const enc = new TextEncoder();
const byteLength = (s: string) => enc.encode(s).byteLength;

// A bundle registered before cards existed: its status and the first three
// gaps, each cut short, so it stays far below a page.
// Every field is cut, so the whole card stays under LEGACY_CARD_MAX bytes
// whatever the row holds (a registered card is already at most 4 KiB).
const LEGACY_CARD_MAX = 1024;
function legacyCard(r: CardRow): string {
  const missing = (JSON.parse(r.missing_json) as { what?: unknown; reason?: unknown }[])
    .slice(0, 3)
    .map((m) => `${String(m.what ?? "").slice(0, 40)}: ${String(m.reason ?? "").slice(0, 160)}`);
  const card = JSON.stringify({ post_id: r.post_id, status: r.completeness, missing, card: null });
  return byteLength(card) <= LEGACY_CARD_MAX ? card : JSON.stringify({ post_id: r.post_id, status: r.completeness, missing: [], card: null });
}

// GET /k/digest?since=<time>[&cursor=<created_at>.<post_id>]&limit=<n>
// Pages run oldest first by (created_at, post_id). The first page starts at
// since (inclusive); next_cursor resumes strictly after the last save
// returned, so saves finished in the same millisecond are neither repeated
// nor skipped. Each page holds at least one save, so paging always moves.
export async function digest(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams;
  const limit = q.get("limit");
  const page = await digestPage(env, { since: q.get("since"), cursor: q.get("cursor"), limit: limit === null ? null : Number(limit) });
  return new Response(page, { headers: { "content-type": "application/json" } });
}

// One digest page as JSON text, at most DIGEST_MAX_BYTES of UTF-8. Cards are
// stored as JSON text and spliced in unparsed. cardField names each save's
// card: "card" for the route, "card_untrusted" for the MCP tool, whose
// convention marks fields holding text from posts, pages or models.
export async function digestPage(env: Env, a: DigestArgs, cardField: "card" | "card_untrusted" = "card"): Promise<string> {
  const since = sinceMs(a.since);
  const limit = limitOf(a.limit);
  const after = cursorOf(a.cursor);
  const db = env.DB;
  const [rows, pending] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT post_id, version, created_at, completeness, missing_json, card_json FROM bundles b
         WHERE created_at >= ?1 AND version = (SELECT max(version) FROM bundles WHERE post_id = b.post_id)
           AND (?3 IS NULL OR created_at > ?3 OR (created_at = ?3 AND post_id > ?4))
         ORDER BY created_at, post_id LIMIT ?2`,
      )
      .bind(since, limit + 1, after?.[0] ?? null, after?.[1] ?? null),
    // A save still has outstanding work while its save job or its bundle job
    // is queued or running; the card appears only when the bundle is done.
    db.prepare("SELECT count(DISTINCT key) AS n FROM knowledge_jobs WHERE kind IN ('save', 'bundle') AND state IN ('queued', 'claimed')"),
  ]);
  const found = rows.results as unknown as CardRow[];
  const head = {
    since: new Date(since).toISOString(),
    until: new Date().toISOString(),
    pending_saves: (pending.results[0] as { n: number }).n,
  };
  // The envelope's own bytes count: head fields, count, truncated, the cursor.
  const envelope = byteLength(JSON.stringify({ ...head, count: 100, truncated: true, next_cursor: "9".repeat(16) + "." + "9".repeat(19), saves: [] }));
  const cards: string[] = [];
  let bytes = envelope;
  let last: CardRow | null = null;
  let truncated = false;
  for (const r of found) {
    const item = `{"version":${r.version},"finished_at":${JSON.stringify(new Date(r.created_at).toISOString())},"${cardField}":${r.card_json ?? legacyCard(r)}}`;
    const size = byteLength(item) + 1;
    if (cards.length >= limit || (cards.length > 0 && bytes + size > DIGEST_MAX_BYTES)) {
      truncated = true;
      break;
    }
    cards.push(item);
    bytes += size;
    last = r;
  }
  const tail = { count: cards.length, truncated, next_cursor: truncated && last ? `${last.created_at}.${last.post_id}` : null };
  const headJson = JSON.stringify({ ...head, ...tail });
  return `${headJson.slice(0, -1)},"saves":[${cards.join(",")}]}`;
}
