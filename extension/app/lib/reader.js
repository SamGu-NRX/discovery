// The lens reader (docs/LENS.md): skims a lens account's home feed the way
// Sam would, so the time spent on each post tells X's ranker what the lens
// cares about. It only scrolls, pauses and opens permalinks the session
// built; it never clicks, likes, follows or marks anything "Not interested".
// All I/O comes in through `io`, so tests drive it with a manual clock;
// app/lib/session.js wires it to the session window.

// How long a post stays in view for each label, before jitter. The brief's
// numbers (skim about 1 s, glance about 4 s, open about 20 s); no
// measurement of X's dwell signal is behind them.
export const DWELL_MS = Object.freeze({ skip: 1000, glance: 4000, open: 20000 });
// Each dwell is multiplied by a random factor in [1 - JITTER, 1 + JITTER].
const JITTER = 0.25;
// Posts labeled per Worker call.
const LABEL_BATCH = 20;
// How long to wait before looking for a post a second time.
const RETRY_MS = 1500;
// Screens scrolled without a new post before the feed counts as dry.
const DRY_SCREENS = 6;

/**
 * @param io {
 *   now(): ms, random(): [0,1), pause(ms): Promise (throws when the session stops),
 *   take(n): up to n posts captured from the home feed, in feed order, that
 *       were not handed out before (each { id, text, author_handle, author_followed }),
 *   onRead(read): optional, each read as it happens, and again when an open
 *       adds its permalink dwell, so a session that stops keeps what it read,
 *   scrollScreen(): Promise, scrollToPost(id): Promise<boolean> (false: not on the page),
 *   label(posts): Promise<{ source, labels: [{ id, action, taste, novelty, project }] }>,
 *   openPermalink(id): Promise (navigates there and returns once it has loaded),
 *   leavePermalink(): Promise, readPermalink(): Promise (scrolls it a little),
 * }
 * @param limits { maxPosts, maxMs, openShare }
 * @returns {{ reads, opened, stop: string }}
 */
export async function readFeed(io, { maxPosts, maxMs, openShare = 0.1 }) {
  const started = io.now();
  const reads = [];
  let dry = 0;
  let stop = "max_posts";
  while (reads.length < maxPosts) {
    if (io.now() - started >= maxMs) {
      stop = "max_time";
      break;
    }
    const pending = io.take(LABEL_BATCH);
    if (!pending.length) {
      if (dry >= DRY_SCREENS) {
        stop = "feed_dry";
        break;
      }
      dry += 1;
      await io.scrollScreen();
      await io.pause(jittered(io, 2500));
      continue;
    }
    dry = 0;
    const { source, labels } = await io.label(pending);
    const byId = new Map(labels.map((l) => [l.id, l]));
    for (const post of pending) {
      if (reads.length >= maxPosts || io.now() - started >= maxMs) break;
      const label = byId.get(post.id);
      if (!label) throw new Error(`the labeler returned nothing for post ${post.id}`);
      // X may render a post a moment after its response arrives, so a post
      // not on the page yet gets one more look; one X has already unloaded
      // cannot be dwelt on.
      if (!(await io.scrollToPost(post.id))) {
        await io.pause(RETRY_MS);
        if (!(await io.scrollToPost(post.id))) continue;
      }
      const dwell = jittered(io, DWELL_MS[label.action]);
      await io.pause(dwell);
      const read = {
        post_id: post.id,
        action: label.action,
        dwell_ms: dwell,
        taste: label.taste ?? null,
        novelty: label.novelty ?? null,
        project: label.project ?? null,
        label_source: source,
        at: new Date(io.now()).toISOString(),
      };
      reads.push(read);
      io.onRead?.(read);
    }
  }
  if (io.now() - started >= maxMs) stop = "max_time";

  // Open about openShare of what was read, the posts labeled open with the
  // highest taste, each on its own permalink, where X shows it in full.
  const toOpen = reads
    .filter((r) => r.action === "open")
    .sort((a, b) => (b.taste ?? 0) - (a.taste ?? 0))
    .slice(0, Math.max(0, Math.round(reads.length * openShare)));
  const opened = [];
  for (const read of toOpen) {
    await io.openPermalink(read.post_id);
    const dwell = jittered(io, DWELL_MS.open);
    const half = Math.round(dwell / 2);
    await io.pause(half);
    await io.readPermalink();
    await io.pause(dwell - half);
    read.dwell_ms += dwell;
    io.onRead?.(read);
    opened.push(read.post_id);
  }
  if (opened.length) await io.leavePermalink();
  return { reads, opened, stop };
}

/**
 * Day 1: records the untouched For You top `count` without dwelling on
 * anything in particular, one screen every 2 to 4 seconds.
 * @returns {{ posts, stop }}
 */
export async function recordBaseline(io, { count = 100, maxScreens = 80 }) {
  const posts = [];
  let screens = 0;
  while (posts.length < count) {
    posts.push(...io.take(count - posts.length));
    if (posts.length >= count) break;
    if (screens >= maxScreens) return { posts, stop: "max_screens" };
    screens += 1;
    await io.scrollScreen();
    await io.pause(2000 + io.random() * 2000);
  }
  return { posts, stop: "complete" };
}

function jittered(io, ms) {
  return Math.round(ms * (1 - JITTER + io.random() * 2 * JITTER));
}
