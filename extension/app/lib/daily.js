// The daily new-saves run. At 05:00 America/Chicago the service worker opens
// the daily page (daily.html?auto=daily), which reads Bookmarks down to the
// newest save the last run handled, collects the context of the saves above
// it (the new_saves job in lib/fetchrun.js) and hands the bundle to the
// knowledge store (lib/knowledge.js). The brief that reads it is written at
// 08:00 Chicago. 05:00 leaves kworker about three hours to read every new
// save first; at 07:00 it had under one, and a video save alone can take
// longer (the discovery lead's call, Nov 13). State is kept per account in chrome.storage.local under
// dailyFetch. Everything here is pure, so the tests run it without Chrome.

export const DAILY_ALARM = "daily-fetch";
export const ZONE = "America/Chicago";
const START = [5, 0];
const DEADLINE = [6, 30];
const RETRY_MS = 15 * 60_000;
// An alarm can fire a little late; one due at 06:30 still counts.
const SLACK_MS = 2 * 60_000;

// On by default for these accounts (Sam approved the loop for @sdotgu); the
// popup's checkbox overrides it either way.
const DEFAULT_ON = ["sdotgu"];
export function dailyEnabled(config, account) {
  if (typeof config.dailyFetch === "boolean") return config.dailyFetch;
  return Boolean(account && DEFAULT_ON.includes(account.toLowerCase()));
}

// ---- Chicago time ---------------------------------------------------------

const parts = (ms) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
};

// The Chicago calendar day of `ms`, as YYYY-MM-DD.
export function chicagoDay(ms) {
  const p = parts(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

// The instant that is hh:mm on `day` in Chicago. The zone's offset at that
// instant is found by formatting a guess; twice settles a DST change.
export function chicagoAt(day, hh, mm) {
  const [y, m, d] = day.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let at = wanted;
  for (let i = 0; i < 2; i += 1) {
    const p = parts(at);
    at += wanted - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  }
  return at;
}

const nextDay = (day) => chicagoDay(chicagoAt(day, 12, 0) + 24 * 3600_000);

export function dailyWindow(now) {
  const day = chicagoDay(now);
  return { day, start: chicagoAt(day, ...START), deadline: chicagoAt(day, ...DEADLINE), tomorrow: chicagoAt(nextDay(day), ...START) };
}

// ---- when to run ----------------------------------------------------------

/**
 * What the service worker does when the alarm fires, Chrome starts, or a
 * retry comes due. `busy` is why a run cannot start now, or null: an
 * archive fetch run or fetch page, or a pause after an X signal.
 * Returns one of
 *   { action: "run" }
 *   { action: "wait", at }               before 05:00, or today already done
 *   { action: "retry", at, cause }       busy; again in 15 minutes
 *   { action: "give_up", cause, at }     today's window is over; `at` is tomorrow's 05:00
 */
export function planAttempt(state, now, busy) {
  const w = dailyWindow(now);
  if (state?.lastDay === w.day) return { action: "wait", at: w.tomorrow };
  if (now < w.start) return { action: "wait", at: w.start };
  // Before the account's first run there is nothing to have missed: an
  // install after the day's window waits for tomorrow's.
  if (!state && now > w.deadline + SLACK_MS) return { action: "wait", at: w.tomorrow };
  if (now > w.deadline + SLACK_MS) {
    return { action: "give_up", at: w.tomorrow, cause: `the 05:00–06:30 window had passed when the extension could run it (${new Date(now).toISOString()}); Chrome was closed or asleep` };
  }
  if (!busy) return { action: "run" };
  const retry = now + RETRY_MS;
  if (retry <= w.deadline + SLACK_MS) return { action: "retry", at: retry, cause: busy };
  return { action: "give_up", at: w.tomorrow, cause: `${busy}, still at 06:30` };
}

// ---- the job --------------------------------------------------------------

// The context of each new save, as x-direct collects it: both reply orders,
// the conversation of a save that is a reply (parent), its branches and
// upstream, 80 TweetDetail requests and 15 branches at most per save. No
// searches: the knowledge store fetches linked pages itself. The run stops
// at 400 requests, so a day with more saves than that leaves the rest for
// the next run (nextDailyState).
export function dailyJobs(boundary, { newest = 0 } = {}) {
  return {
    limits: { detailCapPerPost: 80, branchesPerPost: 15 },
    jobs: [
      {
        type: "new_saves",
        boundary,
        maxPages: 20,
        maxSaves: 20,
        ...(newest ? { newest } : {}),
        context: { rankings: ["Relevance", "Recency"], parent: true, branches: true, upstream: true, quotes: false, mentions: false, links: false, conversation: false },
      },
    ],
  };
}

// ---- after a run ----------------------------------------------------------

// X's own signals end the day like any finished run; anything else that
// stopped a scheduled run before it read a save (a page that was slow to
// call Bookmarks, a side nav not yet showing the account) is tried again
// inside the window. A test run on Nov 13 recorded one such run as 0 saves
// taken, and with one attempt a day it would have left the brief empty.
const X_SIGNALS = ["rate_limited", "login_wall", "challenge", "paused"];
export function retriesInWindow(result, { manual = false } = {}) {
  return !manual && !result.newSaves && Boolean(result.stop) && !X_SIGNALS.includes(result.stop.reason);
}

/**
 * The account's next state after a run, and a problem to show when there is
 * one. `result` is what the fetch page reports: { newSaves, stop, requests,
 * delivery }. A run that handled saves moves the boundary to the newest of
 * them. A first run with nothing taken starts from the current top. A
 * boundary X no longer lists (Sam removed that save) restarts from the
 * current top and says the saves in between were not fetched. A run uses
 * up the day unless retriesInWindow says otherwise: the next try is then
 * tomorrow's 05:00.
 */
export function nextDailyState(prev, result, now, { manual = false } = {}) {
  const saves = result.newSaves;
  const stop = result.stop ? `${result.stop.reason}: ${result.stop.detail}` : null;
  const last = {
    at: new Date(now).toISOString(),
    manual,
    requests: result.requests ?? 0,
    stop,
    taken: saves?.taken.length ?? 0,
    waiting: saves ? saves.new.length - (saves.handled ? saves.taken.indexOf(saves.handled) + 1 : 0) : null,
    delivery: result.delivery ?? null,
  };
  // A manual test run, or a scheduled one retried inside the window
  // (retriesInWindow), does not use up the day.
  const base = { ...prev, ...(manual || retriesInWindow(result, { manual }) ? {} : { lastDay: chicagoDay(now) }), last };
  let problem = null;
  let boundary = prev?.boundary ?? null;
  if (saves?.handled) boundary = saves.handled;
  else if (saves?.found === false) {
    boundary = saves.top;
    problem = `daily fetch: the last save it handled (${saves.boundary}) is no longer in Bookmarks; it starts again from ${saves.top}, and saves between the two were not fetched`;
  }
  if (stop) problem = `daily fetch stopped (${stop}); ${last.waiting ?? "its"} saves wait for the next run`;
  else if (!saves) problem = "daily fetch ended without a result";
  return { state: { ...base, boundary }, problem };
}

// A day that could not run: it is recorded, and the next try is tomorrow.
export function skippedDay(prev, cause, now) {
  return { ...prev, lastDay: chicagoDay(now), last: { at: new Date(now).toISOString(), skipped: cause } };
}
