// Captured batches wait in chrome.storage.local until the Worker accepts
// them, so a closed browser or an offline Worker loses nothing. Each capture
// is stored as its pieces (batch.js), each with its own batch_id. A piece
// leaves the outbox as soon as the body carrying it gets a 2xx, or the Worker
// rejects that body as malformed (400, 413, 422). A piece whose request
// failed or got no answer is retried with the same batch_id, which the
// Worker deduplicates.

import { packPieces, splitCapture } from "./batch.js";
import { WorkerError, postIngest } from "./worker-api.js";
import { bumpStats, createLock, getLocal, loadConfig, recordProblem, setLocal } from "./store.js";

// chrome.storage.local holds 10 MiB (QUOTA_BYTES, counted as each key plus
// the JSON of its value). The outbox may use 7 MiB, measured in UTF-8 bytes,
// which is never less than Chrome's count. The other 3 MiB stay free for the
// small keys the extension must always be able to write: config, stats,
// session records, sent bookmark ids. While the Worker is unreachable the
// outbox fills; past the budget its oldest pieces are dropped and the drop is
// reported in the popup. 7 MiB is a few hundred captured responses, more
// than a day of browsing.
const OUTBOX_BUDGET_BYTES = 7 * 1024 * 1024;
const BOOKMARK_MEMORY = 200;
const serial = createLock();
const encoder = new TextEncoder();
// Stored with each entry so the budget check does not re-encode the outbox.
const sizeOf = (entry) => encoder.encode(JSON.stringify(entry)).length + 32;

// Returns false, storing nothing, when capture is Off by the time the write
// happens; the mode is read under the outbox lock, after every earlier await
// in the capture's path.
export function enqueue({ account, session_id, mode, batch }) {
  return serial(async () => {
    if ((await loadConfig()).mode === "off") return false;
    const { pieces, dropped } = splitCapture(crypto.randomUUID(), batch);
    if (dropped.length) {
      await recordProblem("batch", `dropped ${dropped.length} item(s) larger than one request: ${dropped.slice(0, 3).join(", ")}`);
    }
    const captured_at = new Date().toISOString();
    const outbox = await getLocal("outbox", []);
    for (const piece of pieces) {
      const entry = { account, session_id, mode, captured_at, piece };
      outbox.push({ ...entry, bytes: sizeOf(entry) });
    }
    let total = outbox.reduce((sum, entry) => sum + entry.bytes, 0);
    let overflow = 0;
    // Oldest first, the new capture's own early pieces included if it alone
    // is over budget.
    while (total > OUTBOX_BUDGET_BYTES && outbox.length > 1) {
      total -= outbox.shift().bytes;
      overflow += 1;
    }
    if (overflow) await recordProblem("outbox", `outbox full: dropped the ${overflow} oldest piece(s) not yet sent`);
    await storeOutbox(outbox);
    return true;
  });
}

// The budget leaves room for everything else, but if Chrome still refuses
// the write (other keys grew), the older half of the outbox goes, then half
// again, rather than losing the new capture and every later one. The problem
// is recorded only after space is freed, since recording it needs space too.
async function storeOutbox(outbox) {
  let kept = outbox;
  let failure = null;
  for (;;) {
    try {
      await setLocal({ outbox: kept });
      break;
    } catch (err) {
      if (kept.length <= 1) throw err;
      failure ??= err;
      kept = kept.slice(Math.ceil(kept.length / 2));
    }
  }
  if (failure) {
    await recordProblem("outbox", `storage refused the outbox (${failure.message}); dropped the ${outbox.length - kept.length} oldest piece(s)`).catch(() => {});
  }
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
        let accepted = false;
        try {
          await postIngest(config, body);
          accepted = true;
        } catch (err) {
          const status = err instanceof WorkerError ? err.status : 0;
          // Malformed (400), too large (413) or unprocessable (422) cannot
          // succeed on resend; every other failure, a 404 from a mistyped or
          // redeploying Worker included, is retried.
          const permanent = [400, 413, 422].includes(status);
          await recordProblem("worker", permanent ? `dropped pieces the Worker rejected: ${err.message}` : err.message);
          if (!permanent) return;
        }
        // Settled pieces leave storage first, before any other bookkeeping,
        // so the window in which a stopped service worker would resend them
        // is this one write. A resend inside it is harmless: the Worker
        // ignores a batch_id it has already applied.
        const settled = new Set(pieceIndexes.map((i) => entries[i]));
        outbox = outbox.filter((entry) => !settled.has(entry));
        await setLocal({ outbox });
        if (accepted) await afterAccepted(body);
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
