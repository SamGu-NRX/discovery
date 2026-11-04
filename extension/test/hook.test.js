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

async function sentToWorker() {
  const { result } = await cdp.send("Runtime.evaluate", { contextId: bridgeWorld, expression: "JSON.stringify(sent)", returnByValue: true });
  return JSON.parse(result.value);
}

test("page scripts cannot forge a capture or take the channel, and X's real response still gets through", async () => {
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
