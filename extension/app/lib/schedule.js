// When the next active session runs: at least `intervalHours` (3 or more)
// after the last session started, never before a pause ends, plus up to
// `jitterMinutes` (20 at most) of random delay.

import { getLocal, getPauseUntil, loadConfig, setLocal } from "./store.js";

export const SESSION_ALARM = "session";

export async function scheduleNext() {
  const config = await loadConfig();
  if (config.mode !== "active") {
    await chrome.alarms.clear(SESSION_ALARM);
    await setLocal({ nextSessionAt: null });
    return;
  }
  const last = await getLocal("lastSession", null);
  const pause = await getPauseUntil();
  let earliest = Date.now() + 60_000;
  if (last?.startedAt) earliest = Math.max(earliest, Date.parse(last.startedAt) + config.intervalHours * 3600_000);
  if (pause) earliest = Math.max(earliest, Date.parse(pause));
  const when = earliest + Math.random() * config.jitterMinutes * 60_000;
  await chrome.alarms.create(SESSION_ALARM, { when });
  await setLocal({ nextSessionAt: new Date(when).toISOString() });
}

// Checked again when the alarm fires: a session started by hand after the
// alarm was set moves the 3-hour floor.
export async function intervalElapsed() {
  const config = await loadConfig();
  const last = await getLocal("lastSession", null);
  if (!last?.startedAt) return true;
  return Date.now() >= Date.parse(last.startedAt) + config.intervalHours * 3600_000;
}
