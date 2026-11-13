// When the daily new-saves run starts, waits or gives up, and how its state
// moves (app/lib/daily.js).

import assert from "node:assert/strict";
import { test } from "node:test";

import { chicagoAt, chicagoDay, dailyEnabled, dailyJobs, nextDailyState, planAttempt } from "../app/lib/daily.js";
import { parseJobs } from "../app/lib/fetchrun.js";

const iso = (ms) => new Date(ms).toISOString();
const at = (s) => Date.parse(s);

test("07:00 Chicago is 13:00 UTC in winter and 12:00 UTC in summer, including the days the clocks change", () => {
  assert.equal(iso(chicagoAt("2026-11-13", 7, 0)), "2026-11-13T13:00:00.000Z");
  assert.equal(iso(chicagoAt("2026-07-01", 7, 0)), "2026-07-01T12:00:00.000Z");
  assert.equal(iso(chicagoAt("2026-10-31", 7, 0)), "2026-10-31T12:00:00.000Z", "the day before DST ends");
  assert.equal(iso(chicagoAt("2026-11-01", 7, 0)), "2026-11-01T13:00:00.000Z", "DST ended at 02:00");
  assert.equal(iso(chicagoAt("2026-03-08", 7, 0)), "2026-03-08T12:00:00.000Z", "DST started at 02:00");
  assert.equal(chicagoDay(at("2026-11-13T05:59:00Z")), "2026-11-12", "23:59 Chicago is still the 12th");
  assert.equal(chicagoDay(at("2026-11-13T06:00:00Z")), "2026-11-13");
});

test("the run starts at 07:00, retries every 15 minutes while busy until 07:45, then gives up for the day", () => {
  const day = (hm) => at(`2026-11-13T${hm}:00Z`); // 13:00Z is 07:00 Chicago
  assert.deepEqual(planAttempt(null, day("12:30"), null), { action: "wait", at: day("13:00") });
  assert.deepEqual(planAttempt(null, day("13:00"), null), { action: "run" });
  const busy = "the archive's fetch run is going";
  assert.deepEqual(planAttempt(null, day("13:00"), busy), { action: "retry", at: day("13:15"), cause: busy });
  assert.deepEqual(planAttempt(null, day("13:30"), busy), { action: "retry", at: day("13:45"), cause: busy });
  const late = planAttempt(null, day("13:45"), busy);
  assert.equal(late.action, "give_up");
  assert.match(late.cause, /archive's fetch run is going, still at 07:45/);
  assert.equal(iso(late.at), "2026-11-14T13:00:00.000Z");
  // Chrome was closed through the window: the day is skipped, not run late.
  const missed = planAttempt(null, day("14:10"), null);
  assert.equal(missed.action, "give_up");
  assert.match(missed.cause, /window had passed/);
  // Already run or given up today: tomorrow.
  assert.deepEqual(planAttempt({ lastDay: "2026-11-13" }, day("13:05"), null), { action: "wait", at: day("13:00") + 24 * 3600_000 });
});

test("the daily run is on by default for @sdotgu only, and the popup's setting wins", () => {
  assert.equal(dailyEnabled({ dailyFetch: null }, "sdotgu"), true);
  assert.equal(dailyEnabled({ dailyFetch: null }, "SDotGu"), true);
  assert.equal(dailyEnabled({ dailyFetch: null }, "_sgu_"), false);
  assert.equal(dailyEnabled({ dailyFetch: null }, null), false);
  assert.equal(dailyEnabled({ dailyFetch: false }, "sdotgu"), false);
  assert.equal(dailyEnabled({ dailyFetch: true }, "_sgu_"), true);
});

test("the daily job parses, with x-direct's reply-parent walk, cap 80 and 15 branches", () => {
  const { jobs, limits } = parseJobs(dailyJobs("6"));
  assert.equal(limits.detailCapPerPost, 80);
  assert.equal(limits.branchesPerPost, 15);
  assert.equal(limits.runCap, 400);
  assert.equal(jobs[0].type, "new_saves");
  assert.equal(jobs[0].context.parent, true);
  assert.equal(jobs[0].context.branches, true);
  assert.equal(jobs[0].context.links, false);
  assert.equal(parseJobs(dailyJobs(null, { newest: 3 })).jobs[0].newest, 3);
});

test("after a run the boundary moves to the newest save handled, waiting saves are counted, and a stop names its cause", () => {
  const now = at("2026-11-13T13:20:00Z");
  const saves = { boundary: "6", found: true, top: "1", new: ["1", "2", "3", "4", "5"], taken: ["5", "4", "3"], handled: "3" };
  const done = nextDailyState({ boundary: "6" }, { newSaves: saves, stop: null, requests: 40 }, now);
  assert.equal(done.state.boundary, "3");
  assert.equal(done.state.lastDay, "2026-11-13");
  assert.equal(done.state.last.waiting, 2, "1 and 2");
  assert.equal(done.problem, null);

  const cut = nextDailyState({ boundary: "6" }, { newSaves: { ...saves, handled: "4" }, stop: { reason: "cap", detail: "reached the run cap of 400 requests" }, requests: 400 }, now);
  assert.equal(cut.state.boundary, "4");
  assert.match(cut.problem, /stopped \(cap: reached the run cap of 400 requests\); 3 saves wait/);

  const gone = nextDailyState({ boundary: "77" }, { newSaves: { boundary: "77", found: false, top: "1", new: [], taken: [], handled: null }, stop: null }, now);
  assert.equal(gone.state.boundary, "1");
  assert.match(gone.problem, /no longer in Bookmarks/);

  const manual = nextDailyState({}, { newSaves: { ...saves, boundary: null, found: null, handled: "1", taken: ["3", "2", "1"], new: ["1", "2", "3"] }, stop: null }, now, { manual: true });
  assert.equal(manual.state.boundary, "1");
  assert.equal(manual.state.lastDay, undefined, "a manual test run leaves the scheduled run in place");
});
