// Service worker: receives captures from the x.com content scripts, turns them
// into contract batches, sends them to the Worker, and runs scheduled sessions.

import { captureToBatch } from "./lib/capture.js";
import { chicagoDay, DAILY_ALARM, dailyEnabled, dailyJobs, dailyWindow, nextDailyState, planAttempt, retriesInWindow, skippedDay } from "./lib/daily.js";
import { deliverKept, deliveryDue, keepBundle } from "./lib/knowledge.js";
import { acquireFetchRun, beatFetchRun, fetchRunHeldAnywhere, releaseFetchRun } from "./lib/fetchlock.js";
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
import { errorPauseVerdict } from "./lib/unpause.js";
import {
  clearErrorPause,
  createLock,
  extendPause,
  getLocal,
  loadConfig,
  localDay,
  PAGE_SIGNAL_PREFIX,
  pausedOrPausing,
  pendingPageSignals,
  recordProblem,
  setLocal,
  updatePageState,
} from "./lib/store.js";
import { dueRepolls, pauseFrom, postStatus } from "./lib/worker-api.js";

const FLUSH_ALARM = "flush";
// Lens metric re-polls (docs/LENS.md): checked hourly.
const REPOLL_ALARM = "lens-repoll";
// X's GraphQL error code for "Rate limit exceeded"; it can arrive with HTTP 200.
const RATE_LIMIT_CODE = 88;

chrome.runtime.onInstalled.addListener(() => setUp());
chrome.runtime.onStartup.addListener(() => setUp());

async function setUp() {
  await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  await chrome.alarms.create(REPOLL_ALARM, { periodInMinutes: 60 });
  if (!(await chrome.alarms.get(SESSION_ALARM))) await scheduleNext();
  // Chrome may start inside the 05:00–06:30 window; startDaily runs it then,
  // or sets the alarm for the next start.
  await startDaily().catch((err) => recordProblem("daily", err.message));
}

// Serializes passive back-off reporting: one report per pause.
const backOffLock = createLock();
// Serializes draining the signals pages stored (drainPageSignals).
const drainLock = createLock();

recoverInterruptedSession().catch((err) => recordProblem("session", err.message));
// Work a stopped worker may have left: a passive back-off report not yet
// sent, and captures stored after capture was turned Off.
backOffLock(sendPendingBackOff).catch((err) => recordProblem("worker", err.message));
drainPageSignals().catch((err) => recordProblem("x", err.message));
loadConfig()
  .then((config) => config.mode === "off" && config.modeChangedAt && dropStoredSince(config.modeChangedAt))
  .catch((err) => recordProblem("outbox", err.message));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === FLUSH_ALARM) {
    await flush().catch((err) => recordProblem("worker", err.message));
    await drainPageSignals().catch((err) => recordProblem("x", err.message));
    await backOffLock(sendPendingBackOff).catch((err) => recordProblem("worker", err.message));
    // Daily bundles not yet filed with the knowledge store: at most one pass
    // per 15 minutes after a stop (lib/knowledge.js).
    if (await deliveryDue()) await deliverDaily().catch((err) => recordProblem("daily", `filing: ${err.message}`));
  } else if (alarm.name === DAILY_ALARM) {
    await startDaily().catch((err) => recordProblem("daily", err.message));
  } else if (alarm.name === REPOLL_ALARM) {
    await startRepolls().catch((err) => recordProblem("lens", `re-poll: ${err.message}`));
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
    case "x-limit":
    case "x-blocker": {
      if (!fromXTab) return { error: "back-off signals come from x.com tabs" };
      const reply = await handleSignal(message, sender.tab.id);
      // Paused on: the page's stored copy is no longer needed.
      if (isSignalKey(message.signalKey)) await chrome.storage.local.remove(message.signalKey);
      return reply;
    }
    case "runSession":
      return fromExtensionPage ? startSession("manual") : { error: "only the popup starts sessions" };
    case "stopSession":
      if (!fromExtensionPage) return { error: "only the popup stops sessions" };
      requestStop("stopped_by_user", "stopped from the popup");
      return { stopping: true };
    case "fetch-acquire":
      // sessionInfo() is set synchronously when a session starts, so this
      // check and the claim inside acquireFetchRun happen in one step.
      if (!fromExtensionPage) return { error: "only the fetch page runs fetch mode" };
      return { refused: await acquireFetchRun(String(message.owner), sessionInfo() !== null) };
    case "fetch-heartbeat":
      if (!fromExtensionPage) return { error: "only the fetch page runs fetch mode" };
      return { held: await beatFetchRun(String(message.owner), { tabId: message.tabId ?? null, windowId: message.windowId ?? null }) };
    case "fetch-release":
      if (!fromExtensionPage) return { error: "only the fetch page runs fetch mode" };
      await releaseFetchRun(String(message.owner));
      return { ok: true };
    case "fetch-batch":
      if (!fromExtensionPage) return { error: "only the fetch page sends fetch batches" };
      return queueFetchBatch(message);
    case "clear-error-pause":
      // The fetch page's "Clear error pause" button (lib/unpause.js says
      // which pauses it may lift). Never while a session or run is going.
      if (!fromExtensionPage) return { error: "only the fetch page clears a pause" };
      if (sessionInfo() !== null) return { clearable: false, why: "a session is running" };
      if (await fetchRunHeldAnywhere()) return { clearable: false, why: "a fetch run is going" };
      return clearErrorPause(errorPauseVerdict);
    case "daily-claim":
      if (!fromExtensionPage) return { error: "only the daily page claims the daily run" };
      return claimDaily(message);
    case "daily-result":
      if (!fromExtensionPage) return { error: "only the daily page reports the daily run" };
      return recordDaily(message);
    case "fetch-signal":
      // X told a fetch run to back off: the same pause and report as a 429
      // seen in any tab.
      if (!fromExtensionPage) return { error: "only the fetch page sends fetch signals" };
      await onBackOff(-1, ["rate_limited", "login_wall", "challenge"].includes(message.reason) ? message.reason : "error", `fetch mode: ${String(message.detail).slice(0, 200)}`);
      return { ok: true };
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
  // A fetch run records every response it requests itself; what X's page
  // loads in its tab would only repeat part of that as passive captures.
  if (tabId === (await chrome.storage.session.get("fetchRun")).fetchRun?.tabId) return { ignored: true };

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
    // A lens session's captures name the lens (docs/LENS.md).
    lensId: session?.lensId ?? null,
    batch: result.batch,
  });
  if (!queued) return { ignored: true };
  if (session) noteSessionCapture(session.id, { operation, postIds, posts: result.batch.posts });
  scheduleFlush();
  return { posts: postIds.length };
}

// One batch from the fetch page (app/fetch/fetch.js), queued like a capture
// but under the run's own session id and mode "fetch". The outbox is
// written only here, in the service worker, so its lock covers every writer.
async function queueFetchBatch({ account, session_id, batch }) {
  if (typeof account !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(account)) return { error: "fetch batch without a valid account" };
  if (typeof session_id !== "string" || !/^[0-9a-f-]{36}$/.test(session_id)) return { error: "fetch batch without a session id" };
  if (!batch || typeof batch.op !== "string" || !Array.isArray(batch.posts)) return { error: "malformed fetch batch" };
  const queued = await enqueue({ account, session_id, mode: "fetch", batch });
  if (queued) scheduleFlush();
  return queued ? { queued: true } : { error: "capture is off" };
}

function handleSignal(message, tabId) {
  if (message.type === "x-status") return handleXStatus(message, tabId);
  if (message.type === "x-blocker") return handleXBlocker(message, tabId);
  return onBackOff(tabId, "rate_limited", `${String(message.operation).slice(0, 60)} returned X error 88 (rate limit)`).then(() => ({ ok: true }));
}

const isSignalKey = (key) => typeof key === "string" && new RegExp(`^${PAGE_SIGNAL_PREFIX}[0-9a-f-]{36}$`).test(key);

// Signals a page stored but could not deliver, because this worker was
// stopped or restarting: each is paused on as if it had just arrived, from
// no particular tab, then removed. Runs at startup and every minute.
function drainPageSignals() {
  return drainLock(async () => {
    for (const [key, signal] of Object.entries(await pendingPageSignals())) {
      if (isSignalKey(key) && ["x-status", "x-limit", "x-blocker"].includes(signal?.type)) await handleSignal(signal, -1);
      await chrome.storage.local.remove(key);
    }
  });
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

// A login wall, challenge or rate-limit page detect.js found in any X tab,
// Sam's own included: the same back-off as a 429.
async function handleXBlocker(message, tabId) {
  const reason = message.blocker;
  if (!["login_wall", "challenge", "rate_limited"].includes(reason)) return { ignored: true };
  const detail = `${String(message.evidence).slice(0, 120)} at ${String(message.path).slice(0, 120)}`;
  await onBackOff(tabId, reason, detail);
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
  await extendPause(undefined, reason);
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

// Opens the fetch page in a background tab to re-fetch the metrics of a lens
// account's flagged posts that are due. The page runs one TweetDetail per
// post through fetch mode, with all of fetch mode's limits, tells the Worker
// they are done, and closes itself. Nothing happens without a lens, a Worker,
// or posts due, or while the extension is paused.
async function startRepolls() {
  const config = await loadConfig();
  if (!config.lensId || !config.workerUrl || !config.ingestToken || config.mode === "off") return;
  const account = await getLocal("lastAccount", null);
  if (!account || (await getLocal("pauseUntil", null)) > new Date().toISOString()) return;
  // One re-poll at a time: a job still waiting for its tab, or a fetch run
  // going, waits for the next hour.
  const { repollJob, fetchRun } = await chrome.storage.session.get(["repollJob", "fetchRun"]);
  if (repollJob && Date.now() - repollJob.at < 10 * 60_000) return;
  if (fetchRun && Date.now() - fetchRun.heartbeatAt < 120_000) return;
  const { post_ids: ids = [] } = await dueRepolls(config, account);
  if (!ids.length) return;
  await chrome.storage.session.set({ repollJob: { account, lensId: config.lensId, ids, at: Date.now() } });
  await chrome.tabs.create({ url: chrome.runtime.getURL("fetch/fetch.html?auto=repoll"), active: false });
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

// ---- the daily new-saves run (lib/daily.js) -------------------------------

// One decision at a time: the alarm, Chrome starting, a claim, a result.
const dailyLock = createLock();

async function dailyStates() {
  return getLocal("dailyFetch", {});
}

async function setDailyState(account, state) {
  await setLocal({ dailyFetch: { ...(await dailyStates()), [account]: state } });
}

// Why a daily run cannot start now, or null. The archive's runner keeps a
// fetch page open for its whole queue and between jobs, so an open
// fetch.html counts as its run going even when no request is in flight;
// the daily run never starts beside it.
async function dailyBusy() {
  if (await pausedOrPausing()) return `the extension is paused after an X signal (until ${await getLocal("pauseUntil", "a pending signal is handled")})`;
  if (sessionInfo() !== null) return "a capture session is running";
  if (await fetchRunHeldAnywhere()) return "a fetch run is going (the archive's)";
  const pages = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  if (pages.some((c) => c.documentUrl?.includes("/fetch/fetch.html"))) return "a fetch page is open (the archive's queue)";
  return null;
}

// From the alarm and from Chrome starting: runs today's daily fetch, waits,
// retries in 15 minutes, or gives the day up, and sets the alarm for the
// next step. The day's job goes to session storage for the page to claim.
function startDaily() {
  return dailyLock(async () => {
    const now = Date.now();
    const config = await loadConfig();
    const account = await getLocal("lastAccount", null);
    if (!dailyEnabled(config, account)) {
      await chrome.alarms.create(DAILY_ALARM, { when: dailyWindow(now).tomorrow });
      return;
    }
    const states = await dailyStates();
    const state = states[account] ?? null;
    const { dailyJob } = await chrome.storage.session.get("dailyJob");
    // A page opened under 10 minutes ago that has not claimed yet, or a run
    // already going from it, is today's run.
    if (dailyJob && now - dailyJob.at < 10 * 60_000) return;
    const plan = planAttempt(state, now, await dailyBusy());
    if (plan.action === "run") {
      await chrome.storage.session.set({ dailyJob: { account, at: now, boundary: state?.boundary ?? null } });
      await setLocal({ dailyWaiting: null });
      await chrome.windows.create({ url: chrome.runtime.getURL("fetch/daily.html?auto=daily"), focused: false, type: "normal", width: 900, height: 700 });
      await chrome.alarms.create(DAILY_ALARM, { when: dailyWindow(now).tomorrow });
    } else if (plan.action === "give_up") {
      await setDailyState(account, skippedDay(state, plan.cause, now));
      await setLocal({ dailyWaiting: null });
      await recordProblem("daily", `daily fetch skipped today: ${plan.cause}`);
      await chrome.alarms.create(DAILY_ALARM, { when: plan.at });
    } else {
      await setLocal({ dailyWaiting: plan.action === "retry" ? { since: new Date(now).toISOString(), cause: plan.cause, next: new Date(plan.at).toISOString() } : null });
      await chrome.alarms.create(DAILY_ALARM, { when: plan.at });
    }
  });
}

// The daily page asks for its job. A scheduled page gets the one
// startDaily stored; a manual test run (daily-now) is built here, and is
// refused rather than queued while anything else is busy.
function claimDaily({ manual, newest }) {
  return dailyLock(async () => {
    if (!manual) {
      const { dailyJob } = await chrome.storage.session.get("dailyJob");
      if (!dailyJob || Date.now() - dailyJob.at > 10 * 60_000) return { refused: "no daily run is scheduled for this page" };
      return { account: dailyJob.account, jobs: dailyJobs(dailyJob.boundary) };
    }
    const account = await getLocal("lastAccount", null);
    if (!account) return { refused: "open x.com once while logged in, so the account is known" };
    const busy = await dailyBusy();
    if (busy) return { refused: busy };
    const n = Number.isInteger(newest) && newest > 0 ? Math.min(newest, 20) : 0;
    const boundary = n ? null : ((await dailyStates())[account]?.boundary ?? null);
    return { account, jobs: dailyJobs(boundary, { newest: n }) };
  });
}

// Files the kept bundles' finished saves with the knowledge store.
function deliverDaily() {
  return dailyLock(async () => {
    const out = await deliverKept(await loadConfig());
    if (out.stopped) await recordProblem("daily", `filing with the knowledge store: ${out.stopped}`);
    return out;
  });
}

// The daily page's result: the bundle is kept, the account's next state
// recorded (and a problem when the run stopped), then its finished saves
// are filed with the knowledge store. A scheduled page refused at its own
// start (something got busy in between) is retried as busy, inside the
// window.
function recordDaily({ manual, account, result, bundle }) {
  return dailyLock(async () => {
    const now = Date.now();
    await chrome.storage.session.remove("dailyJob");
    const states = await dailyStates();
    const prev = states[account] ?? null;
    if (result?.refused) {
      if (!manual) {
        const plan = planAttempt(prev, now, result.refused);
        if (plan.action === "give_up") {
          await setDailyState(account, skippedDay(prev, plan.cause, now));
          await recordProblem("daily", `daily fetch skipped today: ${plan.cause}`);
        }
        if (plan.at) await chrome.alarms.create(DAILY_ALARM, { when: plan.at });
      }
      return { ok: true, boundary: prev?.boundary ?? null };
    }
    if (bundle) await keepBundle(bundle, { account, manual: Boolean(manual), runId: manual ? `manual-${new Date(now).toISOString()}` : `daily-${chicagoDay(now)}` });
    const delivery = bundle ? await deliverKept(await loadConfig(), { now }) : null;
    const { state, problem } = nextDailyState(prev, { ...result, delivery }, now, { manual: Boolean(manual) });
    await setDailyState(account, state);
    if (problem) await recordProblem("daily", problem);
    // Stopped before reading a save, and not by X: tried again inside the
    // window, or the day is given up at 06:30 (lib/daily.js, retriesInWindow).
    if (retriesInWindow(result, { manual: Boolean(manual) })) {
      const plan = planAttempt(state, now, `the last try stopped before reading Bookmarks (${result.stop.reason}: ${result.stop.detail})`);
      if (plan.action === "give_up") {
        await setDailyState(account, skippedDay(state, plan.cause, now));
        await recordProblem("daily", `daily fetch skipped today: ${plan.cause}`);
      } else if (plan.action === "retry") {
        await setLocal({ dailyWaiting: { since: new Date(now).toISOString(), cause: plan.cause, next: new Date(plan.at).toISOString() } });
      }
      if (plan.at) await chrome.alarms.create(DAILY_ALARM, { when: plan.at });
    }
    else if (delivery?.stopped) await recordProblem("daily", `filing with the knowledge store: ${delivery.stopped}`);
    return { ok: true, boundary: state.boundary, delivery };
  });
}
