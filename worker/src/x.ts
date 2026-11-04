// X ingest from the extension, and the post reads the runner uses.
// docs/CONTRACT.md, "POST /ingest/x" and "Runner endpoints".
//
// Every write is one D1 batch whose statements read the whole request from a
// single bound JSON array through json_each, so the number of D1 calls is
// constant however many posts a request carries.

import type { Env } from "./check";
import { fail, HttpError, intParam, isStr, json, oneOf, optStr, readJson, str } from "./http";

// docs/CONTRACT.md: at most 128 KB. A 245 KB ingest took 15 to 17 ms of CPU
// on a cold request in production, over the Free plan's 10 ms.
export const INGEST_MAX_BYTES = 128 * 1024;
// docs/CONTRACT.md (7d502f0): account "test" is reserved for synthetic
// checks. Its posts never reach the runner: GET /x/posts skips them and
// ingest makes no candidates from them (see also createCandidate).
export const TEST_ACCOUNT = "test";
const PAUSE_MS = 24 * 3600 * 1000;
const DETAIL_QUEUE_SIZE = 5;

const MODES = ["passive", "active"] as const;
const OPS = ["HomeTimeline", "HomeLatestTimeline", "Bookmarks", "TweetDetail", "SearchTimeline", "UserTweets", "ListLatestTweetsTimeline"] as const;
const SURFACES = ["home_for_you", "home_following", "bookmarks", "detail", "search", "profile", "list"] as const;
const STATUSES = ["ok", "login_wall", "rate_limited", "challenge", "error"] as const;

interface Post {
  id: string;
  author_handle: string;
  author_name: string | null;
  created_at: string;
  text: string;
  lang: string | null;
  conversation_id: string | null;
  in_reply_to_id: string | null;
  quoted_id: string | null;
  retweet_of_id: string | null;
  urls: string[];
  media: unknown[];
  metrics: Record<string, number | null>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function postId(v: unknown, field: string): string {
  if (typeof v !== "string" || !ID.test(v)) fail(`${field} must be an id string`);
  return v;
}
const optId = (v: unknown, field: string) => (v === undefined || v === null ? null : postId(v, field));

// An ISO time or any format Date.parse accepts (X's legacy created_at is
// "Wed Oct 10 20:19:24 +0000 2018"), stored as ISO.
function isoTime(v: unknown, field: string): string {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) fail(`${field} must be a date string, got ${JSON.stringify(v)}`);
  return new Date(ms).toISOString();
}

// Each metric present must be a non-negative count, or null when X omitted it.
function metrics(v: unknown, at: string): Record<string, number | null> {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${at}.metrics must be an object`);
  for (const [k, n] of Object.entries(v)) {
    if (n !== null && !(typeof n === "number" && Number.isFinite(n) && n >= 0)) fail(`${at}.metrics.${k} must be a non-negative number or null, got ${JSON.stringify(n)}`);
  }
  return v as Record<string, number | null>;
}

// Fails loudly on a missing or malformed field, naming where it is, instead
// of storing a half-parsed post.
function normalizePost(p: Record<string, unknown>, at: string): Post {
  if (typeof p !== "object" || p === null) fail(`${at} must be an object`);
  if (typeof p.text !== "string") fail(`${at}.text must be a string`);
  if (p.urls !== undefined && !(Array.isArray(p.urls) && p.urls.every((u) => typeof u === "string"))) fail(`${at}.urls must be an array of strings`);
  if (p.media !== undefined && !Array.isArray(p.media)) fail(`${at}.media must be an array`);
  return {
    id: postId(p.id, `${at}.id`),
    author_handle: str(p.author_handle, `${at}.author_handle`, 100),
    author_name: optStr(p.author_name, `${at}.author_name`, 200),
    created_at: isoTime(p.created_at, `${at}.created_at`),
    text: p.text,
    lang: optStr(p.lang, `${at}.lang`, 16),
    conversation_id: optId(p.conversation_id, `${at}.conversation_id`),
    in_reply_to_id: optId(p.in_reply_to_id, `${at}.in_reply_to_id`),
    quoted_id: optId(p.quoted_id, `${at}.quoted_id`),
    retweet_of_id: optId(p.retweet_of_id, `${at}.retweet_of_id`),
    urls: (p.urls as string[] | undefined) ?? [],
    media: (p.media as unknown[] | undefined) ?? [],
    metrics: metrics(p.metrics, at),
  };
}

interface IngestBody {
  account: unknown;
  session_id: unknown;
  mode: unknown;
  captured_at: unknown;
  batches: unknown;
}

export async function ingest(env: Env, req: Request) {
  const b = await readJson<IngestBody>(req, INGEST_MAX_BYTES);
  const account = str(b.account, "account", 64);
  const sessionId = str(b.session_id, "session_id", 128);
  const mode = oneOf(b.mode, MODES, "mode");
  isoTime(b.captured_at, "captured_at");
  if (!Array.isArray(b.batches)) fail("batches must be an array");

  // One version of each post per batch, the last occurrence in that batch.
  // The upsert applies them in request order and skips batches the Worker
  // already recorded, so the last occurrence in a new batch wins and a
  // replayed copy can't overwrite newer values. urls, media and metrics stay
  // objects: SQLite's json_extract returns them as JSON text.
  const versions: (Post & { batch_id: string; bookmarked: number })[] = [];
  const posts = new Map<string, { id: string; author_handle: string; text: string; batch_ids: string[]; bookmark_batch_ids: string[] }>();
  const sightings: { batch_id: string; post_id: string; surface: string; position: unknown; metrics: unknown }[] = [];
  const threads: unknown[] = [];
  const batchIds = new Set<string>();
  b.batches.forEach((batch: Record<string, unknown>, bi: number) => {
    const at = `batches[${bi}]`;
    if (typeof batch !== "object" || batch === null) fail(`${at} must be an object`);
    const batchId = str(batch.batch_id, `${at}.batch_id`, 200);
    if (batchIds.has(batchId)) fail(`${at}.batch_id ${JSON.stringify(batchId)} appears twice in this request`);
    batchIds.add(batchId);
    const op = oneOf(batch.op, OPS, `${at}.op`);
    const surface = oneOf(batch.surface, SURFACES, `${at}.surface`);
    if (!Array.isArray(batch.posts)) fail(`${at}.posts must be an array`);
    // One sighting per post per batch: a post X lists twice in one response
    // keeps its first position and its last metrics.
    const inBatch = new Map<string, (typeof sightings)[number]>();
    const batchVersions = new Map<string, (typeof versions)[number]>();
    const bookmark = surface === "bookmarks";
    batch.posts.forEach((raw: Record<string, unknown>, pi: number) => {
      const p = normalizePost(raw, `${at}.posts[${pi}]`);
      const position = raw.position === undefined || raw.position === null ? null : raw.position;
      if (position !== null && !Number.isInteger(position)) fail(`${at}.posts[${pi}].position must be an integer`);
      const seen = inBatch.get(p.id);
      if (seen) {
        seen.metrics = p.metrics;
      } else {
        inBatch.set(p.id, { batch_id: batchId, post_id: p.id, surface, position, metrics: p.metrics });
        const prev = posts.get(p.id);
        posts.set(p.id, {
          id: p.id,
          author_handle: p.author_handle,
          text: p.text,
          batch_ids: [...(prev?.batch_ids ?? []), batchId],
          bookmark_batch_ids: bookmark ? [...(prev?.bookmark_batch_ids ?? []), batchId] : (prev?.bookmark_batch_ids ?? []),
        });
      }
      batchVersions.set(p.id, { ...p, batch_id: batchId, bookmarked: bookmark ? 1 : 0 });
    });
    sightings.push(...inBatch.values());
    versions.push(...batchVersions.values());
    if (batch.thread !== undefined && batch.thread !== null) {
      if (op !== "TweetDetail") fail(`${at}.thread is only allowed on TweetDetail batches, not ${op}`);
      const t = batch.thread as Record<string, unknown>;
      const ids = (v: unknown, f: string) => {
        if (!Array.isArray(v)) fail(`${at}.thread.${f} must be an array of ids`);
        return v.map((x, i) => postId(x, `${at}.thread.${f}[${i}]`));
      };
      threads.push({ batch_id: batchId, root_id: postId(t.root_id, `${at}.thread.root_id`), op: ids(t.op_self_thread_ids, "op_self_thread_ids"), replies: ids(t.reply_ids, "reply_ids") });
    }
  });

  const now = Date.now();
  // Random per request. The batch-id insert stamps it on each batch it is
  // the first to record, and every later statement keeps only those batches.
  const requestId = crypto.randomUUID();
  const postList = [...posts.values()];
  const bookmarkList = (account === TEST_ACCOUNT ? [] : postList)
    .filter((p) => p.bookmark_batch_ids.length > 0)
    .map((p) => ({ id: p.id, b: p.bookmark_batch_ids, title: clip(`@${p.author_handle}: ${p.text.replace(/\s+/g, " ")}`, 140), url: `https://x.com/${p.author_handle}/status/${p.id}` }));
  const db = env.DB;
  const fresh = (expr: string, req: string) => `EXISTS (SELECT 1 FROM x_ingest_batches ib WHERE ib.batch_id = ${expr} AND ib.request_id = ${req})`;
  // `arr` must name its outer row explicitly (src.value): inside this
  // subquery an unqualified `value` means bj.value.
  const freshCount = (arr: string, req: string) => `(SELECT count(*) FROM json_each(${arr}) bj WHERE ${fresh("bj.value", req)})`;
  // One D1 batch is one transaction. Each bound string is serialized to D1
  // and counted against the 10 ms CPU limit, so the full post versions are
  // bound once and the other statements get ids only.
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `INSERT OR IGNORE INTO x_ingest_batches (batch_id, request_id, account, session_id, received_at)
         SELECT value, ?2, ?3, ?4, ?5 FROM json_each(?1) RETURNING batch_id`,
      )
      .bind(JSON.stringify([...batchIds]), requestId, account, sessionId, now),
    // Before the upsert: how many posts this request writes, and how many of
    // those are new.
    db
      .prepare(
        `SELECT coalesce(sum(fresh > 0), 0) AS upserted, coalesce(sum(fresh > 0 AND NOT EXISTS (SELECT 1 FROM x_posts WHERE x_posts.id = pid)), 0) AS n
         FROM (SELECT json_extract(src.value, '$.id') AS pid, ${freshCount("json_extract(src.value, '$.b')", "?2")} AS fresh FROM json_each(?1) AS src)`,
      )
      .bind(JSON.stringify(postList.map((p) => ({ id: p.id, b: p.batch_ids }))), requestId),
    // UNIQUE (kind, ref) keeps a post that is bookmarked again from making a
    // second candidate. A post already among Sam's seeded past saves
    // (positives) is not new work.
    db
      .prepare(
        `INSERT OR IGNORE INTO candidates (id, kind, ref, title, url, state, created_at, updated_at, origin)
         SELECT lower(hex(randomblob(16))), 'x_post', json_extract(value, '$.id'), json_extract(value, '$.title'),
                json_extract(value, '$.url'), 'new', ?2, ?2, 'bookmark'
         FROM json_each(?1) AS src
         WHERE ${freshCount("json_extract(src.value, '$.b')", "?3")} > 0
           AND NOT EXISTS (SELECT 1 FROM positives WHERE id = json_extract(value, '$.id'))
         RETURNING id`,
      )
      .bind(JSON.stringify(bookmarkList), now, requestId),
    db
      .prepare(
        `INSERT INTO x_posts (id, author_handle, author_name, created_at, text, lang, conversation_id, in_reply_to_id,
           quoted_id, retweet_of_id, urls_json, media_json, metrics_json, first_seen_at, last_seen_at, seen_count, bookmarked)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.author_handle'), json_extract(value, '$.author_name'),
                json_extract(value, '$.created_at'), json_extract(value, '$.text'), json_extract(value, '$.lang'),
                json_extract(value, '$.conversation_id'), json_extract(value, '$.in_reply_to_id'), json_extract(value, '$.quoted_id'),
                json_extract(value, '$.retweet_of_id'), json_extract(value, '$.urls'), json_extract(value, '$.media'),
                json_extract(value, '$.metrics'), ?2, ?2, 1, json_extract(value, '$.bookmarked')
         FROM json_each(?1)
         WHERE ${fresh("json_extract(value, '$.batch_id')", "?3")}
         ORDER BY key
         ON CONFLICT (id) DO UPDATE SET
           author_handle = excluded.author_handle, author_name = excluded.author_name, text = excluded.text, lang = excluded.lang,
           conversation_id = excluded.conversation_id, in_reply_to_id = excluded.in_reply_to_id, quoted_id = excluded.quoted_id,
           retweet_of_id = excluded.retweet_of_id, urls_json = excluded.urls_json, media_json = excluded.media_json,
           metrics_json = excluded.metrics_json, last_seen_at = excluded.last_seen_at,
           seen_count = x_posts.seen_count + excluded.seen_count, bookmarked = max(x_posts.bookmarked, excluded.bookmarked)`,
      )
      .bind(JSON.stringify(versions), now, requestId),
    db
      .prepare(
        `INSERT INTO x_sightings (post_id, account, surface, position, session_id, mode, seen_at, metrics_json, batch_id)
         SELECT json_extract(value, '$.post_id'), ?2, json_extract(value, '$.surface'), json_extract(value, '$.position'),
                ?3, ?4, ?5, json(json_extract(value, '$.metrics')), json_extract(value, '$.batch_id')
         FROM json_each(?1)
         WHERE ${fresh("json_extract(value, '$.batch_id')", "?6")}`,
      )
      .bind(JSON.stringify(sightings), account, sessionId, mode, now, requestId),
    db
      .prepare(
        `INSERT INTO x_threads (root_id, captured_at, account, op_self_thread_ids_json, reply_ids_json)
         SELECT json_extract(value, '$.root_id'), ?2, ?3, json(json_extract(value, '$.op')), json(json_extract(value, '$.replies'))
         FROM json_each(?1)
         WHERE ${fresh("json_extract(value, '$.batch_id')", "?4")}
         ON CONFLICT (root_id) DO UPDATE SET captured_at = excluded.captured_at, account = excluded.account,
           op_self_thread_ids_json = excluded.op_self_thread_ids_json, reply_ids_json = excluded.reply_ids_json`,
      )
      .bind(JSON.stringify(threads), now, account, requestId),
    db
      .prepare(
        `INSERT INTO x_sessions (session_id, account, mode, started_at, posts)
         VALUES (?1, ?2, ?3, ?4, (SELECT count(*) FROM json_each(?5) WHERE ${fresh("value", "?6")}))
         ON CONFLICT (session_id) DO UPDATE SET posts = x_sessions.posts + excluded.posts`,
      )
      .bind(sessionId, account, mode, now, JSON.stringify(sightings.map((x) => x.batch_id)), requestId),
  ]);
  const recorded = new Set(results[0].results.map((r) => r.batch_id as string));
  return {
    posts_upserted: results[1].results[0].upserted as number,
    sightings: results[4].meta.changes,
    new_posts: results[1].results[0].n as number,
    candidates_created: results[2].results.length,
    // Not in the contract: batch_ids the Worker had already recorded, whose
    // contents this request skipped.
    duplicate_batch_ids: [...batchIds].filter((id) => !recorded.has(id)),
  };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// The account is paused for 24 hours from its latest non-ok status, where a
// detected crash counts as status 'crash' timed at detection.
const PAUSED_SINCE = `SELECT max(ended_at) AS paused_at FROM x_sessions
  WHERE account = ?1 AND status IS NOT NULL AND status != 'ok' AND ended_at > ?2`;
const pauseUntil = (pausedAt: number | null | undefined) => (pausedAt ? new Date(pausedAt + PAUSE_MS).toISOString() : null);

// A session's first status wins, so a replayed status moves nothing: not the
// time (which would extend the pause) and not the status (an "ok" must never
// clear a non-ok one). Two later reports do change it: a non-ok status after
// "ok", and a real status after a detected crash, both timed when they arrive,
// so the pause runs from the later event.
export async function ingestStatus(env: Env, req: Request) {
  const b = await readJson<Record<string, unknown>>(req);
  const account = str(b.account, "account", 64);
  const sessionId = str(b.session_id, "session_id", 128);
  const status = oneOf(b.status, STATUSES, "status");
  const detail = optStr(b.detail, "detail", 2000);
  const screens = b.screens === undefined || b.screens === null ? null : b.screens;
  if (screens !== null && !Number.isInteger(screens)) fail("screens must be an integer");
  const now = Date.now();
  const takes = `(x_sessions.status IS NULL OR (x_sessions.status IN ('ok', 'crash') AND excluded.status != 'ok'))`;
  const [stored, paused] = await env.DB.batch<{ status?: string; ended_at?: number; paused_at?: number }>([
    env.DB.prepare(
      `INSERT INTO x_sessions (session_id, account, started_at, ended_at, status, detail, screens) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)
       ON CONFLICT (session_id) DO UPDATE SET
         ended_at = CASE WHEN ${takes} THEN excluded.ended_at ELSE x_sessions.ended_at END,
         detail = CASE WHEN ${takes} THEN excluded.detail ELSE x_sessions.detail END,
         status = CASE WHEN ${takes} THEN excluded.status ELSE x_sessions.status END,
         screens = coalesce(excluded.screens, x_sessions.screens)
       RETURNING status, ended_at`,
    ).bind(sessionId, account, now, status, detail, screens),
    env.DB.prepare(PAUSED_SINCE).bind(account, now - PAUSE_MS),
  ]);
  return { session_id: sessionId, status: stored.results[0].status, pause_until: pauseUntil(paused.results[0]?.paused_at) };
}

// A reservation that reports no status within this long is taken as a crash.
export const RESERVATION_TIMEOUT_MS = 30 * 60 * 1000;

// docs/CONTRACT.md 36fbd71. The extension must get 200 here before it opens
// any X window. The Worker refuses (423) while the account is paused, so the
// pause holds even when the extension loses its own state. One D1 batch:
// record crashes, then reserve only if nothing pauses the account.
export async function startSession(env: Env, req: Request): Promise<Response> {
  const b = await readJson<Record<string, unknown>>(req);
  const account = str(b.account, "account", 64);
  const sessionId = str(b.session_id, "session_id", 128);
  const now = Date.now();
  const [, reserved, paused, existing] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `UPDATE x_sessions SET status = 'crash', ended_at = ?2,
         detail = 'no status ' || ((?2 - reserved_at) / 60000) || ' min after its reservation'
       WHERE account = ?1 AND reserved_at IS NOT NULL AND status IS NULL AND reserved_at < ?3`,
    ).bind(account, now, now - RESERVATION_TIMEOUT_MS),
    env.DB.prepare(
      `INSERT INTO x_sessions (session_id, account, mode, started_at, reserved_at)
       SELECT ?1, ?2, 'active', ?3, ?3
       WHERE NOT EXISTS (SELECT 1 FROM x_sessions WHERE account = ?2 AND status IS NOT NULL AND status != 'ok' AND ended_at > ?4)
       ON CONFLICT (session_id) DO UPDATE SET reserved_at = coalesce(x_sessions.reserved_at, excluded.reserved_at), mode = 'active'
         WHERE x_sessions.status IS NULL AND x_sessions.account = excluded.account
       RETURNING reserved_at`,
    ).bind(sessionId, account, now, now - PAUSE_MS),
    env.DB.prepare(PAUSED_SINCE).bind(account, now - PAUSE_MS),
    env.DB.prepare("SELECT account, status FROM x_sessions WHERE session_id = ?1").bind(sessionId),
  ]);
  const pausedAt = paused.results[0]?.paused_at as number | null | undefined;
  if (pausedAt) return json({ pause_until: pauseUntil(pausedAt) }, 423);
  const row = reserved.results[0];
  if (!row) {
    const s = existing.results[0];
    throw new HttpError(409, `session ${sessionId} is ${s?.account !== account ? `another account's` : `already closed with status ${s?.status}`}; start a new session_id`);
  }
  return json({ session_id: sessionId, reserved_at: new Date(row.reserved_at as number).toISOString(), pause_until: null });
}

// A capture covers a post when it was taken on that post's permalink (the
// extension records the focal post as root_id), or when the post is one of
// the conversation root's own self-thread posts. A reply by someone else that
// merely appears in the root's replies is not covered: its permalink shows
// its own ancestors and replies, which the root's capture does not.
const capturedFor = (postId: string, conversationId: string) =>
  `(t.root_id = ${postId} OR (t.root_id = ${conversationId} AND EXISTS (SELECT 1 FROM json_each(t.op_self_thread_ids_json) WHERE value = ${postId})))`;

// Candidates whose thread has not been captured, among posts this account
// has seen. A non-ok session status in the last 24 h pauses the account.
export async function detailQueue(env: Env, url: URL) {
  const account = url.searchParams.get("account");
  if (!isStr(account)) fail("account query parameter is required");
  const now = Date.now();
  const [paused, queue] = await env.DB.batch<{ paused_at?: number; ref?: string }>([
    env.DB.prepare(PAUSED_SINCE).bind(account, now - PAUSE_MS),
    env.DB.prepare(
      `SELECT c.ref FROM candidates c JOIN x_posts p ON p.id = c.ref
       WHERE c.kind = 'x_post' AND c.state IN ('new', 'claimed')
         AND EXISTS (SELECT 1 FROM x_sightings s WHERE s.account = ?1 AND s.post_id = c.ref)
         AND NOT EXISTS (SELECT 1 FROM x_threads t WHERE ${capturedFor("c.ref", "p.conversation_id")})
       ORDER BY c.created_at, c.id LIMIT ?2`,
    ).bind(account, DETAIL_QUEUE_SIZE),
  ]);
  const pausedAt = paused.results[0]?.paused_at;
  if (pausedAt) return { post_ids: [], pause_until: pauseUntil(pausedAt) };
  return { post_ids: queue.results.map((r) => r.ref!), pause_until: null };
}

interface PostRow {
  id: string;
  author_handle: string;
  author_name: string | null;
  created_at: string;
  text: string;
  lang: string | null;
  conversation_id: string | null;
  in_reply_to_id: string | null;
  quoted_id: string | null;
  retweet_of_id: string | null;
  urls_json: string;
  media_json: string;
  metrics_json: string;
  first_seen_at: number;
  last_seen_at: number;
  seen_count: number;
  bookmarked: number;
  score: number | null;
  score_parts_json: string | null;
  scored_at: number | null;
  account?: string;
  surface?: string;
  session_id?: string;
}

function presentPost(r: PostRow) {
  const { urls_json, media_json, metrics_json, score_parts_json, ...rest } = r;
  return {
    ...rest,
    urls: JSON.parse(urls_json),
    media: JSON.parse(media_json),
    metrics: JSON.parse(metrics_json),
    score_parts: score_parts_json ? JSON.parse(score_parts_json) : null,
  };
}

const WITH_LATEST_SIGHTING = `
  SELECT p.*, s.account, s.surface, s.session_id FROM x_posts p
  LEFT JOIN x_sightings s ON s.id = (SELECT max(id) FROM x_sightings WHERE post_id = p.id)`;

// The runner's list: only posts some real account has seen, each with its
// latest real sighting. The inner join drops posts seen only by "test".
const WITH_LATEST_REAL_SIGHTING = `
  SELECT p.*, s.account, s.surface, s.session_id FROM x_posts p
  JOIN x_sightings s ON s.id = (SELECT max(id) FROM x_sightings WHERE post_id = p.id AND account != '${TEST_ACCOUNT}')`;

// 500 rows took 11 ms of CPU in production on 2026-11-04, so a page is at
// most 200, the contract's example size.
export async function listPosts(env: Env, url: URL) {
  const unscored = url.searchParams.get("unscored") === "1";
  const limit = intParam(url, "limit", 200, 200);
  // Separate statements so the unscored read can use the partial index
  // x_posts_unscored instead of scanning every post.
  const sql = unscored
    ? `${WITH_LATEST_REAL_SIGHTING} WHERE p.score IS NULL ORDER BY p.first_seen_at LIMIT ?1`
    : `${WITH_LATEST_REAL_SIGHTING} ORDER BY p.first_seen_at DESC LIMIT ?1`;
  const rows = await env.DB.prepare(sql).bind(limit).all<PostRow>();
  return { posts: rows.results.map(presentPost) };
}

export async function saveScores(env: Env, req: Request) {
  const b = await readJson<{ scores: unknown }>(req, 512 * 1024);
  if (!Array.isArray(b.scores) || b.scores.length === 0 || b.scores.length > 1000) fail("scores must be an array of 1 to 1000 items");
  const scores = b.scores.map((s: Record<string, unknown>, i: number) => {
    if (typeof s !== "object" || s === null) fail(`scores[${i}] must be an object`);
    if (typeof s.score !== "number" || !Number.isFinite(s.score)) fail(`scores[${i}].score must be a finite number`);
    return { id: postId(s.id, `scores[${i}].id`), score: s.score, parts: JSON.stringify(s.parts ?? null) };
  });
  const r = await env.DB.prepare(
    `UPDATE x_posts SET score = s.score, score_parts_json = s.parts, scored_at = ?2
     FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.score') AS score, json_extract(value, '$.parts') AS parts
           FROM json_each(?1)) AS s
     WHERE x_posts.id = s.id`,
  )
    .bind(JSON.stringify(scores), Date.now())
    .run();
  return { updated: r.meta.changes, received: scores.length };
}

export async function postContext(env: Env, id: string) {
  const db = env.DB;
  const post = await db.prepare(`${WITH_LATEST_SIGHTING} WHERE p.id = ?1`).bind(id).first<PostRow>();
  if (!post) throw new HttpError(404, `post ${id} not found`);
  // See capturedFor; a capture on the post's own permalink wins.
  const thread = await db
    .prepare(`SELECT * FROM x_threads t WHERE ${capturedFor("?1", "?2")} ORDER BY t.root_id = ?1 DESC LIMIT 1`)
    .bind(id, post.conversation_id ?? id)
    .first<{ root_id: string; captured_at: number; account: string; op_self_thread_ids_json: string; reply_ids_json: string }>();
  const opIds: string[] = thread ? JSON.parse(thread.op_self_thread_ids_json) : [];
  const replyIds: string[] = thread ? JSON.parse(thread.reply_ids_json) : [];
  const wanted = [...opIds, ...replyIds, ...(post.quoted_id ? [post.quoted_id] : [])];
  const rows = wanted.length
    ? (await db.prepare(`SELECT * FROM x_posts WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(wanted)).all<PostRow>()).results
    : [];
  const byId = new Map(rows.map((r) => [r.id, presentPost(r)]));
  // Server order is the order of the captured id lists, not D1's.
  const inOrder = (ids: string[]) => ids.map((i) => byId.get(i)).filter((p) => p !== undefined);
  return {
    post: presentPost(post),
    quoted: post.quoted_id ? (byId.get(post.quoted_id) ?? null) : null,
    thread_captured: thread !== null,
    thread: thread
      ? { root_id: thread.root_id, captured_at: thread.captured_at, op_self_thread: inOrder(opIds), replies: inOrder(replyIds), missing_ids: wanted.filter((i) => !byId.has(i)) }
      : null,
  };
}

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBED_MAX_TEXTS = 100;
// bge-base-en-v1.5 reads at most 512 tokens; longer text only costs bytes.
const EMBED_MAX_CHARS = 4000;

// Workers AI answers {"data":[[...768 floats]...],"shape":[n,768],...}.
// Parsing and re-serializing 100 vectors (about 1.6 MB of JSON) took 8 to
// 11 ms of CPU in production on 2026-11-04, over the Free plan's 10 ms. So
// the body streams through unparsed, with only its leading `{"data":`
// renamed to the contract's `vectors`. The shape, pooling and usage fields
// pass through as extra fields.
const RAW_PREFIX = new TextEncoder().encode('{"data":');

// A JS ReadableStream that re-enqueued each chunk cost 30 to 35 ms of CPU for
// 100 vectors (production, 2026-11-04). IdentityTransformStream lets the
// runtime pipe the rest of the body without running JS per chunk.
export async function embed(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const b = await readJson<{ texts: unknown }>(req, 512 * 1024);
  if (!Array.isArray(b.texts) || b.texts.length === 0 || b.texts.length > EMBED_MAX_TEXTS) fail(`texts must be an array of 1 to ${EMBED_MAX_TEXTS} strings`);
  const texts = b.texts.map((t, i) => {
    if (typeof t !== "string" || t.trim() === "") fail(`texts[${i}] must be a non-empty string`);
    return t.length > EMBED_MAX_CHARS ? t.slice(0, EMBED_MAX_CHARS) : t;
  });
  const raw = (await env.AI.run(EMBED_MODEL, { text: texts }, { returnRawResponse: true })) as unknown as Response;
  if (!raw.ok || !raw.body) throw new HttpError(502, `Workers AI returned HTTP ${raw.status}: ${(await raw.text()).slice(0, 300)}`);

  const reader = raw.body.getReader();
  let head = new Uint8Array(0);
  while (head.length < RAW_PREFIX.length) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = new Uint8Array(head.length + value.length);
    next.set(head);
    next.set(value, head.length);
    head = next;
  }
  if (!RAW_PREFIX.every((byte, i) => head[i] === byte)) {
    await reader.cancel();
    throw new HttpError(502, `Workers AI response does not start with {"data": (got ${JSON.stringify(new TextDecoder().decode(head.slice(0, 40)))})`);
  }
  reader.releaseLock();
  const prefix = new TextEncoder().encode(`{"model":${JSON.stringify(EMBED_MODEL)},"vectors":`);
  const first = new Uint8Array(prefix.length + head.length - RAW_PREFIX.length);
  first.set(prefix);
  first.set(head.subarray(RAW_PREFIX.length), prefix.length);
  const { readable, writable } = new IdentityTransformStream();
  const writer = writable.getWriter();
  // The write resolves only once the client reads it, so it runs alongside
  // the response instead of before it.
  ctx.waitUntil(
    (async () => {
      await writer.write(first);
      writer.releaseLock();
      await raw.body!.pipeTo(writable);
    })(),
  );
  return new Response(readable, { headers: { "content-type": "application/json" } });
}

export async function addPositives(env: Env, req: Request) {
  const b = await readJson<{ items: unknown }>(req, 1024 * 1024);
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 1000) fail("items must be an array of 1 to 1000 items");
  const items = b.items.map((it: Record<string, unknown>, i: number) => {
    if (typeof it !== "object" || it === null) fail(`items[${i}] must be an object`);
    return {
      id: str(it.id, `items[${i}].id`, 64),
      text: str(it.text, `items[${i}].text`, 20_000),
      author_handle: optStr(it.author_handle, `items[${i}].author_handle`, 100),
      source: optStr(it.source, `items[${i}].source`, 200),
    };
  });
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO positives (id, text, author_handle, source, added_at)
     SELECT json_extract(value, '$.id'), json_extract(value, '$.text'), json_extract(value, '$.author_handle'),
            json_extract(value, '$.source'), ?2
     FROM json_each(?1)`,
  )
    .bind(JSON.stringify(items), Date.now())
    .run();
  return { received: items.length, inserted: r.meta.changes };
}

export async function listPositives(env: Env, url: URL) {
  const limit = intParam(url, "limit", 2000, 5000);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isInteger(offset) || offset < 0) fail("offset must be a non-negative integer");
  const [rows, total] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT * FROM positives ORDER BY added_at, id LIMIT ?1 OFFSET ?2").bind(limit, offset),
    env.DB.prepare("SELECT count(*) AS n FROM positives"),
  ]);
  return { total: total.results[0].n, offset, items: rows.results };
}
