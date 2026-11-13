// Whether the current pause may be lifted from the fetch page's "Clear error
// pause" button. Only a pause that comes entirely from requests that failed
// outright (reason "error": a timeout, a closed tab, a page that sent no
// template) may be lifted. Those pause because a dropped request can be X
// refusing, but they are usually the machine; on Nov 12 a disk-full event
// and a CPU-starved machine each paused the archive queue for 24 hours with
// X answering normally. A pause that includes a rate limit, error 88, login
// wall, challenge, a Worker-held pause or anything unrecorded stays.

const DAY_MS = 24 * 3600_000;

/**
 * @param state {
 *   pauseUntil: ISO string or null,
 *   pauseLog: [{ at, until, reason }] as extendPause() records them,
 *   pendingBackOff: the unsent back-off report, or null,
 *   pageSignals: signals pages stored and the worker has not handled yet,
 *   now: ms,
 * }
 * @returns { clearable: true, basis } or { clearable: false, why }
 */
export function errorPauseVerdict({ pauseUntil, pauseLog = [], pendingBackOff = null, pageSignals = {}, now }) {
  if (!pauseUntil || !(Date.parse(pauseUntil) > now)) return { clearable: false, why: "the extension is not paused" };
  if (Object.keys(pageSignals).length) return { clearable: false, why: "an X page reported a signal that has not been handled yet" };
  // Every pause written in the 24 hours before the current one ends.
  const since = Date.parse(pauseUntil) - DAY_MS - 60_000;
  const entries = pauseLog.filter((e) => Date.parse(e.at) >= since);
  if (entries.length) {
    const other = entries.find((e) => e.reason !== "error");
    if (other) return { clearable: false, why: `the pause includes ${other.reason} at ${other.at}` };
    return { clearable: true, basis: `${entries.length} pause record${entries.length > 1 ? "s" : ""}, all failed requests` };
  }
  // A pause written before pauses were logged: its unsent report is the only
  // record of why. One report goes out per 24 hours, so this holds only when
  // that report is a fetch-mode request failure.
  if (pendingBackOff?.status === "error" && /^fetch mode: /.test(pendingBackOff.detail ?? "")) {
    return { clearable: true, basis: `unsent report: ${pendingBackOff.detail}` };
  }
  return { clearable: false, why: "nothing records this pause as a failed request" };
}
