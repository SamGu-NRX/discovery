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
const batch = (surface, posts, extra = {}) => ({
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
  for (const [method, path] of [["POST", "/ingest/x"], ["POST", "/ingest/x/status"], ["GET", "/x/detail-queue?account=a"], ["GET", "/admin/events"], ["POST", "/admin/watchers"], ["GET", "/jobs/1"]]) {
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
    batch("home_for_you", [post("i-1"), post("i-2")]),
    batch("home_following", [post("i-2", { metrics: { likes: 2 } })]),
    batch("bookmarks", [post("i-3"), post("i-old-save")]),
  ]);
  assert.deepEqual(r1, { posts_upserted: 4, sightings: 5, new_posts: 4, candidates_created: 1 });

  const r2 = await ingest("sess-2", [batch("home_for_you", [post("i-1", { metrics: { likes: 9 } })]), batch("bookmarks", [post("i-1", { metrics: { likes: 9 } }), post("i-3")])]);
  assert.deepEqual(r2, { posts_upserted: 2, sightings: 3, new_posts: 0, candidates_created: 1 });

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

  const bad = await s.call("POST", "/ingest/x", { account: "acct", session_id: "s", mode: "passive", batches: [batch("home_for_you", [{ ...post("i-9"), author_handle: undefined }])] }, { raw: true, token: "ingest" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /batches\[0\]\.posts\[0\]\.author_handle/);
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
  const stale = await s.call("POST", `/candidates/${a.id}/complete`, { owner: "runner-a", state: "done" }, { raw: true, token: "runner" });
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
  const done = await runner("POST", `/candidates/${d.id}/complete`, { owner: "runner-e", state: "proposed", note: "p_1" });
  assert.equal(done.state, "proposed");
  assert.deepEqual(await claim("runner-f", 60, "lease:2"), [], "a completed candidate is never handed out again");
});
