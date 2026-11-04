// Active sessions: a short read-only visit to x.com in an unfocused window,
// scrolling at a human pace. A session can do three things to X: open a URL
// minted by xurl.js, scroll, and click one of the two tabs page-agent.js
// allows. Everything it learns arrives through the same capture path as
// passive browsing.

import { flush } from "./outbox.js";
import { scheduleNext } from "./schedule.js";
import { getLocal, getPauseUntil, loadConfig, recordProblem, setLocal } from "./store.js";
import { getDetailQueue, postStatus } from "./worker-api.js";
import { bookmarksUrl, homeUrl, isMintedXUrl, isXPage, permalinkUrl } from "./xurl.js";

const PAUSE_MS = 24 * 3600_000;
const LOAD_TIMEOUT_MS = 30_000;
// Stop reasons that are X telling the account to back off. Each pauses
// sessions for 24 hours and is reported as that status. Every other ending
// (finished, stopped by Sam, window closed, extension restarted) is "ok".
const BLOCKING = new Set(["login_wall", "rate_limited", "challenge", "error"]);

let current = null;

class StopSession extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

const random = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function sessionTabId() {
  return current?.tabId ?? null;
}

export function sessionInfo() {
  return current ? { id: current.id, account: current.account } : null;
}

export function requestStop(reason, detail) {
  if (current && !current.stop) current.stop = { reason, detail };
}

// Called for every capture from the session tab.
export function noteSessionCapture({ operation, postIds }) {
  if (!current) return;
  current.posts += postIds.length;
  if (operation === "Bookmarks" && postIds.some((id) => current.knownBookmarks.has(id))) {
    current.reachedKnownBookmark = true;
  }
}

export async function startSession(trigger) {
  if (current) return { started: false, reason: "A session is already running." };
  const config = await loadConfig();
  if (!config.workerUrl || !config.ingestToken) return { started: false, reason: "Add the Worker URL and token first." };
  if (config.mode === "off") return { started: false, reason: "Capture is off." };
  if (trigger === "alarm" && config.mode !== "active") return { started: false, reason: "Sessions are off." };
  const pause = await getPauseUntil();
  if (pause) return { started: false, reason: `Paused until ${new Date(pause).toLocaleString()}.` };

  current = {
    id: crypto.randomUUID(),
    trigger,
    startedAt: new Date().toISOString(),
    config,
    windowId: null,
    tabId: null,
    phase: "home",
    screens: 0,
    posts: 0,
    stop: null,
    notes: [],
    errorPages: 0,
    account: null,
    knownBookmarks: new Set(await getLocal("sentBookmarkIds", [])),
    reachedKnownBookmark: false,
  };
  await publish();
  run(current);
  return { started: true, id: current.id };
}

async function run(s) {
  // A service worker idles out after 30 s without extension events; page
  // loads can be quiet that long.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  const onRemoved = (windowId) => {
    if (windowId !== s.windowId) return;
    s.windowClosed = true;
    requestStop("window_closed", "the session window was closed");
  };
  chrome.windows.onRemoved.addListener(onRemoved);

  let outcome = { reason: "completed", detail: "finished" };
  try {
    await openWindow(s);
    await visitHome(s);
    await visitBookmarks(s);
    await visitPermalinks(s);
  } catch (err) {
    outcome = err instanceof StopSession ? { reason: err.reason, detail: err.detail } : { reason: "error", detail: err.message };
  }
  // An exception caused by the stop (a closed window, say) is not the reason.
  if (s.stop) outcome = s.stop;

  clearInterval(keepAlive);
  chrome.windows.onRemoved.removeListener(onRemoved);
  try {
    await finish(s, outcome);
  } finally {
    current = null;
    await chrome.storage.session.remove("activeSession");
  }
  await scheduleNext();
}

async function finish(s, outcome) {
  if (!s.windowClosed && s.windowId !== null) {
    // Let captures already in flight from the closing page reach the worker.
    await sleep(1000);
    await chrome.windows.remove(s.windowId).catch(() => {});
  }
  const status = BLOCKING.has(outcome.reason) ? outcome.reason : "ok";
  const detail = [
    `${outcome.reason}: ${outcome.detail}`,
    `screens=${s.screens} posts=${s.posts}`,
    ...s.notes,
  ].join("; ").slice(0, 1000);

  if (status !== "ok") {
    const until = new Date(Date.now() + PAUSE_MS).toISOString();
    const existing = await getPauseUntil();
    if (!existing || Date.parse(existing) < Date.parse(until)) await setLocal({ pauseUntil: until });
  }

  await flush().catch((err) => recordProblem("worker", err.message));
  const account = s.account ?? (await getLocal("lastAccount", null)) ?? s.config.account;
  let reported = false;
  try {
    await postStatus(s.config, { account, session_id: s.id, status, detail });
    reported = true;
  } catch (err) {
    await recordProblem("worker", `session status not reported: ${err.message}`);
  }
  await setLocal({
    lastSession: {
      id: s.id,
      trigger: s.trigger,
      startedAt: s.startedAt,
      endedAt: new Date().toISOString(),
      status,
      reason: outcome.reason,
      detail,
      screens: s.screens,
      posts: s.posts,
      reported,
    },
  });
}

// Called when the service worker starts. A session record without a running
// session means the worker was stopped mid-session: close its window and
// record the interruption.
export async function recoverInterruptedSession() {
  const { activeSession } = await chrome.storage.session.get("activeSession");
  if (!activeSession || current) return;
  await chrome.storage.session.remove("activeSession");
  if (activeSession.windowId != null) await chrome.windows.remove(activeSession.windowId).catch(() => {});
  const config = await loadConfig();
  const detail = "interrupted: the extension's service worker restarted mid-session";
  const account = activeSession.account ?? (await getLocal("lastAccount", null)) ?? config.account;
  const reported = await postStatus(config, { account, session_id: activeSession.id, status: "ok", detail })
    .then(() => true, () => false);
  await setLocal({
    lastSession: { ...activeSession, endedAt: new Date().toISOString(), status: "ok", reason: "interrupted", detail, reported },
  });
}

// Progress the popup shows while a session runs; also what recovery reads.
function publish() {
  const s = current;
  if (!s) return;
  return chrome.storage.session.set({
    activeSession: {
      id: s.id,
      trigger: s.trigger,
      startedAt: s.startedAt,
      windowId: s.windowId,
      account: s.account,
      phase: s.phase,
      screens: s.screens,
      posts: s.posts,
    },
  });
}

function checkpoint(s) {
  if (s.stop) throw new StopSession(s.stop.reason, s.stop.detail);
}

async function pause(s, min, max) {
  await sleep(random(min, max));
  checkpoint(s);
}

async function openWindow(s) {
  const url = homeUrl();
  await loadAndWait(s, async () => {
    const win = await chrome.windows.create({ url: checkedHref(url), focused: false, type: "normal", width: 1200, height: 900 });
    s.windowId = win.id;
    s.tabId = win.tabs[0].id;
    await publish();
  });
}

async function navigate(s, url) {
  const href = checkedHref(url);
  await loadAndWait(s, () => chrome.tabs.update(s.tabId, { url: href }));
}

function checkedHref(url) {
  if (!isMintedXUrl(url)) throw new Error("refusing to open a URL that xurl.js did not build");
  return url.href;
}

// Waits for the navigation started by `start` to finish loading. The listener
// is attached first, so a load that completes before `start` returns still
// counts; any "complete" after it must be the new page.
async function loadAndWait(s, start) {
  const completed = new Set();
  const onUpdated = (tabId, info) => {
    if (info.status === "complete") completed.add(tabId);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    await start();
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (!completed.has(s.tabId) && Date.now() < deadline) {
      await sleep(250);
      checkpoint(s);
    }
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
  // X renders after load; give it the time a person would.
  await pause(s, 2500, 4000);
}

async function agent(s, name, arg) {
  checkpoint(s);
  const tab = await chrome.tabs.get(s.tabId);
  if (!isXPage(tab.url ?? "")) throw new StopSession("error", `the session tab left x.com (${tab.url ?? "unknown url"})`);
  const target = { tabId: s.tabId };
  await chrome.scripting.executeScript({ target, files: ["content/page-agent.js"] });
  const [injection] = await chrome.scripting.executeScript({
    target,
    func: (command) => {
      try {
        return { ok: globalThis.__dxAgent.run(command) };
      } catch (err) {
        return { error: String(err?.message ?? err) };
      }
    },
    args: [{ name, arg }],
  });
  const result = injection?.result;
  if (!result || result.error) throw new StopSession("error", `page agent ${name}: ${result?.error ?? "no result"}`);
  return result.ok;
}

async function inspect(s) {
  const seen = await agent(s, "inspect");
  if (seen.account && !s.account) {
    s.account = seen.account;
    await setLocal({ lastAccount: seen.account });
    await publish();
  }
  if (seen.blocker) throw new StopSession(seen.blocker, `${seen.evidence} at ${seen.path}`);
  // X's generic error page often means throttling; three in a row ends the visit.
  s.errorPages = seen.errorPage ? s.errorPages + 1 : 0;
  if (s.errorPages >= 3) throw new StopSession("error", `X kept showing "Something went wrong" at ${seen.path}`);
  return seen;
}

async function clickTab(s, target) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await agent(s, "click", target);
    if (result.found) {
      if (result.clicked) await pause(s, 1500, 2500);
      return true;
    }
    await pause(s, 900, 1300);
  }
  s.notes.push(`${target} tab not found`);
  return false;
}

async function scrollScreens(s, { screens, ms, done = () => false }) {
  const end = Date.now() + ms;
  let bottoms = 0;
  for (let i = 0; i < screens && Date.now() < end && !done(); i += 1) {
    await pause(s, 2000, 4000);
    const { atBottom } = await agent(s, "scroll", random(0.75, 0.95));
    s.screens += 1;
    await publish();
    await inspect(s);
    bottoms = atBottom ? bottoms + 1 : 0;
    if (bottoms >= 3) break;
  }
}

async function checkWorkerPause(s, account) {
  let queue;
  try {
    queue = await getDetailQueue(s.config, account);
  } catch (err) {
    s.notes.push(`detail queue unavailable: ${err.message}`);
    return null;
  }
  if (queue.pause_until && Date.parse(queue.pause_until) > Date.now()) {
    await setLocal({ pauseUntil: queue.pause_until });
    throw new StopSession("paused", `the Worker paused sessions until ${queue.pause_until}`);
  }
  return queue;
}

async function visitHome(s) {
  s.phase = "home";
  await publish();
  await inspect(s);
  const account = s.account ?? s.config.account;
  if (account) await checkWorkerPause(s, account);
  await clickTab(s, "for_you");
  await inspect(s);
  await scrollScreens(s, { screens: s.config.homeMaxScreens, ms: s.config.homeMaxMinutes * 60_000 });
}

async function visitBookmarks(s) {
  s.phase = "bookmarks";
  await publish();
  await navigate(s, bookmarksUrl());
  await inspect(s);
  const tab = await chrome.tabs.get(s.tabId);
  if (new URL(tab.url).pathname.startsWith("/i/history")) {
    await clickTab(s, "bookmarks");
    await inspect(s);
  }
  await scrollScreens(s, {
    screens: s.config.bookmarksMaxScreens,
    ms: 6 * 60_000,
    done: () => s.reachedKnownBookmark,
  });
}

async function visitPermalinks(s) {
  s.phase = "permalinks";
  await publish();
  const account = s.account ?? s.config.account;
  if (!account) {
    s.notes.push("detail queue skipped: logged-in account unknown");
    return;
  }
  const queue = await checkWorkerPause(s, account);
  const ids = Array.isArray(queue?.post_ids) ? queue.post_ids : [];
  const valid = ids.filter((id) => typeof id === "string" && /^\d{1,25}$/.test(id));
  if (valid.length !== ids.length) s.notes.push(`ignored ${ids.length - valid.length} malformed detail-queue id(s)`);
  for (const id of valid.slice(0, s.config.detailMaxPosts)) {
    await navigate(s, permalinkUrl(id));
    await inspect(s);
    await scrollScreens(s, { screens: s.config.detailMaxScreens, ms: 2 * 60_000 });
  }
}
