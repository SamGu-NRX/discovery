// A daily bundle's saves as the knowledge store's intake takes them
// (app/lib/intake.js), and how each answer is handled (app/lib/knowledge.js).

import assert from "node:assert/strict";
import { test } from "node:test";

import { installFakeChrome } from "./fake-chrome.js";

installFakeChrome();
const { finishedSaves, intakeFor, MAX_BYTES } = await import("../app/lib/intake.js");
const { deliverKept, deliveryDue, keepBundle, RETRY_MS } = await import("../app/lib/knowledge.js");

const p = (id, extra = {}) => ({ id, author_handle: `u${id}`, author_name: `User ${id}`, created_at: "2026-11-12T10:00:00Z", text: `post ${id}`, urls: [], media: [], in_reply_to_id: null, quoted_id: null, ...extra });

// Save 10 replies to 5 (whose parent is 1) and quotes 7. Its own thread is
// 10 then 11. Relevance and Recency read 20, 21 and 21, 22; the parent walk
// read 30; one branch read 40 and 20 again.
function bundle({ handled = "10", detailCapped = false } = {}) {
  const posts = Object.fromEntries(
    [
      p("1"),
      p("5", { in_reply_to_id: "1" }),
      p("7"),
      p("10", { in_reply_to_id: "5", quoted_id: "7", urls: ["https://example.com/a"], links: [{ url: "https://t.co/aaa", expanded: "https://example.com/a" }], media: [{ type: "animated_gif", url: "https://video.twimg.com/g.mp4" }, { type: "photo", url: "https://pbs.twimg.com/media/x?name=orig" }] }),
      p("11", { in_reply_to_id: "10" }),
      p("20", { in_reply_to_id: "10" }),
      p("21", { in_reply_to_id: "10", urls: ["https://example.com/b"], links: [{ url: "https://t.co/bbb", expanded: "https://example.com/b" }] }),
      p("22", { in_reply_to_id: "10" }),
      p("30", { in_reply_to_id: "5" }),
      p("40", { in_reply_to_id: "20" }),
    ].map((x) => [x.id, x]),
  );
  return {
    session_id: `s-${handled}-${detailCapped}`,
    ended_at: "2026-11-13T13:05:00Z",
    newSaves: { boundary: "9", found: true, top: "10", new: ["10"], taken: ["10"], handled },
    posts,
    context: {
      10: {
        id: "10",
        orders: { Relevance: { thread: { reply_ids: ["20", "21"] }, exhausted: true }, Recency: { thread: { reply_ids: ["21", "22"] }, exhausted: false } },
        thread: { op_self_thread_ids: ["10", "11"], reply_ids: [] },
        parent: { id: "5", thread: { reply_ids: ["30", "10"] }, exhausted: true },
        branches: [{ id: "20", thread: { reply_ids: ["40", "20"] } }],
        branchesSkipped: [],
        upstream: { in_reply_to_id: "5", quoted_id: "7", ancestors: ["1", "5"], fetched: [], skipped: [] },
        detailCapped,
      },
    },
  };
}

const opts = { runId: "daily-2026-11-13", account: "sdotgu", capturedAt: "2026-11-13T13:05:00Z" };

test("a save becomes one kintake/1 body: post, self-thread, upstream nearest first, and its context unfiltered by view", () => {
  const { body } = intakeFor(bundle(), "10", opts);
  assert.equal(body.schema, "kintake/1");
  assert.equal(body.run_id, "daily-2026-11-13");
  assert.equal(body.account, "sdotgu");
  assert.equal(body.post.url, "https://x.com/u10/status/10");
  assert.equal(body.post.reply_to, "5");
  assert.equal(body.post.quoted.id, "7");
  assert.equal(body.post.quoted.quoted, null, "a quoted post's own quote is not nested");
  assert.deepEqual(body.post.media, [{ kind: "gif", url: "https://video.twimg.com/g.mp4" }, { kind: "photo", url: "https://pbs.twimg.com/media/x?name=orig" }]);
  assert.deepEqual(body.post.links, [{ url: "https://t.co/aaa", expanded: "https://example.com/a" }], "each t.co with its target, so the store never opens t.co");
  assert.deepEqual(body.thread.map((t) => t.id), ["10", "11"], "the save included, in order");
  assert.deepEqual(body.upstream.map((u) => u.id), ["5", "1"], "nearest parent first");
  assert.deepEqual(body.context.map((c) => [c.id, c.view]), [["20", "relevant"], ["21", "relevant"], ["22", "recent"], ["30", "parent"], ["40", "branch"]]);
  assert.deepEqual(body.context[1].links, [{ url: "https://t.co/bbb", expanded: "https://example.com/b" }]);
  // A post parsed before links were kept: its targets only.
  const old = intakeFor({ ...bundle(), posts: { ...bundle().posts, 10: { ...bundle().posts["10"], links: undefined } } }, "10", opts).body;
  assert.deepEqual(old.post.links, [{ url: "https://example.com/a", expanded: "https://example.com/a" }]);
  assert.equal(body.context_capped, false);
  assert.deepEqual(body.views_read, [{ view: "relevant", reached_end: true, count: 2 }, { view: "recent", reached_end: false, count: 2 }, { view: "parent", reached_end: true, count: 2 }]);
  for (const o of [body.post, ...body.thread, ...body.upstream]) for (const k of ["id", "url", "author_handle", "text"]) assert.equal(typeof o[k], "string", `${o.id}.${k}`);
  assert.equal(intakeFor(bundle({ detailCapped: true }), "10", opts).body.context_capped, true, "the 80-request cap cut it short");
});

test("context stops at 120 posts and the body at 192 KiB, both marked capped; a save the bundle lacks is skipped", () => {
  const b = bundle();
  const many = Array.from({ length: 300 }, (_, i) => String(1000 + i));
  for (const id of many) b.posts[id] = p(id, { in_reply_to_id: "10", text: "x".repeat(1200) });
  b.context["10"].orders.Relevance.thread.reply_ids = many;
  const { body } = intakeFor(b, "10", opts);
  assert.ok(body.context.length <= 120);
  assert.equal(body.context_capped, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(body)).length <= MAX_BYTES);
  assert.match(intakeFor(b, "999", opts).skip, /not in the bundle/);
});

test("only the saves the run finished are filed, oldest first", () => {
  assert.deepEqual(finishedSaves({ newSaves: { taken: ["5", "4", "3"], handled: "4" } }), ["5", "4"]);
  assert.deepEqual(finishedSaves({ newSaves: { taken: [], handled: "1" } }), [], "a first run that took nothing");
  assert.deepEqual(finishedSaves({ newSaves: { taken: ["5"], handled: null } }), []);
});

const config = { workerUrl: "https://discovery-watcher.example.workers.dev", intakeToken: "t".repeat(64) };
const answering = (codes) => {
  const calls = [];
  return {
    calls,
    post: async (url, init) => {
      calls.push({ url, init });
      const code = codes.shift();
      return new Response(JSON.stringify(code < 300 ? { post_id: "x", job: { id: "j", state: "queued", created: true, requeued: false } } : { error: "invalid_request", message: "context[3].id must be …" }), { status: code });
    },
  };
};

test("filing: 201 and 200 file, 409 and 401 stop the pass and wait, 400 rejects that save; every request carries the intake token", async () => {
  await chrome.storage.local.remove(["dailyBundles", "intakeNextAt"]);
  await keepBundle(bundle(), { account: "sdotgu", manual: false, runId: "daily-2026-11-13" });
  assert.deepEqual(await deliverKept({ workerUrl: "", intakeToken: "" }), { filed: 0, rejected: 0, stopped: "no Worker URL or intake token is set" });

  // Not deployed yet: 401, kept, retried no sooner than 15 minutes.
  const now = Date.parse("2026-11-13T13:06:00Z");
  const down = answering([401]);
  const first = await deliverKept(config, { post: down.post, now });
  assert.equal(first.filed, 0);
  assert.match(first.stopped, /answered 401 \(token not accepted, or the route not deployed yet\)/);
  assert.equal(down.calls[0].url, "https://discovery-watcher.example.workers.dev/k/intake");
  assert.equal(down.calls[0].init.headers.authorization, `Bearer ${"t".repeat(64)}`);
  assert.equal(JSON.parse(down.calls[0].init.body).post.id, "10");
  assert.equal(await deliveryDue(now + RETRY_MS - 1), false);
  assert.equal(await deliveryDue(now + RETRY_MS), true);

  // Deployed: filed once; nothing left to send.
  const up = answering([201]);
  assert.deepEqual(await deliverKept(config, { post: up.post, now: now + RETRY_MS }), { filed: 1, rejected: 0, stopped: null });
  assert.equal(await deliveryDue(now + 2 * RETRY_MS), false);
  const again = answering([]);
  await deliverKept(config, { post: again.post });
  assert.equal(again.calls.length, 0, "a filed save is not sent again");

  // 409: the store is busy with that save; it stays unfiled.
  await keepBundle(bundle({ handled: "10" }), { account: "sdotgu", manual: true, runId: "manual-x" });
  const busy = answering([409]);
  const b = await deliverKept(config, { post: busy.post, now });
  assert.match(b.stopped, /still working on post 10 \(409\)/);
  assert.equal(await deliveryDue(now + RETRY_MS), true);

  // 400: that body is refused, recorded with the store's message, not resent.
  const bad = answering([400]);
  const r = await deliverKept(config, { post: bad.post, now: now + RETRY_MS });
  assert.equal(r.rejected, 1);
  assert.match(r.stopped, /refused post 10 \(400\): .*context\[3\]\.id/);
  const after = answering([]);
  await deliverKept(config, { post: after.post, now: now + 2 * RETRY_MS });
  assert.equal(after.calls.length, 0);
});
