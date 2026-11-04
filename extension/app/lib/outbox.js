// Captured batches wait in chrome.storage.local until the Worker accepts
// them, so a closed browser or an offline Worker loses nothing. Each capture
// is stored as its pieces (batch.js), each with its own batch_id. A piece
// leaves the outbox as soon as the body carrying it gets a 2xx, or the Worker
// rejects that body as malformed (4xx other than auth, timeout and 429), so an
// accepted piece is never sent again. A piece whose request failed or got no
// answer is retried with the same batch_id, which the Worker deduplicates.

import { packPieces, splitCapture } from "./batch.js";
import { WorkerError, postIngest } from "./worker-api.js";
import { bumpStats, createLock, getLocal, loadConfig, recordProblem, setLocal } from "./store.js";

// About 2000 home-timeline responses. Past this the oldest pieces are
// dropped and the drop is reported, rather than growing storage without bound
// while the Worker is down.
const OUTBOX_LIMIT = 2000;
const BOOKMARK_MEMORY = 200;
const serial = createLock();

export function enqueue({ account, session_id, mode, batch }) {
  return serial(async () => {
    const { pieces, dropped } = splitCapture(crypto.randomUUID(), batch);
    if (dropped.length) {
      await recordProblem("batch", `dropped ${dropped.length} item(s) larger than one request: ${dropped.slice(0, 3).join(", ")}`);
    }
    const captured_at = new Date().toISOString();
    const outbox = await getLocal("outbox", []);
    for (const piece of pieces) outbox.push({ account, session_id, mode, captured_at, piece });
    const overflow = outbox.length - OUTBOX_LIMIT;
    if (overflow > 0) {
      outbox.splice(0, overflow);
      await recordProblem("outbox", `outbox full: dropped the ${overflow} oldest piece(s)`);
    }
    await setLocal({ outbox });
  });
}

export function flush() {
  return serial(async () => {
    const config = await loadConfig();
    let outbox = await getLocal("outbox", []);
    if (!outbox.length || !config.workerUrl || !config.ingestToken) return;

    const groups = new Map();
    for (const entry of outbox) {
      const key = JSON.stringify([entry.account, entry.session_id, entry.mode]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }

    for (const entries of groups.values()) {
      const { account, session_id, mode, captured_at } = entries[0];
      let bodies;
      try {
        bodies = packPieces({ account, session_id, mode, captured_at }, entries.map((e) => e.piece));
      } catch (err) {
        await recordProblem("batch", `kept ${entries.length} piece(s) that could not be packed: ${err.message}`);
        continue;
      }
      for (const { body, pieceIndexes } of bodies) {
        try {
          await postIngest(config, body);
          await afterAccepted(body);
        } catch (err) {
          const status = err instanceof WorkerError ? err.status : 0;
          const permanent = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
          await recordProblem("worker", permanent ? `dropped pieces the Worker rejected: ${err.message}` : err.message);
          if (!permanent) return;
        }
        // Settled pieces leave storage before the next request, so a service
        // worker stopped mid-flush does not send them again.
        const settled = new Set(pieceIndexes.map((i) => entries[i]));
        outbox = outbox.filter((entry) => !settled.has(entry));
        await setLocal({ outbox });
      }
    }
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
