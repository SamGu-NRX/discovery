// Active sessions: a short read-only visit to x.com in an unfocused window,
// scrolling at a human pace. A session can do two things to X: open a URL
// minted by xurl.js and scroll. It clicks nothing. After every load it checks
// that the tab is on a path the minted URL expects and stops otherwise.
// Everything it learns arrives through the same capture path as passive
// browsing.

import { flush } from "./outbox.js";
import { scheduleNext } from "./schedule.js";
import { getLocal, getPauseUntil, loadConfig, recordProblem, setLocal } from "./store.js";
import { getDetailQueue, postStatus } from "./worker-api.js";
import { bookmarksUrl, historyBookmarksUrl, homeUrl, isMintedXUrl, permalinkUrl, xPath } from "./xurl.js";

const PAUSE_MS = 24 * 3600_000;
const LOAD_TIMEOUT_MS = 30_000;
// Stop reasons reported as that status, each pausing sessions for 24 hours:
// X telling the account to back off, or an error. A session interrupted by
// a service worker restart is reported as "error" too, because whatever
// stopped it was not recorded. Finishing, a stop from the popup, a closed
// window and a pause set by the Worker are "ok".
const BLOCKING = new Set(["login_wall", "rate_limited", "challenge", "error"]);
// X's own back-off signals. One of these replaces a harmless stop (Stop in
// the popup, a closed window, Off); a generic error, such as a tab call
// failing because Sam closed the window, does not.
const X_SIGNALS = new Set(["login_wall", "rate_limited", "challenge"]);

let current = null;
// The session restart recovery is reporting, while it runs: a back-off
// signal that arrives then (from its closing window, say) is part of it.
let recovering = null;
// The restart recovery in progress, if any. A new session waits for it, so
// the old session is reported before a new record replaces its record.
let recovery = Promise.resolve();

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

// The stop is written to session storage at once, so a service worker that
// dies before the session tears down still reports why it stopped. Returns
// whether the running session will report it.
export function requestStop(reason, detail) {
  const s = current;
  if (!s) {
    // During restart recovery, until it has chosen the old session's outcome,
    // a back-off signal joins that outcome. It is written into the old record
    // at once, so a second restart still reports it.
    if (!recovering || recovering.decided || !X_SIGNALS.has(reason)) return false;
    if (!recovering.lateStop) {
      recovering.lateStop = { reason, detail };
      recovering.saved = chrome.storage.session
        .set({ activeSession: { ...recovering.record, lateStop: recovering.lateStop } })
        .catch(() => {});
    }
    return true;
  }
  if (s.finishing) {
    // A back-off signal (a 429 from the closing page, say) still decides the
    // status until teardown has chosen it, just before reporting, and is
    // written at once so a restart in the meantime reports it.
    if (!X_SIGNALS.has(reason) || s.statusDecided) return false;
    if (BLOCKING.has(s.outcome?.reason) || s.lateStop) return true;
    s.lateStop = { reason, detail };
    publish(s, s.lateStop).catch(() => {});
    return true;
  }
  // A back-off signal (a 429 after Sam pressed Stop, say) replaces a
  // harmless stop; nothing replaces a blocking one.
  if (s.stop && (BLOCKING.has(s.stop.reason) || !X_SIGNALS.has(reason))) return true;
  s.stop = { reason, detail };
  // Before its first record the session may still be waiting for recovery
  // to report the previous one; that record must not be overwritten. The
  // first publish in startSession carries this stop.
  if (s.recorded) publish(s).catch(() => {});
  return true;
}

// Called for every capture from a session tab, with the id of the session
// that was running when the capture arrived.
export function noteSessionCapture(sessionId, { operation, postIds }) {
  const s = current;
  if (!s || s.id !== sessionId) return;
  s.posts += postIds.length;
  s.operations.add(operation);
  if (operation === "Bookmarks" && postIds.some((id) => s.knownBookmarks.has(id))) {
    s.reachedKnownBookmark = true;
  }
}

export async function startSession(trigger) {
  if (current) return { started: false, reason: "A session is already running." };
  // Reserve before the first await, so a second start (an alarm and the
  // popup at once) sees this one and refuses.
  const s = {
    id: crypto.randomUUID(),
    trigger,
    startedAt: new Date().toISOString(),
    config: null,
    windowId: null,
    tabId: null,
    phase: "starting",
    expects: () => false,
    screens: 0,
    posts: 0,
    operations: new Set(),
    stop: null,
    completed: false,
    finishing: false,
    recorded: false,
    statusDecided: false,
    lateStop: null,
    outcome: null,
    notes: [],
    errorPages: 0,
    account: null,
    knownBookmarks: new Set(),
    reachedKnownBookmark: false,
  };
  current = s;
  const refuse = (reason) => {
    if (current === s) current = null;
    return { started: false, reason };
  };
  try {
    await recovery;
    // A previous session whose report did not reach the Worker is retried
    // first; until it is reported, no new session starts.
    if (await hasRecordOtherThan(s.id)) {
      await recoverInterruptedSession();
      if (await hasRecordOtherThan(s.id)) return refuse("The last session is not reported yet; is the Worker reachable?");
    }
    s.config = await loadConfig();
    if (!s.config.workerUrl || !s.config.ingestToken) return refuse("Add the Worker URL and token first.");
    if (s.config.mode === "off") return refuse("Capture is off.");
    if (trigger === "alarm" && s.config.mode !== "active") return refuse("Sessions are off.");
    const pause = await getPauseUntil();
    if (pause) return refuse(`Paused until ${new Date(pause).toLocaleString()}.`);
    s.knownBookmarks = new Set(await getLocal("sentBookmarkIds", []));
    if (s.stop) return refuse("Stopped before it began.");
    await publish(s);
    s.recorded = true;
  } catch (err) {
    return refuse(`Could not start: ${err.message}`);
  }
  run(s);
  return { started: true, id: s.id };
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
    s.completed = true;
  } catch (err) {
    outcome = err instanceof StopSession ? { reason: err.reason, detail: err.detail } : { reason: "error", detail: err.message };
  }
  // An exception caused by the stop (a tab call failing on a closed window,
  // say) is not the reason, unless X itself signalled a back-off.
  if (s.stop && !(X_SIGNALS.has(outcome.reason) && !BLOCKING.has(s.stop.reason))) outcome = s.stop;

  clearInterval(keepAlive);
  chrome.windows.onRemoved.removeListener(onRemoved);
  s.finishing = true;
  let reported = false;
  try {
    reported = await finish(s, outcome);
  } finally {
    // Record first, then the slot: while `current` is still this session no
    // other session can start and write a record this removal would delete.
    // A session whose status did not reach the Worker keeps its record, which
    // holds its final outcome; restart recovery or the next start reports it.
    try {
      if (reported) await removeRecord(s.id);
    } finally {
      if (current === s) current = null;
    }
  }
  await scheduleNext();
}

// The outcome with any back-off signal that arrived during teardown.
const finalOutcome = (s) => (s.lateStop && !BLOCKING.has(s.outcome.reason) ? s.lateStop : s.outcome);

async function finish(s, outcome) {
  s.outcome = outcome;
  // Recorded before any teardown step that could be cut short.
  await publish(s, finalOutcome(s));
  if (!s.windowClosed && s.windowId !== null) {
    // Let captures already in flight from the closing page reach the worker.
    await sleep(1000);
    await chrome.windows.remove(s.windowId).catch(() => {});
  }
  await flush().catch((err) => recordProblem("worker", err.message));
  const account = s.account ?? (await getLocal("lastAccount", null)) ?? s.config.account;
  // Record the final outcome; a signal arriving during that write is
  // recorded too. The status is then chosen with no await before the
  // request, so nothing can arrive between choosing and reporting it.
  for (let recorded = null; recorded !== finalOutcome(s); ) {
    recorded = finalOutcome(s);
    await publish(s, recorded);
  }
  s.statusDecided = true;
  outcome = finalOutcome(s);
  const status = BLOCKING.has(outcome.reason) ? outcome.reason : "ok";
  if (s.operations.has("HomeLatestTimeline") && !s.operations.has("HomeTimeline")) {
    s.notes.push("home opened on Following; choose For you once in this browser and X keeps it");
  }
  const detail = [
    `${outcome.reason}: ${outcome.detail}`,
    `screens=${s.screens} posts=${s.posts}`,
    ...s.notes,
  ].join("; ").slice(0, 1000);

  if (status !== "ok") await extendPause();
  let reported = false;
  try {
    await postStatus(s.config, { account, session_id: s.id, status, detail });
    reported = true;
  } catch (err) {
    await recordProblem("worker", `session status not reported: ${err.message}`);
    await publish(s, outcome, { awaitingReport: true });
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
  return reported;
}

// Called when the service worker starts. A session record without a running
// session means the worker stopped mid-session. It is reported with the
// outcome or stop it recorded; with neither and no completion checkpoint, it
// is reported as interrupted, status "error", because a login wall, challenge
// or rate limit may have stopped it before it could say so.
export function recoverInterruptedSession() {
  recovery = recover().catch((err) => recordProblem("session", `recovery failed: ${err.message}`));
  return recovery;
}

async function recover() {
  const { activeSession } = await chrome.storage.session.get("activeSession");
  if (!activeSession || activeSession.id === current?.id) return;
  recovering = { record: activeSession, lateStop: null, decided: false, saved: Promise.resolve() };
  try {
    await recoverRecord(activeSession);
  } finally {
    recovering = null;
  }
}

async function recoverRecord(activeSession) {
  if (activeSession.windowId != null) await chrome.windows.remove(activeSession.windowId).catch(() => {});
  // From here a signal is no longer part of the old session; once the write
  // of one that is has landed, the outcome is chosen.
  recovering.decided = true;
  await recovering.saved;
  // A recorded blocking outcome or stop wins over everything else,
  // including the completion checkpoint, and so does a back-off signal that
  // arrived while the old window closed, in this recovery or in one a
  // restart cut short.
  const recorded = [activeSession.outcome, activeSession.stop, activeSession.lateStop, recovering.lateStop].filter(Boolean);
  const outcome =
    recorded.find((o) => BLOCKING.has(o.reason)) ??
    recorded[0] ??
    (activeSession.completed
      ? { reason: "completed", detail: "finished before the service worker restarted" }
      : { reason: "interrupted", detail: "the extension's service worker restarted mid-session" });
  const status = BLOCKING.has(outcome.reason) ? outcome.reason : outcome.reason === "interrupted" ? "error" : "ok";
  const detail = `${outcome.reason}: ${outcome.detail}`.slice(0, 1000);
  if (status !== "ok") await extendPause();
  const config = await loadConfig();
  const account = activeSession.account ?? (await getLocal("lastAccount", null)) ?? config.account;
  const reported = await postStatus(config, { account, session_id: activeSession.id, status, detail }).then(
    () => true,
    () => false,
  );
  await setLocal({
    lastSession: { ...activeSession, endedAt: new Date().toISOString(), status, reason: outcome.reason, detail, reported },
  });
  // Removed only once the Worker has the report. Otherwise it stays, and the
  // next start or restart reports it again.
  if (reported) await removeRecord(activeSession.id);
}

async function hasRecordOtherThan(id) {
  const { activeSession } = await chrome.storage.session.get("activeSession");
  return Boolean(activeSession && activeSession.id !== id);
}

async function removeRecord(id) {
  const { activeSession } = await chrome.storage.session.get("activeSession");
  if (activeSession?.id === id) await chrome.storage.session.remove("activeSession");
}

async function extendPause() {
  const until = new Date(Date.now() + PAUSE_MS).toISOString();
  const existing = await getPauseUntil();
  if (!existing || Date.parse(existing) < Date.parse(until)) await setLocal({ pauseUntil: until });
}

// Progress the popup shows while a session runs, and what recovery reads.
// `awaitingReport` marks a finished session whose status has not reached the
// Worker yet.
function publish(s, outcome = null, extra = {}) {
  return chrome.storage.session.set({
    activeSession: {
      ...extra,
      id: s.id,
      trigger: s.trigger,
      startedAt: s.startedAt,
      windowId: s.windowId,
      account: s.account,
      phase: s.phase,
      screens: s.screens,
      posts: s.posts,
      stop: s.stop,
      completed: s.completed,
      outcome,
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
  // A stop (Off, say) that arrived while the session was starting.
  checkpoint(s);
  const url = homeUrl();
  const href = checkedHref(s, url);
  await loadAndWait(s, async () => {
    const win = await chrome.windows.create({ url: href, focused: false, type: "normal", width: 1200, height: 900 });
    s.windowId = win.id;
    s.tabId = win.tabs[0].id;
    await publish(s);
  });
}

async function navigate(s, url) {
  checkpoint(s);
  const href = checkedHref(s, url);
  await loadAndWait(s, () => chrome.tabs.update(s.tabId, { url: href }));
}

// Also records which paths the new page may be on; see onExpectedPage().
function checkedHref(s, url) {
  if (!isMintedXUrl(url)) throw new Error("refusing to open a URL that xurl.js did not build");
  s.expects = url.expects;
  s.pathPattern = url.pathPattern;
  s.opened = url.href;
  return url.href;
}

async function currentPath(s) {
  const tab = await chrome.tabs.get(s.tabId);
  const path = xPath(tab.url ?? "");
  if (path === null) throw new StopSession("error", `the session tab left x.com (${tab.url ?? "unknown url"})`);
  return path;
}

// Anything but the expected page (X's own redirects included) ends the
// session; it never reads or scrolls a page it did not mean to open.
async function onExpectedPage(s) {
  const path = await currentPath(s);
  if (!s.expects(path)) throw new StopSession("error", `unexpected page ${path} after opening ${s.opened}`);
  return path;
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
  // Inspect runs on any x.com page, so a login or challenge page is reported
  // as such; scrolling happens only on the expected page.
  if (name === "inspect") await currentPath(s);
  else await onExpectedPage(s);
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
    await publish(s);
  }
  if (seen.blocker) throw new StopSession(seen.blocker, `${seen.evidence} at ${seen.path}`);
  await onExpectedPage(s);
  // X's generic error page often means throttling; three in a row ends the visit.
  s.errorPages = seen.errorPage ? s.errorPages + 1 : 0;
  if (s.errorPages >= 3) throw new StopSession("error", `X kept showing "Something went wrong" at ${seen.path}`);
  return seen;
}

async function scrollScreens(s, { screens, ms, done = () => false }) {
  const end = Date.now() + ms;
  let bottoms = 0;
  for (let i = 0; i < screens && Date.now() < end && !done(); i += 1) {
    await pause(s, 2000, 4000);
    const result = await agent(s, "scroll", { fraction: random(0.75, 0.95), pathPattern: s.pathPattern });
    if (!result.scrolled) throw new StopSession("error", `unexpected page ${result.path} after opening ${s.opened}`);
    const { atBottom } = result;
    s.screens += 1;
    await publish(s);
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

// X opens home on the tab last used in this browser, For You or Following,
// and no URL selects one. Selecting it would take a click, so a home that
// opens on Following is read as it is (its batches are labeled
// home_following) and the session says so.
async function visitHome(s) {
  s.phase = "home";
  await publish(s);
  await inspect(s);
  const account = s.account ?? s.config.account;
  if (account) await checkWorkerPause(s, account);
  await scrollScreens(s, { screens: s.config.homeMaxScreens, ms: s.config.homeMaxMinutes * 60_000 });
}

async function visitBookmarks(s) {
  s.phase = "bookmarks";
  await publish(s);
  await navigate(s, bookmarksUrl());
  await inspect(s);
  // Moved under /i/history, bookmarks may not be the tab that opens.
  if (!s.operations.has("Bookmarks")) {
    await navigate(s, historyBookmarksUrl());
    await inspect(s);
  }
  if (!s.operations.has("Bookmarks")) {
    s.notes.push(`no bookmarks loaded at ${await currentPath(s)}`);
    return;
  }
  await scrollScreens(s, {
    screens: s.config.bookmarksMaxScreens,
    ms: 6 * 60_000,
    done: () => s.reachedKnownBookmark,
  });
}

async function visitPermalinks(s) {
  s.phase = "permalinks";
  await publish(s);
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
