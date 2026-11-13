// Bundles the daily run made (lib/daily.js), kept in chrome.storage.local
// until the knowledge store has them. The store's intake route and its
// schema come from the knowledge lead; until they are wired in here, every
// bundle waits, and the popup shows how many. Kept, so a 07:00 run is never
// lost: at most MAX_KEPT, the oldest dropped first and reported.

import { getLocal, setLocal } from "./store.js";

const KEY = "dailyBundles";
// chrome.storage.local allows 10 MB without unlimitedStorage; a daily
// bundle has been 0.3 to 1 MB.
export const MAX_KEPT = 3;

export async function keepBundle(bundle, { account, manual }) {
  const kept = await getLocal(KEY, []);
  const entry = { id: bundle.session_id, at: new Date().toISOString(), account, manual, bytes: JSON.stringify(bundle).length, delivered: null, bundle };
  const all = [...kept, entry];
  const dropped = all.length > MAX_KEPT ? all.slice(0, all.length - MAX_KEPT).map((e) => e.id) : [];
  await setLocal({ [KEY]: all.slice(-MAX_KEPT) });
  return { id: entry.id, bytes: entry.bytes, dropped };
}

// For the popup: what is waiting, without the bundles themselves.
export async function keptBundles() {
  return (await getLocal(KEY, [])).map(({ bundle, ...rest }) => ({ ...rest, saves: bundle.newSaves?.taken.length ?? 0 }));
}

// What the run reports as its delivery. Wired to the knowledge store's route
// once its schema is agreed; until then the bundle is kept and says why.
export function deliveryOf(kept) {
  return { delivered: false, kept: kept.id, bytes: kept.bytes, dropped: kept.dropped, why: "the knowledge store's intake route is not wired in yet; the bundle waits in extension storage" };
}
