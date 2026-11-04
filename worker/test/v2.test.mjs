// Discovery v2 routes (docs/CONTRACT.md) against a real `wrangler dev` with
// local D1. The fixture's /t3-webhook stands in for T3_APPROVALS_WEBHOOK_URL.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startStack } from "../scripts/harness.mjs";

let s;
before(async () => {
  s = await startStack({ port: 8841, fixturePort: 8842, inspectorPort: 9341 });
});
after(async () => {
  await s?.stop();
});

const post = (id, extra = {}) => ({
  id,
  author_handle: "alice",
  author_name: "Alice",
  created_at: "2026-11-04T08:00:00Z",
  text: `post ${id}`,
  lang: "en",
  conversation_id: id,
  in_reply_to_id: null,
  quoted_id: null,
  retweet_of_id: null,
  urls: [],
  media: [],
  metrics: { likes: 1 },
  ...extra,
});
let batchSeq = 0;
const batch = (surface, posts, extra = {}) => ({
  batch_id: `cap-${process.pid}:${batchSeq++}`,
  op: { bookmarks: "Bookmarks", detail: "TweetDetail" }[surface] ?? "HomeTimeline",
  surface,
  posts: posts.map((p, i) => ({ ...p, position: i })),
  ...extra,
});
const ingest = (session, batches, account = "acct") =>
  s.call("POST", "/ingest/x", { account, session_id: session, mode: "passive", captured_at: new Date().toISOString(), batches }, { token: "ingest" });
const runner = (method, path, body) => s.call(method, path, body, { token: "runner" });
const xCandidates = async () => (await runner("GET", "/candidates?kind=x_post")).candidates;

test("each token reaches only its own routes", async () => {
  const status = async (method, path, token) => (await s.call(method, path, method === "POST" ? {} : undefined, { raw: true, token })).status;
  for (const [method, path] of [["GET", "/x/posts"], ["POST", "/candidates/claim"], ["POST", "/embed"], ["GET", "/positives"], ["GET", "/admin/watchers"], ["POST", "/jobs/claim"]]) {
    assert.equal(await status(method, path, "ingest"), 403, `ingest token on ${method} ${path}`);
  }
  for (const [method, path] of [["GET", "/proposals"], ["GET", "/admin/log"]]) {
    assert.equal(await status(method, path, "ingest"), 403, `ingest token on ${method} ${path}`);
  }
  for (const [method, path] of [["POST", "/ingest/x"], ["POST", "/ingest/x/status"], ["GET", "/x/detail-queue?account=a"], ["GET", "/admin/events"], ["POST", "/admin/watchers"], ["GET", "/jobs/1"], ["GET", "/admin/log"]]) {
    assert.equal(await status(method, path, "runner"), 403, `runner token on ${method} ${path}`);
  }
  assert.equal(await status("GET", "/x/posts", "none"), 401);
  const forged = await fetch(`${s.base}/x/posts`, { headers: { authorization: `Bearer ${s.vars.RUNNER_TOKEN}x` } });
  assert.equal(forged.status, 401);
  // Each token does reach its own routes, and the admin token reaches them all.
  assert.equal(await status("GET", "/x/detail-queue?account=a", "ingest"), 200);
  assert.equal(await status("GET", "/x/posts", "runner"), 200);
  assert.equal(await status("GET", "/x/detail-queue?account=a", "admin"), 200);
});

test("ingest upserts posts with the latest metrics, writes one sighting per post per batch, and makes one candidate per newly bookmarked post", async () => {
  await runner("POST", "/positives", { items: [{ id: "i-old-save", text: "an old save", author_handle: "alice", source: "test" }] });

  const r1 = await ingest("sess-1", [
    // i-1 twice in one batch is one sighting; i-2 in two batches is two.
    batch("home_for_you", [post("i-1"), post("i-2"), post("i-1", { metrics: { likes: 3 } })]),
    batch("home_following", [post("i-2", { metrics: { likes: 2 } })]),
    batch("bookmarks", [post("i-3"), post("i-old-save")]),
  ]);
  assert.deepEqual(r1, { posts_upserted: 4, sightings: 5, new_posts: 4, candidates_created: 1, duplicate_batch_ids: [] });

  const r2 = await ingest("sess-2", [batch("home_for_you", [post("i-1", { metrics: { likes: 9 } })]), batch("bookmarks", [post("i-1", { metrics: { likes: 9 } }), post("i-3")])]);
  assert.deepEqual(r2, { posts_upserted: 2, sightings: 3, new_posts: 0, candidates_created: 1, duplicate_batch_ids: [] });

  const { posts } = await runner("GET", "/x/posts?unscored=1&limit=500");
  const byId = Object.fromEntries(posts.map((p) => [p.id, p]));
  assert.deepEqual(byId["i-1"].metrics, { likes: 9 });
  assert.equal(byId["i-1"].seen_count, 3);
  assert.equal(byId["i-1"].bookmarked, 1);
  assert.equal(byId["i-1"].surface, "bookmarks");
  assert.equal(byId["i-1"].session_id, "sess-2");
  assert.equal(byId["i-1"].account, "acct");
  assert.deepEqual(byId["i-2"].metrics, { likes: 2 });
  assert.equal(byId["i-2"].seen_count, 2);
  assert.equal(byId["i-2"].bookmarked, 0);

  const c = (await xCandidates()).filter((x) => x.ref.startsWith("i-"));
  assert.deepEqual(c.map((x) => x.ref).sort(), ["i-1", "i-3"], "a bookmark makes one candidate, and a seeded past save makes none");
  assert.ok(c.every((x) => x.origin === "bookmark" && x.url === `https://x.com/alice/status/${x.ref}`));

  await runner("POST", "/x/posts/scores", { scores: [{ id: "i-2", score: 0.42, parts: { pos: 0.5 } }] });
  const unscored = (await runner("GET", "/x/posts?unscored=1&limit=500")).posts.map((p) => p.id);
  assert.ok(!unscored.includes("i-2") && unscored.includes("i-1"));

  const valid = { account: "acct", session_id: "s", mode: "passive", captured_at: "2026-11-04T09:00:00Z" };
  const badBodies = [
    [null, /JSON object/],
    [{ ...valid, captured_at: undefined }, /captured_at/],
    [{ ...valid, batches: [batch("home_for_you", [{ ...post("i-9"), author_handle: undefined }])] }, /batches\[0\]\.posts\[0\]\.author_handle/],
    [{ ...valid, batches: [batch("home_for_you", [post("i-9", { created_at: "not-a-date" })])] }, /created_at/],
    [{ ...valid, batches: [batch("home_for_you", [post("i-9", { metrics: { likes: "lots" } })])] }, /metrics\.likes/],
    [{ ...valid, batches: [batch("home_for_you", [post("i-9")], { thread: { root_id: "i-9", op_self_thread_ids: [], reply_ids: [] } })] }, /thread/],
    [{ ...valid, batches: [{ ...batch("home_for_you", [post("i-9")]), batch_id: undefined }] }, /batch_id/],
    [{ ...valid, batches: [batch("home_for_you", [post("i-9")], { batch_id: "same" }), batch("home_for_you", [post("i-9")], { batch_id: "same" })] }, /appears twice/],
  ];
  for (const [body, field] of badBodies) {
    const res = await s.call("POST", "/ingest/x", body, { raw: true, token: "ingest" });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)?.slice(0, 80)}`);
    assert.match(await res.text(), field);
  }
  assert.equal((await runner("GET", "/x/posts?limit=200")).posts.filter((p) => p.id === "i-9").length, 0, "a refused request stores nothing");
});

test("a replayed batch_id writes no sightings and moves no counter, and a partial replay counts only the new batch", async () => {
  const sessionPosts = async () => (await s.call("GET", "/admin/log?since=0")).x_sessions.find((x) => x.session_id === "sess-replay").posts;
  const request = [batch("home_for_you", [post("r-1"), post("r-2")]), batch("bookmarks", [post("r-3")])];
  const first = await ingest("sess-replay", request);
  assert.deepEqual(first, { posts_upserted: 3, sightings: 3, new_posts: 3, candidates_created: 1, duplicate_batch_ids: [] });
  const seen = async () => Object.fromEntries((await runner("GET", "/x/posts?limit=200")).posts.filter((p) => p.id.startsWith("r-")).map((p) => [p.id, p.seen_count]));
  const before = await seen();
  assert.equal(await sessionPosts(), 3);

  // The same request again, as after a lost response.
  const replay = await ingest("sess-replay", request);
  assert.deepEqual(replay, { posts_upserted: 0, sightings: 0, new_posts: 0, candidates_created: 0, duplicate_batch_ids: request.map((b) => b.batch_id) });
  assert.deepEqual(await seen(), before, "a replay must not bump seen_count");
  assert.equal(await sessionPosts(), 3, "a replay must not bump the session's posts");

  // One old batch and one new one: only the new one is written.
  const mixed = await ingest("sess-replay", [request[0], batch("home_following", [post("r-1"), post("r-4")])]);
  assert.deepEqual(mixed, { posts_upserted: 2, sightings: 2, new_posts: 1, candidates_created: 0, duplicate_batch_ids: [request[0].batch_id] });
  assert.equal((await seen())["r-1"], before["r-1"] + 1);
  assert.equal((await seen())["r-2"], before["r-2"]);
  assert.equal(await sessionPosts(), 5);

  // A new batch, then a replayed one holding an older copy of the same post:
  // the replay must not overwrite the newer values.
  const newer = batch("home_for_you", [post("r-1", { text: "edited", metrics: { likes: 777 } })]);
  const order = await ingest("sess-replay", [newer, request[0]]);
  assert.deepEqual(order, { posts_upserted: 1, sightings: 1, new_posts: 0, candidates_created: 0, duplicate_batch_ids: [request[0].batch_id] });
  const r1 = (await runner("GET", "/x/posts/r-1/context")).post;
  assert.equal(r1.text, "edited");
  assert.deepEqual(r1.metrics, { likes: 777 });
  assert.equal(r1.seen_count, before["r-1"] + 2);
});

test("the ingest cap is 128 KB of bytes, counted while reading, even without a Content-Length", async () => {
  const send = (text) => {
    // A stream body goes out chunked, with no Content-Length to check first.
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
    return fetch(`${s.base}/ingest/x`, { method: "POST", duplex: "half", body, headers: { authorization: `Bearer ${s.vars.INGEST_TOKEN}`, "content-type": "application/json" } });
  };
  const wrap = (text) => JSON.stringify({ account: "acct-cap", session_id: "sess-cap", mode: "passive", captured_at: new Date().toISOString(), batches: [batch("home_for_you", [post("cap-1", { text })])] });
  // 2-byte characters: under 128 K characters, over 128 KB of bytes.
  const multibyte = wrap("é".repeat(70_000));
  assert.ok(multibyte.length < 128 * 1024 && new TextEncoder().encode(multibyte).length > 128 * 1024);
  assert.equal((await send(multibyte)).status, 413);
  assert.equal((await send(wrap("a".repeat(132_000)))).status, 413);
  assert.equal((await send(wrap("a".repeat(120_000)))).status, 200);
});

test("account test is synthetic: its posts never reach GET /x/posts or become candidates, and test- refs are refused", async () => {
  // Ids without the test- prefix, so the account alone has to keep them out.
  const r = await ingest("sess-syn", [batch("home_for_you", [post("syn-1"), post("syn-shared")]), batch("bookmarks", [post("syn-2")])], "test");
  assert.equal(r.candidates_created, 0, "a bookmark from account test makes no candidate");
  // A real account sees one of the same posts.
  await ingest("sess-real", [batch("home_for_you", [post("syn-shared")])], "acct-real");
  await ingest("sess-syn", [batch("home_for_you", [post("syn-shared")])], "test");

  for (const path of ["/x/posts?unscored=1&limit=200", "/x/posts?limit=200"]) {
    const ids = (await runner("GET", path)).posts.map((p) => p.id);
    assert.ok(!ids.includes("syn-1") && !ids.includes("syn-2"), `${path} must not list posts only account test has seen`);
    assert.ok(ids.includes("syn-shared"), `${path} still lists a post a real account has seen`);
  }
  const shared = (await runner("GET", "/x/posts?limit=200")).posts.find((p) => p.id === "syn-shared");
  assert.equal(shared.account, "acct-real", "the listed sighting is the real account's, not test's later one");

  const refuse = async (body) => (await s.call("POST", "/candidates", body, { raw: true, token: "runner" })).status;
  assert.equal(await refuse({ kind: "watcher_event", ref: "test-anything", title: "t" }), 422);
  assert.equal(await refuse({ kind: "x_post", ref: "syn-1", title: "t" }), 422, "a post only account test saw can't become a candidate");
  assert.equal(await refuse({ kind: "x_post", ref: "syn-shared", title: "t" }), 201);
  assert.ok(!(await xCandidates()).some((c) => c.ref === "syn-1" || c.ref === "syn-2"));
});

test("a captured thread leaves the detail queue and reads back in server order; a non-ok session pauses the account", async () => {
  await ingest("sess-d", [batch("bookmarks", [post("d-1")])], "acct-d");
  assert.deepEqual((await s.call("GET", "/x/detail-queue?account=acct-d", undefined, { token: "ingest" })).post_ids, ["d-1"]);

  const replies = [post("d-r3", { in_reply_to_id: "d-1" }), post("d-r1", { in_reply_to_id: "d-1" }), post("d-r2", { in_reply_to_id: "d-1" })];
  await ingest("sess-d", [batch("detail", [post("d-1"), post("d-op2", { in_reply_to_id: "d-1" }), ...replies], { thread: { root_id: "d-1", op_self_thread_ids: ["d-op2"], reply_ids: ["d-r3", "d-r1", "d-r2"] } })], "acct-d");
  assert.deepEqual((await s.call("GET", "/x/detail-queue?account=acct-d", undefined, { token: "ingest" })).post_ids, []);

  const ctx = await runner("GET", "/x/posts/d-1/context");
  assert.equal(ctx.thread_captured, true);
  assert.deepEqual(ctx.thread.op_self_thread.map((p) => p.id), ["d-op2"]);
  assert.deepEqual(ctx.thread.replies.map((p) => p.id), ["d-r3", "d-r1", "d-r2"]);

  await s.call("POST", "/ingest/x/status", { account: "acct-d", session_id: "sess-d", status: "login_wall", detail: "login wall at /home" }, { token: "ingest" });
  const q = await s.call("GET", "/x/detail-queue?account=acct-d", undefined, { token: "ingest" });
  assert.deepEqual(q.post_ids, []);
  const pauseMs = Date.parse(q.pause_until) - Date.now();
  assert.ok(pauseMs > 23.9 * 3600_000 && pauseMs <= 24 * 3600_000, `pause_until should be 24 h out, was ${pauseMs} ms`);
});

test("session reservations: a non-ok status or an unreported reservation pauses the account for 24 h, and replays neither extend nor clear it", async () => {
  const start = async (account, session_id) => {
    const res = await s.call("POST", "/x/sessions/start", { account, session_id }, { raw: true, token: "ingest" });
    return { status: res.status, body: await res.json() };
  };
  const report = (account, session_id, status) => s.call("POST", "/ingest/x/status", { account, session_id, status }, { token: "ingest" });
  const hour = 3600_000;
  // Moves a session's times into the past instead of waiting.
  const age = (session_id, column, ms) => s.d1(`UPDATE x_sessions SET ${column} = ${column} - ${ms} WHERE session_id = '${session_id}'`);
  const until = (r) => Date.parse(r.body.pause_until);

  // A clean session, then the next one starts.
  assert.equal((await start("acct-ok", "ok-1")).status, 200);
  await report("acct-ok", "ok-1", "ok");
  assert.equal((await start("acct-ok", "ok-2")).status, 200);

  // rate_limited pauses the account for 24 h from the report.
  assert.equal((await start("acct-rl", "rl-1")).status, 200);
  await report("acct-rl", "rl-1", "rate_limited");
  let r = await start("acct-rl", "rl-2");
  assert.equal(r.status, 423);
  assert.ok(Math.abs(until(r) - (Date.now() + 24 * hour)) < 60_000);
  // A refused start leaves no reservation, which would otherwise read as a
  // crash 30 minutes later and pause the account again.
  assert.deepEqual(await s.d1("SELECT session_id FROM x_sessions WHERE session_id = 'rl-2'"), []);

  // A replayed status, an hour later, neither extends nor clears the pause.
  await age("rl-1", "ended_at", hour);
  const before = until(await start("acct-rl", "rl-3"));
  await report("acct-rl", "rl-1", "rate_limited");
  await report("acct-rl", "rl-1", "ok");
  r = await start("acct-rl", "rl-4");
  assert.equal(r.status, 423, "a replayed ok must not clear the pause");
  assert.equal(until(r), before, "a replayed status must not extend the pause");

  // 24 h after the status, sessions start again.
  await age("rl-1", "ended_at", 23 * hour + 60_000);
  assert.equal((await start("acct-rl", "rl-5")).status, 200);

  // A reservation that never reports is a crash once it is 30 min old,
  // and the 24 h run from when the crash is detected.
  assert.equal((await start("acct-crash", "cr-1")).status, 200);
  await age("cr-1", "reserved_at", 29 * 60_000);
  r = await start("acct-crash", "cr-2");
  assert.equal(r.status, 423, "29 minutes in, cr-1 is still open");
  assert.ok(Math.abs(until(r) - (Date.now() + 60_000)) < 10_000, "until cr-1 would count as a crash");
  await age("cr-1", "reserved_at", 2 * 60_000);
  r = await start("acct-crash", "cr-3");
  assert.equal(r.status, 423);
  const crashUntil = until(r);
  assert.deepEqual(await s.d1("SELECT status, detail FROM x_sessions WHERE session_id = 'cr-1'"), [{ status: "crash", detail: "no status 31 min after its reservation" }]);
  assert.ok(Math.abs(crashUntil - (Date.now() + 24 * hour)) < 60_000);
  // A late ok for the crashed session does not clear it; a late real status
  // starts the clock from its own, later time.
  await report("acct-crash", "cr-1", "ok");
  assert.equal(until(await start("acct-crash", "cr-4")), crashUntil);
  await age("cr-1", "ended_at", hour);
  await report("acct-crash", "cr-1", "rate_limited");
  assert.ok(until(await start("acct-crash", "cr-5")) > crashUntil - hour + 30 * 60_000, "a real status after the crash restarts the 24 h");
  await age("cr-1", "ended_at", 24 * hour + 60_000);
  assert.equal((await start("acct-crash", "cr-6")).status, 200);

  // The guard is per account, and a closed session id can't be reserved again.
  assert.equal((await start("acct-other", "other-1")).status, 200);
  await report("acct-ok", "ok-2", "ok");
  assert.equal((await start("acct-ok", "ok-1")).status, 409);
  assert.equal((await s.call("POST", "/x/sessions/start", { account: "a", session_id: "b" }, { raw: true, token: "runner" })).status, 403);
});

test("a browser restart mid-session gets no new reservation until the open one reports or turns into a crash", async () => {
  const start = async (account, session_id) => {
    const res = await s.call("POST", "/x/sessions/start", { account, session_id }, { raw: true, token: "ingest" });
    return { status: res.status, body: await res.json() };
  };
  const report = (account, session_id, status) => s.call("POST", "/ingest/x/status", { account, session_id, status }, { token: "ingest" });
  const reservedAt = async (id) => (await s.d1(`SELECT reserved_at FROM x_sessions WHERE session_id = '${id}'`))[0].reserved_at;

  // The browser dies mid-session after X rate-limits it, before anything is
  // reported. After the restart the extension asks for a new session.
  assert.equal((await start("acct-restart", "before")).status, 200);
  let r = await start("acct-restart", "after");
  assert.equal(r.status, 423, "a second session while the first is open");
  assert.equal(Date.parse(r.body.pause_until), (await reservedAt("before")) + 30 * 60_000);
  assert.deepEqual(await s.d1("SELECT session_id FROM x_sessions WHERE session_id = 'after'"), [], "a refused start reserves nothing");
  assert.equal((await start("acct-restart", "before")).status, 200, "the same session_id again is a lost-response retry");

  // The extension reports its own open session first; a rate limit pauses 24 h.
  await report("acct-restart", "before", "rate_limited");
  r = await start("acct-restart", "after");
  assert.equal(r.status, 423);
  assert.ok(Date.parse(r.body.pause_until) - Date.now() > 23.9 * 3600_000);

  // A clean report releases the account at once.
  assert.equal((await start("acct-restart-ok", "one")).status, 200);
  assert.equal((await start("acct-restart-ok", "two")).status, 423);
  await report("acct-restart-ok", "one", "ok");
  assert.equal((await start("acct-restart-ok", "two")).status, 200);
});

test("a reply is covered only by a capture of its own permalink, not by the root's capture listing it among replies", async () => {
  const root = post("t-root", { author_handle: "bob" });
  const self = post("t-self", { author_handle: "bob", conversation_id: "t-root", in_reply_to_id: "t-root" });
  const reply = post("t-reply", { author_handle: "alice", conversation_id: "t-root", in_reply_to_id: "t-root" });
  await ingest("sess-t", [batch("bookmarks", [reply, self])], "acct-t");
  await ingest("sess-t", [batch("detail", [root, self, reply], { thread: { root_id: "t-root", op_self_thread_ids: ["t-self"], reply_ids: ["t-reply"] } })], "acct-t");

  const replyCtx = await runner("GET", "/x/posts/t-reply/context");
  assert.equal(replyCtx.thread_captured, false, "another author's root thread is not this reply's thread");
  const queue = (await s.call("GET", "/x/detail-queue?account=acct-t", undefined, { token: "ingest" })).post_ids;
  assert.ok(queue.includes("t-reply"), "the reply's own permalink must still be queued");
  assert.ok(!queue.includes("t-self"), "the OP's own self-thread post is covered by the root capture");
  assert.equal((await runner("GET", "/x/posts/t-self/context")).thread_captured, true);

  await ingest("sess-t", [batch("detail", [reply], { thread: { root_id: "t-reply", op_self_thread_ids: [], reply_ids: [] } })], "acct-t");
  const own = await runner("GET", "/x/posts/t-reply/context");
  assert.equal(own.thread_captured, true);
  assert.equal(own.thread.root_id, "t-reply");
});

test("candidates: an expired lease is reclaimed, a stale owner gets 409, and a candidate that keeps expiring fails instead of looping", async () => {
  await runner("POST", "/candidates", { kind: "watcher_event", ref: "lease:1", title: "lease one", url: null, score: null });
  const again = await runner("POST", "/candidates", { kind: "watcher_event", ref: "lease:1", title: "lease one", url: null, score: null });
  assert.equal(again.created, false, "POST /candidates is idempotent on (kind, ref)");
  const claim = async (owner, ttl_s, ref = "lease:1") => (await runner("POST", "/candidates/claim", { owner, ttl_s, limit: 10 })).candidates.filter((c) => c.ref === ref);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const [a] = await claim("runner-a", 0.5);
  assert.equal(a.owner, "runner-a");
  assert.deepEqual(await claim("runner-b", 60), [], "a live lease must not be reclaimed");
  await wait(700);
  const [b] = await claim("runner-b", 0.5);
  assert.equal(b.id, a.id);
  assert.equal(b.attempts, 2);
  const stale = await s.call("POST", `/candidates/${a.id}/complete`, { owner: "runner-a", lease_token: a.lease_token, state: "done" }, { raw: true, token: "runner" });
  assert.equal(stale.status, 409);

  await wait(700);
  const [c] = await claim("runner-c", 0.5);
  assert.equal(c.attempts, 3);
  await wait(700);
  assert.deepEqual(await claim("runner-d", 60), [], "a third expired lease must not be handed out again");
  const row = (await runner("GET", "/candidates?kind=watcher_event")).candidates.find((x) => x.ref === "lease:1");
  assert.equal(row.state, "failed");

  await runner("POST", "/candidates", { kind: "watcher_event", ref: "lease:2", title: "lease two" });
  const [d] = await claim("runner-e", 60, "lease:2");
  const done = await runner("POST", `/candidates/${d.id}/complete`, { owner: "runner-e", lease_token: d.lease_token, state: "proposed", note: "p_1" });
  assert.equal(done.state, "proposed");
  assert.deepEqual(await claim("runner-f", 60, "lease:2"), [], "a completed candidate is never handed out again");
});

test("lease tokens: completing needs the current claim's token, so a reclaim under the same owner name strands the old one", async () => {
  await runner("POST", "/candidates", { kind: "watcher_event", ref: "token:1", title: "token one" });
  const claim = async (owner, ttl_s) => (await runner("POST", "/candidates/claim", { owner, ttl_s, limit: 10 })).candidates.find((c) => c.ref === "token:1");
  const complete = (id, body) => s.call("POST", `/candidates/${id}/complete`, { state: "done", ...body }, { raw: true, token: "runner" });

  const first = await claim("runner-same", 0.5);
  assert.match(first.lease_token, /^[0-9a-f]{32}$/);
  assert.equal((await complete(first.id, { owner: "runner-same" })).status, 400, "lease_token is required");
  assert.equal((await complete(first.id, { owner: "runner-same", lease_token: "0".repeat(32) })).status, 409);
  assert.ok(!("lease_token" in (await runner("GET", "/candidates?state=claimed")).candidates.find((c) => c.ref === "token:1")), "only the claimant sees its token");

  // A second process with the same owner name reclaims after expiry.
  await new Promise((r) => setTimeout(r, 700));
  const second = await claim("runner-same", 60);
  assert.equal(second.id, first.id);
  assert.notEqual(second.lease_token, first.lease_token);
  assert.equal((await complete(first.id, { owner: "runner-same", lease_token: first.lease_token })).status, 409, "the reclaimed lease's token must no longer complete");
  assert.equal((await complete(second.id, { owner: "runner-same", lease_token: second.lease_token })).status, 200);
});

test("completing with state new defers: the lease is released, attempts and the note are kept, and never-tried candidates are claimed first", async () => {
  const claimOne = async (owner) => (await runner("POST", "/candidates/claim", { owner, ttl_s: 60, limit: 1 })).candidates[0];
  // Lease everything earlier tests left unclaimed, so the order below is this test's alone.
  while (await claimOne("drainer"));

  await runner("POST", "/candidates", { kind: "watcher_event", ref: "defer:1", title: "defer one" });
  const first = await claimOne("runner-x");
  assert.equal(first.ref, "defer:1");
  const deferred = await runner("POST", `/candidates/${first.id}/complete`, { owner: "runner-x", lease_token: first.lease_token, state: "new", note: "deferred: thread not captured yet" });
  assert.equal(deferred.state, "new");
  assert.equal(deferred.owner, null);
  assert.equal(deferred.lease_until, null);
  assert.equal(deferred.attempts, 1, "a deferral keeps attempts");
  assert.equal(deferred.note, "deferred: thread not captured yet");
  const again = await s.call("POST", `/candidates/${first.id}/complete`, { owner: "runner-x", lease_token: first.lease_token, state: "done" }, { raw: true, token: "runner" });
  assert.equal(again.status, 409, "a deferral ends the lease, so its token can't complete again");

  await runner("POST", "/candidates", { kind: "watcher_event", ref: "defer:2", title: "defer two" });
  assert.equal((await claimOne("runner-y")).ref, "defer:2", "a never-tried candidate goes before a deferred one");
  const back = await claimOne("runner-y");
  assert.equal(back.ref, "defer:1");
  assert.equal(back.attempts, 2);

  // Deferrals are not crashes: after three of them, one expired lease must
  // not fail the candidate.
  let lease = back;
  for (const n of [2, 3]) {
    await runner("POST", `/candidates/${lease.id}/complete`, { owner: "runner-y", lease_token: lease.lease_token, state: "new", note: `deferral ${n}` });
    lease = (await runner("POST", "/candidates/claim", { owner: "runner-y", ttl_s: n === 3 ? 0.5 : 60, limit: 10 })).candidates.find((c) => c.ref === "defer:1");
  }
  assert.equal(lease.attempts, 4);
  await new Promise((r) => setTimeout(r, 700));
  const after = (await runner("POST", "/candidates/claim", { owner: "runner-z", ttl_s: 60, limit: 10 })).candidates.find((c) => c.ref === "defer:1");
  assert.ok(after, "one expired lease after three deferrals must not fail the candidate");
  assert.equal(after.expired_leases, 1);
});

// ---- proposals and approval links ----

const proposal = (n, extra = {}) => ({
  candidate_ids: [`cand-${n}`],
  kind: "apply_or_attend",
  title: `Proposal ${n}`,
  why: "Matches what you saved.",
  evidence: [{ quote: "applications open", where: "op" }],
  prepared: [{ type: "draft", ref: "https://example.com/draft", summary: "Draft answers" }],
  final_step_kind: "submit",
  final_step: "Submit the application form",
  inputs: { form: "https://example.com/apply", answers: { n } },
  ...extra,
});
const webhookBodies = async () => (await s.control("webhooks")).map((w) => w.body);
const linkPath = (approveUrl) => new URL(approveUrl).pathname;
const decideForm = (path, fields) =>
  fetch(s.base + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const proposalById = async (id) => (await runner("GET", "/proposals?limit=200")).proposals.find((p) => p.id === id);

test("a proposal with no irreversible step is done at once and never notifies", async () => {
  const r = await runner("POST", "/proposals", proposal("done", { final_step_kind: null, final_step: null }));
  assert.equal(r.state, "done");
  assert.equal(r.approve_url, undefined);
  assert.deepEqual((await webhookBodies()).filter((b) => b.event_id === r.id), []);
  const stored = await proposalById(r.id);
  assert.equal(stored.notify_state, null);
  assert.equal(stored.approval_token_hash, undefined, "the token hash is never returned");
});

test("an approval link is single-use, bound to the inputs_hash it showed, escapes proposal text, and dies at expiry", async () => {
  await s.call("POST", "/admin/notifications/pause", { paused: true });
  try {
    const odd = { title: 'Apply <script>alert("x")</script>', prepared: [{ type: "file", ref: "https://bad host/x", summary: "A ref that is not a valid URL" }] };
    const a = await runner("POST", "/proposals", proposal("link", odd));
    assert.equal(a.state, "awaiting_approval");
    assert.equal(a.notify_state, "paused");
    assert.deepEqual(await webhookBodies(), [], "a paused proposal must not be sent");
    const path = linkPath(a.approve_url);

    const card = await fetch(s.base + path);
    assert.equal(card.status, 200);
    const html = await card.text();
    assert.ok(!html.includes("<script>alert"), "proposal text must be escaped");
    assert.ok(html.includes("Apply &lt;script&gt;"));
    assert.ok(html.includes('value="approve"'), "a malformed prepared ref must not stop the card from rendering its buttons");
    const shown = html.match(/name="inputs_hash" value="([0-9a-f]{64})"/)[1];

    const stale = await decideForm(path, { decision: "approve", inputs_hash: "0".repeat(64) });
    assert.equal(stale.status, 409, "a card rendered for other inputs must not approve these");
    assert.equal((await proposalById(a.id)).state, "awaiting_approval");

    // Three decisions sent together: exactly one is recorded. Local workerd
    // may run them one after another, so the later sequential decision is
    // what proves the UPDATE itself refuses a spent link (mutation M31).
    const raced = await Promise.all([
      decideForm(path, { decision: "approve", inputs_hash: shown }),
      fetch(s.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "skip" }) }),
      decideForm(path, { decision: "later", inputs_hash: shown }),
    ]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409, 409]);
    const decided = await proposalById(a.id);
    assert.ok(["approved", "skipped", "later"].includes(decided.state));
    assert.equal(decided.result.inputs_hash, shown);
    assert.equal((await decideForm(path, { decision: "approve", inputs_hash: shown })).status, 409);

    const retry = await runner("POST", "/proposals", proposal("link", odd));
    assert.equal(retry.id, a.id);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.approve_url, undefined, "a retry must not mint a second link");

    const b = await runner("POST", "/proposals", proposal("expiring", { expires_in_s: 1 }));
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await fetch(s.base + linkPath(b.approve_url))).status, 410);
    assert.equal((await decideForm(linkPath(b.approve_url), { decision: "approve" })).status, 410);
    assert.equal((await fetch(`${s.base}/__scheduled?cron=*/15+*+*+*+*`)).status, 200);
    assert.equal((await proposalById(b.id)).state, "expired");
    assert.equal((await fetch(s.base + "/a/" + "f".repeat(64))).status, 404);
  } finally {
    await s.call("POST", "/admin/notifications/pause", { paused: false });
  }
});

test("the card shows every input the hash binds, and a decision resolves its link before reading a body capped at 4 KB", async () => {
  await s.call("POST", "/admin/notifications/pause", { paused: true });
  try {
    const inputs = { to: "alice@example.com", body: "Hi <b>Bob</b>,\n  see the branch", branch: "release/1.2", count: 42, count_text: "42", dry_run: false, cc: null, attachments: ["cv.pdf", "letter.pdf"], repo: { owner: "sam", name: "discovery" } };
    const r = await runner("POST", "/proposals", proposal("inputs", { inputs }));
    const path = linkPath(r.approve_url);
    const html = await (await fetch(s.base + path)).text();
    for (const shown of ["alice@example.com", "Hi &lt;b&gt;Bob&lt;/b&gt;,\n  see the branch", "release/1.2", ">42<", "false", "null", "cv.pdf", "letter.pdf", "sam", "discovery"]) {
      assert.ok(html.includes(shown), `card must show ${shown}`);
    }
    for (const key of ["to", "body", "branch", "count", "count_text", "dry_run", "cc", "attachments", "repo", "owner", "name"]) assert.ok(html.includes(`<dt>${key}</dt>`), `card must label ${key}`);
    assert.ok(!html.includes("<b>Bob</b>"), "input values are escaped");

    // An unknown link is refused without reading its (large) body.
    const junk = await fetch(`${s.base}/a/${"e".repeat(64)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1024 * 1024) });
    assert.equal(junk.status, 404);
    const big = await decideForm(path, { decision: "skip", pad: "p".repeat(5000) });
    assert.equal(big.status, 413);
    assert.equal((await proposalById(r.id)).state, "awaiting_approval", "an oversized body records nothing");
    assert.equal((await decideForm(path, { decision: "skip" })).status, 200);
  } finally {
    await s.call("POST", "/admin/notifications/pause", { paused: false });
  }
});

test("at most 3 approval notifications go out per UTC day, and a retried proposal never notifies twice", async () => {
  const made = [];
  for (const n of [1, 2, 3, 4]) made.push(await runner("POST", "/proposals", proposal(`cap-${n}`)));
  assert.deepEqual(made.map((m) => m.notify_state), ["sent", "sent", "sent", "capped"]);
  let bodies = await webhookBodies();
  assert.deepEqual(bodies.map((b) => b.event_id), made.slice(0, 3).map((m) => m.id));
  for (const [i, b] of bodies.entries()) {
    assert.deepEqual(Object.keys(b).sort(), ["approve_url", "event_id", "final_step", "title", "why"]);
    assert.equal(b.approve_url, made[i].approve_url);
  }
  assert.ok((await proposalById(made[0].id)).notified_at > 0);
  assert.equal((await proposalById(made[3].id)).notified_at, null);

  await runner("POST", "/proposals", proposal("cap-1"));
  bodies = await webhookBodies();
  assert.equal(bodies.length, 3, "a retried proposal must not notify again");
});

test("a lost creation response is recovered by rotating the token, which keeps expiry and inputs_hash and kills the old link", async () => {
  await s.call("POST", "/admin/notifications/pause", { paused: true });
  try {
    const original = await runner("POST", "/proposals", proposal("rotate"));
    const retry = await runner("POST", "/proposals", proposal("rotate"));
    assert.equal(retry.approve_url, undefined);

    const rotate = (id, body, token = "runner") => s.call("POST", `/proposals/${id}/rotate-token`, body, { raw: true, token });
    assert.equal((await rotate(original.id, {}, "ingest")).status, 403);
    const res = await rotate(original.id, {});
    assert.equal(res.status, 200);
    const rotated = await res.json();
    assert.notEqual(rotated.approve_url, original.approve_url);
    assert.equal(rotated.expires_at, original.expires_at);
    assert.equal(rotated.inputs_hash, (await proposalById(original.id)).inputs_hash);
    assert.equal((await fetch(s.base + linkPath(original.approve_url))).status, 404, "the old link stops working");
    assert.equal((await fetch(s.base + linkPath(rotated.approve_url))).status, 200);

    assert.equal((await decideForm(linkPath(rotated.approve_url), { decision: "later" })).status, 200);
    assert.equal((await rotate(original.id, {})).status, 409, "a spent link can't be rotated back to life");
  } finally {
    await s.call("POST", "/admin/notifications/pause", { paused: false });
  }

  // A link already sent to T3 is the one in Sam's question card.
  const sent = (await runner("GET", "/proposals?state=awaiting_approval&limit=200")).proposals.find((p) => p.notify_state === "sent");
  const refused = await s.call("POST", `/proposals/${sent.id}/rotate-token`, {}, { raw: true, token: "runner" });
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /force/);
  assert.equal((await s.call("POST", `/proposals/${sent.id}/rotate-token`, { force: true }, { raw: true, token: "runner" })).status, 200);
});
