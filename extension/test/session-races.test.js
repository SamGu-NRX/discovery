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
// A session's keep-alive interval must not hold the process open after a
// crash test abandons that session.
const realSetInterval = setInterval;
globalThis.setInterval = (...args) => {
  const timer = realSetInterval(...args);
  timer.unref?.();
  return timer;
};

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
// Status reports fail with 503 while this is set.
let statusDown = false;
// The answer to POST /x/sessions/start: a status and body, or "network" to
// fail; a list is answered in order, its last entry repeating.
let reservation = { status: 200, body: {} };
const reservedIds = [];
// The body POST /ingest/x/status answers with.
let statusAnswer = {};
const ingests = [];
const statusBodies = [];
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname;
  if (path === "/ingest/x/status") statusBodies.push(JSON.parse(init.body));
  if (path === "/x/sessions/start") {
    log.push("reserve");
    reservedIds.push(JSON.parse(init.body).session_id);
    const answer = Array.isArray(reservation) ? (reservation.length > 1 ? reservation.shift() : reservation[0]) : reservation;
    if (answer === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }
  if (path === "/ingest/x/status") {
    const body = JSON.parse(init.body);
    log.push(`status:${body.session_id}:${body.status}`);
    if (statusDown) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(statusAnswer));
  }
  if (path === "/ingest/x") ingests.push(JSON.parse(init.body));
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
  fake.local.delete("backOffReportedUntil");
  fake.local.delete("pendingBackOff");
  fake.local.delete("outbox");
  fake.session.clear();
  log.length = 0;
  ingests.length = 0;
  statusDown = false;
  reservation = { status: 200, body: {} };
  reservedIds.length = 0;
  statusAnswer = {};
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

// Found in a correctness review of dd9581d.

// Holds the next call of obj[name] whose arguments satisfy `when` until
// released; later calls run normally.
function hold(obj, name, when = () => true) {
  const entered = deferred();
  const gate = deferred();
  const original = obj[name];
  obj[name] = async (...args) => {
    if (!when(...args)) return original.apply(obj, args);
    obj[name] = original;
    entered.resolve();
    await gate.promise;
    return original.apply(obj, args);
  };
  return { entered: entered.promise, release: gate.resolve };
}

const switchOff = async () => {
  const off = { ...CONFIG, mode: "off" };
  await chrome.storage.local.set({ config: off });
  chrome.storage.onChanged.fire({ config: { oldValue: CONFIG, newValue: off } }, "local");
};

for (const [status, expected] of [[429, "rate_limited"], [401, "login_wall"]]) {
  test(`a ${status} from the session tab while teardown sends its last captures is reported as ${expected}, and recorded`, async () => {
    await reset();
    await session.startSession("manual");
    const tabId = session.sessionTabId();
    const flushing = hold(chrome.storage.local, "get", (key) => key === "outbox");
    session.requestStop("stopped_by_user", "Sam pressed Stop");
    await flushing.entered;
    await fromTab(tabId, { type: "x-status", operation: "HomeTimeline", status });
    const recorded = structuredClone(fake.session.get("activeSession"));
    flushing.release();
    const report = await ended.promise;
    await untilIdle();
    assert.equal(recorded.outcome.reason, expected);
    assert.equal(report.status, expected);
  });
}

test("a 429 while the session window is still opening stops that session as rate_limited", async () => {
  await reset();
  const opening = hold(chrome.windows, "create");
  await session.startSession("manual");
  await opening.entered;
  await fromTab(500, { type: "x-status", operation: "HomeTimeline", status: 429 });
  opening.release();
  const report = await ended.promise;
  await untilIdle();
  assert.equal(report.status, "rate_limited");
});

test("a 429 while restart recovery closes the old window is part of the recovered report", async () => {
  await reset();
  await chrome.storage.session.set({
    activeSession: { id: "old", windowId: 7, account: "owner", stop: { reason: "stopped_by_user", detail: "Stop" }, completed: false },
  });
  const closing = hold(chrome.windows, "remove");
  const recovering = session.recoverInterruptedSession();
  await closing.entered;
  await fromTab(101, { type: "x-status", operation: "HomeTimeline", status: 429 });
  closing.release();
  await recovering;
  assert.ok(log.includes("status:old:rate_limited"), log.join(" "));
});

test("a capture still being parsed when capture turns Off is not queued or sent", async () => {
  await reset();
  await session.startSession("manual");
  const tabId = session.sessionTabId();
  const parsing = hold(chrome.storage.session, "get", (key) => key === "pages");
  const reply = fromTab(tabId, capture());
  await parsing.entered;
  await switchOff();
  await ended.promise;
  await untilIdle();
  parsing.release();
  assert.equal((await reply).ignored, true);
  const { flush } = await import("../app/lib/outbox.js");
  await flush();
  assert.equal((fake.local.get("outbox") ?? []).length, 0);
  assert.equal(ingests.length, 0);
});

test("Off while a session is starting stops it before any window opens", async () => {
  await reset();
  const recording = hold(chrome.storage.session, "set", (values) => values.activeSession?.windowId === null);
  const starting = session.startSession("manual");
  await recording.entered;
  await switchOff();
  recording.release();
  await starting;
  const report = await ended.promise;
  await untilIdle();
  assert.ok(!log.some((entry) => entry.startsWith("open:")), log.join(" "));
  assert.equal(report.reason, "capture_off");
});

test("an old session whose report failed is kept, retried, and blocks new sessions until reported", async () => {
  await reset();
  await chrome.storage.session.set({
    activeSession: {
      id: "old",
      windowId: 7,
      account: "owner",
      stop: { reason: "stopped_by_user", detail: "Stop" },
      completed: false,
      final: true,
      outcome: { reason: "stopped_by_user", detail: "Stop" },
    },
  });
  statusDown = true;
  await session.recoverInterruptedSession();
  assert.equal(fake.session.get("activeSession")?.id, "old", "record kept after a failed report");
  const refused = await session.startSession("manual");
  assert.equal(refused.started, false);
  assert.ok(!log.some((entry) => entry.startsWith("open:")));

  statusDown = false;
  log.length = 0;
  const started = await session.startSession("manual");
  assert.equal(started.started, true);
  assert.equal(log[0], "status:old:ok", log.join(" "));
  session.requestStop("stopped_by_user", "cleanup");
  await ended.promise;
  await untilIdle();
});

test("closing the session window while a tab call is pending reports ok, not error", async () => {
  await reset();
  const reading = deferred();
  const gate = deferred();
  const get = chrome.tabs.get;
  chrome.tabs.get = async () => {
    chrome.tabs.get = get;
    reading.resolve();
    await gate.promise;
    throw new Error("No tab with id: 101");
  };
  await session.startSession("manual");
  await reading.promise;
  removed.fire(fake.session.get("activeSession").windowId);
  gate.resolve();
  const report = await ended.promise;
  await untilIdle();
  assert.equal(report.status, "ok");
  assert.equal(report.reason, "window_closed");
  assert.equal(fake.local.get("pauseUntil"), undefined);
});

test("a Following timeline captured after home first loaded is still noted in the status", async () => {
  await reset();
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (options) => {
    if (options.args?.[0]?.name === "scroll") {
      session.noteSessionCapture(session.sessionInfo().id, { operation: "HomeLatestTimeline", postIds: ["101"] });
    }
    return execute(options);
  };
  try {
    await session.startSession("manual");
    const report = await ended.promise;
    await untilIdle();
    assert.match(report.detail, /home opened on Following/);
  } finally {
    chrome.scripting.executeScript = execute;
  }
});

// Crash injection, found in review at 376c50c. A worker is "killed" by
// abandoning a copy of session.js mid-flight (it never resumes) and
// "restarted" by importing a fresh copy, which shares only stored state.
let copies = 0;
const workerCopy = () => import(`../app/lib/session.js?worker-${++copies}`);

test("a login wall whose status report failed is still reported after the worker is killed and restarted", async () => {
  await reset();
  const doomed = await workerCopy();
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (options) =>
    options.args?.[0]?.name === "inspect"
      ? [{ result: { ok: { account: "owner", blocker: "login_wall", evidence: "login form", path: "/home" } } }]
      : execute(options);
  statusDown = true;
  try {
    await doomed.startSession("manual");
    const first = await ended.promise;
    while (doomed.sessionInfo() !== null) await new Promise((resolve) => realSetTimeout(resolve, 1));
    assert.equal(first.reported, false);
  } finally {
    chrome.scripting.executeScript = execute;
  }

  // Killed here; the restarted worker can reach the Worker again.
  statusDown = false;
  log.length = 0;
  const restarted = await workerCopy();
  await restarted.recoverInterruptedSession();
  assert.ok(log.some((entry) => /^status:.+:login_wall$/.test(entry)), log.join(" "));
  assert.equal(fake.session.get("activeSession"), undefined);
});

test("a 429 that arrived while recovery closed the old window is reported after the worker is killed mid-recovery", async () => {
  await reset();
  await chrome.storage.session.set({
    activeSession: { id: "old", windowId: 7, account: "owner", stop: { reason: "stopped_by_user", detail: "Stop" }, completed: false },
  });
  const doomed = await workerCopy();
  const closing = hold(chrome.windows, "remove");
  doomed.recoverInterruptedSession(); // never resumes: the worker is killed below
  await closing.entered;
  assert.equal(doomed.requestStop("rate_limited", "HomeTimeline answered HTTP 429"), true);
  await new Promise((resolve) => realSetTimeout(resolve, 1));

  // Killed while recovery is still closing the window.
  log.length = 0;
  const restarted = await workerCopy();
  await restarted.recoverInterruptedSession();
  assert.ok(log.includes("status:old:rate_limited"), log.join(" "));
});

test("a 429 from another X tab during a session is reported once, on the session", async () => {
  await reset();
  const started = await session.startSession("manual");
  await fromTab(500, { type: "x-status", operation: "HomeTimeline", status: 429 });
  const report = await ended.promise;
  await untilIdle();
  assert.equal(report.status, "rate_limited");
  assert.deepEqual(log.filter((entry) => entry.startsWith("status:")), [`status:${started.id}:rate_limited`]);
  assert.ok(Date.parse(fake.local.get("pauseUntil")) > Date.now());
});

// Crash windows found in review at 2511cbb.

// From the moment `trigger()` is called, storage writes hang forever, as if
// the worker stopped with them in flight; `afterWrites` writes still land
// first. `stuck` resolves when the first write hangs. `restart()` gives later
// code working storage.
function killer() {
  const areas = [chrome.storage.local, chrome.storage.session];
  const originals = areas.map((area) => ({ set: area.set, remove: area.remove }));
  const stuck = deferred();
  let allowed = Infinity;
  const gate = (original, area) =>
    function (values) {
      if (allowed <= 0) {
        stuck.resolve();
        return new Promise(() => {});
      }
      allowed -= 1;
      return original.call(area, values);
    };
  return {
    stuck: stuck.promise,
    trigger(afterWrites = 0) {
      allowed = afterWrites;
      areas.forEach((area, i) => {
        area.set = gate(originals[i].set, area);
        area.remove = gate(originals[i].remove, area);
      });
    },
    restart() {
      areas.forEach((area, i) => Object.assign(area, originals[i]));
    },
  };
}

const statuses = (id) => log.filter((entry) => entry.startsWith(`status:${id}:`));

test("a 429 while a new start waits for recovery is reported on the recovered session", async () => {
  await reset();
  await chrome.storage.session.set({
    activeSession: { id: "old", windowId: 7, account: "owner", stop: { reason: "stopped_by_user", detail: "Stop" }, completed: false },
  });
  const closing = hold(chrome.windows, "remove");
  const recovering = session.recoverInterruptedSession();
  await closing.entered;
  const starting = session.startSession("manual");
  await fromTab(500, { type: "x-status", operation: "HomeTimeline", status: 429 });
  closing.release();
  await recovering;
  const started = await starting;
  assert.deepEqual(statuses("old"), ["status:old:rate_limited"]);
  assert.equal(started.started, false);
  assert.ok(Date.parse(fake.local.get("pauseUntil")) > Date.now());
});

test("a 429 while a session is still starting pauses sessions and is reported", async () => {
  await reset();
  const reading = hold(chrome.storage.local, "get", (key) => key === "config");
  const starting = session.startSession("manual");
  await reading.entered;
  await fromTab(500, { type: "x-status", operation: "HomeTimeline", status: 429 });
  reading.release();
  const started = await starting;
  assert.equal(started.started, false);
  assert.ok(Date.parse(fake.local.get("pauseUntil")) > Date.now());
  assert.ok(log.some((entry) => /^status:.+:rate_limited$/.test(entry)), log.join(" "));
});

test("a worker killed before a late 429's write lands never recovers the session as ok", async () => {
  await reset();
  const doomed = await workerCopy();
  await doomed.startSession("manual");
  const closing = hold(chrome.windows, "remove");
  await closing.entered;
  const kill = killer();
  kill.trigger(0);
  doomed.requestStop("rate_limited", "HomeTimeline answered HTTP 429");
  kill.restart();

  const restarted = await workerCopy();
  await restarted.recoverInterruptedSession();
  const reported = log.filter((entry) => entry.startsWith("status:"));
  assert.equal(reported.length, 1, reported.join(" "));
  assert.doesNotMatch(reported[0], /:ok$/);
  assert.ok(Date.parse(fake.local.get("pauseUntil")) > Date.now());
});

test("a worker killed before a recovery-time 429's write lands never recovers the old session as ok", async () => {
  await reset();
  await chrome.storage.session.set({
    activeSession: { id: "old", windowId: 7, account: "owner", stop: { reason: "stopped_by_user", detail: "Stop" }, completed: false },
  });
  const doomed = await workerCopy();
  const closing = hold(chrome.windows, "remove");
  doomed.recoverInterruptedSession();
  await closing.entered;
  const kill = killer();
  kill.trigger(0);
  doomed.requestStop("rate_limited", "HomeTimeline answered HTTP 429");
  kill.restart();

  const restarted = await workerCopy();
  await restarted.recoverInterruptedSession();
  assert.equal(statuses("old").length, 1, log.join(" "));
  assert.doesNotMatch(statuses("old")[0], /:ok$/);
});

test("a challenge the page showed is on record before any other write, so a kill right after reports it", async () => {
  await reset();
  const doomed = await workerCopy();
  const kill = killer();
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (options) => {
    if (options.args?.[0]?.name !== "inspect") return execute(options);
    chrome.scripting.executeScript = execute;
    doomed.requestStop("stopped_by_user", "Sam pressed Stop");
    // The worker stops after recording the challenge and its pause. (Not
    // inside the pause write: the copies share store.js, so a write killed
    // there would hold its lock for every later test, which a real restart
    // would not.)
    kill.trigger(2);
    return [{ result: { ok: { account: "someone_new", blocker: "challenge", evidence: "CAPTCHA", path: "/home" } } }];
  };
  doomed.startSession("manual");
  await kill.stuck;
  kill.restart();

  const restarted = await workerCopy();
  await restarted.recoverInterruptedSession();
  assert.ok(log.some((entry) => /^status:.+:challenge$/.test(entry)), log.join(" "));
});

test("two simultaneous 429s while Sam browses are reported once", async () => {
  await reset();
  await Promise.all([
    fromTab(500, { type: "x-status", operation: "HomeTimeline", status: 429 }),
    fromTab(501, { type: "x-status", operation: "HomeTimeline", status: 429 }),
  ]);
  assert.equal(log.filter((entry) => entry.startsWith("status:")).length, 1, log.join(" "));
});

test("a passive back-off report and its pause are stored together before the report is sent", async () => {
  await reset();
  fake.local.delete("pendingBackOff");
  statusDown = true;
  await fromTab(500, { type: "x-status", operation: "HomeTimeline", status: 429 });
  // The report failed; it waits in storage beside the pause for the next try.
  assert.ok(Date.parse(fake.local.get("pauseUntil")) > Date.now());
  assert.equal(fake.local.get("pendingBackOff")?.status, "rate_limited");
  statusDown = false;
  fake.local.delete("pendingBackOff");
});

test("a capture past the outbox's mode check when Off is chosen is dropped", async () => {
  await reset();
  const reading = hold(chrome.storage.local, "get", (key) => key === "outbox");
  const reply = fromTab(500, capture());
  await reading.entered;
  await switchOff();
  reading.release();
  await reply;
  const { flush } = await import("../app/lib/outbox.js");
  await flush();
  assert.equal((fake.local.get("outbox") ?? []).length, 0);
  assert.equal(ingests.length, 0);
});

test("a session window is recorded before X loads in it", async () => {
  await reset();
  const doomed = await workerCopy();
  const kill = killer();
  const create = chrome.windows.create;
  let createdUrl = null;
  chrome.windows.create = async (options) => {
    chrome.windows.create = create;
    createdUrl = options.url;
    const win = await create(options);
    kill.trigger(0);
    return win;
  };
  doomed.startSession("manual");
  await kill.stuck;
  kill.restart();
  assert.equal(createdUrl, "about:blank");
  assert.equal(tab.url, "about:blank", "X never loaded in a window no record points to");
});

test("a status the Worker accepted is not sent again after a kill at the next write", async () => {
  await reset();
  const doomed = await workerCopy();
  const kill = killer();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await original(url, init);
    if (new URL(url).pathname === "/ingest/x/status") {
      globalThis.fetch = original;
      kill.trigger(1);
    }
    return response;
  };
  const started = await doomed.startSession("manual");
  await kill.stuck;
  kill.restart();
  globalThis.fetch = original;

  const restarted = await workerCopy();
  await restarted.recoverInterruptedSession();
  assert.deepEqual(statuses(started.id), [`status:${started.id}:ok`]);
});

test("a recovery whose report failed marks the record as waiting, not running", async () => {
  await reset();
  await chrome.storage.session.set({
    activeSession: { id: "old", windowId: 7, account: "owner", stop: { reason: "stopped_by_user", detail: "Stop" }, completed: false },
  });
  statusDown = true;
  await session.recoverInterruptedSession();
  statusDown = false;
  assert.equal(fake.session.get("activeSession").awaitingReport, true);
  fake.session.clear();
});

test("a recovered status the Worker accepted is not sent again after a kill at the next write", async () => {
  await reset();
  await chrome.storage.session.set({
    activeSession: { id: "old", windowId: 7, account: "owner", stop: { reason: "challenge", detail: "CAPTCHA" }, completed: false },
  });
  const doomed = await workerCopy();
  const kill = killer();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await original(url, init);
    if (new URL(url).pathname === "/ingest/x/status") {
      globalThis.fetch = original;
      kill.trigger(1);
    }
    return response;
  };
  doomed.recoverInterruptedSession();
  await kill.stuck;
  kill.restart();
  globalThis.fetch = original;

  const restarted = await workerCopy();
  await restarted.recoverInterruptedSession();
  assert.deepEqual(statuses("old"), ["status:old:challenge"]);
});

// Found in an install-readiness review of faf97e1.

test("a 429 a running session takes is a stored pause before the handler returns, so a browser restart starts no session", async () => {
  await reset();
  const opening = hold(chrome.windows, "create");
  await session.startSession("alarm");
  await opening.entered;
  session.requestStop("stopped_by_user", "Sam pressed Stop");
  await fromTab(500, { type: "x-status", operation: "HomeTimeline", status: 429 });
  assert.ok(Date.parse(fake.local.get("pauseUntil")) > Date.now(), "pause stored when the handler returned");

  // A browser restart clears session storage; local storage stays.
  const sessionRecord = fake.session.get("activeSession");
  fake.session.clear();
  const restarted = await workerCopy();
  const result = await restarted.startSession("alarm");
  assert.equal(result.started, false);

  fake.session.set("activeSession", sessionRecord);
  opening.release();
  await ended.promise;
  await untilIdle();
});

test("X error 88 pauses sessions even when the parser rejects the rest of the response", async () => {
  await reset();
  const body = homeResponse();
  body.errors = [{ code: 88, message: "Rate limit exceeded" }];
  body.data.home.home_timeline_urt.instructions = [
    { type: "TimelineAddEntries", entries: [{ entryId: "unknown", content: { entryType: "NewXEntryType" } }] },
  ];
  const answer = await fromTab(500, { ...capture(), body: JSON.stringify(body) });
  assert.equal(answer.ignored, true);
  assert.match(fake.local.get("lastProblem").message, /unknown entryType/);
  assert.ok(Date.parse(fake.local.get("pauseUntil")) > Date.now());
});

for (const [name, answer, reasonPattern] of [
  ["a 423 with pause_until", { status: 423, body: { pause_until: "2099-01-01T00:00:00.000Z" } }, /holding sessions/],
  ["a 404 (no guard deployed yet)", { status: 404, body: {} }, /does not take session reservations/],
  ["a network failure", "network", /could not be reached/],
]) {
  test(`a session the Worker does not reserve, on ${name}, opens no window and reports nothing`, async () => {
    await reset();
    reservation = answer;
    const result = await session.startSession("alarm");
    assert.equal(result.started, false);
    assert.match(result.reason, reasonPattern);
    // A lost answer is retried once; nothing else happens.
    assert.deepEqual(log, answer === "network" ? ["reserve", "reserve"] : ["reserve"]);
    assert.equal(session.sessionInfo(), null);
    assert.equal(fake.session.get("activeSession"), undefined);
    if (answer.body?.pause_until) assert.equal(fake.local.get("pauseUntil"), answer.body.pause_until);
  });
}

// Live endpoint behavior (Worker 16ffe7c2).

test("a reservation whose answer was lost is retried once under the same session id", async () => {
  await reset();
  reservation = ["network", { status: 200, body: {} }];
  const started = await session.startSession("manual");
  assert.equal(started.started, true);
  assert.deepEqual(reservedIds, [started.id, started.id]);
  session.requestStop("stopped_by_user", "cleanup");
  await ended.promise;
  await untilIdle();
});

test("the pause_until the Worker returns for a status is stored", async () => {
  await reset();
  statusAnswer = { status: "ok", pause_until: "2099-01-01T00:00:00.000Z" };
  await session.startSession("manual");
  await ended.promise;
  await untilIdle();
  assert.equal(fake.local.get("pauseUntil"), "2099-01-01T00:00:00.000Z");
});

// Found in an install-readiness review of 40dd650.

test("a GraphQL 401 in one of Sam's own X tabs pauses sessions", async () => {
  await reset();
  await fromTab(500, { type: "x-status", operation: "HomeTimeline", status: 401 });
  assert.ok(Date.parse(fake.local.get("pauseUntil")) > Date.now());
  const started = await session.startSession("alarm");
  assert.equal(started.started, false);
});

test("a session reports under the account it reserved, and stops if X shows another account", async () => {
  await reset();
  await chrome.storage.local.set({ lastAccount: "alice" });
  statusBodies.length = 0;
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (options) =>
    options.args?.[0]?.name === "inspect"
      ? [{ result: { ok: { account: "bob", blocker: null, errorPage: false, path: new URL(tab.url).pathname } } }]
      : execute(options);
  try {
    const started = await session.startSession("manual");
    assert.deepEqual(reservedIds, [started.id]);
    const report = await ended.promise;
    await untilIdle();
    assert.match(report.detail, /logged in as @bob, but this session was reserved for @alice/);
    assert.deepEqual(statusBodies.map((b) => b.account), ["alice"]);
  } finally {
    chrome.scripting.executeScript = execute;
    await chrome.storage.local.set({ lastAccount: "owner" });
  }
});
