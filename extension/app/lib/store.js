// Config and local state in chrome.storage.local, plus the session-scoped
// page state in chrome.storage.session. Nothing here talks to X or the Worker.

// Session limits come from Sam's brief. A stored config may lower them but
// never raise them: loadConfig() clamps every value to these bounds.
const BOUNDS = {
  intervalHours: { min: 3, max: 48, fallback: 3 },
  jitterMinutes: { min: 0, max: 20, fallback: 20 },
  homeMaxScreens: { min: 1, max: 40, fallback: 40 },
  homeMaxMinutes: { min: 1, max: 6, fallback: 6 },
  bookmarksMaxScreens: { min: 1, max: 15, fallback: 15 },
  detailMaxPosts: { min: 0, max: 5, fallback: 5 },
  detailMaxScreens: { min: 1, max: 4, fallback: 4 },
};

const MODES = ["off", "passive", "active"];

export async function loadConfig() {
  const { config = {} } = await chrome.storage.local.get("config");
  const out = {
    // passive: capture what Sam scrolls. active: passive plus scheduled
    // read-only sessions. off: capture nothing.
    mode: MODES.includes(config.mode) ? config.mode : "passive",
    workerUrl: typeof config.workerUrl === "string" ? config.workerUrl.trim() : "",
    ingestToken: typeof config.ingestToken === "string" ? config.ingestToken.trim() : "",
    // Used only when the logged-in handle cannot be read from X's side nav.
    account: typeof config.account === "string" ? config.account.trim().replace(/^@/, "") : "",
    // When the mode last changed (the popup sets it); captures stored after a
    // switch to Off are dropped against it, at the switch and at startup.
    modeChangedAt: Number.isFinite(config.modeChangedAt) ? config.modeChangedAt : null,
  };
  for (const [key, { min, max, fallback }] of Object.entries(BOUNDS)) {
    const value = Number(config[key]);
    out[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }
  return out;
}

// One writer at a time for a read-modify-write of a storage key. Functions
// run under a lock must not wait on the same lock.
export function createLock() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
}

export async function getLocal(key, fallback) {
  const got = await chrome.storage.local.get(key);
  return got[key] ?? fallback;
}

export function setLocal(values) {
  return chrome.storage.local.set(values);
}

export function localDay(date = new Date()) {
  return date.toLocaleDateString("en-CA");
}

// Per-day counters shown in the popup. `with` is written in the same storage
// call as the counters, so the two cannot be split by a stopped worker.
const statsLock = createLock();
export function bumpStats(change, { with: values = {} } = {}) {
  return statsLock(async () => {
    const today = localDay();
    const stats = await getLocal("stats", null);
    const next = stats?.day === today ? { ...stats } : { day: today, postsSent: 0, parseErrors: 0 };
    for (const [k, v] of Object.entries(change)) next[k] = (next[k] ?? 0) + v;
    await setLocal({ ...values, stats: next });
  });
}

export async function recordProblem(kind, message) {
  await setLocal({ lastProblem: { kind, message: String(message).slice(0, 400), at: new Date().toISOString() } });
  if (kind === "parse") await bumpStats({ parseErrors: 1 });
}

export async function getPauseUntil() {
  const until = await getLocal("pauseUntil", null);
  return until && Date.parse(until) > Date.now() ? until : null;
}

// Pauses sessions until `until` (default 24 hours from now), never
// shortening a later pause already stored. chrome.storage.local survives a
// browser restart, so an awaited call here makes the pause hold whatever
// happens next.
const PAUSE_MS = 24 * 3600_000;
const pauseLock = createLock();
// Pause writes started but not yet stored. A call counts from the moment it
// is made, before any await, so a signal handled in this worker is visible to
// pausedOrPausing() even while its write is still in flight.
let pausesInFlight = 0;
// Each call is logged with its reason (pauseLog, the last 50), so the fetch
// page's "Clear error pause" can tell a pause from failed requests apart
// from one X asked for (lib/unpause.js).
export function extendPause(until = new Date(Date.now() + PAUSE_MS).toISOString(), reason = "unrecorded") {
  pausesInFlight += 1;
  return pauseLock(async () => {
    const existing = await getPauseUntil();
    const log = [...(await getLocal("pauseLog", [])), { at: new Date().toISOString(), until, reason }].slice(-50);
    await setLocal({ pauseLog: log, ...(!existing || Date.parse(existing) < Date.parse(until) ? { pauseUntil: until } : {}) });
  }).finally(() => {
    pausesInFlight -= 1;
  });
}

// Lifts the pause when errorPauseVerdict() allows it, under the same lock as
// extendPause(), and logs the clear (pauseClears, the last 50).
export function clearErrorPause(verdictFor) {
  return pauseLock(async () => {
    if (pausesInFlight > 0) return { clearable: false, why: "a pause is being written" };
    const got = await chrome.storage.local.get(["pauseUntil", "pauseLog", "pendingBackOff"]);
    const verdict = verdictFor({ ...got, pageSignals: await pendingPageSignals(), now: Date.now() });
    if (!verdict.clearable) return verdict;
    const clears = [...(await getLocal("pauseClears", [])), { at: new Date().toISOString(), until: got.pauseUntil, basis: verdict.basis }].slice(-50);
    await chrome.storage.local.remove(["pauseUntil", "backOffReportedUntil", "pendingBackOff"]);
    await setLocal({ pauseClears: clears });
    return verdict;
  });
}

// Back-off signals an X page stored before sending them (bridge.js). Each
// has its own key, so pages never overwrite each other's; the service worker
// removes one once it has paused on it.
export const PAGE_SIGNAL_PREFIX = "pageSignal:";
export async function pendingPageSignals() {
  const keys = chrome.storage.local.getKeys
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  const pending = keys.filter((key) => key.startsWith(PAGE_SIGNAL_PREFIX));
  return pending.length ? chrome.storage.local.get(pending) : {};
}

// True while sessions are paused, a pause is being written, or a page has
// stored a signal not yet paused on.
export async function pausedOrPausing() {
  if (pausesInFlight > 0 || (await getPauseUntil())) return true;
  return Object.keys(await pendingPageSignals()).length > 0;
}

// Per-page capture state (feed offsets, permalink threads), kept in
// chrome.storage.session so a service worker restart mid-scroll does not
// restart positions at 0. Cleared when the browser closes.
const PAGE_STATE_LIMIT = 60;
const pageLock = createLock();

// Runs fn(previous state or null) under a lock and stores what it returns.
export function updatePageState(key, fn) {
  return pageLock(async () => {
    const { pages = {} } = await chrome.storage.session.get("pages");
    const { state, result } = await fn(pages[key] ?? null);
    delete pages[key];
    pages[key] = state;
    const keys = Object.keys(pages);
    for (const old of keys.slice(0, Math.max(0, keys.length - PAGE_STATE_LIMIT))) delete pages[old];
    await chrome.storage.session.set({ pages });
    return result;
  });
}
