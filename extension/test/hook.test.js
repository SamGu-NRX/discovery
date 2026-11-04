// hook.js and bridge.js in a real Chromium page: hook.js in the page's world,
// bridge.js in its own isolated world with chrome.runtime stubbed, as an
// extension loads them. Checks that X's real responses get through and that
// page JavaScript cannot forge captures or take the private channel.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

import { homeResponse, itemEntry, tweet } from "./fixtures/x-shapes.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

let browser;
let page;
let cdp;
let bridgeWorld;

before(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("https://x.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/not-graphql")) return route.fulfill({ contentType: "application/json", body: '{"unrelated":true}' });
    if (url.includes("/NotificationsTimeline") || url.includes("/SearchTimeline")) {
      return route.fulfill({ contentType: "application/json", body: '{"errors":[{"code":88,"message":"Rate limit exceeded"}]}' });
    }
    if (url.includes("/graphql/")) return route.fulfill({ contentType: "application/json", body: JSON.stringify(homeResponse()) });
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><a data-testid="AppTabBar_Profile_Link" href="/owner">me</a>' });
  });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  cdp.on("Runtime.executionContextCreated", ({ context: c }) => {
    if (c.name === "bridge") bridgeWorld = c.id;
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: await read("../app/content/hook.js") });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    worldName: "bridge",
    source: `globalThis.sent = []; globalThis.chrome = { runtime: { sendMessage: async (m) => { sent.push(m); } } };\n${await read("../app/content/bridge.js")}`,
  });
  await page.goto("https://x.com/home");
});

after(() => browser?.close());

async function clearSent() {
  await cdp.send("Runtime.evaluate", { contextId: bridgeWorld, expression: "sent.length = 0" });
}

async function sentToWorker() {
  const { result } = await cdp.send("Runtime.evaluate", { contextId: bridgeWorld, expression: "JSON.stringify(sent)", returnByValue: true });
  return JSON.parse(result.value);
}

test("page scripts cannot forge a capture or take the channel, and X's real response still gets through", async () => {
  await clearSent();
  const forged = JSON.stringify({ data: { home: { home_timeline_urt: { instructions: [{ type: "TimelineAddEntries", entries: [itemEntry(tweet({ id: "31337", handle: "forger", userId: "u-f" }), "1")] }] } } } });

  const outcome = await page.evaluate(async (forgedBody) => {
    // Replace built-ins the hook might call, after both scripts started.
    const dispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (event) {
      if (event.type === "dx-capture-data") window.stolen = this;
      return dispatch.call(this, event);
    };
    Response.prototype.text = async () => forgedBody;
    JSON.stringify = ((original) => (value, ...rest) => original(value, ...rest).replace(/"101"/g, '"31337"'))(JSON.stringify);

    // A synthetic load on an XHR that was opened but never sent.
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://x.com/i/api/graphql/q/HomeTimeline");
    Object.defineProperties(xhr, { status: { value: 200 }, responseText: { value: forgedBody } });
    xhr.dispatchEvent(new Event("load"));

    // X's own request, whose body the page reads at once.
    const res = await fetch("/i/api/graphql/q/HomeTimeline?variables=%7B%7D");
    await res.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { stolen: Boolean(window.stolen) };
  }, forged);

  const sent = await sentToWorker();
  assert.equal(outcome.stolen, false);
  assert.equal(sent.length, 1, `expected only the real response, got ${sent.length} message(s)`);
  assert.equal(sent[0].type, "capture");
  assert.equal(sent[0].account, "owner");
  assert.ok(sent[0].body.includes('"rest_id":"101"'), "the real body");
  assert.ok(!sent[0].body.includes('"rest_id":"31337"'), "no forged post");
});

test("a toJSON a page script puts on Object.prototype cannot replace a captured message", async () => {
  await clearSent();
  const forged = JSON.stringify({ data: { home: { home_timeline_urt: { instructions: [{ type: "TimelineAddEntries", entries: [itemEntry(tweet({ id: "31337", handle: "forger", userId: "u-f" }), "1")] }] } } } });
  await page.evaluate(async (forgedBody) => {
    // JSON.stringify calls toJSON on the value it is given, even a saved copy
    // of stringify, so this would swap the whole message.
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        return this && this.kind === "response" ? { ...this, body: forgedBody } : this;
      },
    });
    try {
      const res = await fetch("/i/api/graphql/q/HomeTimeline?variables=%7B%7D");
      await res.arrayBuffer();
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      delete Object.prototype.toJSON;
    }
  }, forged);

  const sent = await sentToWorker();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.includes('"rest_id":"101"'), "the real body");
  assert.ok(!sent[0].body.includes('"rest_id":"31337"'), "no forged post");
});

// Each case makes the browser fetch one thing while the arguments, or the
// promise's resolved value, claim another. Found in review at 022960d.
const MISLABELED = {
  "a Response substituted through a then getter": async () => {
    Object.defineProperty(Response.prototype, "then", {
      configurable: true,
      get() {
        delete Response.prototype.then;
        return (resolve) => resolve(new Response('{"forged":true}', { status: 200 }));
      },
    });
    await fetch("/i/api/graphql/q/HomeTimeline");
  },
  "a Request with its own url property": async () => {
    const request = new Request("https://x.com/not-graphql");
    Object.defineProperty(request, "url", { value: "https://x.com/i/api/graphql/q/HomeTimeline" });
    await (await fetch(request)).arrayBuffer();
  },
  "an object whose url and toString disagree": async () => {
    await (await fetch({ toString: () => "/not-graphql", url: "https://x.com/i/api/graphql/q/HomeTimeline" })).arrayBuffer();
  },
  "an XHR URL whose toString changes between calls": async () => {
    let calls = 0;
    const xhr = new XMLHttpRequest();
    xhr.open("GET", { toString: () => (++calls === 1 ? "/i/api/graphql/q/HomeTimeline" : "/not-graphql") });
    await new Promise((resolve) => {
      xhr.onload = resolve;
      xhr.send();
    });
  },
  // The "?" inside the payload ends the data: URL's path right after the
  // operation name, so the path looks like a GraphQL path.
  "a data: URL whose path names a GraphQL operation": async () => {
    const url = 'data:application/json,{"forged":"/graphql/q/HomeTimeline?"}';
    await (await fetch(url)).arrayBuffer();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    await new Promise((resolve) => {
      xhr.onload = resolve;
      xhr.send();
    });
  },
  "an XHR opened for GraphQL, then reopened elsewhere": async () => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/i/api/graphql/q/HomeTimeline");
    xhr.open("GET", "/not-graphql");
    await new Promise((resolve) => {
      xhr.onload = resolve;
      xhr.send();
    });
  },
};

test("a response is labeled by the URL the browser fetched, not the URL the page claimed", async () => {
  for (const [name, scenario] of Object.entries(MISLABELED)) {
    await clearSent();
    await page.evaluate(`(${scenario})().then(() => new Promise((resolve) => setTimeout(resolve, 150)))`);
    // Whatever is forwarded must be a GraphQL response the browser really
    // fetched from X; here that can only be the home timeline fixture.
    const sent = await sentToWorker();
    for (const message of sent) {
      assert.equal(message.body, JSON.stringify(homeResponse()), `${name}: forwarded ${message.body?.slice(0, 60)}`);
    }
  }
});

// Found in an install-readiness review of d5447c9: code 88 on an operation
// the extension does not capture was never seen.
test("X error 88 on an operation that is not captured is reported, without its body", async () => {
  for (const viaXhr of [false, true]) {
    await clearSent();
    await page.evaluate(async (xhr) => {
      const url = "/i/api/graphql/q/NotificationsTimeline?variables=%7B%7D";
      if (xhr) {
        await new Promise((resolve) => {
          const request = new XMLHttpRequest();
          request.open("GET", url);
          request.onload = resolve;
          request.send();
        });
      } else {
        await (await fetch(url)).text();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }, viaXhr);
    const sent = await sentToWorker();
    assert.deepEqual(sent.map((m) => [m.type, m.operation, m.body]), [["x-limit", "NotificationsTimeline", undefined]], viaXhr ? "xhr" : "fetch");
  }
});

// Found in an install-readiness review of 99b794b: an XHR read as
// responseType "json" has no text, so its code 88 went unseen.
test("X error 88 in a JSON-typed XHR is reported, for captured and uncaptured operations", async () => {
  for (const operation of ["NotificationsTimeline", "SearchTimeline"]) {
    await clearSent();
    await page.evaluate(async (op) => {
      await new Promise((resolve) => {
        const request = new XMLHttpRequest();
        request.open("GET", `/i/api/graphql/q/${op}?variables=%7B%7D`);
        request.responseType = "json";
        request.onload = resolve;
        request.send();
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }, operation);
    const sent = await sentToWorker();
    assert.deepEqual(sent.map((m) => [m.type, m.operation, m.body]), [["x-limit", operation, undefined]], operation);
  }
});
