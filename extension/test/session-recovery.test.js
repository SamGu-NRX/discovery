// What a restarted service worker reports for a session it finds half done.
// A recorded stop (login wall, challenge, rate limit) must survive the
// restart, and a session with no record of how it ended is not "ok".

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { installFakeChrome, startWorker } from "./fake-chrome.js";

const fake = installFakeChrome();
const { recoverInterruptedSession } = await import("../app/lib/session.js");

const worker = await startWorker();
after(() => worker.close());

beforeEach(async () => {
  fake.local.clear();
  fake.session.clear();
  worker.requests.length = 0;
  await chrome.storage.local.set({ config: { workerUrl: worker.url, ingestToken: "t", mode: "active" }, lastAccount: "sam" });
});

async function recover(activeSession) {
  await chrome.storage.session.set({ activeSession: { id: "s-1", windowId: 7, account: "sam", phase: "home", screens: 3, posts: 20, ...activeSession } });
  await recoverInterruptedSession();
  const status = worker.requests.find((r) => r.path === "/ingest/x/status")?.body;
  const { pauseUntil, lastSession } = await chrome.storage.local.get(["pauseUntil", "lastSession"]);
  return { status, paused: Boolean(pauseUntil && Date.parse(pauseUntil) > Date.now()), lastSession };
}

test("a login wall recorded before the restart is reported as login_wall and pauses sessions", async () => {
  const { status, paused, lastSession } = await recover({ stop: { reason: "login_wall", detail: "path /i/flow/login" }, completed: false });
  assert.equal(status.status, "login_wall");
  assert.equal(status.session_id, "s-1");
  assert.equal(paused, true);
  assert.equal(lastSession.status, "login_wall");
  assert.deepEqual(fake.removedWindows, [7]);
});

test("a session with no recorded ending is reported as interrupted with status error", async () => {
  const { status, paused } = await recover({ stop: null, completed: false });
  assert.equal(status.status, "error");
  assert.match(status.detail, /^interrupted/);
  assert.equal(paused, true);
});

test("a session that reached its completion checkpoint is reported ok", async () => {
  const { status, paused } = await recover({ stop: null, completed: true });
  assert.equal(status.status, "ok");
  assert.equal(paused, false);
});
