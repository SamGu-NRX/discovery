// Interleavings of session start, teardown, restart recovery and capture,
// run against session.js and background.js with a stubbed browser. Found in
// review at 022960d. Timers are capped at 3 ms so the human-pace pauses do
// not slow the test; no assertion depends on timing.

import assert from "node:assert/strict";
import { test } from "node:test";

import { installFakeChrome } from "./fake-chrome.js";
import { homeResponse } from "./fixtures/x-shapes.js";

const realSetTimeout = setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(ms ?? 0, 3), ...args);

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const event = () => {
  const listeners = new Set();
  return {
    addListener: (f) => listeners.add(f),
    removeListener: (f) => listeners.delete(f),
    fire: (...args) => [...listeners].forEach((f) => f(...args)),
  };
};

const fake = installFakeChrome();
const updates = event();
const removed = event();
const messages = event();
Object.assign(chrome.runtime, {
  id: "test-extension",
  getURL: (p) => `chrome-extension://test-extension/${p}`,
  onMessage: messages,
  onInstalled: event(),
  onStartup: event(),
});
chrome.alarms.onAlarm = event();
chrome.storage.onChanged = event();
chrome.windows.onRemoved = removed;

// What happened, in order: window opens and status reports.
const log = [];
let tab = null;
chrome.windows.create = async ({ url }) => {
  const id = 10 + log.length;
  log.push(`open:${id}`);
  tab = { id: id + 100, url };
  updates.fire(tab.id, { status: "complete" });
  return { id, tabs: [{ ...tab }] };
};
chrome.tabs = {
  onUpdated: updates,
  get: async () => ({ ...tab }),
  update: async (id, { url }) => {
    tab.url = url;
    updates.fire(id, { status: "complete" });
    return { ...tab };
  },
};
chrome.windows.remove = async (id) => {
  fake.removedWindows.push(id);
  removed.fire(id);
};
chrome.scripting = {
  executeScript: async ({ files, args }) => {
    if (files) return [];
    const path = new URL(tab.url).pathname;
    if (args[0].name === "inspect") return [{ result: { ok: { account: "owner", blocker: null, errorPage: false, path } } }];
    return [{ result: { ok: { scrolled: true, atBottom: false } } }];
  },
};
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname;
  if (path === "/ingest/x/status") {
    const body = JSON.parse(init.body);
    log.push(`status:${body.session_id}:${body.status}`);
  }
  if (path === "/x/detail-queue") return new Response(JSON.stringify({ post_ids: [], pause_until: null }));
  return new Response("{}");
};

// Resolves when the next session writes its final record.
let ended = deferred();
const localSet = chrome.storage.local.set;
chrome.storage.local.set = async (values) => {
  await localSet(values);
  if (values.lastSession) ended.resolve(values.lastSession);
};

const CONFIG = { workerUrl: "http://127.0.0.1:1", ingestToken: "t", account: "owner", mode: "active", homeMaxScreens: 1, bookmarksMaxScreens: 1, detailMaxScreens: 1 };
await chrome.storage.local.set({ config: CONFIG });
await import("../app/background.js");
const session = await import("../app/lib/session.js");

// A session writes its final record before it finishes tearing down.
async function untilIdle() {
  while (session.sessionInfo() !== null) await new Promise((resolve) => realSetTimeout(resolve, 1));
}

// Sends a message to background.js as an x.com tab would.
function fromTab(tabId, message) {
  const reply = deferred();
  messages.fire(message, { id: chrome.runtime.id, url: "https://x.com/home", tab: { id: tabId } }, reply.resolve);
  return reply.promise;
}

const capture = (url = "https://x.com/i/api/graphql/q/HomeTimeline") => ({
  type: "capture",
  operation: "HomeTimeline",
  url,
  body: JSON.stringify(homeResponse()),
  pageLoadId: `load-${Math.random()}`,
  account: "owner",
});

async function reset() {
  await chrome.storage.local.set({ config: CONFIG });
  await session.recoverInterruptedSession();
  fake.local.delete("pauseUntil");
  fake.local.delete("outbox");
  fake.session.clear();
  log.length = 0;
  ended = deferred();
}

test("a session recovered after a restart is reported before a new session can replace its record", async () => {
  await reset();
  await chrome.storage.session.set({
    activeSession: { id: "old", windowId: 7, account: "owner", stop: { reason: "challenge", detail: "CAPTCHA" }, completed: false },
  });
  // Hold recovery right after it reads the old record, and start a session then.
  const read = deferred();
  const gate = deferred();
  const get = chrome.storage.session.get;
  chrome.storage.session.get = async (key) => {
    const snapshot = await get(key);
    if (key === "activeSession") {
      chrome.storage.session.get = get;
      read.resolve();
      await gate.promise;
    }
    return snapshot;
  };
  const recovering = session.recoverInterruptedSession();
  await read.promise;
  const starting = session.startSession("manual");
  gate.resolve();
  await recovering;
  const started = await starting;

  assert.equal(log[0], "status:old:challenge", log.join(" "));
  assert.ok(fake.removedWindows.includes(7));
  // The recovered challenge pauses sessions, so the new start is refused.
  assert.equal(started.started, false);
  assert.match(started.reason, /Paused until/);
  assert.ok(!log.some((entry) => entry.startsWith("open:")));
});

test("a session ending cannot let another start until its own record is gone", async () => {
  await reset();
  const first = await session.startSession("manual");
  assert.equal(first.started, true);

  // Hold the first session's teardown at its record removal.
  const entered = deferred();
  const release = deferred();
  const remove = chrome.storage.session.remove;
  chrome.storage.session.remove = async (key) => {
    chrome.storage.session.remove = remove;
    entered.resolve();
    await release.promise;
    return remove(key);
  };
  session.requestStop("stopped_by_user", "end first");
  await entered.promise;
  const second = await session.startSession("manual");
  release.resolve();
  await ended.promise;

  assert.equal(second.started, false, "a second session started while the first was tearing down");
});

test("a capture parsed after its session ended is still queued under that session", async () => {
  await reset();
  await session.startSession("manual");
  const tabId = session.sessionTabId();
  const sessionId = (await chrome.storage.session.get("activeSession")).activeSession.id;

  // Hold the capture at its first storage read, end the session, then let it go.
  const entered = deferred();
  const gate = deferred();
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async (key) => {
    if (key === "config") {
      chrome.storage.local.get = get;
      entered.resolve();
      await gate.promise;
    }
    return get(key);
  };
  const reply = deferred();
  messages.fire(
    { type: "capture", operation: "HomeTimeline", url: "https://x.com/i/api/graphql/q/HomeTimeline", body: JSON.stringify(homeResponse()), pageLoadId: "load-1", account: "owner" },
    { id: chrome.runtime.id, url: "https://x.com/home", tab: { id: tabId } },
    reply.resolve,
  );
  await entered.promise;
  session.requestStop("stopped_by_user", "teardown before the capture is parsed");
  await ended.promise;
  gate.resolve();

  const answer = await reply.promise;
  assert.equal(answer.error, undefined, answer.error);
  const outbox = fake.local.get("outbox") ?? [];
  assert.ok(outbox.length > 0, "capture queued");
  assert.ok(outbox.every((entry) => entry.session_id === sessionId && entry.mode === "active"));
});

// Found in review at 1c7ec61.

test("a capture whose URL is not an https X URL is ignored, whatever its path says", async () => {
  await reset();
  // The "?" ends the data: URL's path right after the operation name.
  const answer = await fromTab(500, capture('data:application/json,{"x":"/graphql/q/HomeTimeline?"}'));
  assert.equal(answer.ignored, true);
  assert.equal((fake.local.get("outbox") ?? []).length, 0);
});

test("a capture from one session is not counted in the next session", async () => {
  await reset();
  await session.startSession("manual");
  const tabA = session.sessionTabId();
  const entered = deferred();
  const gate = deferred();
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async (key) => {
    if (key === "config") {
      chrome.storage.local.get = get;
      entered.resolve();
      await gate.promise;
    }
    return get(key);
  };
  const reply = fromTab(tabA, capture());
  await entered.promise;
  session.requestStop("stopped_by_user", "end A");
  await ended.promise;
  await untilIdle();

  ended = deferred();
  const b = await session.startSession("manual");
  assert.equal(b.started, true);
  gate.resolve();
  await reply;
  const report = await ended.promise;
  assert.equal(report.id, b.id);
  assert.equal(report.posts, 0, "B counted a post captured by A");
});

test("a stop pressed while a restart is recovered does not overwrite the recovered record", async () => {
  await reset();
  await chrome.storage.session.set({
    activeSession: { id: "old", windowId: 7, account: "owner", stop: { reason: "challenge", detail: "CAPTCHA" }, completed: false },
  });
  // Hold recovery while it closes the old window.
  const closing = deferred();
  const release = deferred();
  const remove = chrome.windows.remove;
  chrome.windows.remove = async (id) => {
    chrome.windows.remove = remove;
    closing.resolve();
    await release.promise;
    return remove(id);
  };
  const recovering = session.recoverInterruptedSession();
  await closing.promise;
  const starting = session.startSession("manual");
  session.requestStop("stopped_by_user", "pressed during recovery");
  await new Promise((resolve) => realSetTimeout(resolve, 20));
  const record = (await chrome.storage.session.get("activeSession")).activeSession;
  release.resolve();
  await recovering;
  await starting;

  assert.equal(record.id, "old");
  assert.equal(record.stop.reason, "challenge");
  assert.ok(log.includes("status:old:challenge"), log.join(" "));
});

test("a GraphQL 429 that arrives while a finished session closes is still reported as rate_limited", async () => {
  await reset();
  const started = await session.startSession("manual");
  const tabId = session.sessionTabId();
  // Hold teardown as it closes the window, then deliver a 429 from the tab.
  const closing = deferred();
  const release = deferred();
  const remove = chrome.windows.remove;
  chrome.windows.remove = async (id) => {
    chrome.windows.remove = remove;
    closing.resolve();
    await release.promise;
    return remove(id);
  };
  await closing.promise;
  await fromTab(tabId, { type: "x-status", operation: "HomeTimeline", status: 429 });
  release.resolve();
  const report = await ended.promise;

  assert.equal(report.id, started.id);
  assert.equal(report.status, "rate_limited");
  assert.ok(Date.parse(fake.local.get("pauseUntil")) > Date.now());
});

// Found in review at 58bd508.

test("turning capture Off stops a running session and rejects its captures", async () => {
  await reset();
  const started = await session.startSession("manual");
  const tabId = session.sessionTabId();
  const off = { ...CONFIG, mode: "off" };
  await chrome.storage.local.set({ config: off });
  chrome.storage.onChanged.fire({ config: { oldValue: CONFIG, newValue: off } }, "local");

  const reply = await fromTab(tabId, capture());
  const report = await ended.promise;
  await untilIdle();
  assert.equal(reply.ignored, true);
  assert.equal((fake.local.get("outbox") ?? []).length, 0);
  assert.equal(report.id, started.id);
  assert.equal(report.reason, "capture_off");
});

test("a 429 after Sam pressed Stop is reported as rate_limited and recorded at once", async () => {
  await reset();
  await session.startSession("manual");
  const tabId = session.sessionTabId();
  session.requestStop("stopped_by_user", "Sam pressed Stop");
  await fromTab(tabId, { type: "x-status", operation: "HomeTimeline", status: 429 });
  const recorded = structuredClone(fake.session.get("activeSession"));
  const report = await ended.promise;
  await untilIdle();
  assert.equal(recorded.stop.reason, "rate_limited");
  assert.equal(report.status, "rate_limited");
  assert.ok(Date.parse(fake.local.get("pauseUntil")) > Date.now());
});

test("a 429 during teardown survives a service worker restart before teardown ends", async () => {
  await reset();
  await session.startSession("manual");
  const tabId = session.sessionTabId();
  const closing = deferred();
  const release = deferred();
  const remove = chrome.windows.remove;
  chrome.windows.remove = async (id) => {
    chrome.windows.remove = remove;
    closing.resolve();
    await release.promise;
    return remove(id);
  };
  await closing.promise;
  await fromTab(tabId, { type: "x-status", operation: "HomeTimeline", status: 429 });
  await new Promise((resolve) => realSetTimeout(resolve, 5));

  // A fresh copy of the module stands in for the restarted worker.
  const restarted = await import(`../app/lib/session.js?restart-${Date.now()}`);
  await restarted.recoverInterruptedSession();
  const recovered = structuredClone(fake.local.get("lastSession"));
  release.resolve();
  await untilIdle();
  assert.equal(recovered.status, "rate_limited");
});
