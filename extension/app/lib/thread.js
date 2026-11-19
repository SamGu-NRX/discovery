// Builds the contract's TweetDetail `thread` from parsed permalink pages.
//
// root_id is the permalink's post (the focal post), because that is the id
// GET /x/detail-queue hands out and the id the runner asks context for. The
// original poster is the focal post's author. op_self_thread_ids is the
// focal post plus every post by that author linked to it through
// in_reply_to_status_id: the ancestors it continues and the continuations
// below it. reply_ids is everything else in the conversation modules, in the
// order X sent it. "Discover more" posts are not part of the thread; their ids
// go in related_ids, in the order X sent them, so a reader can tell what X
// recommended under this permalink. A post X shows both under "Discover more"
// and in the conversation is a reply, never related.
//
// Server order is module order, then item order inside each module. A
// permalink loads in pages: more conversation modules on scroll, and "show
// more" items added to an existing module through TimelineAddToModule, after
// its items or, with prepend, before them. The Worker overwrites a thread row
// by root_id, so each page's batch carries the cumulative thread, and the
// state returned here is carried to the next page of the same permalink.

/**
 * @param state  previous return value for this permalink, or null
 * @param items  parseResponse(...).items for one TweetDetail response
 * @param focalId the permalink's post id (focalTweetId in the request)
 * @returns {{ state, thread } | { state: null, thread: null, error: string }}
 */
export function extendThread(state, items, focalId) {
  if (!focalId) return { state: null, thread: null, error: "TweetDetail request has no focalTweetId" };
  if (state && state.focal.id !== focalId) throw new Error("thread state belongs to another permalink");

  const ref = ({ post, authorId }) => ({ id: post.id, authorId, inReplyToId: post.in_reply_to_id });
  const focalItem = items.find((i) => i.role === "focal");
  if (!state) {
    if (!focalItem) {
      return { state: null, thread: null, error: `TweetDetail for ${focalId}: focal post not in the first page seen` };
    }
    state = { focal: ref(focalItem), ancestors: [], modules: [], related: [] };
  } else {
    state = {
      focal: state.focal,
      ancestors: [...state.ancestors],
      modules: state.modules.map((m) => ({ id: m.id, refs: [...m.refs] })),
      related: [...state.related],
    };
  }

  const known = new Set([state.focal.id, ...state.ancestors.map((r) => r.id), ...state.modules.flatMap((m) => m.refs.map((r) => r.id))]);
  // This response's new replies, grouped by module in the order they came.
  const arrivals = new Map();
  for (const item of items) {
    if (known.has(item.post.id)) continue;
    if (item.role === "ancestor") {
      state.ancestors.push(ref(item));
    } else if (item.role === "reply") {
      const key = item.module ?? "";
      if (!arrivals.has(key)) arrivals.set(key, { prepend: item.prepend, refs: [] });
      arrivals.get(key).refs.push(ref(item));
    } else if (item.role === "related") {
      // Not added to `known`: a later page may show the same post as a reply.
      if (!state.related.includes(item.post.id)) state.related.push(item.post.id);
      continue;
    } else {
      continue;
    }
    known.add(item.post.id);
  }
  for (const [id, { prepend, refs }] of arrivals) {
    let module = state.modules.find((m) => m.id === id);
    if (!module) {
      module = { id, refs: [] };
      state.modules.push(module);
    }
    module.refs = prepend ? [...refs, ...module.refs] : [...module.refs, ...refs];
  }
  const conversation = state.modules.flatMap((m) => m.refs);

  const op = state.focal.authorId;
  const self = new Set([state.focal.id]);

  const ancestorsById = new Map(state.ancestors.map((r) => [r.id, r]));
  for (let parent = ancestorsById.get(state.focal.inReplyToId); parent && parent.authorId === op; ) {
    self.add(parent.id);
    parent = ancestorsById.get(parent.inReplyToId);
  }

  // Repeat until stable so a continuation listed before its parent still joins.
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of conversation) {
      if (!self.has(r.id) && r.authorId === op && self.has(r.inReplyToId)) {
        self.add(r.id);
        grew = true;
      }
    }
  }

  return {
    state,
    thread: {
      root_id: state.focal.id,
      op_self_thread_ids: [
        ...state.ancestors.filter((r) => self.has(r.id)).map((r) => r.id),
        state.focal.id,
        ...conversation.filter((r) => self.has(r.id)).map((r) => r.id),
      ],
      reply_ids: conversation.filter((r) => !self.has(r.id)).map((r) => r.id),
      related_ids: state.related.filter((id) => !known.has(id)),
    },
  };
}
