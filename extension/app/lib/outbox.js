// Captured batches wait in chrome.storage.local until the Worker accepts
// them, so a closed browser or an offline Worker loses nothing. An entry
// leaves the outbox only after every body carrying part of it got a 2xx, or
// after the Worker rejected it as malformed (4xx other than auth and 429).

import { packRequests } from "./batch.js";
import { WorkerError, postIngest } from "./worker-api.js";
import { bumpStats, createLock, getLocal, loadConfig, recordProblem, setLocal } from "./store.js";

// About 2000 home-timeline responses. Past this the oldest entries are
// dropped and the drop is reported, rather than growing storage without bound
// while the Worker is down.
const OUTBOX_LIMIT = 2000;
const BOOKMARK_MEMORY = 200;
const serial = createLock();

export function enqueue({ account, session_id, mode, batch }) {
  return serial(async () => {
    const outbox = await getLocal("outbox", []);
    outbox.push({ account, session_id, mode, captured_at: new Date().toISOString(), batch });
    const overflow = outbox.length - OUTBOX_LIMIT;
    if (overflow > 0) {
      outbox.splice(0, overflow);
      await recordProblem("outbox", `outbox full: dropped the ${overflow} oldest captured batch(es)`);
    }
    await setLocal({ outbox });
  });
}

export function flush() {
  return serial(async () => {
    const config = await loadConfig();
    const outbox = await getLocal("outbox", []);
    if (!outbox.length || !config.workerUrl || !config.ingestToken) return;

    const done = new Set();
    const groups = new Map();
    outbox.forEach((entry, index) => {
      const key = JSON.stringify([entry.account, entry.session_id, entry.mode]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });

    let blocked = null;
    for (const indexes of groups.values()) {
      const first = outbox[indexes[0]];
      const envelope = {
        account: first.account,
        session_id: first.session_id,
        mode: first.mode,
        captured_at: first.captured_at,
      };
      let packed;
      try {
        packed = packRequests(envelope, indexes.map((i) => outbox[i].batch));
      } catch (err) {
        indexes.forEach((i) => done.add(i));
        await recordProblem("batch", `dropped ${indexes.length} batch(es) that could not be packed: ${err.message}`);
        continue;
      }
      if (packed.dropped.length) {
        await recordProblem("batch", `dropped ${packed.dropped.length} post(s) larger than one request: ${packed.dropped.slice(0, 3).join(", ")}`);
      }

      // Bodies go one at a time in order; `settled` is the last body the
      // Worker either accepted or rejected for good.
      let settled = -1;
      for (const [bodyIndex, body] of packed.bodies.entries()) {
        try {
          await postIngest(config, body);
          await afterAccepted(body);
        } catch (err) {
          const status = err instanceof WorkerError ? err.status : 0;
          const permanent = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
          await recordProblem("worker", permanent ? `dropped a batch the Worker rejected: ${err.message}` : err.message);
          if (!permanent) {
            blocked = err;
            break;
          }
        }
        settled = bodyIndex;
      }
      packed.finishedIn.forEach((bodyIndex, k) => {
        if (bodyIndex <= settled) done.add(indexes[k]);
      });
      if (blocked) break;
    }

    // enqueue() waits on the same serial lock, so the outbox has not changed
    // since it was read above.
    await setLocal({ outbox: outbox.filter((_, i) => !done.has(i)) });
  });
}

async function afterAccepted(body) {
  let posts = 0;
  for (const batch of body.batches) {
    posts += batch.posts.length;
    if (batch.surface === "bookmarks" && batch.posts.length) await rememberBookmarks(batch.posts);
  }
  await bumpStats({ postsSent: posts });
}

// The newest 200 bookmark ids already delivered, newest first. A session
// stops scrolling bookmarks once it reaches one of them. A page that starts at
// the top of the list (position 0) holds the newest bookmarks; later pages
// are older and go to the back, where the cap trims.
async function rememberBookmarks(posts) {
  const ids = [...posts].sort((a, b) => a.position - b.position).map((p) => p.id);
  const fresh = new Set(ids);
  const known = (await getLocal("sentBookmarkIds", [])).filter((id) => !fresh.has(id));
  const merged = posts.some((p) => p.position === 0) ? [...ids, ...known] : [...known, ...ids];
  await setLocal({ sentBookmarkIds: merged.slice(0, BOOKMARK_MEMORY) });
}
