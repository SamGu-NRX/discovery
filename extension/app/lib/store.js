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

// Per-day counters shown in the popup.
const statsLock = createLock();
export function bumpStats(change) {
  return statsLock(async () => {
    const today = localDay();
    const stats = await getLocal("stats", null);
    const next = stats?.day === today ? { ...stats } : { day: today, postsSent: 0, parseErrors: 0 };
    for (const [k, v] of Object.entries(change)) next[k] = (next[k] ?? 0) + v;
    await setLocal({ stats: next });
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
