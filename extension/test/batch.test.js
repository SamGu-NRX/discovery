import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_BODY_BYTES, packRequests } from "../app/lib/batch.js";

const envelope = { account: "sdotgu", session_id: "s-1", mode: "active", captured_at: "2026-11-04T10:00:00Z" };
const size = (body) => new TextEncoder().encode(JSON.stringify(body)).length;

function post(id, textBytes) {
  return {
    id: String(id),
    author_handle: "a",
    author_name: "A",
    created_at: "2026-10-25T13:28:50Z",
    // Multi-byte characters, so a character count would undercount bytes.
    text: "é".repeat(textBytes / 2),
    lang: "en",
    conversation_id: String(id),
    in_reply_to_id: null,
    quoted_id: null,
    retweet_of_id: null,
    urls: [],
    media: [],
    metrics: { likes: 1, reposts: 0, replies: 0, quotes: 0, bookmarks: 0, views: 10 },
    position: id,
  };
}

test("captures over 256 KB split into bodies under the cap, keeping every post once and in order", () => {
  const home = { op: "HomeTimeline", surface: "home_for_you", posts: Array.from({ length: 300 }, (_, i) => post(i, 1500)) };
  const detail = {
    op: "TweetDetail",
    surface: "detail",
    posts: Array.from({ length: 200 }, (_, i) => post(1000 + i, 1500)),
    thread: { root_id: "1000", op_self_thread_ids: ["1000"], reply_ids: Array.from({ length: 199 }, (_, i) => String(1001 + i)) },
  };
  const { bodies, dropped, finishedIn } = packRequests(envelope, [home, detail]);

  assert.ok(bodies.length >= 3, `expected a split, got ${bodies.length} body`);
  for (const body of bodies) {
    assert.ok(size(body) <= MAX_BODY_BYTES, `body of ${size(body)} bytes`);
    assert.deepEqual({ ...body, batches: undefined }, { ...envelope, batches: undefined });
  }
  const sent = bodies.flatMap((b) => b.batches.flatMap((batch) => batch.posts.map((p) => p.id)));
  assert.deepEqual(sent, [...home.posts, ...detail.posts].map((p) => p.id));
  assert.deepEqual(dropped, []);

  // The thread goes once, on the last piece of the TweetDetail batch.
  const pieces = bodies.flatMap((b) => b.batches).filter((b) => b.op === "TweetDetail");
  assert.deepEqual(pieces.map((b) => Boolean(b.thread)), [...pieces.slice(1).map(() => false), true]);
  assert.equal(finishedIn[1], bodies.length - 1);
  assert.ok(finishedIn[0] < finishedIn[1]);
});

test("a post too large for any body is dropped and named, and the rest still go", () => {
  const batch = { op: "HomeTimeline", surface: "home_for_you", posts: [post(1, 100), post(2, MAX_BODY_BYTES), post(3, 100)] };
  const { bodies, dropped } = packRequests(envelope, [batch]);
  assert.deepEqual(dropped, ["2"]);
  assert.deepEqual(bodies.flatMap((b) => b.batches.flatMap((x) => x.posts.map((p) => p.id))), ["1", "3"]);
});
