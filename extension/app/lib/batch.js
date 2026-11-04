// Splits captured batches into POST /ingest/x bodies of at most 256 KB, the
// contract's cap that keeps each request inside the Worker's CPU limit.
// A batch too large for one body is split by posts into several batches with
// the same op and surface; a TweetDetail thread rides on the last piece, after
// every post it names has been sent.

export const MAX_BODY_BYTES = 256 * 1024;

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value)).length;

/**
 * @param envelope { account, session_id, mode, captured_at }
 * @param batches  contract batches
 * @returns {{ bodies: object[], dropped: string[], finishedIn: number[] }}
 *   `dropped` lists ids of posts that cannot fit in a body on their own.
 *   `finishedIn[i]` is the index of the body carrying the last piece of
 *   batches[i], or -1 when nothing of it was sent; once that body and every
 *   body before it are accepted, batches[i] is fully delivered.
 */
export function packRequests(envelope, batches, limit = MAX_BODY_BYTES) {
  const emptyBodySize = bytes({ ...envelope, batches: [] });
  const bodies = [];
  const dropped = [];
  const finishedIn = [];
  let open = { batches: [], size: emptyBodySize };

  const closeBody = () => {
    if (open.batches.length) bodies.push({ ...envelope, batches: open.batches });
    open = { batches: [], size: emptyBodySize };
  };

  for (const batch of batches) {
    const { posts, thread, ...shell } = batch;
    // Every piece reserves room for the thread, so whichever piece ends up
    // last can carry it without going over.
    const shellSize = bytes({ ...shell, posts: [], ...(thread ? { thread } : {}) });
    let piece = null;

    const startPiece = () => {
      const cost = shellSize + (open.batches.length ? 1 : 0);
      if (open.size + cost > limit) closeBody();
      piece = { ...shell, posts: [] };
      open.batches.push(piece);
      open.size += shellSize + (open.batches.length > 1 ? 1 : 0);
    };

    for (const post of posts) {
      const postSize = bytes(post);
      if (emptyBodySize + shellSize + postSize > limit) {
        dropped.push(post.id);
        continue;
      }
      if (!piece) startPiece();
      const cost = postSize + (piece.posts.length ? 1 : 0);
      if (open.size + cost > limit) {
        closeBody();
        startPiece();
        piece.posts.push(post);
        open.size += postSize;
      } else {
        piece.posts.push(post);
        open.size += cost;
      }
    }
    if (thread) {
      if (!piece) startPiece();
      piece.thread = thread;
    }
    finishedIn.push(piece ? bodies.length : -1);
  }
  closeBody();

  for (const body of bodies) {
    const size = bytes(body);
    if (size > limit) throw new Error(`packRequests built a ${size}-byte body over the ${limit}-byte limit`);
  }
  return { bodies, dropped, finishedIn };
}
