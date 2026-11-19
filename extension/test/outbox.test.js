// The outbox against a local Worker: what is sent, what is retried, and that
// an accepted piece is never sent again.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { LOCAL_QUOTA_BYTES, installFakeChrome, startWorker } from "./fake-chrome.js";

installFakeChrome();
const { enqueue, flush } = await import("../app/lib/outbox.js");

// Statuses for the next requests, in order; 200 once the list is empty.
const statuses = [];
const worker = await startWorker(() => statuses.shift() ?? 200);
after(() => worker.close());

function post(id, textBytes = 1500) {
  return {
    id: String(id),
    author_handle: "a",
    author_name: "A",
    created_at: "2026-10-25T13:28:50Z",
    text: "x".repeat(textBytes),
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

test("after a failed request only unsent pieces are retried, under the same batch_ids", async () => {
  await chrome.storage.local.set({ config: { workerUrl: worker.url, ingestToken: "t", mode: "passive" } });
  // About 300 KB, so three pieces and three requests.
  const posts = Array.from({ length: 180 }, (_, i) => post(i));
  await enqueue({ account: "a", session_id: "s", mode: "passive", batch: { op: "HomeTimeline", surface: "home_for_you", posts } });

  statuses.push(200, 503);
  await flush();
  await flush();

  const sent = worker.requests.map((r) => r.body.batches.map((b) => b.batch_id));
  assert.equal(sent.length, 4, "first flush: accepted, failed; second flush: the failed piece again, then the last");
  const [first, failed, retried, last] = sent;
  assert.deepEqual(retried, failed);
  assert.ok(![...retried, ...last].some((id) => first.includes(id)), "the accepted piece is not sent again");
  const captureId = first[0].split(":")[0];
  assert.deepEqual([...first, ...retried, ...last], [0, 1, 2].map((i) => `${captureId}:${i}`));

  const accepted = [worker.requests[0], worker.requests[2], worker.requests[3]];
  assert.deepEqual(accepted.flatMap((r) => r.body.batches.flatMap((b) => b.posts.map((p) => p.id))), posts.map((p) => p.id));
  assert.deepEqual((await chrome.storage.local.get("outbox")).outbox, []);
});

// Found in review at 58bd508: the outbox was capped by count, and pieces can
// be large, so a Worker outage could fill Chrome's 10 MiB local quota and
// every later write (captures, session records, config) would fail.
test("while the Worker is unreachable a full outbox drops its oldest pieces, and storage keeps room for the rest", async () => {
  await chrome.storage.local.set({ outbox: [], lastProblem: null });
  // About 12 MB of captures in 100 KB pieces.
  const ids = [];
  for (let i = 0; i < 120; i += 1) {
    const batch = { op: "HomeTimeline", surface: "home_for_you", posts: [post(`c${i}`, 100_000)] };
    await enqueue({ account: "a", session_id: "s", mode: "passive", batch });
    ids.push(`c${i}`);
  }
  const { outbox, lastProblem } = await chrome.storage.local.get(["outbox", "lastProblem"]);
  const kept = outbox.map((e) => e.piece.posts[0].id);
  assert.deepEqual(kept, ids.slice(-kept.length), "the newest captures are kept, in order");
  assert.ok(kept.length < ids.length, "older captures were dropped");
  assert.match(lastProblem.message, /outbox full: dropped/);

  // A megabyte of other state still fits beside the full outbox.
  assert.ok((await chrome.storage.local.getBytesInUse()) < LOCAL_QUOTA_BYTES - 1024 * 1024);
  await chrome.storage.local.set({ lastSession: { detail: "x".repeat(1024 * 1024 - 100) } });
});

test("when other state crowds the quota, a refused outbox write drops older pieces and keeps the new capture", async () => {
  await chrome.storage.local.set({ outbox: [], lastProblem: null, lastSession: null });
  for (let i = 0; i < 60; i += 1) {
    await enqueue({ account: "a", session_id: "s", mode: "passive", batch: { op: "HomeTimeline", surface: "home_for_you", posts: [post(`d${i}`, 100_000)] } });
  }
  // Leave less room than the outbox budget assumes.
  const used = await chrome.storage.local.getBytesInUse();
  await chrome.storage.local.set({ crowding: "x".repeat(LOCAL_QUOTA_BYTES - used - 50_000) });

  await enqueue({ account: "a", session_id: "s", mode: "passive", batch: { op: "HomeTimeline", surface: "home_for_you", posts: [post("newest", 100_000)] } });
  const { outbox, lastProblem } = await chrome.storage.local.get(["outbox", "lastProblem"]);
  assert.equal(outbox.at(-1).piece.posts[0].id, "newest");
  assert.match(lastProblem.message, /storage refused the outbox/);
  await chrome.storage.local.remove("crowding");
});

// Found in a correctness review of dd9581d.

// Each of these tests starts from an empty outbox with the Worker configured.
async function freshStore() {
  await chrome.storage.local.remove(["outbox", "lastProblem", "lastSession", "crowding", "stats"]);
  await chrome.storage.local.set({ config: { workerUrl: worker.url, ingestToken: "t", mode: "passive" } });
}

const capture = (prefix, count, textBytes) => ({
  account: "a",
  session_id: "s",
  mode: "passive",
  batch: { op: "HomeTimeline", surface: "home_for_you", posts: Array.from({ length: count }, (_, i) => post(`${prefix}${i}`, textBytes)) },
});

test("one capture larger than the outbox budget keeps only its newest pieces within 7 MiB", async () => {
  await freshStore();
  await enqueue(capture("big", 80, 100_000));
  const { outbox } = await chrome.storage.local.get("outbox");
  assert.ok(JSON.stringify(outbox).length <= 7 * 1024 * 1024, `${JSON.stringify(outbox).length} bytes`);
  assert.equal(outbox.at(-1).piece.posts.at(-1).id, "big79");
});

test("an accepted piece leaves storage in the same write as the counts and bookmark memory it changes", async () => {
  await freshStore();
  await enqueue({ ...capture("bm", 3, 100), batch: { op: "Bookmarks", surface: "bookmarks", posts: [0, 1, 2].map((i) => ({ ...post(`bm${i}`, 100), position: i })) } });
  const writes = [];
  const set = chrome.storage.local.set;
  chrome.storage.local.set = async (values) => {
    writes.push(structuredClone(values));
    return set(values);
  };
  try {
    await flush();
  } finally {
    chrome.storage.local.set = set;
  }
  // A worker stopped after any one write leaves the piece and its
  // bookkeeping together: both done or both not.
  const removal = writes.find((values) => Array.isArray(values.outbox) && values.outbox.length === 0);
  assert.ok(removal, "the piece was removed");
  assert.equal(removal.stats.postsSent, 3);
  assert.deepEqual(removal.sentBookmarkIds.slice(0, 3), ["bm0", "bm1", "bm2"]);
});

test("when storage is completely full, the outbox frees space before recording why, and keeps the new capture", async () => {
  await freshStore();
  await enqueue(capture("old", 1, 5000));
  const used = await chrome.storage.local.getBytesInUse();
  // The key's length plus the value's JSON, quotes included.
  await chrome.storage.local.set({ crowding: "x".repeat(LOCAL_QUOTA_BYTES - used - "crowding".length - 2) });
  assert.equal(await chrome.storage.local.getBytesInUse(), LOCAL_QUOTA_BYTES);

  await enqueue(capture("new", 1, 1000));
  const { outbox } = await chrome.storage.local.get("outbox");
  assert.deepEqual(outbox.map((e) => e.piece.posts[0].id), ["new0"]);
  await chrome.storage.local.remove("crowding");
});

test("a piece the Worker answers with 404 is kept and retried under the same batch_id", async () => {
  await freshStore();
  const before = worker.requests.length;
  await enqueue(capture("r", 1, 100));
  statuses.push(404);
  await flush();
  await flush();
  const sent = worker.requests.slice(before).map((r) => r.body.batches[0].batch_id);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.deepEqual((await chrome.storage.local.get("outbox")).outbox, []);
});

function deferredLocal() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
