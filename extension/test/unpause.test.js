// Which pauses the fetch page's "Clear error pause" may lift (app/lib/unpause.js).

import assert from "node:assert/strict";
import { test } from "node:test";

import { errorPauseVerdict } from "../app/lib/unpause.js";

const NOW = Date.parse("2026-11-12T23:00:00Z");
const UNTIL = "2026-11-13T21:57:00Z"; // set at 21:57 on Nov 12
const at = (iso) => ({ at: iso, until: UNTIL });

test("a pause made only of failed requests may be cleared; one that includes anything else may not", () => {
  const errorOnly = [{ ...at("2026-11-12T21:57:00Z"), reason: "error" }, { ...at("2026-11-12T22:10:00Z"), reason: "error" }];
  assert.deepEqual(errorPauseVerdict({ pauseUntil: UNTIL, pauseLog: errorOnly, now: NOW }), { clearable: true, basis: "2 pause records, all failed requests" });

  for (const reason of ["rate_limited", "login_wall", "challenge", "unrecorded"]) {
    const v = errorPauseVerdict({ pauseUntil: UNTIL, pauseLog: [...errorOnly, { ...at("2026-11-12T22:30:00Z"), reason }], now: NOW });
    assert.equal(v.clearable, false, reason);
    assert.match(v.why, new RegExp(reason));
  }

  // A rate limit from more than a day before the pause ends belongs to an
  // earlier pause and does not hold this one.
  const old = [{ ...at("2026-11-11T20:00:00Z"), reason: "rate_limited" }, ...errorOnly];
  assert.equal(errorPauseVerdict({ pauseUntil: UNTIL, pauseLog: old, now: NOW }).clearable, true);
});

test("a pause written before pauses were logged is cleared only on an unsent fetch-mode failure report", () => {
  const failure = { status: "error", detail: "fetch mode: TweetDetail request failed: signal timed out" };
  assert.equal(errorPauseVerdict({ pauseUntil: UNTIL, pendingBackOff: failure, now: NOW }).clearable, true);
  assert.equal(errorPauseVerdict({ pauseUntil: UNTIL, pendingBackOff: { ...failure, status: "rate_limited" }, now: NOW }).clearable, false);
  assert.equal(errorPauseVerdict({ pauseUntil: UNTIL, pendingBackOff: { status: "error", detail: "session: home timed out" }, now: NOW }).clearable, false);
  assert.equal(errorPauseVerdict({ pauseUntil: UNTIL, pendingBackOff: null, now: NOW }).clearable, false);
});

test("nothing is cleared without a pause, or while a page's X signal waits to be handled", () => {
  assert.equal(errorPauseVerdict({ pauseUntil: null, now: NOW }).why, "the extension is not paused");
  assert.equal(errorPauseVerdict({ pauseUntil: "2026-11-12T22:00:00Z", now: NOW }).clearable, false, "an expired pause is not a pause");
  const v = errorPauseVerdict({ pauseUntil: UNTIL, pauseLog: [{ ...at("2026-11-12T21:57:00Z"), reason: "error" }], pageSignals: { "pageSignal:1": { reason: "rate_limited" } }, now: NOW });
  assert.equal(v.clearable, false);
});
