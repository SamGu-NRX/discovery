// Fetch mode's job runner: pages Bookmarks and collects context around posts
// by issuing X's own read operations, paced and capped, and feeds every
// response through the same parser passive capture uses. All I/O comes in
// through `io` so tests drive it with fixtures and a manual clock; the
// extension wires it up in app/fetch/fetch.js.
//
// Every request goes through one gate (request() below). In order it checks
// the stop flag, the per-run request cap, and the shared pause (any X signal
// anywhere in the extension pauses fetch runs too), waits out the pacing gap,
// and checks the pause again after the wait. After the response it logs a
// ledger row, and any X back-off signal stops the whole run and pauses for
// 24 hours.

import { captureToBatch } from "./capture.js";
import { DETAIL_CURSORS, FetchRefused, assertReadOperation, buildRequest, classifyResponse, cursorsOf, isPostId } from "./fetchops.js";
import { ParseError, parseResponse } from "./parse.js";
import { extendThread } from "./thread.js";

// Defaults. A job may lower any of these, never raise the gap below 1500 ms
// or the cap above 400 (clampLimits).
export const DEFAULT_LIMITS = Object.freeze({
  // Sam's brief: at least 1.5 s between requests, with jitter on top.
  minGapMs: 1500,
  jitterMs: 1000,
  // Requests per run, primes included.
  runCap: 400,
  // TweetDetail requests per post: both reply orders, branches and upstream.
  detailCapPerPost: 40,
  // Reply branches opened per post (see branchCandidates).
  branchesPerPost: 6,
  // SearchTimeline pages per query and product.
  searchPagesPerQuery: 5,
  // Linked URLs searched per post.
  linksPerPost: 3,
  // Re-primes after a 404 per operation, before the run stops.
  reprimesPerOperation: 1,
});

export function clampLimits(given = {}) {
  const out = { ...DEFAULT_LIMITS };
  const int = (v) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : null);
  if (int(given.minGapMs) !== null) out.minGapMs = Math.max(DEFAULT_LIMITS.minGapMs, int(given.minGapMs));
  if (int(given.jitterMs) !== null) out.jitterMs = Math.max(0, Math.min(10_000, int(given.jitterMs)));
  if (int(given.runCap) !== null) out.runCap = Math.max(1, Math.min(DEFAULT_LIMITS.runCap, int(given.runCap)));
  for (const key of ["detailCapPerPost", "branchesPerPost", "searchPagesPerQuery", "linksPerPost", "reprimesPerOperation"]) {
    if (int(given[key]) !== null) out[key] = Math.max(0, Math.min(200, int(given[key])));
  }
  return out;
}

export class RunStopped extends Error {
  constructor(reason, detail, { pause = false } = {}) {
    super(`${reason}: ${detail}`);
    this.name = "RunStopped";
    this.reason = reason;
    this.detail = detail;
    this.pause = pause;
  }
}

/**
 * Validates a job list. Throws with a specific message on anything it does
 * not understand; a job runner should not guess.
 */
export function parseJobs(input) {
  const doc = typeof input === "string" ? JSON.parse(input) : input;
  const jobs = Array.isArray(doc) ? doc : doc?.jobs;
  if (!Array.isArray(jobs) || !jobs.length) throw new Error('expected {"jobs": [...]} with at least one job');
  const limits = clampLimits(Array.isArray(doc) ? {} : doc.limits);
  const out = jobs.map((job, i) => {
    const at = `jobs[${i}]`;
    if (job?.type === "bookmarks_until") {
      if (!isPostId(job.boundary)) throw new Error(`${at}.boundary must be a post id string`);
      const after = job.after ?? 0;
      if (!Number.isInteger(after) || after < 0 || after > 500) throw new Error(`${at}.after must be a whole number up to 500`);
      const maxPages = job.maxPages ?? 40;
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error(`${at}.maxPages must be 1..100`);
      return { type: "bookmarks_until", boundary: job.boundary, after, maxPages };
    }
    if (job?.type === "context") {
      if (!Array.isArray(job.ids) || !job.ids.length || !job.ids.every(isPostId)) throw new Error(`${at}.ids must be post id strings`);
      const known = ["ids", "type", "rankings", "branches", "quotes", "mentions", "links", "conversation", "upstream"];
      for (const key of Object.keys(job)) if (!known.includes(key)) throw new Error(`${at}.${key} is not a context option`);
      const rankings = job.rankings ?? ["Relevance", "Recency"];
      if (!Array.isArray(rankings) || !rankings.every((r) => ["Relevance", "Recency", "Likes"].includes(r))) {
        throw new Error(`${at}.rankings must list Relevance, Recency or Likes`);
      }
      const flag = (key) => {
        const v = job[key] ?? true;
        if (typeof v !== "boolean") throw new Error(`${at}.${key} must be true or false`);
        return v;
      };
      return {
        type: "context",
        ids: [...new Set(job.ids)],
        rankings,
        branches: flag("branches"),
        quotes: flag("quotes"),
        mentions: flag("mentions"),
        links: flag("links"),
        conversation: flag("conversation"),
        upstream: flag("upstream"),
      };
    }
    throw new Error(`${at}.type must be bookmarks_until or context, got ${JSON.stringify(job?.type)}`);
  });
  return { jobs: out, limits };
}

/**
 * @param io {
 *   now(): ms, sleep(ms), random(): [0,1),
 *   paused(): Promise<boolean>   the extension's shared pause,
 *   prime(kind, arg): Promise<void>  open a page where X itself calls the
 *       operation ("bookmarks" | "detail" with a post id | "search" with a query),
 *   template(operation): Promise<template | null>  parsed template, see fetchops.parseTemplate,
 *   send(operation, url): Promise<{ status, contentType, text, ms }>  one GET from the x.com tab,
 *   onBatch({ batch, operation }): Promise<void>  a contract batch to queue,
 *   onSignal({ reason, detail })  back-off to pause on,
 *   onStart(run)  optional, the live run record, for showing progress,
 *   stopRequested(): boolean
 * }
 */
export async function runJobs(jobs, limits, io) {
  const run = {
    startedAt: io.now(),
    limits,
    requests: 0,
    primes: [],
    ledger: [],
    posts: {},
    bookmarks: null,
    context: {},
    stop: null,
    lastRequestAt: null,
    reprimes: {},
    primedFor: {},
  };
  // Lets the page show progress; the run is not to be changed through it.
  io.onStart?.(run);
  try {
    for (const job of jobs) {
      if (job.type === "bookmarks_until") await bookmarksUntil(run, io, job);
      else await context(run, io, job);
    }
  } catch (err) {
    if (err instanceof RunStopped) {
      run.stop = { reason: err.reason, detail: err.detail };
      if (err.pause) await io.onSignal({ reason: err.reason, detail: err.detail });
    } else if (err instanceof FetchRefused || err instanceof ParseError) {
      run.stop = { reason: "error", detail: err.message };
    } else {
      throw err;
    }
  }
  run.endedAt = io.now();
  const { lastRequestAt, reprimes, primedFor, ...out } = run;
  return out;
}

async function gate(run, io) {
  if (io.stopRequested()) throw new RunStopped("stopped", "stopped by Sam");
  if (run.requests >= run.limits.runCap) throw new RunStopped("cap", `reached the run cap of ${run.limits.runCap} requests`);
  if (await io.paused()) throw new RunStopped("paused", "the extension is paused (an X signal in the last 24 hours)");
  if (run.lastRequestAt !== null) {
    const gap = run.limits.minGapMs + io.random() * run.limits.jitterMs;
    const wait = run.lastRequestAt + gap - io.now();
    if (wait > 0) await io.sleep(wait);
  }
  // A signal can arrive while waiting, from this tab or any other.
  if (io.stopRequested()) throw new RunStopped("stopped", "stopped by Sam");
  if (await io.paused()) throw new RunStopped("paused", "the extension was paused while waiting");
  run.requests += 1;
  run.lastRequestAt = io.now();
}

const PRIMES = { Bookmarks: "bookmarks", TweetDetail: "detail", SearchTimeline: "search" };

// Opens a page where X itself calls `operation`, so its template is current.
// Counts as one request against the cap, since the page load reaches X.
async function prime(run, io, operation, arg) {
  await gate(run, io);
  const kind = PRIMES[operation];
  const at = io.now();
  await io.prime(kind, arg);
  run.primes.push({ operation, kind, arg, at: new Date(at).toISOString(), ms: io.now() - at });
  run.primedFor[operation] = arg;
  if (!(await io.template(operation))) {
    throw new RunStopped("error", `opened the ${kind} page but X did not call ${operation} there, so its query id and features are unknown`);
  }
}

// One GET. Returns { json, url }; re-primes and retries once after a 404.
async function request(run, io, operation, changes, note) {
  assertReadOperation(operation);
  for (;;) {
    const template = await io.template(operation);
    const { url, variables } = buildRequest(template, operation, changes);
    await gate(run, io);
    let res;
    try {
      res = await io.send(operation, url);
    } catch (err) {
      ledger(run, { operation, variables, status: 0, ms: null, note: `${note}; failed: ${err.message}` });
      // The fetcher refuses redirects, and X redirects a signed-out request
      // to its login page, so a redirect counts as a login wall.
      const redirected = /redirect/i.test(err.message);
      throw new RunStopped(redirected ? "login_wall" : "error", `${operation} request failed: ${err.message}`, { pause: redirected });
    }
    const verdict = classifyResponse({ operation, ...res });
    ledger(run, { operation, variables, status: res.status, ms: res.ms, note });
    if (verdict.kind === "json") return { json: verdict.json, url };
    if (verdict.kind === "stop") throw new RunStopped(verdict.reason, verdict.detail, { pause: verdict.pause });
    const used = run.reprimes[operation] ?? 0;
    if (used >= run.limits.reprimesPerOperation) throw new RunStopped("error", `${verdict.detail}, also after re-opening the page`);
    run.reprimes[operation] = used + 1;
    await prime(run, io, operation, run.primedFor[operation]);
  }
}

function ledger(run, { operation, variables, status, ms, note }) {
  // Cursors are long opaque strings; the start is enough to tell pages apart.
  const shown = { ...variables };
  if (typeof shown.cursor === "string") shown.cursor = `${shown.cursor.slice(0, 16)}…`;
  run.ledger.push({ i: run.requests, at: new Date(run.lastRequestAt).toISOString(), operation, variables: shown, status, ms, note });
}

// Parses one response into a batch, keeps its posts, and queues the batch.
// `primary` lists the response's own posts in display order, without the
// quoted and reposted originals that ride along.
async function absorb(run, io, { operation, json, url, offset, threadState = null }) {
  const capture = captureToBatch({ operation, json, url, offset, threadState });
  if (capture.threadError) throw new ParseError(capture.threadError);
  for (const post of capture.batch?.posts ?? []) run.posts[post.id] = post;
  if (capture.batch) await io.onBatch({ operation, batch: capture.batch });
  const { items } = parseResponse(operation, json, { focalId: capture.focalId });
  return { ...capture, primary: items.filter((i) => i.role !== "embedded") };
}

async function bookmarksUntil(run, io, job) {
  const state = { boundary: job.boundary, after: job.after, ids: [], boundaryIndex: null, pages: 0, exhausted: false, wallMs: 0 };
  run.bookmarks = state;
  const started = io.now();
  await prime(run, io, "Bookmarks");
  let cursor;
  const seenCursors = new Set();
  let offset = 0;
  while (state.pages < job.maxPages) {
    const { json, url } = await request(run, io, "Bookmarks", cursor ? { cursor } : {}, `bookmarks page ${state.pages + 1}`);
    state.pages += 1;
    const capture = await absorb(run, io, { operation: "Bookmarks", json, url, offset });
    offset += capture.advance;
    let fresh = 0;
    for (const { post } of capture.primary) {
      if (state.ids.includes(post.id)) continue;
      fresh += 1;
      state.ids.push(post.id);
      if (post.id === job.boundary) state.boundaryIndex = state.ids.length - 1;
    }
    if (state.boundaryIndex !== null && state.ids.length - 1 - state.boundaryIndex >= job.after) break;
    const next = cursorsOf("Bookmarks", json).find((c) => c.type === "Bottom");
    if (!fresh || !next || seenCursors.has(next.value)) {
      state.exhausted = true;
      break;
    }
    seenCursors.add(next.value);
    cursor = next.value;
  }
  state.wallMs = io.now() - started;
}

function postRecord(id) {
  return {
    id,
    orders: {},
    thread: null,
    // In the order they were opened: { id, ...walk }.
    branches: [],
    branchesSkipped: [],
    upstream: null,
    quotes: {},
    mentions: {},
    links: {},
    conversation: {},
    detailRequests: 0,
    searchRequests: 0,
    detailCapped: false,
    wallMs: 0,
  };
}

async function context(run, io, job) {
  const records = job.ids.map((id) => {
    run.context[id] ??= postRecord(id);
    return run.context[id];
  });
  // TweetDetail for every post first, then every search, so each operation
  // runs on the page that taught its template.
  await prime(run, io, "TweetDetail", job.ids[0]);
  for (const record of records) {
    const started = io.now();
    try {
      await detailFor(run, io, job, record);
    } catch (err) {
      // A deleted or protected post comes back without itself; that post
      // has no context to collect, and the run goes on. Any other parse
      // failure means X changed a shape and stops the run.
      if (!(err instanceof ParseError && /focal post not in the first page/.test(err.message))) throw err;
      record.error = err.message;
    }
    record.wallMs += io.now() - started;
  }
  const searches = records.flatMap((record) => searchesFor(run, job, record));
  if (!searches.length) return;
  await prime(run, io, "SearchTimeline", searches[0].query);
  for (const s of searches) {
    const started = io.now();
    await search(run, io, s);
    s.record.wallMs += io.now() - started;
  }
}

// One permalink in one reply order, followed through every cursor until
// none is left or the post's cap is reached. `shared` is the thread state
// the batches carry (null to start one); returns the walk's own thread, the
// shared state after it, and the ancestors X showed above the focal post.
async function walkPermalink(run, io, record, { focalId, rankingMode, shared, note }) {
  const walk = { thread: null, requests: 0, exhausted: false, cursorsFollowed: {}, cursorsLeft: 0 };
  const ancestors = [];
  let own = null;
  let offset = 0;
  const queue = [null];
  const followed = new Set();
  while (queue.length) {
    if (record.detailRequests >= run.limits.detailCapPerPost) {
      record.detailCapped = true;
      walk.cursorsLeft = queue.length;
      break;
    }
    const cursor = queue.shift();
    const changes = { focalTweetId: focalId, rankingMode, ...(cursor ? { cursor: cursor.value } : {}) };
    const { json, url } = await request(run, io, "TweetDetail", changes, `${note}${cursor ? ` ${cursor.type}` : ""}`);
    record.detailRequests += 1;
    walk.requests += 1;
    if (cursor) walk.cursorsFollowed[cursor.type] = (walk.cursorsFollowed[cursor.type] ?? 0) + 1;
    const capture = await absorb(run, io, { operation: "TweetDetail", json, url, offset, threadState: shared });
    shared = capture.threadState;
    offset += capture.advance;
    const built = extendThread(own, capture.primary, focalId);
    if (built.error) throw new ParseError(built.error);
    own = built.state;
    walk.thread = built.thread;
    for (const item of capture.primary) {
      if (item.role === "ancestor" && !ancestors.includes(item.post.id)) ancestors.push(item.post.id);
    }
    for (const c of cursorsOf("TweetDetail", json)) {
      if (!DETAIL_CURSORS.has(c.type) || followed.has(c.value)) continue;
      followed.add(c.value);
      queue.push(c);
    }
  }
  walk.exhausted = queue.length === 0;
  return { walk, shared, ancestors };
}

// Each reply order keeps its own thread; the batches carry one thread
// across both orders, since the Worker keeps one row per root and
// overwrites it. Then the reply branches, then what the post answers or
// quotes.
async function detailFor(run, io, job, record) {
  const { id } = record;
  let shared = null;
  let ancestors = [];
  for (const rankingMode of job.rankings) {
    const done = await walkPermalink(run, io, record, { focalId: id, rankingMode, shared, note: `${id} ${rankingMode}` });
    record.orders[rankingMode] = done.walk;
    shared = done.shared;
    for (const a of done.ancestors) if (!ancestors.includes(a)) ancestors.push(a);
  }
  if (shared) record.thread = extendThread(shared, [], id).thread;

  if (job.branches && record.thread) {
    const candidates = branchCandidates(run, record);
    for (const branchId of candidates) {
      if (record.branches.length >= run.limits.branchesPerPost || record.detailRequests >= run.limits.detailCapPerPost) {
        record.branchesSkipped.push(branchId);
        continue;
      }
      const done = await walkPermalink(run, io, record, { focalId: branchId, rankingMode: "Relevance", shared: null, note: `${id} branch ${branchId}` });
      record.branches.push({ id: branchId, ...done.walk });
    }
  }

  if (!job.upstream) return;
  const focal = run.posts[id];
  const upstream = { in_reply_to_id: focal?.in_reply_to_id ?? null, quoted_id: focal?.quoted_id ?? null, ancestors, fetched: [], skipped: [] };
  for (const target of [upstream.in_reply_to_id, upstream.quoted_id]) {
    if (!target || run.posts[target]) continue;
    if (record.detailRequests >= run.limits.detailCapPerPost) {
      upstream.skipped.push(target);
      continue;
    }
    const { json, url } = await request(run, io, "TweetDetail", { focalTweetId: target, rankingMode: "Relevance" }, `${id} upstream ${target}`);
    record.detailRequests += 1;
    await absorb(run, io, { operation: "TweetDetail", json, url, offset: 0 });
    upstream.fetched.push(target);
  }
  record.upstream = upstream;
}

// Replies whose own permalink may hold more of the conversation: X shows a
// reply's replies only a few levels deep under the saved post. The rule is
// the Phase 2 pilot's (x-bookmarks-eval archive/2026-11-12/RELEVANCE.md):
// a reply that has replies of its own and is by the saved post's author,
// shows 2 or more replies, or asks a question. The author's replies come
// first, then by reply count.
function branchCandidates(run, record) {
  const author = run.posts[record.id]?.author_handle;
  const ids = [...record.thread.op_self_thread_ids, ...record.thread.reply_ids].filter((x) => x !== record.id);
  const eligible = ids
    .map((x) => run.posts[x])
    .filter((p) => p && p.metrics.replies > 0 && (p.author_handle === author || p.metrics.replies >= 2 || p.text.includes("?")));
  eligible.sort((a, b) => (b.author_handle === author) - (a.author_handle === author) || b.metrics.replies - a.metrics.replies);
  return eligible.map((p) => p.id);
}

// Searches for links the post makes to something other than X itself.
// X's url: operator matches the expanded link; host and path are enough.
export function linkTargets(post, max) {
  const out = [];
  for (const raw of post?.urls ?? []) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (/(^|\.)(x\.com|twitter\.com|t\.co)$/i.test(u.hostname)) continue;
    const target = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
    if (!out.includes(target)) out.push(target);
    if (out.length >= max) break;
  }
  return out;
}

function searchesFor(run, job, record) {
  const out = [];
  const add = (bucket, key, query, product) => out.push({ record, bucket, key, query, product });
  const { id } = record;
  if (job.quotes) add("quotes", "quoted_tweet_id", `quoted_tweet_id:${id}`, "Latest");
  // url:<id> matches any link to the post: x.com or twitter.com, any handle.
  if (job.mentions) for (const p of ["Latest", "Top"]) add("mentions", `url:${id}`, `url:${id}`, p);
  if (job.links) {
    for (const target of linkTargets(run.posts[id], run.limits.linksPerPost)) {
      for (const p of ["Latest", "Top"]) add("links", target, `url:"${target}"`, p);
    }
  }
  const conversationId = run.posts[id]?.conversation_id;
  if (job.conversation && conversationId) {
    add("conversation", `conversation_id:${conversationId}`, `conversation_id:${conversationId}`, "Latest");
  }
  return out;
}

async function search(run, io, s) {
  const result = { query: s.query, product: s.product, ids: [], pages: 0, exhausted: false };
  s.record[s.bucket][s.key] ??= {};
  s.record[s.bucket][s.key][s.product] = result;
  const seenCursors = new Set();
  let cursor;
  let offset = 0;
  while (result.pages < run.limits.searchPagesPerQuery) {
    const changes = { rawQuery: s.query, product: s.product, ...(cursor ? { cursor } : {}) };
    const { json, url } = await request(run, io, "SearchTimeline", changes, `${s.record.id} ${s.bucket} ${s.product}`);
    s.record.searchRequests += 1;
    result.pages += 1;
    const capture = await absorb(run, io, { operation: "SearchTimeline", json, url, offset });
    offset += capture.advance;
    let fresh = 0;
    for (const { post } of capture.primary) {
      if (result.ids.includes(post.id)) continue;
      fresh += 1;
      result.ids.push(post.id);
    }
    const next = cursorsOf("SearchTimeline", json).find((c) => c.type === "Bottom");
    if (!fresh || !next || seenCursors.has(next.value)) {
      result.exhausted = true;
      break;
    }
    seenCursors.add(next.value);
    cursor = next.value;
  }
}
