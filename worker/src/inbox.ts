// POST /inbox/x: posts a scheduled GrokBot run read through its X plugin, sent
// in parts. docs/CONTRACT.md, "POST /inbox/x". These rows are kept apart from
// x_posts and candidates: nothing here feeds the runner yet.
//
// The caller is an LLM, so every 400 names the exact field path and what was
// wrong, and says that nothing from the part was stored; the caller fixes that
// field and sends the whole part again. Every refused body is recorded in
// inbox_x_rejects so malformed runs can be counted later.

import type { Env } from "./check";
import { HttpError, json, timeParam } from "./http";

export const INBOX_MAX_BYTES = 256 * 1024;
// A refused body is stored up to this many bytes.
export const REJECT_BODY_BYTES = 64 * 1024;
const MAX_ITEMS = 2000;
const MAX_PARTS = 100;
// An admin read returns at most this many rows of one kind; a wider window is
// refused instead of cut short.
const EXPORT_MAX_ROWS = 10_000;

const SURFACES = ["bookmarks", "home", "thread"] as const;
const TOP_KEYS = ["run_id", "account", "part", "parts", "collected_at", "items"];
const ITEM_KEYS = ["surface", "position", "thread_root_id", "post"];
const POST_KEYS = ["id", "url", "author_handle", "author_name", "created_at", "text", "quoted_id", "metrics"];
const METRIC_KEYS = ["likes", "reposts", "replies", "quotes", "bookmarks", "views"];

const RUN_ID = /^[A-Za-z0-9._:+-]{1,128}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const DIGITS = /^\d{1,25}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const STATUS_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}|i|i\/web)\/status\/(\d+)(?:[/?#].*)?$/;

const RESEND = "Nothing from this part was stored. Fix it and send the whole part again.";

class Invalid extends Error {}
function bad(msg: string): never {
  throw new Invalid(msg);
}

const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? "nothing" : s.length > 80 ? s.slice(0, 77) + "..." : s;
};

function object(v: unknown, at: string, keys: string[]): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) bad(`${at || "the body"} must be a JSON object, got ${show(v)}`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) bad(`${at ? at + "." : ""}${k} is not a known field; the fields here are ${keys.join(", ")}`);
  }
  return o;
}

function text(v: unknown, at: string, max: number, allowEmpty = false): string {
  if (typeof v !== "string") bad(`${at} must be a string, got ${show(v)}`);
  const s = v as string;
  if (!allowEmpty && s.length === 0) bad(`${at} must not be empty`);
  if (s.length > max) bad(`${at} is ${s.length} characters; the limit is ${max}`);
  return s;
}

function handle(v: unknown, at: string): string {
  const s = text(v, at, 100);
  if (s.startsWith("@")) bad(`${at} must be the handle without the leading @, got ${show(s)}`);
  if (!HANDLE.test(s)) bad(`${at} must be an X handle (1 to 15 letters, digits or _), got ${show(s)}`);
  return s;
}

function postId(v: unknown, at: string): string {
  if (typeof v === "number") bad(`${at} must be a string of digits in quotes, got the number ${show(v)}; X ids are too large for JSON numbers`);
  const s = text(v, at, 25);
  if (!DIGITS.test(s)) bad(`${at} must be a string of digits, got ${show(s)}`);
  return s;
}

function optPostId(v: unknown, at: string): string | null {
  return v === undefined || v === null ? null : postId(v, at);
}

function isoTime(v: unknown, at: string): string {
  const s = text(v, at, 40);
  if (!ISO.test(s) || !Number.isFinite(Date.parse(s))) bad(`${at} must be an ISO 8601 time with a zone, such as 2026-11-12T13:10:00Z, got ${show(s)}`);
  return s;
}

function integer(v: unknown, at: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v)) bad(`${at} must be an integer, got ${show(v)}`);
  const n = v as number;
  if (n < min || n > max) bad(`${at} must be from ${min} to ${max}, got ${n}`);
  return n;
}

function metrics(v: unknown, at: string): Record<string, number | null> | null {
  if (v === undefined || v === null) return null;
  const o = object(v, at, METRIC_KEYS);
  for (const [k, n] of Object.entries(o)) {
    if (n !== null && !(typeof n === "number" && Number.isInteger(n) && n >= 0)) bad(`${at}.${k} must be a whole number of at least 0, or null when unknown, got ${show(n)}`);
  }
  return o as Record<string, number | null>;
}

interface Item {
  surface: (typeof SURFACES)[number];
  position: number;
  post_id: string;
  url: string;
  author_handle: string;
  author_name: string;
  created_at: string;
  text: string;
  quoted_id: string | null;
  metrics: Record<string, number | null> | null;
  thread_root_id: string | null;
}

interface Part {
  run_id: string;
  account: string;
  part: number;
  parts: number;
  collected_at: string;
  items: Item[];
}

// Throws Invalid naming the first bad field.
function validate(body: unknown): Part {
  const b = object(body, "", TOP_KEYS);
  for (const k of TOP_KEYS) if (!(k in b)) bad(`${k} is missing; the top-level fields are ${TOP_KEYS.join(", ")}`);
  const runId = text(b.run_id, "run_id", 128);
  if (!RUN_ID.test(runId)) bad(`run_id may hold only letters, digits and . _ : + -, got ${show(runId)}`);
  const account = handle(b.account, "account");
  const parts = integer(b.parts, "parts", 1, MAX_PARTS);
  const part = integer(b.part, "part", 1, MAX_PARTS);
  if (part > parts) bad(`part is ${part} but parts is ${parts}; parts are numbered 1 to parts`);
  const collectedAt = isoTime(b.collected_at, "collected_at");
  if (!Array.isArray(b.items)) bad(`items must be an array, got ${show(b.items)}`);
  const raw = b.items as unknown[];
  if (raw.length > MAX_ITEMS) bad(`items has ${raw.length} entries; the limit is ${MAX_ITEMS} per part`);

  const seen = new Map<string, number>();
  const items = raw.map((rawItem, i): Item => {
    const at = `items[${i}]`;
    const it = object(rawItem, at, ITEM_KEYS);
    if (!SURFACES.includes(it.surface as Item["surface"])) bad(`${at}.surface must be one of ${SURFACES.join(", ")}, got ${show(it.surface)}`);
    const surface = it.surface as Item["surface"];
    const position = integer(it.position, `${at}.position`, 0, 100_000);
    let root: string | null = null;
    if (surface === "thread") {
      if (it.thread_root_id === undefined || it.thread_root_id === null) bad(`${at}.thread_root_id is required when surface is thread: the id of the bookmarked post whose thread this is`);
      root = postId(it.thread_root_id, `${at}.thread_root_id`);
    } else if (it.thread_root_id !== undefined && it.thread_root_id !== null) {
      bad(`${at}.thread_root_id is only allowed when surface is thread; remove it or set it to null`);
    }
    if (!("post" in it)) bad(`${at}.post is missing`);
    const p = object(it.post, `${at}.post`, POST_KEYS);
    const id = postId(p.id, `${at}.post.id`);
    const url = text(p.url, `${at}.post.url`, 300);
    const m = url.match(STATUS_URL);
    if (!m) bad(`${at}.post.url must look like https://x.com/<handle>/status/<id>, got ${show(url)}`);
    if (m[1] !== id) bad(`${at}.post.url points at status ${m[1]} but ${at}.post.id is ${id}; they must be the same post`);
    const item: Item = {
      surface,
      position,
      post_id: id,
      url,
      author_handle: handle(p.author_handle, `${at}.post.author_handle`),
      author_name: text(p.author_name, `${at}.post.author_name`, 200),
      created_at: isoTime(p.created_at, `${at}.post.created_at`),
      text: text(p.text, `${at}.post.text`, 50_000, true),
      quoted_id: optPostId(p.quoted_id, `${at}.post.quoted_id`),
      metrics: metrics(p.metrics, `${at}.post.metrics`),
      thread_root_id: root,
    };
    const key = `${surface}|${root ?? ""}|${id}`;
    const first = seen.get(key);
    if (first !== undefined) bad(`${at} repeats post ${id} on surface ${surface}${root ? ` under thread_root_id ${root}` : ""}, already sent as items[${first}]; send each post once per surface`);
    seen.set(key, i);
    return item;
  });
  return { run_id: runId, account, part, parts, collected_at: collectedAt, items };
}

// Reads the body counting bytes, and keeps up to INBOX_MAX_BYTES. Past the
// cap, or with a declared Content-Length over it, it stops reading once it has
// the first REJECT_BODY_BYTES for the reject record.
async function readCapped(req: Request): Promise<{ bytes: Uint8Array; total: number; over: boolean }> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  const keep = declared > INBOX_MAX_BYTES ? REJECT_BODY_BYTES : INBOX_MAX_BYTES;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let kept = 0;
  let over = declared > INBOX_MAX_BYTES;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (kept < keep) {
        const take = value.subarray(0, keep - kept);
        chunks.push(take);
        kept += take.byteLength;
      }
      if (total > INBOX_MAX_BYTES) over = true;
      if (over && kept >= Math.min(keep, REJECT_BODY_BYTES)) {
        await reader.cancel();
        break;
      }
    }
  }
  const bytes = new Uint8Array(kept);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.byteLength;
  }
  return { bytes, total: Math.max(total, declared), over };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function recordReject(
  env: Env,
  r: { status: number; error: string; runId: string | null; part: number | null; bytes: Uint8Array; total: number },
) {
  const body = new TextDecoder().decode(r.bytes.subarray(0, REJECT_BODY_BYTES));
  await env.DB.prepare(
    `INSERT INTO inbox_x_rejects (received_at, status, error, run_id, part, body_bytes, body_truncated, body)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(Date.now(), r.status, r.error, r.runId, r.part, r.total, r.total > REJECT_BODY_BYTES ? 1 : 0, body)
    .run();
}

// Best effort, for the reject record only.
function claimedKey(parsed: unknown): { runId: string | null; part: number | null } {
  const o = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  return {
    runId: typeof o.run_id === "string" && o.run_id.length <= 128 ? o.run_id : null,
    part: Number.isInteger(o.part) ? (o.part as number) : null,
  };
}

export async function inbox(env: Env, req: Request): Promise<Response> {
  const { bytes, total, over } = await readCapped(req);
  if (over) {
    const error = `body is ${total} bytes; the limit is ${INBOX_MAX_BYTES}. Split the items into more parts (keep each under 200 KB) and send each part.`;
    await recordReject(env, { status: 413, error, runId: null, part: null, bytes, total });
    throw new HttpError(413, error);
  }
  const raw = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const error = `body is not valid JSON (${e instanceof Error ? e.message : String(e)}). ${RESEND}`;
    await recordReject(env, { status: 400, error, runId: null, part: null, bytes, total });
    throw new HttpError(400, error);
  }
  let v: Part;
  try {
    v = validate(parsed);
  } catch (e) {
    if (!(e instanceof Invalid)) throw e;
    const error = `${e.message}. ${RESEND}`;
    await recordReject(env, { status: 400, error, ...claimedKey(parsed), bytes, total });
    throw new HttpError(400, error);
  }

  const now = Date.now();
  const requestId = crypto.randomUUID();
  const sha = await sha256Hex(bytes);
  const db = env.DB;
  // One D1 batch, one transaction. The part row is the idempotency key; the
  // items are copied only when this request's part row went in. The items are
  // bound as the validated values rather than read back out of the raw body,
  // so a body with a repeated JSON key cannot store something other than what
  // was checked.
  const [inserted, items, stored] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `INSERT OR IGNORE INTO inbox_x_parts (run_id, part, parts, account, collected_at, request_id, received_at, item_count, body_bytes, body_sha256, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING run_id`,
      )
      .bind(v.run_id, v.part, v.parts, v.account, v.collected_at, requestId, now, v.items.length, total, sha, raw),
    db
      .prepare(
        `INSERT INTO inbox_x_items (run_id, part, surface, position, post_id, url, author_handle, author_name, created_at, text,
           quoted_id, metrics_json, thread_root_id, received_at)
         SELECT ?2, ?3, json_extract(value, '$.surface'), json_extract(value, '$.position'), json_extract(value, '$.post_id'),
                json_extract(value, '$.url'), json_extract(value, '$.author_handle'), json_extract(value, '$.author_name'),
                json_extract(value, '$.created_at'), json_extract(value, '$.text'), json_extract(value, '$.quoted_id'),
                json(json_extract(value, '$.metrics')), json_extract(value, '$.thread_root_id'), ?5
         FROM json_each(?1)
         WHERE EXISTS (SELECT 1 FROM inbox_x_parts WHERE run_id = ?2 AND part = ?3 AND request_id = ?4)
         ORDER BY key`,
      )
      .bind(JSON.stringify(v.items), v.run_id, v.part, requestId, now),
    db.prepare("SELECT body_sha256, received_at FROM inbox_x_parts WHERE run_id = ?1 AND part = ?2").bind(v.run_id, v.part),
  ]);
  if (inserted.results.length > 0) {
    return json({ run_id: v.run_id, part: v.part, parts: v.parts, items_stored: items.meta.changes, duplicate: false });
  }
  const first = stored.results[0] as { body_sha256: string; received_at: number };
  const sameBody = first.body_sha256 === sha;
  if (!sameBody) {
    await recordReject(env, {
      status: 200,
      error: `run_id ${v.run_id} part ${v.part} was already stored at ${new Date(first.received_at).toISOString()} with a different body; this one was not stored`,
      runId: v.run_id,
      part: v.part,
      bytes,
      total,
    });
  }
  return json({ run_id: v.run_id, part: v.part, parts: v.parts, items_stored: 0, duplicate: true, same_body: sameBody });
}

function window(url: URL): { since: number; until: number } {
  const since = timeParam(url, "since");
  const until = timeParam(url, "until");
  if (since === null || until === null) throw new HttpError(400, "since and until are both required (ISO time or epoch milliseconds)");
  if (until <= since) throw new HttpError(400, "until must be after since");
  return { since, until };
}

const tooMany = (what: string) => new HttpError(400, `more than ${EXPORT_MAX_ROWS} ${what} in this window; ask for a narrower one`);

// Admin: every accepted part, item and reject received in [since, until).
export async function inboxExport(env: Env, url: URL) {
  const { since, until } = window(url);
  const db = env.DB;
  const [parts, items, rejects] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM inbox_x_parts WHERE received_at >= ?1 AND received_at < ?2 ORDER BY received_at, run_id, part LIMIT ?3").bind(since, until, EXPORT_MAX_ROWS + 1),
    db.prepare("SELECT * FROM inbox_x_items WHERE received_at >= ?1 AND received_at < ?2 ORDER BY id LIMIT ?3").bind(since, until, EXPORT_MAX_ROWS + 1),
    db.prepare("SELECT * FROM inbox_x_rejects WHERE received_at >= ?1 AND received_at < ?2 ORDER BY id LIMIT ?3").bind(since, until, EXPORT_MAX_ROWS + 1),
  ]);
  for (const [rows, what] of [[parts, "parts"], [items, "items"], [rejects, "rejects"]] as const) {
    if (rows.results.length > EXPORT_MAX_ROWS) throw tooMany(what);
  }
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString(), parts: parts.results, items: items.results, rejects: rejects.results };
}

const SIGHTINGS_PAGE = 1000;

// Admin: the extension's sightings seen in [since, until), each joined to its
// post, oldest first, a page at a time (after_id is the last sighting_id of
// the previous page). Account "test" is left out. The post columns are the
// post's latest stored values; the sighting's metrics_json are the values at
// that sighting. The first page also carries the threads captured and the
// sessions started or ended in the window.
export async function sightingsExport(env: Env, url: URL) {
  const { since, until } = window(url);
  const afterRaw = url.searchParams.get("after_id") ?? "0";
  const afterId = Number(afterRaw);
  if (!Number.isInteger(afterId) || afterId < 0) throw new HttpError(400, "after_id must be a non-negative integer");
  const db = env.DB;
  const rows = await db
    .prepare(
      `SELECT s.id AS sighting_id, s.post_id, s.account, s.surface, s.position, s.session_id, s.mode, s.seen_at, s.metrics_json, s.batch_id,
              p.author_handle, p.author_name, p.created_at, p.text, p.lang, p.conversation_id, p.in_reply_to_id, p.quoted_id,
              p.retweet_of_id, p.urls_json, p.bookmarked, p.first_seen_at
       FROM x_sightings s JOIN x_posts p ON p.id = s.post_id
       WHERE s.seen_at >= ?1 AND s.seen_at < ?2 AND s.id > ?3 AND s.account != 'test'
       ORDER BY s.id LIMIT ?4`,
    )
    .bind(since, until, afterId, SIGHTINGS_PAGE)
    .all<{ sighting_id: number }>();
  const out: Record<string, unknown> = {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    sightings: rows.results,
    next_after_id: rows.results.length === SIGHTINGS_PAGE ? rows.results[rows.results.length - 1].sighting_id : null,
  };
  if (afterId === 0) {
    const [threads, sessions] = await db.batch<Record<string, unknown>>([
      db.prepare("SELECT * FROM x_threads WHERE captured_at >= ?1 AND captured_at < ?2 AND account != 'test' ORDER BY captured_at LIMIT ?3").bind(since, until, EXPORT_MAX_ROWS + 1),
      db
        .prepare(
          `SELECT * FROM x_sessions WHERE account != 'test' AND ((started_at >= ?1 AND started_at < ?2) OR (ended_at >= ?1 AND ended_at < ?2))
           ORDER BY started_at LIMIT ?3`,
        )
        .bind(since, until, EXPORT_MAX_ROWS + 1),
    ]);
    if (threads.results.length > EXPORT_MAX_ROWS) throw tooMany("threads");
    if (sessions.results.length > EXPORT_MAX_ROWS) throw tooMany("sessions");
    out.threads = threads.results;
    out.sessions = sessions.results;
  }
  return out;
}
