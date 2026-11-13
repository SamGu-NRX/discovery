// The daily new-saves run. At 07:00 America/Chicago the service worker opens
// the fetch page (fetch.html?auto=daily), which reads Bookmarks down to the
// newest save the last run handled, collects the context of the saves above
// it (the new_saves job in lib/fetchrun.js) and hands the bundle to the
// knowledge store (lib/knowledge.js). The brief that reads it is written at
// 08:00 Chicago. State is kept per account in chrome.storage.local under
// dailyFetch. Everything here is pure, so the tests run it without Chrome.

export const DAILY_ALARM = "daily-fetch";
export const ZONE = "America/Chicago";
const START = [7, 0];
const DEADLINE = [7, 45];
const RETRY_MS = 15 * 60_000;
// An alarm can fire a little late; one due at 07:45 still counts.
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
 *   { action: "wait", at }               before 07:00, or today already done
 *   { action: "retry", at, cause }       busy; again in 15 minutes
 *   { action: "give_up", cause, at }     today's window is over; `at` is tomorrow's 07:00
 */
export function planAttempt(state, now, busy) {
  const w = dailyWindow(now);
  if (state?.lastDay === w.day) return { action: "wait", at: w.tomorrow };
  if (now < w.start) return { action: "wait", at: w.start };
  if (now > w.deadline + SLACK_MS) {
    return { action: "give_up", at: w.tomorrow, cause: `the 07:00–07:45 window had passed when the extension could run it (${new Date(now).toISOString()}); Chrome was closed or asleep` };
  }
  if (!busy) return { action: "run" };
  const retry = now + RETRY_MS;
  if (retry <= w.deadline + SLACK_MS) return { action: "retry", at: retry, cause: busy };
  return { action: "give_up", at: w.tomorrow, cause: `${busy}, still at 07:45` };
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

/**
 * The account's next state after a run, and a problem to show when there is
 * one. `result` is what the fetch page reports: { newSaves, stop, requests,
 * delivery }. A run that handled saves moves the boundary to the newest of
 * them. A first run with nothing taken starts from the current top. A
 * boundary X no longer lists (Sam removed that save) restarts from the
 * current top and says the saves in between were not fetched. Every run,
 * finished or not, uses up the day: the next try is tomorrow's 07:00.
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
  // A manual test run does not use up the day's scheduled run.
  const base = { ...prev, ...(manual ? {} : { lastDay: chicagoDay(now) }), last };
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
