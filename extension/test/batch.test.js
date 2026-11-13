import assert from "node:assert/strict";
import { test } from "node:test";

import { packPieces, splitCapture } from "../app/lib/batch.js";

// docs/CONTRACT.md, POST /ingest/x. Written out here, not imported, so the
// test fails if the batcher's default drifts from the contract.
const CONTRACT_CAP = 128 * 1024;

const envelope = { account: "sdotgu", session_id: "4d3f0c1e-7a7b-4a51-9d3e-5e2a1b9c0d11", mode: "active", captured_at: "2026-11-04T10:00:00.000Z" };
const size = (body) => new TextEncoder().encode(JSON.stringify(body)).length;
const CAPTURE = "0b8e6a4e-3f0a-4c1e-9d2b-7c6f5e4d3c2b";

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

const ids = (batches) => batches.flatMap((b) => b.posts.map((p) => p.id));

test("a capture over 128 KB is cut into pieces named <capture>:<index>, packed into bodies under the cap", () => {
  const detail = {
    op: "TweetDetail",
    surface: "detail",
    posts: Array.from({ length: 200 }, (_, i) => post(1000 + i, 1500)),
    thread: { root_id: "1000", op_self_thread_ids: ["1000"], reply_ids: Array.from({ length: 199 }, (_, i) => String(1001 + i)) },
  };
  const { pieces, dropped } = splitCapture(CAPTURE, detail);
  assert.deepEqual(dropped, []);
  assert.ok(pieces.length >= 3, `expected a split, got ${pieces.length} piece(s)`);
  assert.deepEqual(pieces.map((p) => p.batch_id), pieces.map((_, i) => `${CAPTURE}:${i}`));
  assert.deepEqual(ids(pieces), detail.posts.map((p) => p.id));
  // The thread goes once, on the last piece.
  assert.deepEqual(pieces.map((p) => Boolean(p.thread)), [...pieces.slice(1).map(() => false), true]);

  const home = { op: "HomeTimeline", surface: "home_for_you", posts: Array.from({ length: 300 }, (_, i) => post(i, 1500)) };
  const all = [...splitCapture("c2", home).pieces, ...pieces];
  const bodies = packPieces(envelope, all);
  for (const { body } of bodies) {
    assert.ok(size(body) <= CONTRACT_CAP, `body of ${size(body)} bytes`);
    assert.deepEqual({ ...body, batches: undefined }, { ...envelope, batches: undefined });
  }
  assert.deepEqual(bodies.flatMap((b) => b.pieceIndexes), all.map((_, i) => i));
  assert.deepEqual(ids(bodies.flatMap((b) => b.body.batches)), [...home.posts, ...detail.posts].map((p) => p.id));
});

test("a post too large for any body is dropped and named, and the rest still go", () => {
  const batch = { op: "HomeTimeline", surface: "home_for_you", posts: [post(1, 100), post(2, CONTRACT_CAP), post(3, 100)] };
  const { pieces, dropped } = splitCapture(CAPTURE, batch);
  assert.deepEqual(dropped, ["2"]);
  assert.deepEqual(ids(pieces), ["1", "3"]);
});

test("a post that fits on its own is sent even when the thread it belongs to fills a body", () => {
  const thread = { root_id: "1", op_self_thread_ids: ["1"], reply_ids: Array.from({ length: 4000 }, (_, i) => String(9_000_000_000_000_000_000n + BigInt(i))) };
  const { pieces, dropped } = splitCapture(CAPTURE, { op: "TweetDetail", surface: "detail", posts: [post(1, 60_000)], thread });
  assert.deepEqual(dropped, []);
  assert.deepEqual(ids(pieces), ["1"]);
  assert.ok(pieces.at(-1).thread, "thread sent last");
  for (const { body } of packPieces(envelope, pieces)) assert.ok(size(body) <= CONTRACT_CAP);
});
