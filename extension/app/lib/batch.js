// Splits captured batches into POST /ingest/x bodies of at most 128 KB, the
// contract's cap (docs/CONTRACT.md, POST /ingest/x): in production a 245 KB
// ingest took 15-17 ms of CPU on a cold request, over the Worker's 10 ms
// limit, and 128 KB took 3-8 ms.
// A batch too large for one body is split by posts into several batches with
// the same op and surface; a TweetDetail thread rides on the last piece, after
// every post it names has been sent.

const MAX_BODY_BYTES = 128 * 1024;

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value)).length;

/**
 * @param envelope { account, session_id, mode, captured_at }
 * @param batches  contract batches
 * @returns {{ bodies: object[], dropped: string[], finishedIn: number[] }}
 *   `dropped` lists ids of posts that cannot fit in a body on their own, and
 *   "thread:<root_id>" for a thread that cannot.
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
    const shellSize = bytes({ ...shell, posts: [] });
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
      // Bytes `,"thread":{...}` adds to a piece.
      const threadSize = bytes({ ...shell, posts: [], thread }) - shellSize;
      if (emptyBodySize + shellSize + threadSize > limit) {
        dropped.push(`thread:${thread.root_id}`);
      } else {
        if (!piece || open.size + threadSize > limit) {
          if (piece) closeBody();
          startPiece();
        }
        piece.thread = thread;
        open.size += threadSize;
      }
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
