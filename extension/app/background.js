// Service worker: receives captures from the x.com content scripts, turns them
// into contract batches, sends them to the Worker, and runs scheduled sessions.

import { captureToBatch } from "./lib/capture.js";
import { focalTweetIdFromUrl, operationFromUrl } from "./lib/ops.js";
import { dropStoredSince, enqueue, flush } from "./lib/outbox.js";
import { ParseError } from "./lib/parse.js";
import { SESSION_ALARM, intervalElapsed, scheduleNext } from "./lib/schedule.js";
import {
  noteSessionCapture,
  recoverInterruptedSession,
  requestStop,
  sessionInfo,
  sessionTabId,
  startSession,
} from "./lib/session.js";
import {
  createLock,
  extendPause,
  getLocal,
  loadConfig,
  localDay,
  recordProblem,
  setLocal,
  updatePageState,
} from "./lib/store.js";
import { pauseFrom, postStatus } from "./lib/worker-api.js";

const FLUSH_ALARM = "flush";
// X's GraphQL error code for "Rate limit exceeded"; it can arrive with HTTP 200.
const RATE_LIMIT_CODE = 88;

chrome.runtime.onInstalled.addListener(() => setUp());
chrome.runtime.onStartup.addListener(() => setUp());

async function setUp() {
  await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  if (!(await chrome.alarms.get(SESSION_ALARM))) await scheduleNext();
}

// Serializes passive back-off reporting: one report per pause.
const backOffLock = createLock();

recoverInterruptedSession().catch((err) => recordProblem("session", err.message));
// Work a stopped worker may have left: a passive back-off report not yet
// sent, and captures stored after capture was turned Off.
backOffLock(sendPendingBackOff).catch((err) => recordProblem("worker", err.message));
loadConfig()
  .then((config) => config.mode === "off" && config.modeChangedAt && dropStoredSince(config.modeChangedAt))
  .catch((err) => recordProblem("outbox", err.message));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === FLUSH_ALARM) {
    await flush().catch((err) => recordProblem("worker", err.message));
    await backOffLock(sendPendingBackOff).catch((err) => recordProblem("worker", err.message));
  } else if (alarm.name === SESSION_ALARM) {
    const result = (await intervalElapsed()) ? await startSession("alarm") : { started: false };
    if (!result.started) await scheduleNext();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config && changes.config.oldValue?.mode !== changes.config.newValue?.mode) {
    // Off means nothing is captured, including by a session already running
    // or a capture being stored at that moment.
    if (changes.config.newValue?.mode === "off") {
      requestStop("capture_off", "capture was turned off");
      dropStoredSince(changes.config.newValue.modeChangedAt ?? Date.now()).catch((err) => recordProblem("outbox", err.message));
    }
    scheduleNext().catch((err) => recordProblem("session", err.message));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(sendResponse, (err) => sendResponse({ error: err.message }));
  return true;
});

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) return { error: "unknown sender" };
  // Content scripts report the page's URL, so only extension pages (the
  // popup, opened as a popup or a tab) carry the extension's own origin.
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL("")) ?? false;
  const fromXTab = sender.tab && sender.url?.startsWith("https://x.com/");

  switch (message?.type) {
    case "capture":
      if (!fromXTab) return { error: "captures come from x.com tabs" };
      // Anything other than a ParseError is a bug here; it still belongs in
      // the popup rather than only in the reply to the bridge.
      return handleCapture(message, sender.tab.id).catch(async (err) => {
        await recordProblem("capture", `${message.operation}: ${err.message}`);
        return { error: err.message };
      });
    case "x-status":
      return fromXTab ? handleXStatus(message, sender.tab.id) : { error: "statuses come from x.com tabs" };
    case "runSession":
      return fromExtensionPage ? startSession("manual") : { error: "only the popup starts sessions" };
    case "stopSession":
      if (!fromExtensionPage) return { error: "only the popup stops sessions" };
      requestStop("stopped_by_user", "stopped from the popup");
      return { stopping: true };
    default:
      return { error: `unknown message ${message?.type}` };
  }
}

async function handleCapture(message, tabId) {
  const { url, body, pageLoadId } = message;
  const operation = operationFromUrl(url);
  // The bridge's operation name must match the URL it came with.
  if (!operation || operation !== message.operation || typeof body !== "string" || typeof pageLoadId !== "string") {
    return { ignored: true };
  }
  // Taken once: the session can end while this capture is parsed and queued,
  // and the capture still belongs to it.
  const session = tabId === sessionTabId() ? sessionInfo() : null;
  const inSession = session !== null;

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    await recordProblem("parse", `${operation}: response was not JSON`);
    return { ignored: true };
  }
  // X's rate-limit error (code 88) is a back-off signal on its own, checked
  // before the mode and before any parsing, so neither Off nor a response
  // the parser rejects can hide it.
  if (Array.isArray(json?.errors) && json.errors.some((e) => e?.code === RATE_LIMIT_CODE)) {
    await onBackOff(tabId, "rate_limited", `${operation} returned X error 88 (rate limit)`);
  }
  const config = await loadConfig();
  if (config.mode === "off") return { ignored: true };

  const focalId = operation === "TweetDetail" ? focalTweetIdFromUrl(url) : null;
  const key = [pageLoadId, operation, focalId ?? ""].join("|");
  const result = await updatePageState(key, async (page) => {
    const offset = page?.offset ?? 0;
    try {
      const capture = captureToBatch({ operation, json, url, offset, threadState: page?.thread ?? null });
      return { state: { offset: offset + capture.advance, thread: capture.threadState }, result: capture };
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      await recordProblem("parse", err.message);
      return { state: page ?? { offset: 0, thread: null }, result: null };
    }
  });
  if (!result) return { ignored: true };
  if (result.threadError) await recordProblem("parse", result.threadError);

  if (!result.batch) return { posts: 0 };

  const handle = typeof message.account === "string" && /^[A-Za-z0-9_]{1,15}$/.test(message.account) ? message.account : null;
  if (handle) await setLocal({ lastAccount: handle });
  const account = handle ?? session?.account ?? (await getLocal("lastAccount", null)) ?? config.account;
  if (!account) {
    await recordProblem("capture", "dropped a batch: the logged-in account is unknown (no profile link in X's side nav)");
    return { ignored: true };
  }

  const postIds = result.batch.posts.map((p) => p.id);
  const queued = await enqueue({
    account,
    session_id: session ? session.id : await passiveSessionId(),
    mode: inSession ? "active" : "passive",
    batch: result.batch,
  });
  if (!queued) return { ignored: true };
  if (session) noteSessionCapture(session.id, { operation, postIds });
  scheduleFlush();
  return { posts: postIds.length };
}

async function handleXStatus(message, tabId) {
  const status = Number(message.status);
  const operation = String(message.operation).slice(0, 60);
  if (status === 429) await onBackOff(tabId, "rate_limited", `${operation} answered HTTP 429`);
  // A GraphQL 401 from any X tab means the account's login is not usable, so
  // it pauses sessions like any login wall. There is no evidence that X
  // answers GraphQL with 401 in a working logged-in tab; if it does, the cost
  // is a 24-hour pause, never a session running past a login wall.
  else if (status === 401) await onBackOff(tabId, "login_wall", `${operation} answered HTTP 401`);
  return { ok: true };
}

// X throttles the account, not the tab: a back-off signal stops a running
// session wherever it was seen, including one still opening its window or
// one restart recovery is reporting, and that session reports it. Only a
// signal no session takes (seen while Sam browses with no session running,
// or after a session reported its status) is reported under the passive
// session, once, and holds sessions off for the pause.
async function onBackOff(tabId, reason, detail) {
  const fromSession = tabId === sessionTabId();
  const accepted = requestStop(reason, fromSession ? detail : `${detail} in another tab`);
  // Every X signal pauses sessions in chrome.storage.local before this
  // returns. A session's own record of the signal lives in session storage,
  // which a browser restart clears before the session could write its pause.
  await extendPause();
  if (accepted) return;
  await backOffLock(async () => {
    await recordProblem("x", detail);
    // One passive report per 24 hours: a second signal finds the stamp.
    const reportedUntil = await getLocal("backOffReportedUntil", null);
    if (reportedUntil && Date.parse(reportedUntil) > Date.now()) return;
    const config = await loadConfig();
    const account = (await getLocal("lastAccount", null)) ?? config.account;
    const report = account ? { account, session_id: await passiveSessionId(), status: reason, detail } : null;
    // The stamp and the report to send are one write, so a stopped worker
    // leaves either neither or both, and the next start sends the report.
    await setLocal({ pendingBackOff: report, backOffReportedUntil: new Date(Date.now() + 24 * 3600_000).toISOString() });
    await sendPendingBackOff();
  });
}

// Sends the stored passive back-off report, if any, and clears it once the
// Worker has it. Runs under backOffLock.
async function sendPendingBackOff() {
  const report = await getLocal("pendingBackOff", null);
  if (!report) return;
  try {
    const answer = await postStatus(await loadConfig(), report);
    await setLocal({ pendingBackOff: null });
    if (pauseFrom(answer)) await extendPause(pauseFrom(answer));
  } catch (err) {
    await recordProblem("worker", `back-off status not reported yet: ${err.message}`);
  }
}

// Passive captures share one session id per local day.
const passiveLock = createLock();
function passiveSessionId() {
  return passiveLock(async () => {
    const today = localDay();
    const passive = await getLocal("passiveSession", null);
    if (passive?.day === today) return passive.id;
    const id = crypto.randomUUID();
    await setLocal({ passiveSession: { day: today, id } });
    return id;
  });
}

let flushTimer = null;
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush().catch((err) => recordProblem("worker", err.message)), 3000);
}
