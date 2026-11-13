// Bundles the daily run made (lib/daily.js), kept in chrome.storage.local
// and filed save by save with the knowledge store's intake (POST /k/intake,
// kintake/1, lib/intake.js). Only the service worker calls these, under its
// daily lock, so one writer owns the list.
//
// How each answer is handled:
// - 201 or 200: filed (200: it was already filed; the same body changes
//   nothing).
// - 409: the store is still working on that save; the pass stops and the
//   rest is retried later.
// - 400 or 413: that save's body is refused; it is marked rejected with the
//   store's message and not sent again, and the pass stops and reports it.
// - 401, 403, anything else, or no answer: the pass stops and everything is
//   retried later. Until the intake route is deployed it answers 401.

import { finishedSaves, intakeFor } from "./intake.js";
import { getLocal, setLocal } from "./store.js";

const KEY = "dailyBundles";
// chrome.storage.local allows 10 MB without unlimitedStorage; a daily
// bundle has been 0.3 to 1 MB. The oldest goes first, delivered or not.
export const MAX_KEPT = 3;
// After a pass stops, the next one waits this long.
export const RETRY_MS = 15 * 60_000;

export async function keepBundle(bundle, { account, manual, runId }) {
  const kept = await getLocal(KEY, []);
  const entry = { id: bundle.session_id, at: new Date().toISOString(), account, manual, runId, bytes: JSON.stringify(bundle).length, delivered: false, deliveries: {}, bundle };
  const all = [...kept, entry];
  const dropped = all.length > MAX_KEPT ? all.slice(0, all.length - MAX_KEPT).filter((e) => !e.delivered).map((e) => e.id) : [];
  await setLocal({ [KEY]: all.slice(-MAX_KEPT) });
  return { id: entry.id, dropped };
}

// For the popup: what is kept, without the bundles themselves.
export async function keptBundles() {
  return (await getLocal(KEY, [])).map(({ bundle, ...rest }) => ({ ...rest, saves: finishedSaves(bundle).length }));
}

export async function deliveryDue(now = Date.now()) {
  const next = await getLocal("intakeNextAt", 0);
  if (next > now) return false;
  return (await getLocal(KEY, [])).some((e) => !e.delivered);
}

/**
 * Files every finished save of every kept bundle not yet filed. `post` is
 * fetch (tests pass a fake). Returns { filed, rejected, stopped }.
 */
export async function deliverKept(config, { post = fetch, now = Date.now() } = {}) {
  const out = { filed: 0, rejected: 0, stopped: null };
  if (!config.workerUrl || !config.intakeToken) {
    out.stopped = "no Worker URL or intake token is set";
    return out;
  }
  const kept = await getLocal(KEY, []);
  const at = new Date(now).toISOString();
  pass: for (const entry of kept) {
    if (entry.delivered) continue;
    entry.deliveries ??= {};
    const saves = finishedSaves(entry.bundle);
    for (const id of saves) {
      if (entry.deliveries[id]) continue;
      const made = intakeFor(entry.bundle, id, { runId: entry.runId, account: entry.account, capturedAt: entry.bundle.ended_at });
      if (made.skip) {
        entry.deliveries[id] = { state: "rejected", at, message: made.skip };
        out.rejected += 1;
        continue;
      }
      let res;
      try {
        res = await post(`${config.workerUrl}/k/intake`, {
          method: "POST",
          redirect: "error",
          headers: { authorization: `Bearer ${config.intakeToken}`, "content-type": "application/json" },
          body: JSON.stringify(made.body),
        });
      } catch (err) {
        out.stopped = `the intake did not answer: ${err.message}`;
        break pass;
      }
      if (res.status === 200 || res.status === 201) {
        const answer = await res.json().catch(() => null);
        entry.deliveries[id] = { state: "filed", at, code: res.status, job: answer?.job ?? null };
        out.filed += 1;
      } else if (res.status === 409) {
        out.stopped = `the intake is still working on post ${id} (409); retried later`;
        break pass;
      } else if (res.status === 400 || res.status === 413) {
        const message = (await res.text().catch(() => "")).slice(0, 300);
        entry.deliveries[id] = { state: "rejected", at, code: res.status, message };
        out.rejected += 1;
        out.stopped = `the intake refused post ${id} (${res.status}): ${message}`;
        break pass;
      } else {
        out.stopped = `the intake answered ${res.status}${res.status === 401 || res.status === 403 ? " (token not accepted, or the route not deployed yet)" : ""}; retried later`;
        break pass;
      }
    }
    if (saves.every((id) => entry.deliveries[id])) entry.delivered = true;
  }
  await setLocal({ [KEY]: kept, intakeNextAt: out.stopped ? now + RETRY_MS : 0 });
  return out;
}
