// Turns one X GraphQL response into normalized posts (docs/CONTRACT.md,
// "Normalized post" and the GraphQL path appendix). Shapes follow
// twitter-web-exporter at ddf2b0c (src/utils/api.ts, src/modules/*/api.ts).
//
// X changes these payloads without notice. Anything the contract needs that
// is missing or has the wrong type throws ParseError, and the caller drops the
// whole batch and records the error, so a format change shows up in the popup
// instead of as quietly wrong rows. Content X legitimately leaves out (cursor
// entries, prompts, ads, tombstones, visibility-limited tweets with no result)
// is skipped.

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParseError";
  }
}

const INSTRUCTION_PATHS = {
  HomeTimeline: ["data", "home", "home_timeline_urt", "instructions"],
  HomeLatestTimeline: ["data", "home", "home_timeline_urt", "instructions"],
  Bookmarks: ["data", "bookmark_timeline_v2", "timeline", "instructions"],
  TweetDetail: ["data", "threaded_conversation_with_injections_v2", "instructions"],
  SearchTimeline: ["data", "search_by_raw_query", "search_timeline", "timeline", "instructions"],
  UserTweets: ["data", "user", "result", "timeline", "timeline", "instructions"],
  UserOriginalsTimeline: ["data", "user", "result", "timeline", "timeline", "instructions"],
  UserRepliesTimeline: ["data", "user", "result", "timeline", "timeline", "instructions"],
  ListLatestTweetsTimeline: ["data", "list", "tweets_timeline", "timeline", "instructions"],
};

// X's GraphQL error code for "Rate limit exceeded". It can arrive with HTTP 200.
const RATE_LIMIT_CODE = 88;

/**
 * @returns {{ items: Item[], rateLimited: boolean }}
 *   Item: { post, authorId, role, slot, module, prepend }. `role` is
 *   "timeline" outside TweetDetail; there it is "focal", "ancestor", "reply"
 *   or "related". Quoted and reposted originals come back with role
 *   "embedded" and the slot of the post that carried them. `slot` orders the
 *   primary posts as X displays them. `module` is the entryId of the module
 *   the post came in (null for a single entry), and `prepend` is true when a
 *   TimelineAddToModule put it in front of that module's earlier items.
 */
export function parseResponse(operation, json, { focalId = null } = {}) {
  const path = INSTRUCTION_PATHS[operation];
  if (!path) throw new ParseError(`no parser for operation ${operation}`);
  if (!isObject(json)) throw new ParseError(`${operation}: response is not a JSON object`);

  const errors = Array.isArray(json.errors) ? json.errors : [];
  const rateLimited = errors.some((e) => e && e.code === RATE_LIMIT_CODE);

  let instructions = json;
  for (const key of path) instructions = isObject(instructions) ? instructions[key] : undefined;
  if (!Array.isArray(instructions)) {
    if (rateLimited) return { items: [], rateLimited };
    const why = errors.length ? ` (X error: ${String(errors[0]?.message).slice(0, 120)})` : "";
    throw new ParseError(`${operation}: no instructions array at ${path.join(".")}${why}`);
  }

  const ctx = { operation, focalId, detail: operation === "TweetDetail", emptyTweets: 0 };
  const primaries = [];
  for (const instruction of instructions) {
    if (!isObject(instruction) || typeof instruction.type !== "string") {
      throw new ParseError(`${operation}: instruction without a type`);
    }
    switch (instruction.type) {
      case "TimelineAddEntries":
        if (!Array.isArray(instruction.entries)) {
          throw new ParseError(`${operation}: TimelineAddEntries without entries[]`);
        }
        for (const entry of displayOrder(instruction.entries)) readEntry(ctx, entry, primaries);
        break;
      case "TimelinePinEntry":
      case "TimelineReplaceEntry":
        if (!isObject(instruction.entry)) throw new ParseError(`${operation}: ${instruction.type} without entry`);
        readEntry(ctx, instruction.entry, primaries);
        break;
      case "TimelineAddToModule":
        readAddToModule(ctx, instruction, primaries);
        break;
      default:
        // TimelineClearCache, TimelineTerminateTimeline, TimelineShowAlert and
        // other UI instructions carry no posts.
        break;
    }
  }

  // Some empty results are normal, but a response where every tweet is
  // empty means X moved `legacy`, not that the feed is empty.
  if (ctx.emptyTweets > 0 && primaries.length === 0) {
    throw new ParseError(`${operation}: all ${ctx.emptyTweets} tweet result(s) lack legacy`);
  }
  return { items: assemble(ctx, primaries), rateLimited };
}

// X may return entries out of display order; a larger sortIndex is shown
// first (twitter-web-exporter compareSortIndex). Keep the array order when any
// entry lacks a numeric sortIndex, since mixing would not be a total order.
function displayOrder(entries) {
  const numeric = entries.every((e) => isObject(e) && typeof e.sortIndex === "string" && /^-?\d+$/.test(e.sortIndex));
  if (!numeric) return entries;
  return [...entries].sort((a, b) => {
    const x = BigInt(a.sortIndex);
    const y = BigInt(b.sortIndex);
    return x > y ? -1 : x < y ? 1 : 0;
  });
}

function readEntry(ctx, entry, out) {
  if (!isObject(entry) || typeof entry.entryId !== "string") {
    throw new ParseError(`${ctx.operation}: timeline entry without entryId`);
  }
  const { entryId, content } = entry;
  if (entryId.startsWith("promoted-")) return;
  if (!isObject(content)) throw new ParseError(`${ctx.operation}: entry ${entryId} without content`);

  const entryType = content.entryType ?? content.__typename;
  if (entryType === "TimelineTimelineCursor") return;
  if (entryType === "TimelineTimelineItem") {
    const place = { role: roleForItem(ctx, entryId), module: null, prepend: false };
    readItemContent(ctx, content.itemContent, place, entryId, out);
    return;
  }
  if (entryType === "TimelineTimelineModule") {
    if (!Array.isArray(content.items)) throw new ParseError(`${ctx.operation}: module ${entryId} without items[]`);
    const place = { role: roleForModule(ctx, entryId), module: entryId, prepend: false };
    for (const item of content.items) {
      if (!isObject(item) || typeof item.entryId !== "string" || !isObject(item.item)) {
        throw new ParseError(`${ctx.operation}: module ${entryId} has a malformed item`);
      }
      readItemContent(ctx, item.item.itemContent, place, item.entryId, out);
    }
    return;
  }
  throw new ParseError(`${ctx.operation}: entry ${entryId} has unknown entryType ${String(entryType)}`);
}

function readAddToModule(ctx, instruction, out) {
  const { moduleEntryId, moduleItems } = instruction;
  if (typeof moduleEntryId !== "string" || !Array.isArray(moduleItems)) {
    throw new ParseError(`${ctx.operation}: TimelineAddToModule without moduleEntryId or moduleItems[]`);
  }
  const place = { role: roleForModule(ctx, moduleEntryId), module: moduleEntryId, prepend: instruction.prepend === true };
  for (const item of moduleItems) {
    if (!isObject(item) || typeof item.entryId !== "string" || !isObject(item.item)) {
      throw new ParseError(`${ctx.operation}: module ${moduleEntryId} has a malformed item`);
    }
    readItemContent(ctx, item.item.itemContent, place, item.entryId, out);
  }
}

function roleForItem(ctx, entryId) {
  if (!ctx.detail) return "timeline";
  // On a permalink, single tweet-<id> entries are the focal post and the
  // posts above it that it replies to.
  const id = /^tweet-(\d+)$/.exec(entryId)?.[1];
  if (id && id === ctx.focalId) return "focal";
  return id ? "ancestor" : "related";
}

function roleForModule(ctx, entryId) {
  if (!ctx.detail) return "timeline";
  return entryId.startsWith("conversationthread-") ? "reply" : "related";
}

function readItemContent(ctx, itemContent, place, entryId, out) {
  if (!isObject(itemContent)) throw new ParseError(`${ctx.operation}: ${entryId} without itemContent`);
  const kind = itemContent.__typename ?? itemContent.itemType;
  // Users, prompts, cursors, lists, topics: not posts.
  if (kind !== "TimelineTweet") return;
  if (itemContent.promotedMetadata) return;
  if (!isObject(itemContent.tweet_results)) {
    throw new ParseError(`${ctx.operation}: ${entryId} TimelineTweet without tweet_results`);
  }
  // X omits the result for some visibility-limited tweets.
  const result = itemContent.tweet_results.result;
  if (result === undefined || result === null) return;
  const tweet = unwrapTweet(ctx, result, entryId);
  if (!tweet) return;
  // X sometimes delivers the permalink's own post inside a conversation
  // module rather than as a tweet-<id> entry; it is the focal post either way.
  if (ctx.detail && ctx.focalId && tweet.rest_id === ctx.focalId) {
    out.push({ tweet, role: "focal", module: null, prepend: false });
  } else {
    out.push({ tweet, ...place });
  }
}

// T in the contract appendix: the tweet itself, or the .tweet inside a
// TweetWithVisibilityResults wrapper. Deleted, protected or unavailable posts
// are null, and so is a Tweet result without `legacy`: X sends those empty
// results, and twitter-web-exporter's filterEmptyTweet skips them the same
// way. A Tweet that has `legacy` gets the full checks in normalizeTweet.
function unwrapTweet(ctx, result, where) {
  if (!isObject(result)) throw new ParseError(`${ctx.operation}: ${where} tweet result is not an object`);
  let tweet;
  switch (result.__typename) {
    case "Tweet":
      tweet = result;
      break;
    case "TweetWithVisibilityResults":
      if (!isObject(result.tweet)) {
        throw new ParseError(`${ctx.operation}: ${where} TweetWithVisibilityResults without .tweet`);
      }
      tweet = result.tweet;
      break;
    case "TweetTombstone":
    case "TweetUnavailable":
      return null;
    default:
      throw new ParseError(`${ctx.operation}: ${where} has unknown tweet type ${String(result.__typename)}`);
  }
  if (tweet.legacy === undefined || tweet.legacy === null) {
    ctx.emptyTweets += 1;
    return null;
  }
  return tweet;
}

// When one post appears in several places, the thread needs its strongest
// role: a post shown under "Discover more" and in a conversation module is
// still a reply.
const ROLE_RANK = { focal: 4, ancestor: 3, reply: 2, related: 1, timeline: 0 };

function assemble(ctx, primaries) {
  const items = [];
  const byId = new Map();
  let slot = 0;
  for (const { tweet, role, module, prepend } of primaries) {
    const { post, authorId } = normalizeTweet(ctx, tweet);
    // One sighting per post per batch: a post repeated in a response keeps
    // its first position.
    const seen = byId.get(post.id);
    if (seen) {
      if (ROLE_RANK[role] > ROLE_RANK[seen.role]) Object.assign(seen, { role, module, prepend });
      continue;
    }
    const item = { post, authorId, role, module, prepend, slot, tweet };
    byId.set(post.id, item);
    items.push(item);
    slot += 1;
  }
  const primaryIds = new Set(byId.keys());

  const embeddedIds = new Set();
  const embedded = [];
  for (const item of items) {
    for (const inner of embeddedTweets(ctx, item.tweet)) {
      const { post, authorId } = normalizeTweet(ctx, inner);
      if (primaryIds.has(post.id) || embeddedIds.has(post.id)) continue;
      embeddedIds.add(post.id);
      embedded.push({ post, authorId, role: "embedded", slot: item.slot });
    }
  }

  return [...items.map(({ tweet, ...rest }) => rest), ...embedded];
}

// The reposted original, the quoted post, and the post the original quotes.
function embeddedTweets(ctx, tweet) {
  const found = [];
  const add = (result, label) => {
    if (!result) return null;
    const inner = unwrapTweet(ctx, result, `${tweet.rest_id} ${label}`);
    if (inner) found.push(inner);
    return inner;
  };
  const original = add(tweet.legacy?.retweeted_status_result?.result, "repost");
  add(tweet.quoted_status_result?.result, "quote");
  if (original) add(original.quoted_status_result?.result, "repost quote");
  return found;
}

function normalizeTweet(ctx, t) {
  const id = typeof t.rest_id === "string" && /^\d+$/.test(t.rest_id) ? t.rest_id : null;
  const fail = (field) => {
    throw new ParseError(`${ctx.operation}: tweet ${id ?? "(no rest_id)"} missing or invalid ${field}`);
  };
  if (!id) fail("rest_id");
  const legacy = t.legacy;
  if (!isObject(legacy)) fail("legacy");

  const createdAt = twitterDateToIso(legacy.created_at);
  if (!createdAt) fail("legacy.created_at");

  const user = t.core?.user_results?.result;
  if (!isObject(user)) fail("core.user_results.result");
  const handle = user.core?.screen_name ?? user.legacy?.screen_name;
  if (typeof handle !== "string" || !handle) fail("author screen_name");
  const name = user.core?.name ?? user.legacy?.name;
  if (typeof name !== "string") fail("author name");
  const authorId = user.rest_id ?? legacy.user_id_str;
  if (typeof authorId !== "string" || !authorId) fail("author rest_id");
  // Whether the logged-in account follows the author: relationship_perspectives
  // in current payloads, legacy.following in older ones, null when X sends
  // neither (a lens reads this as a signal, never as a requirement).
  const following = user.relationship_perspectives?.following ?? user.legacy?.following;
  const authorFollowed = typeof following === "boolean" ? following : null;

  const note = t.note_tweet?.note_tweet_results?.result;
  let text;
  if (typeof note?.text === "string") {
    text = note.text;
  } else {
    if (typeof legacy.full_text !== "string") fail("legacy.full_text");
    text = decodeLegacyEntities(legacy.full_text);
  }

  if (typeof legacy.conversation_id_str !== "string") fail("legacy.conversation_id_str");
  const inReplyTo = optionalId(legacy.in_reply_to_status_id_str, () => fail("legacy.in_reply_to_status_id_str"));

  if (!isObject(legacy.entities)) fail("legacy.entities");
  const noteUrls = note?.entity_set?.urls ?? [];
  const legacyUrls = legacy.entities.urls ?? [];
  if (!Array.isArray(noteUrls)) fail("note_tweet entity_set.urls");
  if (!Array.isArray(legacyUrls)) fail("legacy.entities.urls");
  const urls = [];
  for (const u of [...noteUrls, ...legacyUrls]) {
    const url = u?.expanded_url;
    if (typeof url === "string" && url && !urls.includes(url)) urls.push(url);
  }

  const mediaList = legacy.extended_entities?.media ?? legacy.entities.media ?? [];
  if (!Array.isArray(mediaList)) fail("legacy media[]");
  const media = mediaList.map((m) => {
    if (typeof m?.type !== "string" || typeof m.media_url_https !== "string") fail("media type or media_url_https");
    const variants = m.video_info?.variants ?? [];
    if (!Array.isArray(variants)) fail("media video_info.variants");
    return { type: m.type, url: mediaUrl(m, variants) };
  });

  const quoted = t.quoted_status_result?.result;
  const quotedId = (quoted && (quoted.rest_id ?? quoted.tweet?.rest_id)) ?? legacy.quoted_status_id_str ?? null;
  const original = legacy.retweeted_status_result?.result;
  const retweetOf = (original && (original.rest_id ?? original.tweet?.rest_id)) ?? null;

  // twitter-web-exporter types these five counts as always present. Views
  // are optional there (`views.count?`) and X omits them on older posts.
  const count = (value, field) => {
    if (!Number.isInteger(value) || value < 0) fail(`legacy.${field}`);
    return value;
  };
  let views = null;
  if (t.views?.count !== undefined) {
    if (typeof t.views.count !== "string" || !/^\d+$/.test(t.views.count)) fail("views.count");
    views = Number(t.views.count);
  }

  return {
    authorId,
    post: {
      id,
      author_handle: handle,
      author_name: name,
      created_at: createdAt,
      text,
      lang: typeof legacy.lang === "string" ? legacy.lang : null,
      conversation_id: legacy.conversation_id_str,
      in_reply_to_id: inReplyTo,
      quoted_id: quotedId,
      retweet_of_id: retweetOf,
      author_followed: authorFollowed,
      urls,
      media,
      metrics: {
        likes: count(legacy.favorite_count, "favorite_count"),
        reposts: count(legacy.retweet_count, "retweet_count"),
        replies: count(legacy.reply_count, "reply_count"),
        quotes: count(legacy.quote_count, "quote_count"),
        bookmarks: count(legacy.bookmark_count, "bookmark_count"),
        views,
      },
    },
  };
}

function optionalId(value, fail) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) fail();
  return value;
}

// Videos and GIFs: the highest-bitrate variant, as twitter-web-exporter's
// getMediaOriginalUrl does. Photos: the image itself.
function mediaUrl(m, variants) {
  if (m.type === "video" || m.type === "animated_gif") {
    let best = null;
    for (const v of variants) {
      if (typeof v?.url !== "string") continue;
      if (!best || (v.bitrate ?? 0) > (best.bitrate ?? 0)) best = v;
    }
    if (best) return best.url;
  }
  return m.media_url_https;
}

const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

// "Sat Oct 25 13:28:50 +0000 2026" -> "2026-10-25T13:28:50Z". A date that
// does not exist (Oct 99, 77:88) does not survive the round trip through Date.
function twitterDateToIso(value) {
  if (typeof value !== "string") return null;
  const m = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\w{3}) (\d{2}) (\d{2}:\d{2}:\d{2}) \+0000 (\d{4})$/.exec(value);
  if (!m || !MONTHS[m[1]]) return null;
  const iso = `${m[4]}-${MONTHS[m[1]]}-${m[2]}T${m[3]}Z`;
  const parsed = new Date(iso);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === iso.replace("Z", ".000Z") ? iso : null;
}

// legacy.full_text escapes these three characters as HTML entities;
// note_tweet text does not.
function decodeLegacyEntities(text) {
  return text.replace(/&(amp|lt|gt);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">" })[e]);
}

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
