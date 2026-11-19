// The lens reader (app/lib/reader.js) against a fake session page and a
// manual clock: what it dwells on, for how long, what it opens, and when it
// stops.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DWELL_MS, readFeed, recordBaseline } from "../app/lib/reader.js";

// A feed of posts with fixed labels. `random` 0.5 makes every jitter factor 1.
function page({ posts, labelOf, random = () => 0.5, unloaded = new Set(), stopAfterPauses = Infinity, appendOnScroll = [] }) {
  let clock = 0;
  let handed = 0;
  const feed = [...posts];
  const log = [];
  const reads = new Map();
  let pauses = 0;
  const io = {
    now: () => clock,
    random,
    pause: async (ms) => {
      if (++pauses > stopAfterPauses) throw new Error("session stopped");
      log.push(["pause", ms]);
      clock += ms;
    },
    take: (n) => {
      const out = feed.slice(handed, handed + n);
      handed += out.length;
      return out;
    },
    scrollScreen: async () => {
      log.push(["scroll"]);
      feed.push(...appendOnScroll.splice(0, 5));
    },
    scrollToPost: async (id) => {
      log.push(["to", id]);
      return !unloaded.has(id);
    },
    label: async (batch) => ({ source: "model", labels: batch.map((p) => ({ id: p.id, ...labelOf(p) })) }),
    openPermalink: async (id) => log.push(["open", id]),
    readPermalink: async () => log.push(["readPermalink"]),
    leavePermalink: async () => log.push(["leave"]),
    onRead: (read) => reads.set(read.post_id, { ...read }),
  };
  return { io, log, reads };
}

const post = (i) => ({ id: String(1000 + i), text: `post ${i}`, author_handle: "a", author_followed: false });
const posts = (n) => Array.from({ length: n }, (_, i) => post(i));

test("each post stays in view for its label's dwell, and about one in ten is opened on its permalink, most on-topic first", async () => {
  // Posts 0 to 5 are labeled open with rising taste, 6 to 14 glance, the rest skip.
  const labelOf = (p) => {
    const i = Number(p.id) - 1000;
    return i < 6 ? { action: "open", taste: 0.8 + i / 100 } : i < 15 ? { action: "glance", taste: 0.6 } : { action: "skip", taste: 0.1 };
  };
  const { io, log, reads } = page({ posts: posts(30), labelOf });
  const result = await readFeed(io, { maxPosts: 30, maxMs: 3_600_000 });

  assert.equal(result.reads.length, 30);
  for (const r of result.reads.filter((x) => !result.opened.includes(x.post_id))) assert.equal(r.dwell_ms, DWELL_MS[r.action], r.post_id);
  // Every dwell happens with its post scrolled into view just before.
  const toThenPause = log.filter(([kind], i) => kind === "to" && log[i + 1]?.[0] === "pause").length;
  assert.equal(toThenPause, 30);
  assert.deepEqual(result.opened, ["1005", "1004", "1003"], "3 of 30, the highest taste first");
  assert.deepEqual(log.filter(([kind]) => kind === "open").map(([, id]) => id), ["1005", "1004", "1003"]);
  assert.equal(reads.get("1005").dwell_ms, DWELL_MS.open * 2, "the feed dwell plus the permalink dwell");
  assert.equal(reads.get("1000").dwell_ms, DWELL_MS.open, "an open-labeled post past the 10% is not opened");
  assert.ok(result.reads.every((r) => r.label_source === "model"));
});

test("dwell is jittered within a quarter either way", async () => {
  let n = 0;
  const randoms = [0, 0.999];
  const { io } = page({ posts: posts(2), labelOf: () => ({ action: "glance", taste: 0.5 }), random: () => randoms[n++ % 2] });
  const { reads } = await readFeed(io, { maxPosts: 2, maxMs: 60_000, openShare: 0 });
  assert.deepEqual(reads.map((r) => r.dwell_ms), [3000, 4998]);
});

test("the reader stops at its post cap and its time cap, scrolls when it has read everything, and gives up on a dry feed", async () => {
  const skip = () => ({ action: "skip", taste: 0 });
  const capped = await readFeed(page({ posts: posts(30), labelOf: skip }).io, { maxPosts: 5, maxMs: 3_600_000 });
  assert.equal(capped.reads.length, 5);
  assert.equal(capped.stop, "max_posts");

  const timed = await readFeed(page({ posts: posts(30), labelOf: () => ({ action: "open", taste: 1 }) }).io, { maxPosts: 30, maxMs: 70_000, openShare: 0 });
  assert.equal(timed.stop, "max_time");
  assert.equal(timed.reads.length, 4, "four 20-second dwells fit 70 seconds");

  const more = page({ posts: posts(2), labelOf: skip, appendOnScroll: posts(7).slice(2) });
  const scrolled = await readFeed(more.io, { maxPosts: 30, maxMs: 3_600_000 });
  assert.equal(scrolled.reads.length, 7, "posts that arrive after a scroll are read too");
  assert.equal(scrolled.stop, "feed_dry");
  assert.equal(more.log.filter(([kind]) => kind === "scroll").length, 7, "one scroll that brought posts, then six that did not");
});

test("a post X has already unloaded is neither dwelt on nor recorded", async () => {
  const { io, log } = page({ posts: posts(3), labelOf: () => ({ action: "glance", taste: 0.5 }), unloaded: new Set(["1001"]) });
  const { reads } = await readFeed(io, { maxPosts: 3, maxMs: 60_000, openShare: 0 });
  assert.deepEqual(reads.map((r) => r.post_id), ["1000", "1002"]);
  assert.deepEqual(log.filter(([kind, id]) => kind === "to" && id === "1001").length, 2, "one more look before giving up");
});

test("a stopped session ends the reader at once, and the reads so far are kept", async () => {
  const { io, log, reads } = page({ posts: posts(10), labelOf: () => ({ action: "glance", taste: 0.5 }), stopAfterPauses: 3 });
  await assert.rejects(readFeed(io, { maxPosts: 10, maxMs: 3_600_000 }), /session stopped/);
  assert.equal(reads.size, 3);
  assert.equal(log.filter(([kind]) => kind === "to").length, 4, "nothing is scrolled to after the stop");
  assert.ok(!log.some(([kind]) => kind === "open"));
});

test("the baseline takes the first 100 posts in feed order, scrolling for more, and dwells on nothing in particular", async () => {
  const many = posts(130);
  const { io, log } = page({ posts: many.slice(0, 40), labelOf: () => ({}), appendOnScroll: many.slice(40) });
  const { posts: got, stop } = await recordBaseline(io, { count: 100 });
  assert.equal(stop, "complete");
  assert.deepEqual(got.map((p) => p.id), many.slice(0, 100).map((p) => p.id));
  assert.ok(!log.some(([kind]) => kind === "to" || kind === "open"));
});
