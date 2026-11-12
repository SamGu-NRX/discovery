// hook.js when another extension's page script ran first and replaced
// XMLHttpRequest and Request with subclasses, as some of Sam's installed
// extensions do. Found live on Nov 12: the hook threw at load on x.com and
// captured nothing, so passive capture and fetch mode both went blind.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

import { homeResponse } from "./fixtures/x-shapes.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const FOREIGN = `
  window.XMLHttpRequest = class extends XMLHttpRequest {};
  window.Request = class extends Request {};
`;

let browser;
let page;
let cdp;
let isolated;
const errors = [];

before(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("https://x.com/**", (route) =>
    route.request().url().includes("/graphql/")
      ? route.fulfill({ contentType: "application/json", body: JSON.stringify(homeResponse()) })
      : route.fulfill({ contentType: "text/html", body: '<!doctype html><a data-testid="AppTabBar_Profile_Link" href="/owner">me</a>' }),
  );
  page = await context.newPage();
  page.on("pageerror", (err) => errors.push(err.message));
  cdp = await context.newCDPSession(page);
  cdp.on("Runtime.executionContextCreated", ({ context: c }) => {
    if (c.name === "extension") isolated = c.id;
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FOREIGN });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: await read("../app/content/hook.js") });
  const stub = "globalThis.sent = []; globalThis.chrome = { runtime: { sendMessage: async (m) => { sent.push(m); return { ok: true }; } }, storage: { local: { set: async () => {} } } };";
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { worldName: "extension", source: `${stub}\n${await read("../app/content/bridge.js")}` });
  await page.goto("https://x.com/home");
});

after(() => browser?.close());

test("with XMLHttpRequest and Request already subclassed by another script, the hook loads, captures and learns templates", async () => {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "/i/api/graphql/tdQueryId_0002/TweetDetail?variables=%7B%7D&features=%7B%7D");
      xhr.setRequestHeader("x-csrf-token", "t");
      xhr.onload = resolve;
      xhr.send();
    });
    await (await fetch(new Request("/i/api/graphql/hmQueryId_0001/HomeTimeline?variables=%7B%7D"))).text();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  assert.deepEqual(errors, []);
  const { result } = await cdp.send("Runtime.evaluate", {
    contextId: isolated,
    expression: "JSON.stringify({ ops: sent.map((m) => m.operation), template: globalThis.__dxTemplates.summary('TweetDetail') })",
    returnByValue: true,
  });
  const { ops, template } = JSON.parse(result.value);
  assert.deepEqual(ops.sort(), ["HomeTimeline", "TweetDetail"]);
  assert.deepEqual(template.headerNames, ["x-csrf-token"]);
});
