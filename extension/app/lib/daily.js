// The daily new-saves run: once a day the service worker opens the fetch
// page in a background tab, which reads Bookmarks down to the newest save
// the last run handled, collects the context of the saves above it (the
// new_saves job in lib/fetchrun.js) and sends everything to the Worker. Off
// unless the popup's "Fetch new saves daily" is ticked. Its state is kept per
// account in chrome.storage.local under dailyFetch.

export const DAILY_ALARM = "daily-fetch";

// The hourly check starts a run once 20 hours have passed since the last
// one that finished, so a day whose usual hour found Chrome closed still
// gets its run later that day. A run that did not finish is tried again
// after 3 hours rather than every hour, so a repeating failure costs X at
// most a few requests a day.
const DAY_GAP_MS = 20 * 3600_000;
const RETRY_GAP_MS = 3 * 3600_000;

export function dailyDue(state, now) {
  if (state?.lastAttemptAt && now - state.lastAttemptAt < RETRY_GAP_MS) return false;
  return !state?.lastRunAt || now - state.lastRunAt >= DAY_GAP_MS;
}

// What a daily run collects for each new save: both reply orders, the
// parent's conversation, branches, upstream, and the first page of quote,
// mention and link searches (2 links a save, so 7 search pages a save;
// newSaves in lib/fetchrun.js explains how 4 saves fit the 400-request cap).
export function dailyJobs(boundary) {
  return {
    limits: { linksPerPost: 2 },
    jobs: [
      {
        type: "new_saves",
        boundary,
        maxSaves: 4,
        context: { rankings: ["Relevance", "Recency"], parent: true, branches: true, upstream: true, quotes: true, mentions: true, links: true, conversation: false },
      },
    ],
  };
}

// The account's next state after a run, and a problem to show when there is
// one. A run that handled saves moves the boundary to the newest of them.
// A boundary X no longer lists (Sam removed that save) restarts from the
// current top and says which saves were not fetched. A run that stopped
// keeps the boundary, so the next run retries the same saves.
export function nextDailyState(prev, bundle, now) {
  const saves = bundle.newSaves;
  const base = { ...prev, lastAttemptAt: now };
  const last = { at: new Date(now).toISOString(), requests: bundle.requests, stop: bundle.stop ? `${bundle.stop.reason}: ${bundle.stop.detail}` : null };
  if (saves?.handled) {
    return { state: { ...base, boundary: saves.handled, lastRunAt: now, last: { ...last, saves: saves.taken.length, waiting: saves.new.length - saves.taken.length } }, problem: null };
  }
  if (!bundle.stop && saves?.found === false) {
    return {
      state: { ...base, boundary: saves.top, lastRunAt: now, last: { ...last, saves: 0, waiting: 0 } },
      problem: `daily fetch: the last save it handled (${saves.boundary}) is no longer in Bookmarks; it starts again from ${saves.top}, and saves between the two were not fetched`,
    };
  }
  if (!bundle.stop && saves && saves.new.length === 0) {
    return { state: { ...base, lastRunAt: now, last: { ...last, saves: 0, waiting: 0 } }, problem: null };
  }
  return { state: { ...base, last: { ...last, saves: 0 } }, problem: `daily fetch did not finish (${last.stop ?? "no result"}); it tries again in 3 hours` };
}
