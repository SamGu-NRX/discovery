// One save of a daily run as the knowledge store's intake takes it:
// kintake/1, one save per POST /k/intake (docs/KNOWLEDGE.md, "Daily loop",
// on mvp-loop). Pure, so the tests run it on a bundle without Chrome. Only
// what the fetch run read goes in; no cookie or session value is in a
// bundle to begin with.

export const MAX_BYTES = 192 * 1024;
const MAX_CONTEXT = 120;
const MAX_MEDIA = 20;
const MAX_LINKS = 50;

// The views in the order context is filled when it has to be cut: the
// replies X ranks first, then the newest, then the parent's conversation,
// then reply branches.
const VIEWS = [
  ["relevant", (r) => r.orders?.Relevance?.thread?.reply_ids],
  ["recent", (r) => r.orders?.Recency?.thread?.reply_ids],
  ["parent", (r) => r.parent?.thread?.reply_ids],
];

const MEDIA_KIND = { photo: "photo", video: "video", animated_gif: "gif" };

// Each t.co in the post with its target (lib/parse.js, links), so the
// knowledge store never has to open t.co. A bundle parsed before links were
// kept has targets only; those go as both url and expanded.
function linksOf(p) {
  if (Array.isArray(p.links)) return p.links.slice(0, MAX_LINKS).map((l) => ({ url: l.url, expanded: l.expanded }));
  return (p.urls ?? []).slice(0, MAX_LINKS).map((u) => ({ url: u, expanded: u }));
}

function postObject(posts, id, { withQuoted = true } = {}) {
  const p = posts[id];
  if (!p) return null;
  return {
    id,
    url: `https://x.com/${p.author_handle}/status/${id}`,
    author_handle: p.author_handle,
    ...(p.author_name ? { author_name: p.author_name } : {}),
    ...(p.created_at ? { created_at: p.created_at } : {}),
    text: typeof p.text === "string" ? p.text : "",
    media: (p.media ?? []).slice(0, MAX_MEDIA).map((m) => ({ kind: MEDIA_KIND[m.type] ?? "photo", url: m.url })),
    links: linksOf(p),
    quoted: withQuoted && p.quoted_id ? postObject(posts, p.quoted_id, { withQuoted: false }) : null,
    reply_to: p.in_reply_to_id ?? null,
  };
}

function contextEntry(posts, id, view) {
  const p = posts[id];
  return {
    id,
    author_handle: p.author_handle,
    text: typeof p.text === "string" ? p.text : "",
    reply_to: p.in_reply_to_id ?? null,
    quoted_id: p.quoted_id ?? null,
    view,
    ...(p.created_at ? { created_at: p.created_at } : {}),
    ...(linksOf(p).length ? { links: linksOf(p) } : {}),
  };
}

/**
 * The intake body for save `id` of `bundle`, or { skip: why } when the
 * bundle cannot describe it.
 */
export function intakeFor(bundle, id, { runId, account, capturedAt }) {
  const posts = bundle.posts ?? {};
  const record = bundle.context?.[id];
  const post = postObject(posts, id);
  if (!post) return { skip: `post ${id} is not in the bundle` };
  if (!record) return { skip: `post ${id} has no context record` };

  const thread = (record.thread?.op_self_thread_ids ?? []).map((t) => postObject(posts, t, { withQuoted: false })).filter(Boolean);
  // X lists ancestors root first above the save; the intake wants the
  // nearest parent first.
  const upstreamIds = [...(record.upstream?.ancestors ?? [])].reverse();
  if (post.reply_to && !upstreamIds.includes(post.reply_to)) upstreamIds.unshift(post.reply_to);
  const upstream = upstreamIds.filter((u) => u !== id).map((u) => postObject(posts, u, { withQuoted: false })).filter(Boolean);

  const skip = new Set([id, ...thread.map((t) => t.id), ...upstream.map((u) => u.id)]);
  const context = [];
  const add = (ids, view) => {
    for (const c of ids ?? []) {
      if (skip.has(c) || !posts[c]) continue;
      skip.add(c);
      context.push(contextEntry(posts, c, view));
    }
  };
  for (const [view, pick] of VIEWS) add(pick(record), view);
  for (const b of record.branches ?? []) add(b.thread?.reply_ids, "branch");

  const viewsRead = [
    ...["Relevance", "Recency"].filter((o) => record.orders?.[o]).map((o) => ({ view: o === "Relevance" ? "relevant" : "recent", reached_end: Boolean(record.orders[o].exhausted), count: record.orders[o].thread?.reply_ids?.length ?? 0 })),
    ...(record.parent?.thread ? [{ view: "parent", reached_end: Boolean(record.parent.exhausted), count: record.parent.thread.reply_ids?.length ?? 0 }] : []),
  ];
  let capped = Boolean(record.detailCapped) || (record.branchesSkipped?.length ?? 0) > 0 || (record.upstream?.skipped?.length ?? 0) > 0 || record.parent?.skipped === "per-post cap";
  if (context.length > MAX_CONTEXT) {
    context.length = MAX_CONTEXT;
    capped = true;
  }
  const body = {
    schema: "kintake/1",
    run_id: runId,
    account,
    ...(capturedAt ? { captured_at: capturedAt } : {}),
    post,
    thread,
    upstream,
    context,
    context_capped: capped,
    views_read: viewsRead,
  };
  // Over 192 KiB, context goes from the end (branches first) until it fits.
  while (byteLength(body) > MAX_BYTES && body.context.length) {
    body.context.length = Math.floor(body.context.length * 0.9);
    body.context_capped = true;
  }
  if (byteLength(body) > MAX_BYTES) return { skip: `post ${id} is over 192 KiB even without context` };
  return { body };
}

const byteLength = (v) => new TextEncoder().encode(JSON.stringify(v)).length;

// The saves of a daily bundle the intake gets: those the run finished, in
// the order it took them (oldest first), which is what the boundary moved
// past (lib/fetchrun.js, newSaves).
export function finishedSaves(bundle) {
  const s = bundle.newSaves;
  if (!s?.handled) return [];
  return s.taken.slice(0, s.taken.indexOf(s.handled) + 1);
}
