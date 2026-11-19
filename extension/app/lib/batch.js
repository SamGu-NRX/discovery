// POST /ingest/x bodies are at most 128 KB, the contract's cap
// (docs/CONTRACT.md, POST /ingest/x): in production a 245 KB ingest took
// 15-17 ms of CPU on a cold request, over the Worker's 10 ms limit, and
// 128 KB took 3-8 ms.
//
// Each capture is cut into pieces once, when it is queued: batches with the
// same op and surface, each carrying `batch_id` "<capture uuid>:<piece index>",
// the Worker's idempotency key. Cutting a capture never depends on what else is
// queued, so a piece keeps its id and content across retries. A TweetDetail
// thread rides on the last piece, after every post it names. Bodies are then
// filled with whole pieces.

const MAX_BODY_BYTES = 128 * 1024;
// Room kept in every body for the envelope (account, session_id, mode,
// captured_at and the batches array), so any single piece fits a body alone.
const ENVELOPE_RESERVE = 1024;

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value)).length;

/**
 * @returns {{ pieces: object[], dropped: string[] }} `dropped` lists ids of
 *   posts too large for a body on their own, and "thread:<root_id>" for a
 *   thread that is.
 */
export function splitCapture(captureId, batch, limit = MAX_BODY_BYTES) {
  const budget = limit - ENVELOPE_RESERVE;
  const { posts, thread, ...shell } = batch;
  const pieces = [];
  const dropped = [];
  let piece = null;
  let size = 0;

  const startPiece = () => {
    piece = { batch_id: `${captureId}:${pieces.length}`, ...shell, posts: [] };
    pieces.push(piece);
    size = bytes(piece);
  };
  // The largest an empty piece can be: its index has at most this many digits.
  const emptyPieceSize = bytes({ batch_id: `${captureId}:${posts.length + 1}`, ...shell, posts: [] });

  for (const post of posts) {
    const postSize = bytes(post);
    if (emptyPieceSize + postSize > budget) {
      dropped.push(post.id);
      continue;
    }
    if (!piece || size + postSize + (piece.posts.length ? 1 : 0) > budget) startPiece();
    size += postSize + (piece.posts.length ? 1 : 0);
    piece.posts.push(post);
  }
  if (thread) {
    // Bytes `,"thread":{...}` adds to a piece.
    const threadSize = bytes({ ...shell, posts: [], thread }) - bytes({ ...shell, posts: [] });
    if (emptyPieceSize + threadSize > budget) {
      dropped.push(`thread:${thread.root_id}`);
    } else {
      if (!piece || size + threadSize > budget) startPiece();
      piece.thread = thread;
    }
  }
  return { pieces, dropped };
}

/**
 * Fills bodies with whole pieces, in order.
 * @returns {{ body: object, pieceIndexes: number[] }[]}
 */
export function packPieces(envelope, pieces, limit = MAX_BODY_BYTES) {
  const emptyBody = bytes({ ...envelope, batches: [] });
  if (emptyBody > ENVELOPE_RESERVE) {
    throw new Error(`request envelope is ${emptyBody} bytes, over the ${ENVELOPE_RESERVE}-byte reserve`);
  }
  const out = [];
  let open = null;
  pieces.forEach((piece, index) => {
    const pieceSize = bytes(piece);
    const separator = open?.pieceIndexes.length ? 1 : 0;
    if (!open || open.size + separator + pieceSize > limit) {
      open = { body: { ...envelope, batches: [] }, pieceIndexes: [], size: emptyBody };
      out.push(open);
    }
    open.size += (open.pieceIndexes.length ? 1 : 0) + pieceSize;
    open.body.batches.push(piece);
    open.pieceIndexes.push(index);
  });
  for (const { body } of out) {
    const size = bytes(body);
    if (size > limit) throw new Error(`packPieces built a ${size}-byte body over the ${limit}-byte limit`);
  }
  return out.map(({ body, pieceIndexes }) => ({ body, pieceIndexes }));
}
