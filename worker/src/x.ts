// X ingest from the extension, and the post reads the runner uses.
// docs/CONTRACT.md, "POST /ingest/x" and "Runner endpoints".
//
// Every write is one D1 batch whose statements read the whole request from a
// single bound JSON array through json_each, so the number of D1 calls is
// constant however many posts a request carries.

import type { Env } from "./check";
import { fail, HttpError, intParam, isStr, oneOf, optStr, readJson, str } from "./http";

export const INGEST_MAX_BYTES = 256 * 1024;
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
  metrics: Record<string, number>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function postId(v: unknown, field: string): string {
  if (typeof v !== "string" || !ID.test(v)) fail(`${field} must be an id string`);
  return v;
}
const optId = (v: unknown, field: string) => (v === undefined || v === null ? null : postId(v, field));

// Fails loudly on a missing required field, naming where it is, instead of
// storing a half-parsed post.
function normalizePost(p: Record<string, unknown>, at: string): Post {
  if (typeof p !== "object" || p === null) fail(`${at} must be an object`);
  if (typeof p.text !== "string") fail(`${at}.text must be a string`);
  if (p.urls !== undefined && !(Array.isArray(p.urls) && p.urls.every((u) => typeof u === "string"))) fail(`${at}.urls must be an array of strings`);
  if (p.media !== undefined && !Array.isArray(p.media)) fail(`${at}.media must be an array`);
  if (p.metrics !== undefined && (typeof p.metrics !== "object" || p.metrics === null || Array.isArray(p.metrics))) fail(`${at}.metrics must be an object`);
  return {
    id: postId(p.id, `${at}.id`),
    author_handle: str(p.author_handle, `${at}.author_handle`, 100),
    author_name: optStr(p.author_name, `${at}.author_name`, 200),
    created_at: str(p.created_at, `${at}.created_at`, 64),
    text: p.text,
    lang: optStr(p.lang, `${at}.lang`, 16),
    conversation_id: optId(p.conversation_id, `${at}.conversation_id`),
    in_reply_to_id: optId(p.in_reply_to_id, `${at}.in_reply_to_id`),
    quoted_id: optId(p.quoted_id, `${at}.quoted_id`),
    retweet_of_id: optId(p.retweet_of_id, `${at}.retweet_of_id`),
    urls: (p.urls as string[] | undefined) ?? [],
    media: (p.media as unknown[] | undefined) ?? [],
    metrics: (p.metrics as Record<string, number> | undefined) ?? {},
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
  if (!Array.isArray(b.batches)) fail("batches must be an array");

  // Last occurrence wins for the post's fields, so metrics end at the latest
  // values in the request.
  const posts = new Map<string, Post & { sightings: number }>();
  const sightings: unknown[] = [];
  const bookmarkIds = new Set<string>();
  const threads: unknown[] = [];
  b.batches.forEach((batch: Record<string, unknown>, bi: number) => {
    const at = `batches[${bi}]`;
    if (typeof batch !== "object" || batch === null) fail(`${at} must be an object`);
    oneOf(batch.op, OPS, `${at}.op`);
    const surface = oneOf(batch.surface, SURFACES, `${at}.surface`);
    if (!Array.isArray(batch.posts)) fail(`${at}.posts must be an array`);
    batch.posts.forEach((raw: Record<string, unknown>, pi: number) => {
      const p = normalizePost(raw, `${at}.posts[${pi}]`);
      const position = raw.position === undefined || raw.position === null ? null : raw.position;
      if (position !== null && !Number.isInteger(position)) fail(`${at}.posts[${pi}].position must be an integer`);
      posts.set(p.id, { ...p, sightings: (posts.get(p.id)?.sightings ?? 0) + 1 });
      sightings.push({ post_id: p.id, surface, position, metrics: p.metrics });
      if (surface === "bookmarks") bookmarkIds.add(p.id);
    });
    if (batch.thread !== undefined && batch.thread !== null) {
      const t = batch.thread as Record<string, unknown>;
      const ids = (v: unknown, f: string) => {
        if (!Array.isArray(v)) fail(`${at}.thread.${f} must be an array of ids`);
        return v.map((x, i) => postId(x, `${at}.thread.${f}[${i}]`));
      };
      threads.push({ root_id: postId(t.root_id, `${at}.thread.root_id`), op: ids(t.op_self_thread_ids, "op_self_thread_ids"), replies: ids(t.reply_ids, "reply_ids") });
    }
  });

  const now = Date.now();
  const postList = [...posts.values()].map((p) => ({
    ...p,
    urls: JSON.stringify(p.urls),
    media: JSON.stringify(p.media),
    metrics: JSON.stringify(p.metrics),
    bookmarked: bookmarkIds.has(p.id) ? 1 : 0,
  }));
  const bookmarkList = postList
    .filter((p) => p.bookmarked)
    .map((p) => ({ id: p.id, title: clip(`@${p.author_handle}: ${p.text.replace(/\s+/g, " ")}`, 140), url: `https://x.com/${p.author_handle}/status/${p.id}` }));
  const db = env.DB;
  const results = await db.batch([
    db.prepare("SELECT count(*) AS n FROM x_posts WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))").bind(JSON.stringify(postList)),
    // UNIQUE (kind, ref) keeps a post that is bookmarked again from making a
    // second candidate. A post already among Sam's seeded past saves
    // (positives) is not new work.
    db
      .prepare(
        `INSERT OR IGNORE INTO candidates (id, kind, ref, title, url, state, created_at, updated_at, origin)
         SELECT lower(hex(randomblob(16))), 'x_post', json_extract(value, '$.id'), json_extract(value, '$.title'),
                json_extract(value, '$.url'), 'new', ?2, ?2, 'bookmark'
         FROM json_each(?1)
         WHERE NOT EXISTS (SELECT 1 FROM positives WHERE id = json_extract(value, '$.id'))
         RETURNING id`,
      )
      .bind(JSON.stringify(bookmarkList), now),
    db
      .prepare(
        `INSERT INTO x_posts (id, author_handle, author_name, created_at, text, lang, conversation_id, in_reply_to_id,
           quoted_id, retweet_of_id, urls_json, media_json, metrics_json, first_seen_at, last_seen_at, seen_count, bookmarked)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.author_handle'), json_extract(value, '$.author_name'),
                json_extract(value, '$.created_at'), json_extract(value, '$.text'), json_extract(value, '$.lang'),
                json_extract(value, '$.conversation_id'), json_extract(value, '$.in_reply_to_id'), json_extract(value, '$.quoted_id'),
                json_extract(value, '$.retweet_of_id'), json_extract(value, '$.urls'), json_extract(value, '$.media'),
                json_extract(value, '$.metrics'), ?2, ?2, json_extract(value, '$.sightings'), json_extract(value, '$.bookmarked')
         FROM json_each(?1) WHERE true
         ON CONFLICT (id) DO UPDATE SET
           author_handle = excluded.author_handle, author_name = excluded.author_name, text = excluded.text, lang = excluded.lang,
           conversation_id = excluded.conversation_id, in_reply_to_id = excluded.in_reply_to_id, quoted_id = excluded.quoted_id,
           retweet_of_id = excluded.retweet_of_id, urls_json = excluded.urls_json, media_json = excluded.media_json,
           metrics_json = excluded.metrics_json, last_seen_at = excluded.last_seen_at,
           seen_count = x_posts.seen_count + excluded.seen_count, bookmarked = max(x_posts.bookmarked, excluded.bookmarked)`,
      )
      .bind(JSON.stringify(postList), now),
    db
      .prepare(
        `INSERT INTO x_sightings (post_id, account, surface, position, session_id, mode, seen_at, metrics_json)
         SELECT json_extract(value, '$.post_id'), ?2, json_extract(value, '$.surface'), json_extract(value, '$.position'),
                ?3, ?4, ?5, json(json_extract(value, '$.metrics'))
         FROM json_each(?1)`,
      )
      .bind(JSON.stringify(sightings), account, sessionId, mode, now),
    db
      .prepare(
        `INSERT INTO x_threads (root_id, captured_at, account, op_self_thread_ids_json, reply_ids_json)
         SELECT json_extract(value, '$.root_id'), ?2, ?3, json(json_extract(value, '$.op')), json(json_extract(value, '$.replies'))
         FROM json_each(?1) WHERE true
         ON CONFLICT (root_id) DO UPDATE SET captured_at = excluded.captured_at, account = excluded.account,
           op_self_thread_ids_json = excluded.op_self_thread_ids_json, reply_ids_json = excluded.reply_ids_json`,
      )
      .bind(JSON.stringify(threads), now, account),
    db
      .prepare(
        `INSERT INTO x_sessions (session_id, account, mode, started_at, posts) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (session_id) DO UPDATE SET posts = x_sessions.posts + excluded.posts`,
      )
      .bind(sessionId, account, mode, now, sightings.length),
  ]);
  const existing = (results[0].results[0] as { n: number }).n;
  return {
    posts_upserted: postList.length,
    sightings: sightings.length,
    new_posts: postList.length - existing,
    candidates_created: results[1].results.length,
  };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export async function ingestStatus(env: Env, req: Request) {
  const b = await readJson<Record<string, unknown>>(req);
  const account = str(b.account, "account", 64);
  const sessionId = str(b.session_id, "session_id", 128);
  const status = oneOf(b.status, STATUSES, "status");
  const detail = optStr(b.detail, "detail", 2000);
  const screens = b.screens === undefined || b.screens === null ? null : b.screens;
  if (screens !== null && !Number.isInteger(screens)) fail("screens must be an integer");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO x_sessions (session_id, account, started_at, ended_at, status, detail, screens) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)
     ON CONFLICT (session_id) DO UPDATE SET ended_at = ?3, status = ?4, detail = ?5, screens = coalesce(?6, x_sessions.screens)`,
  )
    .bind(sessionId, account, now, status, detail, screens)
    .run();
  return { session_id: sessionId, status, pause_until: status === "ok" ? null : new Date(now + PAUSE_MS).toISOString() };
}

// Candidates whose thread has not been captured, among posts this account
// has seen. A non-ok session status in the last 24 h pauses the account.
export async function detailQueue(env: Env, url: URL) {
  const account = url.searchParams.get("account");
  if (!isStr(account)) fail("account query parameter is required");
  const now = Date.now();
  const [paused, queue] = await env.DB.batch<{ ended_at?: number; ref?: string }>([
    env.DB.prepare(
      `SELECT max(ended_at) AS ended_at FROM x_sessions WHERE account = ?1 AND status IS NOT NULL AND status != 'ok' AND ended_at > ?2`,
    ).bind(account, now - PAUSE_MS),
    env.DB.prepare(
      `SELECT c.ref FROM candidates c JOIN x_posts p ON p.id = c.ref
       WHERE c.kind = 'x_post' AND c.state IN ('new', 'claimed')
         AND EXISTS (SELECT 1 FROM x_sightings s WHERE s.account = ?1 AND s.post_id = c.ref)
         AND NOT EXISTS (SELECT 1 FROM x_threads t WHERE t.root_id IN (c.ref, p.conversation_id))
       ORDER BY c.created_at, c.id LIMIT ?2`,
    ).bind(account, DETAIL_QUEUE_SIZE),
  ]);
  const endedAt = paused.results[0]?.ended_at;
  if (endedAt) return { post_ids: [], pause_until: new Date(endedAt + PAUSE_MS).toISOString() };
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

export async function listPosts(env: Env, url: URL) {
  const unscored = url.searchParams.get("unscored") === "1";
  const limit = intParam(url, "limit", 200, 500);
  // Separate statements so the unscored read can use the partial index
  // x_posts_unscored instead of scanning every post.
  const sql = unscored
    ? `${WITH_LATEST_SIGHTING} WHERE p.score IS NULL ORDER BY p.first_seen_at LIMIT ?1`
    : `${WITH_LATEST_SIGHTING} ORDER BY p.first_seen_at DESC LIMIT ?1`;
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
  // The extension may record the thread under the opened post's id or under
  // its conversation root; prefer the post's own.
  const thread = await db
    .prepare(`SELECT * FROM x_threads WHERE root_id IN (?1, ?2) ORDER BY root_id = ?1 DESC LIMIT 1`)
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

export async function embed(env: Env, req: Request) {
  const b = await readJson<{ texts: unknown }>(req, 512 * 1024);
  if (!Array.isArray(b.texts) || b.texts.length === 0 || b.texts.length > EMBED_MAX_TEXTS) fail(`texts must be an array of 1 to ${EMBED_MAX_TEXTS} strings`);
  const texts = b.texts.map((t, i) => {
    if (typeof t !== "string" || t.trim() === "") fail(`texts[${i}] must be a non-empty string`);
    return t.length > EMBED_MAX_CHARS ? t.slice(0, EMBED_MAX_CHARS) : t;
  });
  const out = (await env.AI.run(EMBED_MODEL, { text: texts })) as { data?: number[][] };
  if (!Array.isArray(out.data) || out.data.length !== texts.length) throw new HttpError(502, `Workers AI returned ${out.data?.length ?? "no"} vectors for ${texts.length} texts`);
  return { model: EMBED_MODEL, vectors: out.data };
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
