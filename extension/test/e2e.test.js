// The unpacked extension in a throwaway Chromium profile with no X login.
// Chromium resolves x.com to a local HTTPS server holding the fixture pages
// and fails every other hostname, so nothing can reach the real X, including
// windows the extension opens itself. The Worker is a local HTTP server.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  bookmarksResponse,
  detailPage2Response,
  detailResponse,
  homeResponse,
  itemEntry,
  tweet,
} from "./fixtures/x-shapes.js";

const APP = fileURLToPath(new URL("../app", import.meta.url));
const PAGES = fileURLToPath(new URL("./fixtures/pages", import.meta.url));
const TOKEN = "test-ingest-token";

let profile;
let context;
let worker;
let mock;
let extensionId;
const site = { lensAccount: "fixtureuser", lensLabels: "ok", homeIsLoginWall: false, homeRedirect: null, homeWithoutTimeline: false, graphqlStatus: 200, clicks: [], pages: [], requests: 0 };
// K in app/lib/session.js: the most requests a session window may make to X
// before X shows it a timeline.
const K = 50;

let fakeX;

before(async () => {
  mock = await startMockWorker();
  profile = await mkdtemp(join(tmpdir(), "x-capture-e2e-"));
  fakeX = await startFakeX(profile);
  context = await chromium.launchPersistentContext(join(profile, "chromium"), {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${APP}`,
      `--load-extension=${APP}`,
      `--host-resolver-rules=MAP x.com 127.0.0.1:${fakeX.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
      "--ignore-certificate-errors",
    ],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

after(async () => {
  if (process.env.E2E_DEBUG) {
    console.log(JSON.stringify(mock.requests.map((r) => ({ path: r.path, mode: r.body?.mode, status: r.body?.status, detail: r.body?.detail, batches: r.body?.batches?.map((b) => [b.surface, b.posts.map((p) => p.id + "@" + p.position)]) })), null, 1));
    console.log(JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(["lastProblem", "lastSession", "stats"])), null, 1));
    console.log(JSON.stringify(await worker.evaluate(() => chrome.storage.session.get(null)), null, 1));
  }
  await context?.close();
  mock?.server.close();
  fakeX?.server.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function configure(extra = {}) {
  site.clicks = [];
  site.pages = [];
  site.requests = 0;
  await worker.evaluate(
    (config) => chrome.storage.local.set({ config, pauseUntil: null, lastSession: null }),
    {
      mode: "passive",
      workerUrl: mock.url,
      ingestToken: TOKEN,
      homeMaxScreens: 2,
      bookmarksMaxScreens: 2,
      detailMaxPosts: 1,
      detailMaxScreens: 1,
      ...extra,
    },
  );
}

test("passive capture: X's own fetch and XHR responses reach the Worker as normalized batches", async () => {
  await configure();
  const page = await context.newPage();
  await page.goto("https://x.com/home");
  // The fixture page fetches the first page; a person clicking For You loads
  // the second page over XHR.
  await page.click('[data-name="for-you"]');

  const request = await mock.waitFor(
    (r) => r.path === "/ingest/x" && r.body.batches.some((b) => b.posts.some((p) => p.id === "150")),
  );
  assert.equal(request.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.body.mode, "passive");
  assert.equal(request.body.account, "fixtureuser");

  const posts = mock.requests
    .filter((r) => r.path === "/ingest/x" && r.body.mode === "passive")
    .flatMap((r) => r.body.batches.filter((b) => b.surface === "home_for_you").flatMap((b) => b.posts));
  const alice = posts.find((p) => p.id === "101");
  assert.equal(alice.text, "Tools & tricks <3 https://t.co/abc");
  assert.equal(alice.position, 0);
  // The XHR page continues the feed's positions after the 7 posts of the first.
  assert.equal(posts.find((p) => p.id === "150").position, 7);
  await page.close();
});

test("an active session reads home, bookmarks and one permalink by navigation alone, clicks nothing, and reports ok", async () => {
  await configure();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const startedAt = mock.requests.length;
  await popup.click("#run");

  const status = await mock.waitFor((r) => r.path === "/ingest/x/status", { after: startedAt, timeoutMs: 120_000 });
  assert.equal(status.body.status, "ok", status.body.detail);
  assert.equal(status.body.account, "fixtureuser");
  assert.match(status.body.detail, /^completed/);

  const ingests = mock.requests.slice(startedAt).filter((r) => r.path === "/ingest/x" && r.body.session_id === status.body.session_id);
  assert.ok(ingests.every((r) => r.body.mode === "active"));
  const batches = ingests.flatMap((r) => r.body.batches);
  assert.deepEqual([...new Set(batches.map((b) => b.surface))].sort(), ["bookmarks", "detail", "home_for_you"]);

  const queueCall = mock.requests.slice(startedAt).find((r) => r.path.startsWith("/x/detail-queue"));
  assert.equal(queueCall.path, "/x/detail-queue?account=fixtureuser");
  const threads = batches.filter((b) => b.thread).map((b) => b.thread);
  assert.deepEqual(threads.at(-1), {
    root_id: "200",
    op_self_thread_ids: ["200", "201", "202", "207"],
    reply_ids: ["203", "204", "205", "208"],
    related_ids: ["206", "210", "209"],
  });

  assert.deepEqual(site.pages, ["/home", "/i/bookmarks", "/i/history/bookmarks", "/i/status/200"]);
  const reservation = mock.requests.slice(startedAt).find((r) => r.path === "/x/sessions/start");
  assert.deepEqual(reservation.body, { account: "fixtureuser", session_id: status.body.session_id });
  assert.deepEqual(site.clicks, []);
  // Every piece carries an idempotency key of the form <capture uuid>:<index>.
  assert.ok(batches.every((b) => /^[0-9a-f-]{36}:\d+$/.test(b.batch_id)), "batch_id on every batch");
  await popup.close();
});

test("a session that meets a login wall stops, reports login_wall and pauses itself", async () => {
  await configure();
  site.homeIsLoginWall = true;
  try {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const startedAt = mock.requests.length;
    await popup.click("#run");
    const status = await mock.waitFor((r) => r.path === "/ingest/x/status", { after: startedAt, timeoutMs: 60_000 });
    assert.equal(status.body.status, "login_wall");
    assert.deepEqual(site.pages, ["/i/flow/login"], "stopped before bookmarks and permalinks");
    assert.deepEqual(site.clicks, []);
    assert.ok(site.requests <= K, `${site.requests} requests to X`);

    const pauseUntil = await worker.evaluate(async () => (await chrome.storage.local.get("pauseUntil")).pauseUntil);
    assert.ok(Date.parse(pauseUntil) > Date.now() + 23 * 3600_000);
    await popup.reload();
    assert.equal(await popup.isDisabled("#run"), true);
  } finally {
    site.homeIsLoginWall = false;
  }
});

// x.com, served over HTTPS with a throwaway self-signed certificate.
test("a GraphQL 429 during a session stops it and reports rate_limited", async () => {
  await configure();
  site.graphqlStatus = 429;
  try {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const startedAt = mock.requests.length;
    await popup.click("#run");
    const status = await mock.waitFor((r) => r.path === "/ingest/x/status", { after: startedAt, timeoutMs: 60_000 });
    assert.equal(status.body.status, "rate_limited");
    assert.match(status.body.detail, /HomeTimeline answered HTTP 429/);
    assert.deepEqual(site.pages, ["/home"], "stopped before bookmarks and permalinks");
    assert.ok(site.requests <= K, `${site.requests} requests to X`);
    const pauseUntil = await worker.evaluate(async () => (await chrome.storage.local.get("pauseUntil")).pauseUntil);
    assert.ok(Date.parse(pauseUntil) > Date.now() + 23 * 3600_000);
    await popup.close();
  } finally {
    site.graphqlStatus = 200;
  }
});

// The bound must hold even when nothing on the page reads as a block: this
// home page keeps calling X and never loads a timeline.
test("a session window that keeps calling X without a timeline is closed at K requests and pauses sessions", async () => {
  await configure();
  site.homeWithoutTimeline = true;
  try {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const startedAt = mock.requests.length;
    await popup.click("#run");
    const status = await mock.waitFor((r) => r.path === "/ingest/x/status", { after: startedAt, timeoutMs: 60_000 });
    assert.equal(status.body.status, "error");
    assert.match(status.body.detail, new RegExp(`X took ${K} requests without showing a timeline`));
    // Requests the page had already started when the cap closed the window
    // may still arrive; let them, then count.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.ok(site.requests <= K, `${site.requests} requests to X`);
    assert.deepEqual(site.pages, ["/home"]);
    const pauseUntil = await worker.evaluate(async () => (await chrome.storage.local.get("pauseUntil")).pauseUntil);
    assert.ok(Date.parse(pauseUntil) > Date.now() + 23 * 3600_000);
    await popup.close();
  } finally {
    site.homeWithoutTimeline = false;
  }
});

test("a session sent somewhere it did not open stops before reading it", async () => {
  await configure();
  site.homeRedirect = "/settings/account";
  try {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const startedAt = mock.requests.length;
    await popup.click("#run");
    const status = await mock.waitFor((r) => r.path === "/ingest/x/status", { after: startedAt, timeoutMs: 60_000 });
    assert.equal(status.body.status, "error");
    assert.match(status.body.detail, /unexpected page \/settings\/account after opening https:\/\/x\.com\/home/);
    assert.equal(status.body.detail.match(/screens=(\d+)/)[1], "0");
    await popup.close();
  } finally {
    site.homeRedirect = null;
  }
});

test("two starts at once run one session", async () => {
  await configure();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const startedAt = mock.requests.length;
  const replies = await popup.evaluate(() =>
    Promise.all([chrome.runtime.sendMessage({ type: "runSession" }), chrome.runtime.sendMessage({ type: "runSession" })]),
  );
  assert.deepEqual(replies.map((r) => r.started).sort(), [false, true]);
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stopSession" }));
  const status = await mock.waitFor((r) => r.path === "/ingest/x/status", { after: startedAt, timeoutMs: 60_000 });
  assert.match(status.body.detail, /^stopped_by_user/);
  await popup.close();
});

// Found in an install-readiness review of 017f38a: the login page answers
// 200, so only the page itself shows the wall.
test("a login page in one of Sam's own tabs pauses sessions and is reported, without touching the page", async () => {
  await configure({ mode: "active", account: "fixtureuser" });
  await worker.evaluate(() => chrome.storage.local.remove(["backOffReportedUntil", "pendingBackOff"]));
  const startedAt = mock.requests.length;
  const page = await context.newPage();
  await page.goto("https://x.com/i/flow/login");
  const report = await mock.waitFor((r) => r.path === "/ingest/x/status" && r.body.status === "login_wall", { after: startedAt });
  assert.match(report.body.detail, /\/i\/flow\/login/);
  const pauseUntil = await worker.evaluate(async () => (await chrome.storage.local.get("pauseUntil")).pauseUntil);
  assert.ok(Date.parse(pauseUntil) > Date.now());

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const reply = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "runSession" }));
  assert.equal(reply.started, false);
  assert.ok(!mock.requests.slice(startedAt).some((r) => r.path === "/x/sessions/start"));
  assert.deepEqual(site.clicks, []);
  await popup.close();
  await page.close();
});

// Found in an install-readiness review of d5447c9: checks ran only after a
// URL change (at about 1.5 s and 5 s), so a blocker appearing later on the
// same URL went unseen. The fixture shows its prompt 9 s after load.
test("a login prompt that appears later on the same URL in Sam's tab still pauses sessions", async () => {
  await configure({ mode: "active", account: "fixtureuser" });
  await worker.evaluate(() => chrome.storage.local.remove(["backOffReportedUntil", "pendingBackOff"]));
  const startedAt = mock.requests.length;
  const page = await context.newPage();
  await page.goto("https://x.com/home#late-login");
  const report = await mock.waitFor((r) => r.path === "/ingest/x/status" && r.body.status === "login_wall", { after: startedAt });
  assert.match(report.body.detail, /login control input at \/home/);
  assert.deepEqual(site.clicks, []);
  await page.close();
});

test("fetch mode: pages learn the templates, every request is a paced GET of a read operation, and batches, status and bundle carry no header value", async () => {
  await configure({ mode: "passive", account: "fixtureuser" });
  await worker.evaluate(async () => {
    const keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith("pageSignal:"));
    await chrome.storage.local.remove([...keys, "backOffReportedUntil", "pendingBackOff"]);
    await chrome.storage.local.set({ lastAccount: "fixtureuser" });
    await chrome.storage.session.remove(["activeSession", "fetchRun"]);
  });
  site.graphql = [];
  const startedAt = mock.requests.length;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/fetch/fetch.html`);
  const job = {
    limits: { detailCapPerPost: 6 },
    jobs: [
      { type: "bookmarks_until", boundary: "402" },
      { type: "context", ids: ["200"], rankings: ["Relevance"], branches: false, mentions: false, links: false, conversation: false, upstream: false },
    ],
  };
  await page.fill("#job", JSON.stringify(job));
  const download = page.waitForEvent("download", { timeout: 120_000 });
  await page.click("#start");
  const bundle = JSON.parse(await readFile(await (await download).path(), "utf8"));

  assert.equal(bundle.stop, null, JSON.stringify(bundle.stop));
  assert.deepEqual(bundle.bookmarks.ids, ["401", "402"]);
  assert.deepEqual(bundle.context["200"].thread.reply_ids, ["203", "204", "205", "208"]);
  assert.deepEqual(bundle.context["200"].quotes.quoted_tweet_id.Latest.ids, ["601"]);

  // What reached the fake X from fetch mode: the fetcher's GETs, which carry
  // the page's own headers, never a mutation.
  const fetched = site.graphql.filter((r) => r.fetcher);
  assert.ok(fetched.length >= 4, `${fetched.length} fetch-mode requests`);
  assert.ok(fetched.every((r) => r.headers["x-csrf-token"] === "fixture-csrf-token" && r.headers["x-client-transaction-id"] === "fixture-tid"));
  assert.ok(site.graphql.every((r) => r.method === "GET" && ["Bookmarks", "TweetDetail", "SearchTimeline"].includes(r.op)), JSON.stringify(site.graphql.map((r) => [r.method, r.op])));
  const times = fetched.map((r) => r.at);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= 1400, `requests ${i - 1} and ${i} were ${times[i] - times[i - 1]} ms apart`);

  const run = mock.requests.slice(startedAt);
  const reservation = run.find((r) => r.path === "/x/sessions/start");
  assert.equal(reservation.body.mode, "fetch");
  const ingests = run.filter((r) => r.path === "/ingest/x" && r.body.session_id === reservation.body.session_id);
  assert.ok(ingests.length && ingests.every((r) => r.body.mode === "fetch"));
  assert.ok(ingests.flatMap((r) => r.body.batches).some((b) => b.surface === "bookmarks"));
  const status = run.find((r) => r.path === "/ingest/x/status" && r.body.session_id === reservation.body.session_id);
  assert.equal(status.body.status, "ok", status.body.detail);

  const stored = JSON.stringify(await worker.evaluate(async () => [await chrome.storage.local.get(null), await chrome.storage.session.get(null)]));
  for (const [where, text] of [["bundle", JSON.stringify(bundle)], ["Worker requests", JSON.stringify(run)], ["extension storage", stored]]) {
    assert.ok(!text.includes("fixture-csrf-token") && !text.includes("fixture-bearer"), `a header value is in the ${where}`);
  }
  assert.deepEqual(site.clicks, []);
  await page.close();
});

test("a lens session reads the home feed by dwell alone, opens its one on-topic post, and sends its reads and lens-tagged batches", async () => {
  await configure({ mode: "passive", account: "fixtureuser", lensId: "harness", lensMaxPosts: 5, lensMaxMinutes: 3 });
  await worker.evaluate(async () => {
    const keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith("pageSignal:"));
    await chrome.storage.local.remove([...keys, "backOffReportedUntil", "pendingBackOff"]);
    await chrome.storage.session.remove(["activeSession", "fetchRun"]);
  });
  const startedAt = mock.requests.length;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.click("#run");
  const status = await mock.waitFor((r) => r.path === "/ingest/x/status", { after: startedAt, timeoutMs: 180_000 });
  assert.equal(status.body.status, "ok", status.body.detail);

  const run = mock.requests.slice(startedAt);
  const reads = run.filter((r) => r.path === "/lenses/harness/reads").flatMap((r) => r.body.reads);
  assert.deepEqual(reads.map((r) => [r.post_id, r.action]).sort(), [["101", "open"], ["102", "skip"], ["103", "skip"], ["104", "skip"], ["105", "skip"]]);
  assert.match(status.body.detail, /lens harness: 5 read, 1 opened/);
  const open = reads.find((r) => r.post_id === "101");
  assert.ok(open.dwell_ms >= 30_000 && open.dwell_ms <= 50_000, `feed plus permalink dwell was ${open.dwell_ms} ms`);
  assert.ok(reads.filter((r) => r.action === "skip").every((r) => r.dwell_ms >= 750 && r.dwell_ms <= 1250));
  assert.ok(run.filter((r) => r.path === "/lenses/harness/reads").every((r) => r.body.session_id === status.body.session_id));
  assert.ok(site.pages.includes("/i/status/101"), "the open post was read on its permalink");
  assert.ok(!site.pages.includes("/i/bookmarks"), "a lens session reads only its feed");
  const ingests = run.filter((r) => r.path === "/ingest/x" && r.body.session_id === status.body.session_id);
  // Captures before the lens was verified for this account go untagged;
  // those after (the permalink's) carry it.
  assert.ok(ingests.some((r) => r.body.lens_id === "harness"));
  assert.ok(ingests.every((r) => r.body.lens_id === undefined || r.body.lens_id === "harness"));
  assert.deepEqual(site.clicks, []);
  await popup.close();
  await configure({ lensId: null });
});

test("a lens of another account, or labels the reader cannot use, end the session without pausing X and without lens-tagged batches", async () => {
  for (const [name, change, detail] of [
    ["another account's lens", { lensAccount: "someoneelse" }, /lens harness is not a lens of @fixtureuser/],
    ["an action the reader does not know", { lensLabels: "bad" }, /labels are unusable: action "like"/],
  ]) {
    Object.assign(site, { lensAccount: "fixtureuser", lensLabels: "ok" }, change);
    await configure({ mode: "passive", account: "fixtureuser", lensId: "harness", lensMaxPosts: 5, lensMaxMinutes: 3 });
    await worker.evaluate(() => chrome.storage.session.remove(["activeSession", "fetchRun"]));
    const startedAt = mock.requests.length;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.click("#run");
    const status = await mock.waitFor((r) => r.path === "/ingest/x/status", { after: startedAt, timeoutMs: 120_000 });
    assert.equal(status.body.status, "ok", name);
    assert.match(status.body.detail, detail, name);
    const pauseUntil = await worker.evaluate(async () => (await chrome.storage.local.get("pauseUntil")).pauseUntil);
    assert.ok(!pauseUntil || Date.parse(pauseUntil) < Date.now(), `${name}: X is not paused`);
    const run = mock.requests.slice(startedAt);
    assert.ok(!run.some((r) => r.path === "/ingest/x" && r.body.lens_id), `${name}: no batch carries the lens`);
    assert.ok(!run.some((r) => r.path === "/lenses/harness/reads" && r.body.reads.some((x) => !["skip", "glance", "open"].includes(x.action))), name);
    await popup.close();
  }
  Object.assign(site, { lensAccount: "fixtureuser", lensLabels: "ok" });
  await configure({ lensId: null });
});

async function startFakeX(dir) {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=x.com",
    "-addext", "subjectAltName=DNS:x.com", "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  const server = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    serveX(req, res).catch((err) => res.writeHead(500).end(String(err)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

async function serveX(req, res) {
  site.requests += 1;
  const url = new URL(req.url, "https://x.com");
  const send = (type, body, status = 200) => res.writeHead(status, { "content-type": type }).end(body);
  const html = async (file) => {
    site.pages.push(url.pathname);
    return send("text/html", await readFile(join(PAGES, file), "utf8"));
  };
  const json = (body) => send("application/json", JSON.stringify(body));

  if (url.pathname === "/__log") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    site.clicks.push(JSON.parse(raw));
    return res.writeHead(204).end();
  }
  if (url.pathname === "/__fixture/shared.js") return send("text/javascript", await readFile(join(PAGES, "shared.js"), "utf8"));
  const op = /\/graphql\/[^/]+\/(\w+)$/.exec(url.pathname)?.[1];
  if (op) {
    // The fetcher asks for no-store, which the fixture pages never do.
    site.graphql?.push({ at: Date.now(), op, method: req.method, headers: req.headers, fetcher: req.headers["cache-control"] === "no-cache" });
    if (site.graphqlStatus !== 200) return send("application/json", "{}", site.graphqlStatus);
    const variables = JSON.parse(url.searchParams.get("variables") ?? "{}");
    if (op === "SearchTimeline") {
      const entries = [itemEntry(tweet({ id: "601", handle: "quoter", userId: "u-quoter" }), "6000")];
      return json({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } } });
    }
    if (op === "HomeTimeline" && variables.cursor === "page2") return json(homePage2());
    if (op === "HomeTimeline") return json(homeResponse());
    if (op === "Bookmarks") return json(bookmarksResponse());
    if (op === "TweetDetail") return json(variables.cursor ? detailPage2Response() : detailResponse());
    return send("text/plain", "", 404);
  }
  if (url.pathname === "/i/api/1.1/ping") return res.writeHead(204).end();
  if (url.pathname === "/home") {
    if (site.homeWithoutTimeline) return html("busy.html");
    if (site.homeIsLoginWall) return res.writeHead(302, { location: "https://x.com/i/flow/login" }).end();
    if (site.homeRedirect) return res.writeHead(302, { location: `https://x.com${site.homeRedirect}` }).end();
    return html("home.html");
  }
  if (url.pathname === "/i/flow/login") return html("login.html");
  if (url.pathname === "/settings/account") return html("settings.html");
  if (url.pathname === "/i/bookmarks" || url.pathname.startsWith("/i/history")) return html("history.html");
  if (/^\/i\/status\/\d+$/.test(url.pathname)) return html("status.html");
  if (url.pathname === "/search") return html("search.html");
  return send("text/plain", "", 404);
}

function homePage2() {
  const entries = [itemEntry(tweet({ id: "150", handle: "hana", userId: "u-hana" }), "1500")];
  return { data: { home: { home_timeline_urt: { instructions: [{ type: "TimelineAddEntries", entries }] } } } };
}

// Records every request; answers like the contract's Worker. CORS headers let
// the extension call it without a host permission for 127.0.0.1.
function startMockWorker() {
  const requests = [];
  const waiters = new Set();
  const server = createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const record = { method: req.method, path: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      requests.push(record);
      for (const waiter of waiters) waiter(record, requests.length - 1);
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/x/detail-queue")) return res.end(JSON.stringify({ post_ids: ["200"], pause_until: null }));
      if (req.url === "/x/sessions/start") return res.end("{}");
      // Lens routes (docs/LENS.md): one lens for the fixture account; 101 is
      // labeled open, every other post skip.
      if (req.url.startsWith("/lenses?account=")) return res.end(JSON.stringify({ lenses: [{ id: "harness", account: site.lensAccount }] }));
      if (req.url === "/lenses/harness/label") {
        const labels = record.body.posts.map((p) => ({ id: p.id, action: site.lensLabels === "bad" ? "like" : p.id === "101" ? "open" : "skip", taste: p.id === "101" ? 0.9 : 0.1, novelty: 1, project: 0 }));
        return res.end(JSON.stringify({ source: "model", labels }));
      }
      if (req.url === "/ingest/x") return res.end(JSON.stringify({ posts_upserted: 0, sightings: 0, new_posts: 0, candidates_created: 0 }));
      return res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        requests,
        url: `http://127.0.0.1:${server.address().port}`,
        // Resolves with the first request at index >= `after` matching `match`.
        waitFor(match, { after = 0, timeoutMs = 30_000 } = {}) {
          const existing = requests.slice(after).find(match);
          if (existing) return Promise.resolve(existing);
          return new Promise((done, fail) => {
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(new Error(`no matching Worker request within ${timeoutMs} ms`));
            }, timeoutMs);
            const check = (record, index) => {
              if (index < after || !match(record)) return;
              clearTimeout(timer);
              waiters.delete(check);
              done(record);
            };
            waiters.add(check);
          });
        },
      });
    });
  });
}
