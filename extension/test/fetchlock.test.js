// Sessions and fetch runs share one account and never overlap. Both are
// admitted in the service worker (app/lib/fetchlock.js, startSession in
// app/lib/session.js), so these run the real modules against fake storage.

import assert from "node:assert/strict";
import { test } from "node:test";

import { installFakeChrome } from "./fake-chrome.js";

installFakeChrome();
const { acquireFetchRun, beatFetchRun, fetchRunHeld, releaseFetchRun } = await import("../app/lib/fetchlock.js");
const { startSession } = await import("../app/lib/session.js");

test("a held fetch run refuses sessions at once, a second run, and stops holding when its page stops beating", async () => {
  assert.equal(await acquireFetchRun("run-a", false), null);
  // Refused before startSession awaits anything, so it cannot race the run.
  const pending = startSession("manual");
  assert.deepEqual(await pending, { started: false, reason: "A fetch run is going." });
  assert.equal(await acquireFetchRun("run-b", false), "Another fetch run is going.");
  assert.equal(await beatFetchRun("run-b"), false, "only the owner beats");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 121_000;
    assert.equal(fetchRunHeld(), false, "a page that stopped beating for 2 minutes holds nothing");
    assert.equal(await acquireFetchRun("run-b", false), null);
  } finally {
    Date.now = realNow;
  }
  await releaseFetchRun("run-a");
  assert.equal(fetchRunHeld(), true, "releasing someone else's run changes nothing");
  await releaseFetchRun("run-b");
  assert.equal(fetchRunHeld(), false);
  assert.deepEqual(await chrome.storage.session.get("fetchRun"), {});
});

test("a fetch run is refused while a session is starting or has not reported", async () => {
  assert.equal(await acquireFetchRun("run-c", true), "A session is running or starting.");
  await chrome.storage.session.set({ activeSession: { id: "s1", statusSent: false } });
  assert.equal(await acquireFetchRun("run-c", false), "A session is running or not yet reported.");
  assert.equal(fetchRunHeld(), false, "a refused claim is let go");
  await chrome.storage.session.remove("activeSession");
});
