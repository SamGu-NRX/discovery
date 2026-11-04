// bridge.js in an isolated world with a fake chrome.runtime and a manual
// clock, so delivery and retry can be stepped exactly. Found in a readiness
// review of 24a9a80: a blocker counted as reported before the service worker
// had stored its pause, so a failed send held the next report off for 30
// minutes.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

let browser;
let page;
let cdp;
let world;

before(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("https://x.com/**", (route) =>
    route.request().url().includes("/graphql/")
      ? route.fulfill({ status: 429, contentType: "application/json", body: "{}" })
      : route.fulfill({ contentType: "text/html", body: '<!doctype html><input name="password">' }),
  );
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  cdp.on("Runtime.executionContextCreated", ({ context: c }) => {
    if (c.name === "bridge") world = c.id;
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // While the worker is down a send rejects; once up it answers { ok: true },
  // or { error } while `failing` is set.
  const harness = `
    globalThis.clock = 100000; Date.now = () => clock;
    globalThis.tick = null; globalThis.timers = []; globalThis.sent = []; globalThis.workerUp = false; globalThis.failing = false;
    globalThis.setInterval = (f) => { tick = f; };
    globalThis.setTimeout = (f) => { timers.push(f); };
    globalThis.chrome = { runtime: { sendMessage: async (m) => {
      sent.push(m);
      if (!workerUp) throw new Error("The message port closed before a response was received.");
      return failing ? { error: "could not store the pause" } : { ok: true };
    } } };
    globalThis.runTimers = () => timers.splice(0).forEach((f) => f());
  `;
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: await read("../app/content/hook.js") });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    worldName: "bridge",
    source: `${harness}\n${await read("../app/content/detect.js")}\n${await read("../app/content/bridge.js")}`,
  });
  await page.goto("https://x.com/home");
});

after(() => browser?.close());

const run = async (expression) =>
  (await cdp.send("Runtime.evaluate", { contextId: world, expression, returnByValue: true, awaitPromise: true })).result.value;

test("a login wall whose report the worker did not acknowledge is sent again at the next check", async () => {
  await run("tick(); runTimers(); new Promise((r) => queueMicrotask(r))");
  assert.equal(await run("sent.filter((m) => m.type === 'x-blocker').length"), 1);
  // The worker comes back; the next 5-second check sends again.
  await run("workerUp = true; clock += 5000; tick(); new Promise((r) => queueMicrotask(r))");
  assert.equal(await run("sent.filter((m) => m.type === 'x-blocker').length"), 2);
  // Acknowledged now: no further sends until the 30-minute repeat.
  await run("clock += 5000; tick(); clock += 5000; tick(); new Promise((r) => queueMicrotask(r))");
  assert.equal(await run("sent.filter((m) => m.type === 'x-blocker').length"), 2);
});

test("a 429 from X is sent until the worker acknowledges it, through a rejected send and an error reply", async () => {
  await run("workerUp = false; failing = false; sent.length = 0");
  const statusSends = () => run("sent.filter((m) => m.type === 'x-status' && m.status === 429).length");
  await page.evaluate(async () => {
    await (await fetch("/i/api/graphql/q/HomeTimeline")).text();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  assert.equal(await statusSends(), 1, "first send, rejected");
  await run("workerUp = true; failing = true; runTimers()");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(await statusSends(), 2, "sent again after the 2 s wait, answered with an error");
  await run("failing = false; runTimers()");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(await statusSends(), 3, "sent again, acknowledged");
  await run("runTimers()");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(await statusSends(), 3, "nothing more once acknowledged");
});
