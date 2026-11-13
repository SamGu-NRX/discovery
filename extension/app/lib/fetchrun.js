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

// Defaults. A job may tighten any of these but never loosen the pacing: the
// gap stays at least 1500 ms, the jitter at least 1000 ms, the cap at most
// 400 and the rate reserve at least 30% (clampLimits).
export const DEFAULT_LIMITS = Object.freeze({
  // Sam's brief: at least 1.5 s between requests, with jitter on top.
  minGapMs: 1500,
  jitterMs: 1000,
  // Requests per run, primes included.
  runCap: 400,
  // TweetDetail requests per post: both reply orders, the parent's
  // conversation, branches and upstream. On Nov 12 run 2 used 30 requests
  // and 6 branches per post and lost 4 of the judged keeps on Mollick's
  // 252-reply essay, replies and branches it never reached; the archive's
  // queue then ran 60 saves at 80 and 15, and only 1 reached 80
  // (docs/x-direct/COMPARISON.md). At 80 a 400-request run still covers at
  // least 5 saves.
  detailCapPerPost: 80,
  // Reply branches opened per post (see branchCandidates).
  branchesPerPost: 15,
  // SearchTimeline pages per query and product.
  searchPagesPerQuery: 5,
  // Linked URLs searched per post.
  linksPerPost: 3,
  // Re-primes after a 404 per operation, before the run stops.
  reprimesPerOperation: 1,
  // X gives each endpoint a request budget per 15-minute window, per
  // account, and Sam's own X tabs draw on the same budget. A run never takes
  // the last 30% of a window: it waits for the reset instead, at most this
  // long, and otherwise stops that run cleanly.
  rateReserveFraction: 0.3,
  maxRateWaitMs: 16 * 60_000,
  // How searches run. "page": open the search page and take the first page
  // of results X loads for it. "replay": replay SearchTimeline with cursors.
  // Live X answered every replayed SearchTimeline with 404 on Nov 12 while
  // it accepted replayed TweetDetail, so page is the default.
  searchVia: "page",
  // Search page loads per 15 minutes. X's SearchTimeline budget was 50 per
  // window on Nov 12, shared with Sam's own searches.
  searchPageLoadsPerWindow: 30,
});

export function clampLimits(given = {}) {
  const out = { ...DEFAULT_LIMITS };
  const int = (v) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : null);
  if (int(given.minGapMs) !== null) out.minGapMs = Math.max(DEFAULT_LIMITS.minGapMs, int(given.minGapMs));
  if (int(given.jitterMs) !== null) out.jitterMs = Math.max(DEFAULT_LIMITS.jitterMs, Math.min(10_000, int(given.jitterMs)));
  if (Number.isFinite(Number(given.rateReserveFraction))) out.rateReserveFraction = Math.max(DEFAULT_LIMITS.rateReserveFraction, Math.min(0.9, Number(given.rateReserveFraction)));
  if (int(given.maxRateWaitMs) !== null) out.maxRateWaitMs = Math.max(0, Math.min(DEFAULT_LIMITS.maxRateWaitMs, int(given.maxRateWaitMs)));
  if (given.searchVia !== undefined) {
    if (!["page", "replay"].includes(given.searchVia)) throw new Error("limits.searchVia must be page or replay");
    out.searchVia = given.searchVia;
  }
  if (int(given.searchPageLoadsPerWindow) !== null) out.searchPageLoadsPerWindow = Math.max(1, Math.min(DEFAULT_LIMITS.searchPageLoadsPerWindow, int(given.searchPageLoadsPerWindow)));
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
      const known = ["ids", "type", "rankings", "parent", "branches", "quotes", "mentions", "links", "conversation", "upstream"];
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
        parent: flag("parent"),
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
 *   stopRequested(): false, or why the run should stop
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
    // Thread state per permalink, across every walk that opens it: the
    // Worker keeps one thread row per root and overwrites it, so each batch
    // must carry everything known about that root.
    threadStates: {},
    // The last x-rate-limit-* headers per operation, and each wait for a reset.
    rate: {},
    rateWaits: [],
    // When each search page load happened, for searchPageLoadsPerWindow.
    searchPageLoads: [],
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
  const { lastRequestAt, reprimes, primedFor, threadStates, searchPageLoads, ...out } = run;
  return out;
}

async function gate(run, io, operation = null) {
  if (io.stopRequested()) throw new RunStopped("stopped", stopDetail(io));
  if (run.requests >= run.limits.runCap) throw new RunStopped("cap", `reached the run cap of ${run.limits.runCap} requests`);
  if (await io.paused()) throw new RunStopped("paused", "the extension is paused (an X signal in the last 24 hours)");
  if (operation) await keepRateReserve(run, io, operation);
  if (run.lastRequestAt !== null) {
    const gap = run.limits.minGapMs + io.random() * run.limits.jitterMs;
    const wait = run.lastRequestAt + gap - io.now();
    if (wait > 0) await io.sleep(wait);
  }
  // A signal can arrive while waiting, from this tab or any other.
  if (io.stopRequested()) throw new RunStopped("stopped", stopDetail(io));
  if (await io.paused()) throw new RunStopped("paused", "the extension was paused while waiting");
  run.requests += 1;
  run.lastRequestAt = io.now();
}

const PRIMES = { Bookmarks: "bookmarks", TweetDetail: "detail", SearchTimeline: "search" };

// Opens a page where X itself calls `operation`, so its template is current.
// Counts as one request against the cap, since the page load reaches X.
async function prime(run, io, operation, arg) {
  run.primedFor[operation] = arg;
  // X has moved bookmarks under /i/history: /i/bookmarks may open another
  // history tab, and /i/history/bookmarks is tried next. Each page load is
  // its own request through the gate.
  const kinds = operation === "Bookmarks" ? ["bookmarks", "history_bookmarks"] : [PRIMES[operation]];
  for (const kind of kinds) {
    await gate(run, io, operation);
    const at = io.now();
    await io.prime(kind, arg);
    run.primes.push({ operation, kind, arg, at: new Date(at).toISOString(), ms: io.now() - at });
    if (await io.template(operation)) return;
  }
  throw new RunStopped("error", `opened ${kinds.join(" and ")} but X did not call ${operation} there, so its query id and features are unknown`);
}

// Waits for X's window to reset when the last response left no more than
// the reserve, so a run never spends the requests Sam's own browsing needs.
async function keepRateReserve(run, io, operation) {
  const rate = run.rate[operation];
  if (!rate || rate.limit === null || rate.remaining === null || rate.reset === null) return;
  const reserve = Math.max(5, Math.ceil(rate.limit * run.limits.rateReserveFraction));
  if (rate.remaining > reserve) return;
  const wait = rate.reset * 1000 + 2000 - io.now();
  if (wait > run.limits.maxRateWaitMs) {
    throw new RunStopped("rate_budget", `${operation} has ${rate.remaining} of ${rate.limit} requests left and resets in ${Math.round(wait / 60_000)} min`);
  }
  if (wait > 0) {
    run.rateWaits.push({ operation, at: new Date(io.now()).toISOString(), ms: wait, remaining: rate.remaining, limit: rate.limit });
    await io.sleep(wait);
  }
  delete run.rate[operation];
}

// One GET. Returns { json, url }; re-primes and retries once after a 404.
async function request(run, io, operation, changes, note) {
  assertReadOperation(operation);
  for (;;) {
    const template = await io.template(operation);
    const { url, variables } = buildRequest(template, operation, changes);
    await gate(run, io, operation);
    let res;
    try {
      res = await io.send(operation, url);
    } catch (err) {
      ledger(run, { operation, variables, status: 0, ms: null, note: `${note}; failed: ${err.message}` });
      // A request that never got an answer may be X refusing the connection;
      // treat it like X backing off.
      throw new RunStopped("error", `${operation} request failed: ${err.message}`, { pause: true });
    }
    if (res.rate?.limit != null) run.rate[operation] = res.rate;
    const verdict = classifyResponse({ operation, ...res });
    ledger(run, { operation, variables, status: res.status, ms: res.ms, note, remaining: res.rate?.remaining ?? null });
    if (verdict.kind === "json") return { json: verdict.json, url };
    if (verdict.kind === "stop") throw new RunStopped(verdict.reason, verdict.detail, { pause: verdict.pause });
    const used = run.reprimes[operation] ?? 0;
    if (used >= run.limits.reprimesPerOperation) throw new RunStopped("error", `${verdict.detail}, also after re-opening the page`);
    run.reprimes[operation] = used + 1;
    await prime(run, io, operation, run.primedFor[operation]);
  }
}

function ledger(run, { operation, variables, status, ms, note, remaining = null }) {
  // Cursors are long opaque strings; the start is enough to tell pages apart.
  const shown = { ...variables };
  if (typeof shown.cursor === "string") shown.cursor = `${shown.cursor.slice(0, 16)}…`;
  run.ledger.push({ i: run.requests, at: new Date(run.lastRequestAt).toISOString(), operation, variables: shown, status, ms, remaining, note });
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
    // The conversation of the post this one answers, when it is a reply:
    // { id, ...walk }, or { id, skipped: reason }. null for a post that
    // answers nothing or a job without `parent`.
    parent: null,
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
  if (run.limits.searchVia === "replay") await prime(run, io, "SearchTimeline", searches[0].query);
  for (const s of searches) {
    const started = io.now();
    await search(run, io, s);
    s.record.wallMs += io.now() - started;
  }
}

// One permalink in one reply order, followed through every cursor until
// none is left or the post's cap is reached. Returns the walk's own thread
// and the ancestors X showed above the focal post; the batches carry the
// permalink's thread across all its walks (run.threadStates).
async function walkPermalink(run, io, record, { focalId, rankingMode, note }) {
  const walk = { thread: null, requests: 0, exhausted: false, cursorsFollowed: {}, cursorsLeft: 0 };
  const ancestors = [];
  let own = null;
  let offset = 0;
  const queue = [null];
  const followed = new Set();
  const seen = new Set();
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
    const capture = await absorb(run, io, { operation: "TweetDetail", json, url, offset, threadState: run.threadStates[focalId] ?? null });
    run.threadStates[focalId] = capture.threadState;
    offset += capture.advance;
    const built = extendThread(own, capture.primary, focalId);
    if (built.error) throw new ParseError(built.error);
    own = built.state;
    walk.thread = built.thread;
    let fresh = 0;
    for (const item of capture.primary) {
      if (item.role === "ancestor" && !ancestors.includes(item.post.id)) ancestors.push(item.post.id);
      if (!seen.has(item.post.id)) {
        seen.add(item.post.id);
        fresh += 1;
      }
    }
    // Live X hands out a new Top cursor with every page, and following one
    // returns nothing but another (seen on Nov 12: half of a run's
    // TweetDetail requests were empty Top pages). So Top is followed from a
    // walk's first page only, and a page that brought no new post ends its
    // line of cursors.
    if (cursor && fresh === 0) continue;
    for (const c of cursorsOf("TweetDetail", json)) {
      if (!DETAIL_CURSORS.has(c.type) || followed.has(c.value)) continue;
      if (c.type === "Top" && cursor) continue;
      followed.add(c.value);
      queue.push(c);
    }
  }
  walk.exhausted = queue.length === 0;
  return { walk, ancestors };
}

// Each reply order keeps its own thread; the batches carry one thread
// across both orders, since the Worker keeps one row per root and
// overwrites it. Then the reply branches, then what the post answers or
// quotes.
async function detailFor(run, io, job, record) {
  const { id } = record;
  const ancestors = [];
  for (const rankingMode of job.rankings) {
    const done = await walkPermalink(run, io, record, { focalId: id, rankingMode, note: `${id} ${rankingMode}` });
    record.orders[rankingMode] = done.walk;
    for (const a of done.ancestors) if (!ancestors.includes(a)) ancestors.push(a);
  }
  if (run.threadStates[id]) record.thread = extendThread(run.threadStates[id], [], id).thread;

  // A saved reply often sits in a conversation whose replies are about the
  // post it answers, not about the reply itself. On Nov 12 Emil's save
  // (2120252783953871317) answered his own 86-reply post, and 16 of its 22
  // judged keeps were replies to that post, which the computer-use pilot read
  // and fetch mode did not: it had the parent from the ancestors above the
  // save and never opened the parent's own permalink. One Relevance walk
  // there reads what the pilot read.
  const parentId = run.posts[id]?.in_reply_to_id ?? null;
  if (job.parent && parentId) {
    // A parent that is itself a save in this run gets its own walks.
    if (run.context[parentId]) record.parent = { id: parentId, skipped: "saved in this run" };
    else if (record.detailRequests >= run.limits.detailCapPerPost) record.parent = { id: parentId, skipped: "per-post cap" };
    else {
      const done = await walkPermalink(run, io, record, { focalId: parentId, rankingMode: "Relevance", note: `${id} parent ${parentId}` });
      record.parent = { id: parentId, ...done.walk };
    }
  }

  if (job.branches && record.thread) {
    const candidates = branchCandidates(run, record);
    for (const branchId of candidates) {
      if (record.branches.length >= run.limits.branchesPerPost || record.detailRequests >= run.limits.detailCapPerPost) {
        record.branchesSkipped.push(branchId);
        continue;
      }
      const done = await walkPermalink(run, io, record, { focalId: branchId, rankingMode: "Relevance", note: `${id} branch ${branchId}` });
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
    const capture = await absorb(run, io, { operation: "TweetDetail", json, url, offset: 0, threadState: run.threadStates[target] ?? null });
    run.threadStates[target] = capture.threadState;
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
  // Posts above the saved one are upstream, not branches.
  const self = record.thread.op_self_thread_ids;
  const ids = [...self.slice(self.indexOf(record.id) + 1), ...record.thread.reply_ids];
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
  if (run.limits.searchVia === "page") return searchByPage(run, io, s, result);
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

// Waits until fewer than searchPageLoadsPerWindow search pages were opened
// in the last 15 minutes, or stops the run cleanly when that is too far off.
async function keepSearchBudget(run, io) {
  const WINDOW = 15 * 60_000;
  const recent = run.searchPageLoads.filter((at) => io.now() - at < WINDOW);
  run.searchPageLoads = recent;
  if (recent.length < run.limits.searchPageLoadsPerWindow) return;
  const wait = recent[0] + WINDOW + 2000 - io.now();
  if (wait > run.limits.maxRateWaitMs) throw new RunStopped("rate_budget", `${recent.length} search pages opened in 15 minutes`);
  run.rateWaits.push({ operation: "SearchTimeline", at: new Date(io.now()).toISOString(), ms: wait, remaining: null, limit: run.limits.searchPageLoadsPerWindow });
  await io.sleep(wait);
}

// One search page load: the first page of results, as X's own page asked
// for it. Later pages would need X to load more on scroll; a result notes
// whether X offered more.
async function searchByPage(run, io, s, result) {
  await keepSearchBudget(run, io);
  await gate(run, io);
  run.searchPageLoads.push(io.now());
  const note = `${s.record.id} ${s.bucket} ${s.product} (page)`;
  const variables = { rawQuery: s.query, product: s.product };
  let res;
  try {
    res = await io.loadPage("search", s.query, s.product);
  } catch (err) {
    ledger(run, { operation: "SearchTimeline", variables, status: 0, ms: null, note: `${note}; failed: ${err.message}` });
    throw new RunStopped("error", `search page for ${s.query} failed: ${err.message}`, { pause: true });
  }
  ledger(run, { operation: "SearchTimeline", variables, status: res.status, ms: res.ms, note });
  const verdict = classifyResponse({ operation: "SearchTimeline", ...res });
  if (verdict.kind === "stale") throw new RunStopped("error", verdict.detail);
  if (verdict.kind === "stop") throw new RunStopped(verdict.reason, verdict.detail, { pause: verdict.pause });
  s.record.searchRequests += 1;
  result.pages = 1;
  const capture = await absorb(run, io, { operation: "SearchTimeline", json: verdict.json, url: res.url, offset: 0 });
  for (const { post } of capture.primary) if (!result.ids.includes(post.id)) result.ids.push(post.id);
  const next = cursorsOf("SearchTimeline", verdict.json).find((c) => c.type === "Bottom");
  result.exhausted = !next || capture.primary.length === 0;
  result.morePages = !result.exhausted;
}

// The page passes the reason as a string; anything else is the old "Sam
// pressed Stop".
function stopDetail(io) {
  const why = io.stopRequested();
  return typeof why === "string" ? why : "stopped by Sam";
}
