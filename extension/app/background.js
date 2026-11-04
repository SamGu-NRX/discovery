// Service worker: receives captures from the x.com content scripts, turns them
// into contract batches, sends them to the Worker, and runs scheduled sessions.

import { captureToBatch } from "./lib/capture.js";
import { focalTweetIdFromUrl, operationFromUrl } from "./lib/ops.js";
import { enqueue, flush } from "./lib/outbox.js";
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
  getLocal,
  getPauseUntil,
  loadConfig,
  localDay,
  recordProblem,
  setLocal,
  updatePageState,
} from "./lib/store.js";
import { postStatus } from "./lib/worker-api.js";

const FLUSH_ALARM = "flush";

chrome.runtime.onInstalled.addListener(() => setUp());
chrome.runtime.onStartup.addListener(() => setUp());

async function setUp() {
  await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  if (!(await chrome.alarms.get(SESSION_ALARM))) await scheduleNext();
}

recoverInterruptedSession().catch((err) => recordProblem("session", err.message));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === FLUSH_ALARM) {
    await flush().catch((err) => recordProblem("worker", err.message));
  } else if (alarm.name === SESSION_ALARM) {
    const result = (await intervalElapsed()) ? await startSession("alarm") : { started: false };
    if (!result.started) await scheduleNext();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config && changes.config.oldValue?.mode !== changes.config.newValue?.mode) {
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
  const config = await loadConfig();
  if (!inSession && config.mode === "off") return { ignored: true };

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    await recordProblem("parse", `${operation}: response was not JSON`);
    return { ignored: true };
  }

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

  if (result.rateLimited) await onRateLimited(tabId, `${operation} returned X error 88 (rate limit)`);
  if (!result.batch) return { posts: 0 };

  const handle = typeof message.account === "string" && /^[A-Za-z0-9_]{1,15}$/.test(message.account) ? message.account : null;
  if (handle) await setLocal({ lastAccount: handle });
  const account = handle ?? session?.account ?? (await getLocal("lastAccount", null)) ?? config.account;
  if (!account) {
    await recordProblem("capture", "dropped a batch: the logged-in account is unknown (no profile link in X's side nav)");
    return { ignored: true };
  }

  const postIds = result.batch.posts.map((p) => p.id);
  if (session) noteSessionCapture(session.id, { operation, postIds });
  await enqueue({
    account,
    session_id: session ? session.id : await passiveSessionId(),
    mode: inSession ? "active" : "passive",
    batch: result.batch,
  });
  scheduleFlush();
  return { posts: postIds.length };
}

async function handleXStatus(message, tabId) {
  const status = Number(message.status);
  const operation = String(message.operation).slice(0, 60);
  if (status === 429) await onRateLimited(tabId, `${operation} answered HTTP 429`);
  else if (status === 401 && tabId === sessionTabId()) requestStop("login_wall", `${operation} answered HTTP 401`);
  return { ok: true };
}

// X throttles the account, not the tab: any rate limit stops a running
// session. One the session will not report (seen while Sam browses, or too
// late in a session's teardown) is reported once under the passive session
// and holds sessions off for the Worker's pause.
async function onRateLimited(tabId, detail) {
  const fromSession = tabId === sessionTabId();
  const accepted = sessionTabId() !== null && requestStop("rate_limited", fromSession ? detail : `${detail} in another tab`);
  if (fromSession && accepted) return;
  await recordProblem("x", detail);
  if (await getPauseUntil()) return;
  await setLocal({ pauseUntil: new Date(Date.now() + 24 * 3600_000).toISOString() });
  const config = await loadConfig();
  const account = (await getLocal("lastAccount", null)) ?? config.account;
  if (account) {
    await postStatus(config, { account, session_id: await passiveSessionId(), status: "rate_limited", detail })
      .catch((err) => recordProblem("worker", err.message));
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
