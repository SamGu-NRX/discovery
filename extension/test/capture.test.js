import assert from "node:assert/strict";
import { test } from "node:test";

import { captureToBatch } from "../app/lib/capture.js";
import { ParseError } from "../app/lib/parse.js";
import {
  BOOKMARKS_URL,
  HOME_URL,
  NOTE_TEXT,
  bookmarksResponse,
  detailPage2Response,
  detailResponse,
  detailUrl,
  homeResponse,
  itemEntry,
  midThreadDetailResponse,
  moduleEntry,
  tweet,
} from "./fixtures/x-shapes.js";

const home = (json = homeResponse(), offset = 0) =>
  captureToBatch({ operation: "HomeTimeline", json, url: HOME_URL, offset });
const byId = (batch, id) => batch.posts.find((p) => p.id === id);

test("a timeline post normalizes to the contract's post shape", () => {
  const { batch } = home();
  assert.equal(batch.op, "HomeTimeline");
  assert.equal(batch.surface, "home_for_you");
  assert.deepEqual(byId(batch, "101"), {
    id: "101",
    author_handle: "alice",
    author_name: "Alice A",
    created_at: "2026-10-25T13:28:50Z",
    text: "Tools & tricks <3 https://t.co/abc",
    lang: "en",
    conversation_id: "101",
    in_reply_to_id: null,
    quoted_id: null,
    retweet_of_id: null,
    urls: ["https://expanded.example/link"],
    media: [{ type: "photo", url: "https://pbs.twimg.com/media/F1aT_M9aAAEgJwi.jpg" }],
    metrics: { likes: 12, reposts: 3, replies: 4, quotes: 1, bookmarks: 9, views: 2300 },
    position: 0,
  });
});

test("a long post uses the note_tweet text and its links, and a video its best variant", () => {
  const post = byId(home().batch, "103");
  assert.equal(post.text, NOTE_TEXT);
  assert.deepEqual(post.urls, ["https://note.example/full"]);
  assert.deepEqual(post.media, [{ type: "video", url: "https://video.twimg.com/high.mp4" }]);
});

test("a post inside a TweetWithVisibilityResults wrapper is unwrapped", () => {
  const post = byId(home().batch, "102");
  assert.equal(post.author_handle, "bob");
  assert.equal(post.text, "limited visibility post");
});

test("positions follow display order across items and modules; cursors, ads, users and tombstones are skipped", () => {
  const { batch, advance } = home(homeResponse(), 40);
  const primaries = batch.posts.filter((p) => !["107", "109"].includes(p.id));
  assert.deepEqual(
    primaries.map((p) => [p.id, p.position]),
    [["101", 40], ["102", 41], ["103", 42], ["104", 43], ["105", 44], ["106", 45], ["108", 46]],
  );
  assert.equal(advance, 7);
  assert.equal(byId(batch, "105").in_reply_to_id, "104");
  assert.equal(byId(batch, "999"), undefined);
});

test("reposted and quoted originals ride along at their carrier's position", () => {
  const { batch } = home();
  assert.equal(byId(batch, "106").retweet_of_id, "107");
  assert.equal(byId(batch, "107").position, byId(batch, "106").position);
  assert.equal(byId(batch, "107").text, "original text");
  assert.equal(byId(batch, "108").quoted_id, "109");
  assert.equal(byId(batch, "109").position, byId(batch, "108").position);
});

test("bookmark batches leave quoted posts out, so the Worker does not mark them bookmarked", () => {
  const { batch } = captureToBatch({ operation: "Bookmarks", json: bookmarksResponse(), url: BOOKMARKS_URL, offset: 0 });
  assert.equal(batch.surface, "bookmarks");
  assert.deepEqual(batch.posts.map((p) => p.id), ["401", "402"]);
  assert.equal(batch.posts[0].quoted_id, "4019");
});

test("a post missing a required field fails the whole response loudly", () => {
  const json = homeResponse();
  const conversation = json.data.home.home_timeline_urt.instructions[1].entries.find((e) => e.entryId === "home-conversation-104");
  delete conversation.content.items[1].item.itemContent.tweet_results.result.legacy.created_at;
  assert.throws(() => home(json), (err) => err instanceof ParseError && /tweet 105 .*legacy\.created_at/.test(err.message));
});

test("a moved instructions path or an unknown entry type fails loudly", () => {
  assert.throws(() => home({ data: { home: { timeline: {} } } }), (err) => err instanceof ParseError && /no instructions/.test(err.message));
  const json = homeResponse();
  json.data.home.home_timeline_urt.instructions[1].entries.push({ entryId: "x-1", sortIndex: "1", content: { entryType: "TimelineTimelineCarousel" } });
  assert.throws(() => home(json), (err) => err instanceof ParseError && /unknown entryType/.test(err.message));
});

test("X's rate-limit error with no data is reported, not treated as a parse error", () => {
  const result = home({ errors: [{ code: 88, message: "Rate limit exceeded" }] });
  assert.equal(result.rateLimited, true);
  assert.equal(result.batch, null);
});

test("a permalink separates the original poster's self-thread from other replies", () => {
  const { batch } = captureToBatch({ operation: "TweetDetail", json: detailResponse(), url: detailUrl("200"), offset: 0 });
  assert.equal(batch.surface, "detail");
  assert.deepEqual(batch.thread, {
    root_id: "200",
    op_self_thread_ids: ["200", "201", "202"],
    reply_ids: ["203", "204", "205"],
  });
  assert.ok(byId(batch, "206"), "Discover more posts are still captured");
});

test("later pages of a permalink extend the same thread", () => {
  const first = captureToBatch({ operation: "TweetDetail", json: detailResponse(), url: detailUrl("200"), offset: 0 });
  const second = captureToBatch({
    operation: "TweetDetail",
    json: detailPage2Response(),
    url: detailUrl("200"),
    offset: first.advance,
    threadState: first.threadState,
  });
  assert.deepEqual(second.batch.thread, {
    root_id: "200",
    op_self_thread_ids: ["200", "201", "202", "207"],
    reply_ids: ["203", "204", "205", "208"],
  });
  assert.deepEqual(second.batch.posts.map((p) => [p.id, p.position]), [["207", 7], ["208", 8]]);
});

test("a permalink in the middle of a thread includes the original poster's earlier posts", () => {
  const { batch } = captureToBatch({ operation: "TweetDetail", json: midThreadDetailResponse(), url: detailUrl("302"), offset: 0 });
  assert.deepEqual(batch.thread, { root_id: "302", op_self_thread_ids: ["300", "301", "302", "303"], reply_ids: ["304"] });
});

test("a later permalink page seen without its first page keeps its posts but builds no thread", () => {
  const result = captureToBatch({ operation: "TweetDetail", json: detailPage2Response(), url: detailUrl("200"), offset: 0 });
  assert.equal(result.batch.thread, undefined);
  assert.deepEqual(result.batch.posts.map((p) => p.id), ["207", "208"]);
  assert.match(result.threadError, /focal post/);
});

// Thread edge cases found in review. `op` is the permalink's author.
const op = (id, inReplyTo) => tweet({ id, handle: "op", userId: "u-op", conversationId: "200", inReplyTo });
const other = (id, inReplyTo = "200") => tweet({ id, handle: "x", userId: "u-x", conversationId: "200", inReplyTo });
const detailOf = (instructions) => ({ data: { threaded_conversation_with_injections_v2: { instructions } } });
const addEntries = (entries) => ({ type: "TimelineAddEntries", entries });
const addToModule = (moduleEntryId, prepend, posts) => ({
  type: "TimelineAddToModule",
  moduleEntryId,
  prepend,
  moduleItems: moduleEntry(moduleEntryId, "0", posts).content.items,
});
function permalink(instructions, previous = null) {
  return captureToBatch({
    operation: "TweetDetail",
    json: detailOf(instructions),
    url: detailUrl("200"),
    offset: previous?.advance ?? 0,
    threadState: previous?.threadState ?? null,
  });
}

test("posts added to an earlier conversation module keep that module's place, before or after its items", () => {
  const first = () =>
    permalink([
      addEntries([
        itemEntry(op("200"), "9000"),
        moduleEntry("conversationthread-a", "8990", [other("202")]),
        moduleEntry("conversationthread-b", "8980", [other("203")]),
      ]),
    ]);
  assert.deepEqual(permalink([addToModule("conversationthread-a", false, [other("201")])], first()).batch.thread.reply_ids, ["202", "201", "203"]);
  assert.deepEqual(permalink([addToModule("conversationthread-a", true, [other("201")])], first()).batch.thread.reply_ids, ["201", "202", "203"]);

  const selfFirst = permalink([addEntries([itemEntry(op("200"), "9000"), moduleEntry("conversationthread-a", "8990", [op("202", "201")])])]);
  const selfNext = permalink([addToModule("conversationthread-a", true, [op("201", "200")])], selfFirst);
  assert.deepEqual(selfNext.batch.thread.op_self_thread_ids, ["200", "201", "202"]);
});

test("a reply also shown under Discover more stays a reply", () => {
  const { batch } = permalink([
    addEntries([
      itemEntry(op("200"), "9000"),
      moduleEntry("tweetdetailrelatedtweets-1", "8990", [other("201")]),
      moduleEntry("conversationthread-201", "8980", [other("201")]),
    ]),
  ]);
  assert.deepEqual(batch.posts.map((p) => p.id), ["200", "201"]);
  assert.deepEqual(batch.thread, { root_id: "200", op_self_thread_ids: ["200"], reply_ids: ["201"] });
});

test("a focal post delivered inside a conversation module still roots the thread", () => {
  const { batch, threadError } = permalink([addEntries([moduleEntry("conversationthread-200", "9000", [op("200"), op("201", "200"), other("202")])])]);
  assert.equal(threadError, null);
  assert.deepEqual(batch.thread, { root_id: "200", op_self_thread_ids: ["200", "201"], reply_ids: ["202"] });
});

test("an impossible date, a missing count or a malformed list fails loudly", () => {
  const cases = {
    "legacy.created_at": (t) => (t.legacy.created_at = "Sat Oct 99 77:88:99 +0000 2026"),
    "legacy.favorite_count": (t) => delete t.legacy.favorite_count,
    "legacy.entities.urls": (t) => (t.legacy.entities.urls = {}),
    "video_info.variants": (t) => (t.legacy.extended_entities = { media: [{ type: "video", media_url_https: "https://pbs.twimg.com/t.jpg", video_info: { variants: {} } }] }),
  };
  for (const [field, mutate] of Object.entries(cases)) {
    const t = op("200");
    mutate(t);
    const json = { data: { home: { home_timeline_urt: { instructions: [addEntries([itemEntry(t, "9000")])] } } } };
    assert.throws(() => home(json), (err) => err instanceof ParseError && err.message.includes(field), field);
  }
});

test("an empty Tweet result with no legacy is skipped; the rest of the response is kept", () => {
  const json = homeResponse();
  const entries = json.data.home.home_timeline_urt.instructions[1].entries;
  entries.push(itemEntry({ __typename: "Tweet", rest_id: "777" }, "1750"));
  const { batch } = home(json);
  assert.equal(byId(batch, "777"), undefined);
  assert.ok(byId(batch, "101"));
});

test("a response whose every tweet lacks legacy fails loudly", () => {
  const json = { data: { home: { home_timeline_urt: { instructions: [addEntries([itemEntry({ __typename: "Tweet", rest_id: "777" }, "1")])] } } } };
  assert.throws(() => home(json), (err) => err instanceof ParseError && /lack legacy/.test(err.message));
});
