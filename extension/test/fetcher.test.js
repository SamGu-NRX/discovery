// Fetch mode in a real Chromium page: hook.js in the page's world, and
// bridge.js, detect.js and fetcher.js in one isolated world with
// chrome.runtime stubbed, as the extension loads them. x.com is a route that
// records every request, so nothing reaches the real X.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

import { detailResponse } from "./fixtures/x-shapes.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const QID = "tdQueryId_0002";
const CSRF = "csrf-secret-0123456789";

let browser;
let page;
let cdp;
let isolated;
const seen = [];

before(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("https://x.com/**", (route) => {
    const request = route.request();
    if (request.url().includes("/graphql/")) {
      seen.push({ method: request.method(), url: request.url(), headers: request.headers() });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(detailResponse()) });
    }
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><a data-testid="AppTabBar_Profile_Link" href="/owner">me</a>' });
  });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  cdp.on("Runtime.executionContextCreated", ({ context: c }) => {
    if (c.name === "extension") isolated = c.id;
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: await read("../app/content/hook.js") });
  const stub = "globalThis.sent = []; globalThis.chrome = { runtime: { sendMessage: async (m) => { sent.push(m); return { ok: true }; } }, storage: { local: { set: async () => {} } } };";
  const scripts = await Promise.all(["../app/content/detect.js", "../app/content/bridge.js", "../app/content/fetcher.js"].map(read));
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { worldName: "extension", source: [stub, ...scripts].join("\n;\n") });
  await page.goto("https://x.com/i/status/200");
});

after(() => browser?.close());

async function inExtension(expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { contextId: isolated, expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}
const fetcher = (command) =>
  inExtension(`Promise.resolve().then(() => globalThis.__dxFetcher.run(${JSON.stringify(command)})).then((value) => ({ value }), (err) => ({ error: err.message }))`);

// X's page asks for TweetDetail the way its client does: an XHR with auth
// headers, or a fetch with an init dictionary.
const pageRequest = (via, tid) =>
  page.evaluate(
    async ({ via, tid, qid, csrf }) => {
      const variables = encodeURIComponent(JSON.stringify({ focalTweetId: "200", with_rux_injections: false, rankingMode: "Relevance" }));
      const features = encodeURIComponent(JSON.stringify({ view_counts_everywhere_api_enabled: true }));
      const url = `/i/api/graphql/${qid}/TweetDetail?variables=${variables}&features=${features}`;
      const headers = { authorization: "Bearer page-bearer", "x-csrf-token": csrf, "x-client-transaction-id": tid, "x-twitter-auth-type": "OAuth2Session" };
      if (via === "xhr") {
        await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", url);
          for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
          xhr.onload = resolve;
          xhr.send();
        });
      } else {
        await (await fetch(url, { headers })).text();
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
    { via, tid, qid: QID, csrf: CSRF },
  );

test("the page's own request becomes a template inside the tab; its CSRF token never reaches the service worker", async () => {
  await pageRequest("xhr", "tid-from-xhr");
  const { value: summaries } = await fetcher({ name: "templates" });
  const t = summaries.TweetDetail;
  assert.ok(t, "TweetDetail template learned from the XHR");
  assert.equal(new URL(t.url).pathname, `/i/api/graphql/${QID}/TweetDetail`);
  assert.equal(t.method, "GET");
  assert.deepEqual([...t.headerNames].sort(), ["authorization", "x-client-transaction-id", "x-csrf-token", "x-twitter-auth-type"]);
  assert.ok(!JSON.stringify(summaries).includes(CSRF), "summaries carry header names, not values");
  assert.equal(summaries.CreateBookmark, undefined);

  const toWorker = JSON.stringify(await inExtension("sent"));
  assert.ok(toWorker.includes('"type":"capture"'), "the response itself is still captured");
  assert.ok(!toWorker.includes(CSRF), "no header value is sent to the service worker");
});

test("the fetcher sends a GET with the headers X's page used last, and refuses mutations and other hosts", async () => {
  await pageRequest("fetch", "tid-from-fetch");
  seen.length = 0;
  const variables = encodeURIComponent(JSON.stringify({ focalTweetId: "200", rankingMode: "Recency" }));
  const url = `https://x.com/i/api/graphql/${QID}/TweetDetail?variables=${variables}&features=%7B%7D`;
  const { value, error } = await fetcher({ name: "get", arg: { operation: "TweetDetail", url } });
  assert.equal(error, undefined);
  assert.equal(value.status, 200);
  assert.match(value.contentType, /^application\/json/);
  assert.equal(JSON.parse(value.text).data.threaded_conversation_with_injections_v2.instructions.length, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].headers["x-csrf-token"], CSRF);
  assert.equal(seen[0].headers["x-client-transaction-id"], "tid-from-fetch", "the latest page request's headers");

  seen.length = 0;
  const refusals = [
    { operation: "CreateBookmark", url: `https://x.com/i/api/graphql/${QID}/CreateBookmark` },
    { operation: "DeleteBookmark", url: `https://x.com/i/api/graphql/${QID}/DeleteBookmark` },
    { operation: "TweetDetail", url: `https://x.com/i/api/graphql/${QID}/FavoriteTweet` },
    { operation: "TweetDetail", url: `https://api.example.com/i/api/graphql/${QID}/TweetDetail` },
  ];
  for (const arg of refusals) {
    const reply = await fetcher({ name: "get", arg });
    assert.match(reply.error ?? "", /refused/, JSON.stringify(arg));
  }
  assert.deepEqual(seen, [], "nothing refused reached the network");
  assert.match((await fetcher({ name: "post", arg: {} })).error, /unknown fetcher command/);
});
