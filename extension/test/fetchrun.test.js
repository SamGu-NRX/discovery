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
function harness(answer, { paused = () => false, random = () => 0.5, stopAfter = Infinity, teaches = () => true } = {}) {
  let clock = 1_000_000;
  const sends = [];
  const primes = [];
  const batches = [];
  const signals = [];
  let learned = false;
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
      learned = teaches(kind);
      clock += 3000;
    },
    template: async (operation) => (learned ? pageTemplate(operation) : null),
    send: async (operation, href) => {
      const url = new URL(href);
      const variables = JSON.parse(url.searchParams.get("variables"));
      sends.push({ at: clock, operation, url, variables });
      clock += 120;
      const reply = answer(operation, variables, sends.length);
      return reply?.status !== undefined ? { ms: 120, ...reply } : { ms: 120, ...json(reply) };
    },
    // A search page load: what X's own page would receive for the query.
    loadPage: async (kind, rawQuery, product) => {
      sends.push({ at: clock, operation: "SearchTimeline", page: true, variables: { rawQuery, product } });
      clock += 3000;
      const reply = answer("SearchTimeline", { rawQuery, product }, sends.length);
      return reply?.status !== undefined ? { ms: 3000, url: "https://x.com/i/api/graphql/stQueryId_0003/SearchTimeline", ...reply } : { ms: 3000, url: "https://x.com/i/api/graphql/stQueryId_0003/SearchTimeline", ...json(reply) };
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
  // A branch permalink: the reply itself and one answer to it, plus a second
  // answer only in Recency order.
  const branch = (id, rankingMode) => detail([{ type: "TimelineAddEntries", entries: [
    itemEntry(post(id, "b", { conversationId: "200" }), "9000"),
    moduleEntry(`conversationthread-7${id}`, "8990", [other(`7${id}`, "z", id)]),
    ...(rankingMode === "Recency" ? [moduleEntry(`conversationthread-8${id}`, "8980", [other(`8${id}`, "y", id)])] : []),
  ] }]);
  return (operation, v) => {
    if (operation === "TweetDetail") {
      log.push(`${v.rankingMode}:${v.cursor ?? "-"}`);
      if (v.focalTweetId !== "200") return branch(v.focalTweetId, v.rankingMode);
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

  assert.deepEqual(h.primes, [["detail", "200"]], "TweetDetail on a permalink; each search is its own page load");
  assert.ok(h.sends.filter((x) => x.operation === "SearchTimeline").every((x) => x.page), "searches open search pages, not replays");
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

  assert.deepEqual(record.quotes.quoted_tweet_id.Latest.ids, ["901", "902"]);
  assert.equal(record.quotes.quoted_tweet_id.Latest.morePages, true, "X offered a further page");
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
  assert.equal(parseJobs({ limits: { jitterMs: 0 }, jobs: [{ type: "bookmarks_until", boundary: "1" }] }).limits.jitterMs, 1000, "jitter cannot be turned off");

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
  "a redirect": [{ status: 0, contentType: "", text: "", redirected: true }, "login_wall"],
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
  assert.throws(() => parseJobs({ jobs: [{ type: "likes" }] }), /bookmarks_until, context or new_saves/);
  assert.throws(() => parseJobs({ jobs: [{ type: "context", ids: ["1"], quote: false }] }), /quote is not a context option/);
  assert.throws(() => parseJobs({ jobs: [{ type: "context", ids: [1] }] }), /post id strings/);
});

test("a run leaves 30% of X's per-endpoint window to Sam: it waits for the reset, or stops cleanly when that is too far off", async () => {
  // The harness clock starts at 1,000,000 ms; X's reset is in epoch seconds.
  const page = (resetSeconds) => (_, v) => ({ ...json(bookmarksPage([v.cursor ? "2" : "1"], v.cursor ? null : "c1")), rate: { limit: 50, remaining: 15, reset: resetSeconds } });
  const soon = harness(page(1_600));
  const waited = await run({ jobs: [{ type: "bookmarks_until", boundary: "2" }] }, soon);
  assert.equal(waited.stop, null);
  assert.ok(soon.sends[1].at >= 1_602_000, `second request at ${soon.sends[1].at}, before the window reset`);
  assert.equal(waited.rateWaits.length, 1);

  const late = harness(page(1_000 + 30 * 60));
  const stopped = await run({ jobs: [{ type: "bookmarks_until", boundary: "2" }] }, late);
  assert.equal(stopped.stop.reason, "rate_budget");
  assert.equal(late.sends.length, 1);
  assert.deepEqual(late.signals, [], "running low is not X backing off, so nothing is paused");
});

test("each page load is its own gated request: the bookmarks fallback counts against the cap and stops for a pause", async () => {
  // /i/bookmarks teaches nothing (X opened another history tab), so the run
  // tries /i/history/bookmarks, as a second request.
  const h = harness(() => bookmarksPage(["1"], null), { teaches: (kind) => kind === "history_bookmarks" });
  const result = await run({ jobs: [{ type: "bookmarks_until", boundary: "1" }] }, h);
  assert.deepEqual(h.primes.map(([kind]) => kind), ["bookmarks", "history_bookmarks"]);
  assert.equal(result.requests, 3, "two page loads and one GET");

  const capped = harness(() => bookmarksPage(["1"], null), { teaches: () => false });
  const stopped = await run({ limits: { runCap: 1 }, jobs: [{ type: "bookmarks_until", boundary: "1" }] }, capped);
  assert.equal(stopped.stop.reason, "cap");
  assert.equal(capped.primes.length, 1);

  let pausedNow = false;
  const paused = harness(() => bookmarksPage(["1"], null), { teaches: () => ((pausedNow = true), false), paused: () => pausedNow });
  const held = await run({ jobs: [{ type: "bookmarks_until", boundary: "1" }] }, paused);
  assert.equal(held.stop.reason, "paused");
  assert.equal(paused.primes.length, 1, "no second page load after the pause");
});

test("a request that fails outright stops the run and pauses, whatever the error says", async () => {
  const h = harness(() => {
    throw new TypeError("Failed to fetch");
  });
  const result = await run({ jobs: [{ type: "bookmarks_until", boundary: "1" }] }, h);
  assert.equal(result.stop.reason, "error");
  assert.deepEqual(h.signals.map((s) => s.reason), ["error"]);
});

test("a branch walk never replaces a saved post's merged thread: the batches keep both reply orders", async () => {
  // 203 is saved and also a branch of 200, opened after 203's own two walks.
  const h = harness(contextAnswer());
  await run({ jobs: [{ type: "context", ids: ["203", "200"], quotes: false, mentions: false, links: false, conversation: false }] }, h);
  const last = h.batches.filter((b) => b.thread?.root_id === "203").at(-1).thread;
  assert.deepEqual(last.reply_ids, ["7203", "8203"]);
});

// Emil's save on Nov 12: the save 401 is the author's reply to their own
// post 400, and the replies worth having are under 400.
//   permalink 401: 400 above it, 401, one reply 411
//   permalink 400: 400, the self-reply 401, replies 402 and 403; Bottom -> 404
function parentAnswer(log = []) {
  const p = (id, handle, inReplyTo) => post(id, handle, { conversationId: "400", inReplyTo });
  return (operation, v) => {
    assert.equal(operation, "TweetDetail");
    log.push(`${v.focalTweetId}:${v.rankingMode}:${v.cursor ?? "-"}`);
    if (v.focalTweetId === "401") {
      return detail([{ type: "TimelineAddEntries", entries: [itemEntry(p("400", "op"), "9000"), itemEntry(p("401", "op", "400"), "8990"), moduleEntry("conversationthread-411", "8980", [p("411", "r", "401")])] }]);
    }
    if (v.focalTweetId === "400" && !v.cursor) {
      return detail([{ type: "TimelineAddEntries", entries: [
        itemEntry(p("400", "op"), "9000"),
        moduleEntry("conversationthread-401", "8990", [p("401", "op", "400")]),
        moduleEntry("conversationthread-402", "8980", [p("402", "x", "400")]),
        moduleEntry("conversationthread-403", "8970", [p("403", "y", "400")]),
        cursorItem("Bottom", "pb1"),
      ] }]);
    }
    if (v.focalTweetId === "400" && v.cursor === "pb1") return detail([{ type: "TimelineAddEntries", entries: [moduleEntry("conversationthread-404", "8960", [p("404", "z", "400")])] }]);
    throw new Error(`no fixture for ${JSON.stringify(v)}`);
  };
}
const DETAIL_ONLY = { branches: false, quotes: false, mentions: false, links: false, conversation: false };

test("a saved reply also reads the conversation of the post it answers, in Relevance order, within the save's cap", async () => {
  const log = [];
  const h = harness(parentAnswer(log));
  const record = (await run({ jobs: [{ type: "context", ids: ["401"], ...DETAIL_ONLY }] }, h)).context["401"];
  assert.deepEqual(log, ["401:Relevance:-", "401:Recency:-", "400:Relevance:-", "400:Relevance:pb1"]);
  assert.equal(record.parent.id, "400");
  assert.deepEqual(record.parent.thread.reply_ids, ["402", "403", "404"]);
  assert.equal(record.parent.exhausted, true);
  assert.equal(record.detailRequests, 4, "the parent's walk counts against the save's cap");
  assert.deepEqual(record.upstream.fetched, [], "the parent is not fetched again as upstream");

  const off = harness(parentAnswer());
  assert.equal((await run({ jobs: [{ type: "context", ids: ["401"], parent: false, ...DETAIL_ONLY }] }, off)).context["401"].parent, null);
  assert.equal(off.sends.length, 2);

  const capped = await run({ limits: { detailCapPerPost: 2 }, jobs: [{ type: "context", ids: ["401"], ...DETAIL_ONLY }] }, harness(parentAnswer()));
  assert.deepEqual(capped.context["401"].parent, { id: "400", skipped: "per-post cap" });

  // A parent that is saved too gets its own walks, not a second one under the reply.
  const bothLog = [];
  const both = await run({ jobs: [{ type: "context", ids: ["401", "400"], ...DETAIL_ONLY }] }, harness(parentAnswer(bothLog)));
  assert.deepEqual(both.context["401"].parent, { id: "400", skipped: "saved in this run" });
  assert.deepEqual(bothLog.filter((x) => x.startsWith("400:")), ["400:Relevance:-", "400:Relevance:pb1", "400:Recency:-", "400:Recency:pb1"], "only 400's own two walks");
});

// Bookmarks newest first: 1 to 9 over three pages; every permalink is the
// post alone.
function savesAnswer(log, { detailReply } = {}) {
  const pages = { "": [["1", "2", "3", "4"], "c1"], c1: [["5", "6", "7"], "c2"], c2: [["8", "9"], null] };
  return (operation, v) => {
    log.push(operation === "Bookmarks" ? `Bookmarks:${v.cursor ?? "-"}` : `TweetDetail:${v.focalTweetId}`);
    if (operation === "Bookmarks") return bookmarksPage(...pages[v.cursor ?? ""]);
    return detailReply ?? detail([{ type: "TimelineAddEntries", entries: [itemEntry(post(v.focalTweetId, "saver"), "9000")] }]);
  };
}
const QUIET = { rankings: ["Relevance"], parent: false, upstream: false, ...DETAIL_ONLY };

test("new_saves reads the saves above the last boundary, oldest first and at most maxSaves, and names the newest it handled", async () => {
  const log = [];
  const result = await run({ jobs: [{ type: "new_saves", boundary: "6", maxSaves: 3, context: QUIET }] }, harness(savesAnswer(log)));
  assert.equal(result.stop, null);
  assert.deepEqual(result.newSaves, { boundary: "6", found: true, top: "1", new: ["1", "2", "3", "4", "5"], taken: ["5", "4", "3"], handled: "3" });
  assert.deepEqual(log, ["Bookmarks:-", "Bookmarks:c1", "TweetDetail:5", "TweetDetail:4", "TweetDetail:3"], "stops paging at the boundary; 1 and 2 wait for the next run");

  // A first run reads one page and starts from its top post.
  const firstLog = [];
  const first = await run({ jobs: [{ type: "new_saves", boundary: null, context: QUIET }] }, harness(savesAnswer(firstLog)));
  assert.deepEqual(first.newSaves, { boundary: null, found: null, top: "1", new: [], taken: [], handled: "1" });
  assert.deepEqual(firstLog, ["Bookmarks:-"]);

  // A boundary X no longer lists: nothing is guessed, nothing is handled.
  const goneLog = [];
  const gone = await run({ jobs: [{ type: "new_saves", boundary: "77", maxPages: 2, context: QUIET }] }, harness(savesAnswer(goneLog)));
  assert.deepEqual(gone.newSaves, { boundary: "77", found: false, top: "1", new: [], taken: [], handled: null });
  assert.deepEqual(goneLog, ["Bookmarks:-", "Bookmarks:c1"]);

  // A run that stops during context handles nothing, so the next run retries.
  const stopped = await run({ jobs: [{ type: "new_saves", boundary: "6", context: QUIET }] }, harness(savesAnswer([], { detailReply: BACK_OFF["HTTP 429"][0] })));
  assert.equal(stopped.stop.reason, "rate_limited");
  assert.equal(stopped.newSaves.handled, null);

  assert.throws(() => parseJobs({ jobs: [{ type: "new_saves", boundary: "6", context: { ids: ["1"] } }] }), /context\.ids is not a context option/);
});

test("by default a post's conversation is followed past 40 requests, up to 80", async () => {
  // A conversation with one reply per page and a Bottom cursor on every page
  // up to page 100. Run 2's limits stopped Mollick's essay short on Nov 12.
  const focal = post("500", "op", { conversationId: "500" });
  const page = (n) => [moduleEntry(`conversationthread-5${n}`, String(8990 - n), [post(String(5000 + n), "r", { conversationId: "500", inReplyTo: "500" })]), ...(n < 100 ? [cursorItem("Bottom", `p${n + 1}`)] : [])];
  const h = harness((_, v) => detail([{ type: "TimelineAddEntries", entries: v.cursor ? page(Number(v.cursor.slice(1))) : [itemEntry(focal, "9000"), ...page(0)] }]));
  const record = (await run({ jobs: [{ type: "context", ids: ["500"], rankings: ["Relevance"], upstream: false, ...DETAIL_ONLY }] }, h)).context["500"];
  assert.equal(record.detailRequests, 80);
  assert.equal(record.thread.reply_ids.length, 80);
  assert.equal(record.detailCapped, true);
});

test("a fresh Top cursor on every page is not followed past the first page, and an empty page ends its cursors", async () => {
  // Live X on Nov 12: each page offered a new Top cursor, and each Top
  // page was empty apart from yet another one.
  let n = 0;
  const focal = post("300", "op", { conversationId: "300" });
  const h = harness((_, v) => {
    n += 1;
    if (!v.cursor) return detail([{ type: "TimelineAddEntries", entries: [itemEntry(focal, "9000"), moduleEntry("conversationthread-301", "8990", [post("301", "x", { conversationId: "300", inReplyTo: "300" })]), cursorItem("Top", `t${n}`), cursorItem("Bottom", "b1")] }]);
    if (v.cursor === "b1") return detail([{ type: "TimelineAddEntries", entries: [moduleEntry("conversationthread-302", "8980", [post("302", "y", { conversationId: "300", inReplyTo: "300" })]), cursorItem("Top", `t${n}`), cursorItem("Bottom", "b2")] }]);
    return detail([{ type: "TimelineAddEntries", entries: [cursorItem("Top", `t${n}`), cursorItem("Bottom", `b${n}`)] }]);
  });
  const result = await run({ jobs: [{ type: "context", ids: ["300"], rankings: ["Relevance"], branches: false, quotes: false, mentions: false, links: false, conversation: false, upstream: false }] }, h);
  assert.deepEqual(h.sends.map((s) => s.variables.cursor ?? "-"), ["-", "t1", "b1", "b2"]);
  assert.equal(result.context["300"].orders.Relevance.exhausted, true);
  assert.deepEqual(result.context["300"].thread.reply_ids, ["301", "302"]);
});

test("replayed search, when chosen, pages by cursor on a primed search page and stops at a page with no new results", async () => {
  const h = harness(contextAnswer());
  const result = await run({ limits: { searchVia: "replay" }, jobs: [{ type: "context", ids: ["200"], rankings: ["Relevance"], branches: false, mentions: false, links: false, conversation: false }] }, h);
  assert.deepEqual(h.primes.map(([kind]) => kind), ["detail", "search"]);
  assert.deepEqual(result.context["200"].quotes.quoted_tweet_id.Latest.ids, ["901", "902"]);
  assert.equal(result.context["200"].quotes.quoted_tweet_id.Latest.pages, 2);
});

test("search page loads keep to their own budget per 15 minutes", async () => {
  const ids = Array.from({ length: 4 }, (_, i) => String(500 + i));
  const answer = (operation, v) => (operation === "TweetDetail" ? detail([{ type: "TimelineAddEntries", entries: [itemEntry(post(v.focalTweetId, "op"), "9000")] }]) : searchPage(["901"], null));
  const g = harness(answer);
  const result = await run({ limits: { searchPageLoadsPerWindow: 2 }, jobs: [{ type: "context", ids, rankings: ["Relevance"], branches: false, mentions: false, links: false, conversation: false, upstream: false }] }, g);
  assert.equal(result.stop, null);
  const pages = g.sends.filter((x) => x.page).map((x) => x.at);
  assert.equal(pages.length, 4);
  for (let i = 2; i < pages.length; i += 1) assert.ok(pages[i] - pages[i - 2] >= 15 * 60_000, `page load ${i} is the third within 15 minutes`);
  assert.ok(result.rateWaits.some((w) => w.operation === "SearchTimeline"));
});

test("a new_saves run cut short still moves the boundary past the saves it finished, oldest first", async () => {
  // Bookmarks:-, Bookmarks:c1, TweetDetail:5, TweetDetail:4, then Stop.
  const log = [];
  const result = await run({ jobs: [{ type: "new_saves", boundary: "6", maxSaves: 3, context: QUIET }] }, harness(savesAnswer(log), { stopAfter: 4 }));
  assert.equal(result.stop.reason, "stopped");
  assert.deepEqual(log, ["Bookmarks:-", "Bookmarks:c1", "TweetDetail:5", "TweetDetail:4"]);
  assert.deepEqual(result.newSaves.taken, ["5", "4", "3"]);
  assert.equal(result.newSaves.handled, "4", "5 and 4 are done; 3 and newer wait");
});

test("a first new_saves run can take its newest saves, and a run without new_saves carries no new_saves fields", async () => {
  const log = [];
  const first = await run({ jobs: [{ type: "new_saves", boundary: null, newest: 3, context: QUIET }] }, harness(savesAnswer(log)));
  assert.deepEqual(first.newSaves, { boundary: null, found: null, top: "1", new: ["1", "2", "3"], taken: ["3", "2", "1"], handled: "1" });
  assert.deepEqual(log, ["Bookmarks:-", "TweetDetail:3", "TweetDetail:2", "TweetDetail:1"]);
  assert.throws(() => parseJobs({ jobs: [{ type: "new_saves", boundary: "6", newest: 3 }] }), /newest is for a first run/);

  // The archive's importer reads context bundles; they keep their shape.
  const plain = await run({ jobs: [{ type: "context", ids: ["5"], ...QUIET }] }, harness(savesAnswer([])));
  assert.equal("newSaves" in plain, false);
  assert.equal("completed" in plain, false);
});
