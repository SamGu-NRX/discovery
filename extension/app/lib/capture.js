import { contractOp, focalTweetIdFromUrl } from "./ops.js";
import { parseResponse } from "./parse.js";
import { extendThread } from "./thread.js";

/**
 * One captured GraphQL response -> one contract batch.
 *
 * `offset` is how many posts earlier responses of the same operation put on
 * this page, so `position` counts down the whole feed, not just this response.
 * Throws ParseError when the response does not match the expected shape.
 */
export function captureToBatch({ operation, json, url, offset, threadState = null }) {
  const { op, surface } = contractOp(operation);
  const focalId = operation === "TweetDetail" ? focalTweetIdFromUrl(url) : null;
  const { items, rateLimited } = parseResponse(operation, json, { focalId });

  // Every post in a bookmarks batch is marked bookmarked by the Worker, so
  // quoted and reposted originals stay out of it; the bookmarked post still
  // names them in quoted_id and retweet_of_id.
  const kept = surface === "bookmarks" ? items.filter((i) => i.role !== "embedded") : items;
  const ordered = [...kept].sort((a, b) => a.slot - b.slot || (a.role === "embedded") - (b.role === "embedded"));
  const posts = ordered.map((i) => ({ ...i.post, position: offset + i.slot }));
  const advance = items.filter((i) => i.role !== "embedded").length;

  let thread = null;
  let threadError = null;
  let nextThreadState = threadState;
  if (op === "TweetDetail") {
    const built = extendThread(threadState, items, focalId);
    if (built.error) threadError = built.error;
    else {
      thread = built.thread;
      nextThreadState = built.state;
    }
  }

  const batch = posts.length || thread ? { op, surface, posts, ...(thread ? { thread } : {}) } : null;
  return { batch, advance, threadState: nextThreadState, threadError, rateLimited, focalId };
}
