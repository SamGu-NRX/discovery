// Fetch mode's runner (app/lib/fetchrun.js) against fixture responses served
// by a fake x.com tab, with a manual clock. The fake answers by operation,
// variables and cursor, the way X's GraphQL endpoint does, so these tests
// check which requests the runner makes, in what order and how far apart.

import assert from "node:assert/strict";
import { test } from "node:test";

import { FetchRefused, buildRequest, parseTemplate } from "../app/lib/fetchops.js";
import { parseJobs, runJobs } from "../app/lib/fetchrun.js";
import { itemEntry, moduleEntry, tweet } from "./fixtures/x-shapes.js";

const QID = { Bookmarks: "bmQueryId_0001", TweetDetail: "tdQueryId_0002", SearchTimeline: "stQueryId_0003" };
const FEATURES = { responsive_web_graphql_timeline_navigation_enabled: true, view_counts_everywhere_api_enabled: true };
const PAGE_VARIABLES = {
  Bookmarks: { count: 20, includePromotedContent: true },
  TweetDetail: { focalTweetId: "1", with_rux_injections: false, includePromotedContent: true, withVoice: true },
  SearchTimeline: { rawQuery: "seed", count: 20, querySource: "typed_query", product: "Latest" },
};
const pageTemplate = (operation) =>
  parseTemplate({
    method: "GET",
    url: `https://x.com/i/api/graphql/${QID[operation]}/${operation}?variables=${encodeURIComponent(JSON.stringify(PAGE_VARIABLES[operation]))}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`,
  });

const cursor = (type, value) => ({
  entryId: `cursor-${type.toLowerCase()}-${value}`,
  sortIndex: "1",
  content: { entryType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value, cursorType: type },
});
// TweetDetail wraps its paging cursors in an item.
const cursorItem = (type, value) => ({
  entryId: `cursor-${type.toLowerCase()}-${value}`,
  sortIndex: "1",
  content: { entryType: "TimelineTimelineItem", itemContent: { itemType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value, cursorType: type } },
});
const showMore = (moduleId, value) => ({
  entryId: `${moduleId}-cursor-showmore-${value}`,
  item: { itemContent: { itemType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value, cursorType: "ShowMore" } },
});
const withItem = (module, item) => ({ ...module, content: { ...module.content, items: [...module.content.items, item] } });

const post = (id, handle = "u", extra = {}) => tweet({ id, handle, userId: `u-${handle}`, ...extra });
const entries = (posts, base = 9000) => posts.map((p, i) => itemEntry(p, String(base - i)));
const bookmarksPage = (ids, next) => ({
  data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [...entries(ids.map((id) => post(id, "saver"))), ...(next ? [cursor("Bottom", next)] : [])] }] } } },
});
const searchPage = (ids, next) => ({
  data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [...entries(ids.map((id) => post(id, "s"))), ...(next ? [cursor("Bottom", next)] : [])] }] } } } },
});
const detail = (instructions) => ({ data: { threaded_conversation_with_injections_v2: { instructions } } });

const json = (body) => ({ status: 200, contentType: "application/json; charset=utf-8", text: JSON.stringify(body) });

// A fake x.com tab: `answer(operation, variables)` returns a response or a
// JSON body. Records every send with the manual clock's time.
function harness(answer, { paused = () => false, random = () => 0.5, stopAfter = Infinity } = {}) {
  let clock = 1_000_000;
  const sends = [];
  const primes = [];
  const batches = [];
  const signals = [];
  const io = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    random,
    paused: async () => paused(sends),
    stopRequested: () => sends.length >= stopAfter,
    prime: async (kind, arg) => {
      primes.push([kind, arg ?? null]);
      clock += 3000;
    },
    template: async (operation) => pageTemplate(operation),
    send: async (operation, href) => {
      const url = new URL(href);
      const variables = JSON.parse(url.searchParams.get("variables"));
      sends.push({ at: clock, operation, url, variables });
      clock += 120;
      const reply = answer(operation, variables, sends.length);
      return reply?.status !== undefined ? { ms: 120, ...reply } : { ms: 120, ...json(reply) };
    },
    onBatch: async ({ batch }) => batches.push(batch),
    onSignal: async (signal) => signals.push(signal),
  };
  return { io, sends, primes, batches, signals };
}

const run = (doc, h) => {
  const { jobs, limits } = parseJobs(doc);
  return runJobs(jobs, limits, h.io);
};

test("bookmarks_until pages by cursor to the boundary plus N, in bookmark order, reusing the page's query id and features", async () => {
  const pages = { "": [["1", "2", "3"], "c1"], c1: [["4", "5"], "c2"], c2: [["6", "7", "8"], "c3"], c3: [["9"], null] };
  const h = harness((operation, v) => {
    assert.equal(operation, "Bookmarks");
    return bookmarksPage(...pages[v.cursor ?? ""]);
  });
  const result = await run({ jobs: [{ type: "bookmarks_until", boundary: "4", after: 3 }] }, h);

  assert.equal(result.stop, null);
  assert.deepEqual(h.primes, [["bookmarks", null]]);
  assert.deepEqual(result.bookmarks.ids, ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(result.bookmarks.boundaryIndex, 3);
  assert.deepEqual(h.sends.map((s) => s.variables.cursor ?? null), [null, "c1", "c2"], "stops once 3 posts past the boundary are in");
  for (const { url, variables } of h.sends) {
    assert.equal(url.pathname, `/i/api/graphql/${QID.Bookmarks}/Bookmarks`);
    assert.deepEqual(JSON.parse(url.searchParams.get("features")), FEATURES);
    assert.equal(variables.includePromotedContent, true, "the page's own variables are kept");
  }
  assert.deepEqual(h.batches.flatMap((b) => b.posts.map((p) => [p.id, p.position])), [["1", 0], ["2", 1], ["3", 2], ["4", 3], ["5", 4], ["6", 5], ["7", 6], ["8", 7]]);
  assert.ok(h.batches.every((b) => b.op === "Bookmarks" && b.surface === "bookmarks"));

  // A boundary X never shows: the list ends where X stops sending a cursor.
  const short = harness((_, v) => bookmarksPage(...pages[v.cursor ?? ""]));
  const end = await run({ jobs: [{ type: "bookmarks_until", boundary: "77", after: 3 }] }, short);
  assert.equal(end.bookmarks.exhausted, true);
  assert.equal(end.bookmarks.boundaryIndex, null);
  assert.equal(short.sends.length, 4);
});

// Permalink 200 by op, with a link to a repo:
//   Relevance: 201 (op, + "show more" -> 207 op), 203 x; Bottom -> 208 w,
//              which offers "Show probable spam" -> 209 spam
//   Recency:   210 v, nothing more
// Reply counts: op's 201 and 207 have 4, 210 has 3, 203 has 1 and asks a
// question, 208 has 1, 209 has none.
function contextAnswer({ log = [] } = {}) {
  const op = (id, inReplyTo) => post(id, "op", { conversationId: "200", inReplyTo });
  const other = (id, handle, inReplyTo = "200", text) => post(id, handle, { conversationId: "200", inReplyTo, ...(text && { text }) });
  const replies = (p, n) => ((p.legacy.reply_count = n), p);
  const focal = post("200", "op", { conversationId: "200", urls: ["https://github.com/acme/tool", "https://x.com/op/status/5"] });
  const relevance = {
    "": detail([{
      type: "TimelineAddEntries",
      entries: [
        itemEntry(focal, "9000"),
        withItem(moduleEntry("conversationthread-201", "8990", [op("201", "200")]), showMore("conversationthread-201", "sm1")),
        moduleEntry("conversationthread-203", "8980", [replies(other("203", "x", "200", "why?"), 1)]),
        cursorItem("Bottom", "b1"),
      ],
    }]),
    sm1: detail([{ type: "TimelineAddToModule", moduleEntryId: "conversationthread-201", moduleItems: [{ entryId: "conversationthread-201-tweet-207", item: { itemContent: { itemType: "TimelineTweet", __typename: "TimelineTweet", tweet_results: { result: op("207", "201") } } } }] }]),
    b1: detail([{ type: "TimelineAddEntries", entries: [moduleEntry("conversationthread-208", "8970", [replies(other("208", "w"), 1)]), cursorItem("ShowMoreThreadsPrompt", "spam1")] }]),
    spam1: detail([{ type: "TimelineAddEntries", entries: [moduleEntry("conversationthread-209", "8960", [replies(other("209", "spam"), 0)])] }]),
  };
  const recency = { "": detail([{ type: "TimelineAddEntries", entries: [itemEntry(focal, "9000"), moduleEntry("conversationthread-210", "8990", [replies(other("210", "v"), 3)])] }]) };
  const searches = {
    "quoted_tweet_id:200|Latest|": searchPage(["901", "902"], "s1"),
    "quoted_tweet_id:200|Latest|s1": searchPage([], "s2"),
    "url:200|Latest|": searchPage(["911"], null),
    "url:200|Top|": searchPage(["911"], null),
    'url:"github.com/acme/tool"|Latest|': searchPage(["921"], null),
    'url:"github.com/acme/tool"|Top|': searchPage(["921", "922"], null),
    "conversation_id:200|Latest|": searchPage(["203", "299"], null),
  };
  // A branch permalink: the reply itself and one answer to it.
  const branch = (id) => detail([{ type: "TimelineAddEntries", entries: [itemEntry(post(id, "b", { conversationId: "200" }), "9000"), moduleEntry(`conversationthread-7${id}`, "8990", [other(`7${id}`, "z", id)])] }]);
  return (operation, v) => {
    if (operation === "TweetDetail") {
      log.push(`${v.rankingMode}:${v.cursor ?? "-"}`);
      if (v.focalTweetId !== "200") return branch(v.focalTweetId);
      return (v.rankingMode === "Recency" ? recency : relevance)[v.cursor ?? ""];
    }
    const key = `${v.rawQuery}|${v.product}|${v.cursor ?? ""}`;
    log.push(key);
    const page = searches[key];
    if (!page) throw new Error(`no fixture for search ${key}`);
    return page;
  };
}

test("context follows every reply cursor in both orders, merges the thread across them, then runs every search on the search page", async () => {
  const log = [];
  const h = harness(contextAnswer({ log }));
  const result = await run({ jobs: [{ type: "context", ids: ["200"] }] }, h);
  assert.equal(result.stop, null);
  const record = result.context["200"];

  assert.deepEqual(h.primes, [["detail", "200"], ["search", "quoted_tweet_id:200"]], "TweetDetail on a permalink, then searches on a search page");
  assert.deepEqual(log.slice(0, 5), ["Relevance:-", "Relevance:sm1", "Relevance:b1", "Relevance:spam1", "Recency:-"]);
  assert.deepEqual(record.orders.Relevance.thread.op_self_thread_ids, ["200", "201", "207"]);
  assert.deepEqual(record.orders.Relevance.thread.reply_ids, ["203", "208", "209"]);
  assert.deepEqual(record.orders.Recency.thread.reply_ids, ["210"]);
  assert.equal(record.orders.Relevance.exhausted, true);
  // The Worker keeps one thread row per root: the batches carry both orders.
  assert.deepEqual(record.thread.reply_ids, ["203", "208", "209", "210"]);
  assert.deepEqual(h.batches.filter((b) => b.thread?.root_id === "200").at(-1).thread.reply_ids, ["203", "208", "209", "210"]);

  // Branches: the author's replies first, then by reply count; 208 (one
  // reply, no question) and 209 (none) stay closed.
  assert.deepEqual(record.branches.map((b) => b.id), ["201", "207", "210", "203"]);
  assert.deepEqual(record.branches.find((b) => b.id === "203").thread.reply_ids, ["7203"]);

  assert.deepEqual(record.quotes.quoted_tweet_id.Latest.ids, ["901", "902"], "stops at a page with no new results");
  assert.deepEqual(record.mentions["url:200"].Top.ids, ["911"]);
  assert.deepEqual(Object.keys(record.links), ["github.com/acme/tool"], "links to X itself are not searched");
  assert.deepEqual(record.links["github.com/acme/tool"].Top.ids, ["921", "922"]);
  assert.deepEqual(record.conversation["conversation_id:200"].Latest.ids, ["203", "299"]);
  assert.ok(result.ledger.every((row) => ["TweetDetail", "SearchTimeline"].includes(row.operation)));
});

test("the per-post cap stops following cursors and records what was left", async () => {
  const h = harness(contextAnswer());
  const result = await run({ limits: { detailCapPerPost: 2 }, jobs: [{ type: "context", ids: ["200"], quotes: false, mentions: false, links: false, conversation: false }] }, h);
  const record = result.context["200"];
  assert.equal(h.sends.length, 2);
  assert.equal(record.detailCapped, true);
  assert.equal(record.orders.Relevance.exhausted, false);
  assert.ok(record.orders.Relevance.cursorsLeft >= 1);
});

test("requests are at least 1.5 s plus jitter apart, a job cannot lower that or raise the cap, and the run stops at its cap", async () => {
  const { limits } = parseJobs({ limits: { minGapMs: 100, runCap: 5000 }, jobs: [{ type: "bookmarks_until", boundary: "1" }] });
  assert.equal(limits.minGapMs, 1500);
  assert.equal(limits.runCap, 400);

  let n = 0;
  const h = harness(() => bookmarksPage([String(++n)], `c${n}`), { random: () => 0.25 });
  const result = await run({ limits: { runCap: 6, jitterMs: 1000 }, jobs: [{ type: "bookmarks_until", boundary: "999", after: 0, maxPages: 50 }] }, h);
  assert.equal(result.stop.reason, "cap");
  assert.equal(h.sends.length, 5, "the page load that taught the template counts as one request");
  for (let i = 1; i < h.sends.length; i += 1) {
    const gap = h.sends[i].at - h.sends[i - 1].at;
    assert.ok(gap >= 1750, `gap ${i} was ${gap} ms`);
  }
});

const BACK_OFF = {
  "HTTP 429": [{ status: 429, contentType: "text/plain", text: "" }, "rate_limited"],
  "X error 88 with HTTP 200": [json({ errors: [{ code: 88, message: "Rate limit exceeded" }] }), "rate_limited"],
  "HTTP 401": [{ status: 401, contentType: "application/json", text: "{}" }, "login_wall"],
  "an HTML page instead of JSON": [{ status: 200, contentType: "text/html", text: "<html>log in</html>" }, "error"],
  "a challenge on the page": [{ status: 0, contentType: "", text: "", blocked: { blocker: "challenge", evidence: "captcha iframe", path: "/i/bookmarks" } }, "challenge"],
};

test("every X back-off signal stops the whole run at once and pauses the extension", async () => {
  for (const [name, [reply, reason]] of Object.entries(BACK_OFF)) {
    const h = harness((_, v) => (v.cursor ? reply : bookmarksPage(["1"], "c1")));
    const result = await run({ jobs: [{ type: "bookmarks_until", boundary: "999" }, { type: "context", ids: ["200"] }] }, h);
    assert.equal(result.stop?.reason, reason, name);
    assert.deepEqual(h.signals.map((s) => s.reason), [reason], `${name}: paused once`);
    assert.equal(h.sends.length, 2, `${name}: nothing sent after the signal, the next job included`);
  }
});

test("a pause set elsewhere (another tab's 429) stops the run before its next request, without a second report", async () => {
  const h = harness((_, v) => bookmarksPage([v.cursor ?? "1"], "c1"), { paused: (sends) => sends.length >= 1 });
  const result = await run({ jobs: [{ type: "bookmarks_until", boundary: "999" }] }, h);
  assert.equal(result.stop.reason, "paused");
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.signals, []);
});

test("a 404 re-opens the page once for a fresh template; a second 404 stops the run without pausing", async () => {
  const notFound = { status: 404, contentType: "", text: "" };
  let calls = 0;
  const once = harness(() => (++calls === 1 ? notFound : bookmarksPage(["1"], null)));
  const ok = await run({ jobs: [{ type: "bookmarks_until", boundary: "1" }] }, once);
  assert.equal(ok.stop, null);
  assert.deepEqual(once.primes, [["bookmarks", null], ["bookmarks", null]]);
  assert.deepEqual(ok.bookmarks.ids, ["1"]);

  const always = harness(() => notFound);
  const failed = await run({ jobs: [{ type: "bookmarks_until", boundary: "1" }] }, always);
  assert.equal(failed.stop.reason, "error");
  assert.match(failed.stop.detail, /404/);
  assert.equal(always.sends.length, 2);
  assert.deepEqual(always.signals, []);
});

test("only read operations are built: a mutation is refused by name, and a POST template still yields a GET URL", () => {
  for (const name of ["CreateBookmark", "DeleteBookmark", "FavoriteTweet", "CreateTweet", "CreateRetweet"]) {
    assert.throws(() => parseTemplate({ method: "POST", url: `https://x.com/i/api/graphql/aaaaaaaaaaaa/${name}`, body: '{"variables":{},"features":{}}' }), FetchRefused, name);
    assert.throws(() => buildRequest({ ...pageTemplate("TweetDetail"), operation: name }, name, {}), FetchRefused, name);
  }
  assert.throws(() => buildRequest(null, "TweetDetail", { focalTweetId: "1" }), /no template for TweetDetail/);
  assert.throws(() => buildRequest(pageTemplate("Bookmarks"), "Bookmarks", { userId: "1" }), /not one fetch mode sets/);

  const posted = parseTemplate({
    method: "POST",
    url: `https://x.com/i/api/graphql/${QID.SearchTimeline}/SearchTimeline`,
    body: JSON.stringify({ variables: PAGE_VARIABLES.SearchTimeline, features: FEATURES, queryId: QID.SearchTimeline }),
  });
  const { url } = buildRequest(posted, "SearchTimeline", { rawQuery: "url:1", product: "Top" });
  const built = new URL(url);
  assert.equal(built.pathname, `/i/api/graphql/${QID.SearchTimeline}/SearchTimeline`);
  assert.equal(JSON.parse(built.searchParams.get("variables")).rawQuery, "url:1");
  assert.deepEqual(JSON.parse(built.searchParams.get("features")), FEATURES);
});

test("a job list with an unknown job type or option is refused, not half-run", () => {
  assert.throws(() => parseJobs({ jobs: [{ type: "likes" }] }), /bookmarks_until or context/);
  assert.throws(() => parseJobs({ jobs: [{ type: "context", ids: ["1"], quote: false }] }), /quote is not a context option/);
  assert.throws(() => parseJobs({ jobs: [{ type: "context", ids: [1] }] }), /post id strings/);
});
