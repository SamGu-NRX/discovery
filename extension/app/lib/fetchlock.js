// Which fetch-mode run, if any, owns the account's X requests. Sessions and
// fetch runs never overlap: both are admitted here, in the service worker,
// where a check and the claim that follows it run without an await between
// them. The owner is also written to chrome.storage.session (`fetchRun`) so
// a restarted service worker still sees a live run, and so the capture path
// can tell the run's tab apart.
//
// The fetch page sends a heartbeat every 20 s, through rate-limit waits
// too. A run whose page stopped beating for 2 minutes (closed, crashed) no
// longer holds the lock.

export const FETCH_STALE_MS = 120_000;

let owner = null; // { id, heartbeatAt }

const fresh = (heartbeatAt) => Date.now() - heartbeatAt < FETCH_STALE_MS;

// Synchronous, for startSession's first step.
export function fetchRunHeld() {
  return owner !== null && fresh(owner.heartbeatAt);
}

// After an await: also counts a run a previous service worker admitted.
export async function fetchRunHeldAnywhere() {
  if (fetchRunHeld()) return true;
  const { fetchRun } = await chrome.storage.session.get("fetchRun");
  return Boolean(fetchRun && fresh(fetchRun.heartbeatAt));
}

/**
 * Claims the lock for `id` unless a session is running or starting
 * (`sessionBusy`, checked by the caller in the same synchronous step) or
 * another fresh run holds it. Returns null on success or the reason.
 */
export async function acquireFetchRun(id, sessionBusy) {
  if (sessionBusy) return "A session is running or starting.";
  if (fetchRunHeld() && owner.id !== id) return "Another fetch run is going.";
  owner = { id, heartbeatAt: Date.now() };
  // Checked after claiming: a run a previous worker admitted, or a session
  // that has not reported yet. Either releases the claim.
  const { fetchRun, activeSession } = await chrome.storage.session.get(["fetchRun", "activeSession"]);
  if (fetchRun && fetchRun.owner !== id && fresh(fetchRun.heartbeatAt)) {
    owner = null;
    return "Another fetch run is going.";
  }
  if (activeSession && !activeSession.statusSent) {
    owner = null;
    return "A session is running or not yet reported.";
  }
  await chrome.storage.session.set({ fetchRun: { owner: id, heartbeatAt: owner.heartbeatAt, tabId: null, windowId: null } });
  return null;
}

export async function beatFetchRun(id, { tabId = null, windowId = null } = {}) {
  if (!owner || owner.id !== id) return false;
  owner.heartbeatAt = Date.now();
  await chrome.storage.session.set({ fetchRun: { owner: id, heartbeatAt: owner.heartbeatAt, tabId, windowId } });
  return true;
}

export async function releaseFetchRun(id) {
  if (owner?.id === id) owner = null;
  const { fetchRun } = await chrome.storage.session.get("fetchRun");
  if (fetchRun?.owner === id) await chrome.storage.session.remove("fetchRun");
}
