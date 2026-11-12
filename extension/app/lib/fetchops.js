// Fetch mode's request side: which GraphQL operations it may issue, how a
// request is built from what X's own page sent, and which cursors a response
// offers. Pure functions; app/fetch/fetch.js and content/fetcher.js do the I/O.
//
// Fetch mode never hardcodes a query id or feature flags. X changes both
// without notice, so every request reuses the query id, `features` and
// `fieldToggles` of the last request X's own page made for that operation
// (a "template", learned by content/hook.js). An operation the page has not
// called yet has no template and is refused.

export class FetchRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "FetchRefused";
  }
}

// The only operations fetch mode may call. All are reads. Anything else,
// CreateBookmark, DeleteBookmark, FavoriteTweet, CreateTweet and every other
// mutation included, is refused by name before a URL is built.
// content/fetcher.js and content/bridge.js keep their own copies (classic
// scripts cannot import modules); change all three together.
export const READ_OPERATIONS = Object.freeze([
  "Bookmarks",
  "TweetDetail",
  "SearchTimeline",
  "UserTweets",
  "UserOriginalsTimeline",
  "UserRepliesTimeline",
]);

export function assertReadOperation(operation) {
  if (typeof operation !== "string" || !READ_OPERATIONS.includes(operation)) {
    throw new FetchRefused(`refusing operation ${JSON.stringify(operation)}: fetch mode issues only ${READ_OPERATIONS.join(", ")}`);
  }
}

const GRAPHQL_PATH = /^\/i\/api\/graphql\/([A-Za-z0-9_-]{10,40})\/([A-Za-z]+)$/;

/**
 * A template summary from the page (content/bridge.js `summary()`): the
 * request X's page made, without its headers. `url` is the request URL;
 * for a POST, `body` is its JSON body.
 * @returns {{ operation, queryId, variables, features, fieldToggles, method }}
 */
export function parseTemplate(summary) {
  if (!summary || typeof summary.url !== "string") throw new FetchRefused("template has no request URL");
  let url;
  try {
    url = new URL(summary.url);
  } catch {
    throw new FetchRefused(`template URL does not parse: ${summary.url.slice(0, 120)}`);
  }
  if (url.protocol !== "https:" || url.hostname !== "x.com") throw new FetchRefused(`template is not an x.com URL: ${url.origin}`);
  const m = GRAPHQL_PATH.exec(url.pathname);
  if (!m) throw new FetchRefused(`template URL is not a GraphQL operation: ${url.pathname}`);
  const [, queryId, operation] = m;
  assertReadOperation(operation);

  let source;
  if (summary.method === "GET") {
    source = Object.fromEntries(["variables", "features", "fieldToggles"].map((k) => [k, url.searchParams.get(k)]));
  } else if (summary.method === "POST") {
    // X has moved some reads to POST. Fetch mode still only sends GET, with
    // the same three objects in the query string.
    let body;
    try {
      body = JSON.parse(summary.body ?? "");
    } catch {
      throw new FetchRefused(`${operation} template is a POST without a JSON body`);
    }
    source = {
      variables: body.variables === undefined ? null : JSON.stringify(body.variables),
      features: body.features === undefined ? null : JSON.stringify(body.features),
      fieldToggles: body.fieldToggles === undefined ? null : JSON.stringify(body.fieldToggles),
    };
  } else {
    throw new FetchRefused(`${operation} template has method ${JSON.stringify(summary.method)}`);
  }
  const object = (key, required) => {
    const raw = source[key];
    if (raw === null || raw === undefined) {
      if (required) throw new FetchRefused(`${operation} template has no ${key}`);
      return null;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new FetchRefused(`${operation} template ${key} is not JSON`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FetchRefused(`${operation} template ${key} is not an object`);
    return value;
  };
  return {
    operation,
    queryId,
    method: summary.method,
    variables: object("variables", true),
    features: object("features", true),
    fieldToggles: object("fieldToggles", false),
  };
}

// The variables fetch mode changes, per operation. Everything else in the
// page's own variables (includePromotedContent, withVoice and whatever X adds
// next) is kept as the page sent it.
const SETTABLE = {
  Bookmarks: ["cursor", "count"],
  TweetDetail: ["focalTweetId", "cursor", "rankingMode", "referrer"],
  SearchTimeline: ["rawQuery", "product", "cursor", "count", "querySource"],
  UserTweets: ["userId", "cursor", "count"],
  UserOriginalsTimeline: ["userId", "cursor", "count"],
  UserRepliesTimeline: ["userId", "cursor", "count"],
};

// Keys that only make sense for the page's own request and must not be
// replayed: its cursor (each request sets its own or none).
const DROPPED = ["cursor"];

/**
 * Builds the GET for `operation` from its template with `changes` applied.
 * `changes` may only touch that operation's settable variables; a value of
 * undefined removes the key.
 * @returns {{ url: string, variables: object }}
 */
export function buildRequest(template, operation, changes = {}) {
  assertReadOperation(operation);
  if (!template) throw new FetchRefused(`no template for ${operation} yet: open a page where X itself calls it first`);
  if (template.operation !== operation) throw new FetchRefused(`template is for ${template.operation}, not ${operation}`);
  const variables = { ...template.variables };
  for (const key of DROPPED) delete variables[key];
  for (const [key, value] of Object.entries(changes)) {
    if (!SETTABLE[operation].includes(key)) throw new FetchRefused(`${operation}: variable ${key} is not one fetch mode sets`);
    if (value === undefined) delete variables[key];
    else variables[key] = value;
  }
  if (operation === "TweetDetail" && !isPostId(variables.focalTweetId)) throw new FetchRefused("TweetDetail needs a numeric focalTweetId");
  if (operation === "SearchTimeline" && (typeof variables.rawQuery !== "string" || !variables.rawQuery)) {
    throw new FetchRefused("SearchTimeline needs a rawQuery");
  }
  const url = new URL(`https://x.com/i/api/graphql/${template.queryId}/${operation}`);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set("features", JSON.stringify(template.features));
  if (template.fieldToggles) url.searchParams.set("fieldToggles", JSON.stringify(template.fieldToggles));
  return { url: url.href, variables };
}

export const isPostId = (id) => typeof id === "string" && /^\d{1,25}$/.test(id);

const INSTRUCTION_PATHS = {
  Bookmarks: ["data", "bookmark_timeline_v2", "timeline", "instructions"],
  TweetDetail: ["data", "threaded_conversation_with_injections_v2", "instructions"],
  SearchTimeline: ["data", "search_by_raw_query", "search_timeline", "timeline", "instructions"],
  UserTweets: ["data", "user", "result", "timeline", "timeline", "instructions"],
  UserOriginalsTimeline: ["data", "user", "result", "timeline", "timeline", "instructions"],
  UserRepliesTimeline: ["data", "user", "result", "timeline", "timeline", "instructions"],
};

/**
 * Every cursor a response offers, in the order X sent them:
 * `{ type, value, entryId, module }`. `type` is X's cursorType: Top and
 * Bottom page a timeline; on a permalink, ShowMore is a "Show more replies"
 * row inside a conversation module (module is that module's entryId), and
 * ShowMoreThreads / ShowMoreThreadsPrompt are "Show additional replies" and
 * "Show probable spam".
 */
export function cursorsOf(operation, json) {
  let instructions = json;
  for (const key of INSTRUCTION_PATHS[operation] ?? []) instructions = instructions?.[key];
  if (!Array.isArray(instructions)) return [];
  const out = [];
  const take = (content, entryId, module) => {
    if (!content || typeof content !== "object") return;
    const kind = content.entryType ?? content.__typename ?? content.itemType;
    if (kind !== "TimelineTimelineCursor") return;
    if (typeof content.value !== "string" || typeof content.cursorType !== "string") return;
    out.push({ type: content.cursorType, value: content.value, entryId, module });
  };
  const fromEntry = (entry) => {
    const content = entry?.content;
    if (!content) return;
    const kind = content.entryType ?? content.__typename;
    if (kind === "TimelineTimelineCursor") take(content, entry.entryId, null);
    else if (kind === "TimelineTimelineItem") take(content.itemContent, entry.entryId, null);
    else if (kind === "TimelineTimelineModule" && Array.isArray(content.items)) {
      for (const item of content.items) take(item?.item?.itemContent, item?.entryId, entry.entryId);
    }
  };
  for (const instruction of instructions) {
    if (instruction?.type === "TimelineAddEntries" && Array.isArray(instruction.entries)) instruction.entries.forEach(fromEntry);
    else if (instruction?.type === "TimelineReplaceEntry") fromEntry(instruction.entry);
    else if (instruction?.type === "TimelineAddToModule" && Array.isArray(instruction.moduleItems)) {
      for (const item of instruction.moduleItems) take(item?.item?.itemContent, item?.entryId, instruction.moduleEntryId);
    }
  }
  return out;
}

// Cursors a permalink is followed through. Top loads earlier posts of a long
// chain above the focal post.
export const DETAIL_CURSORS = new Set(["Bottom", "ShowMore", "ShowMoreThreads", "ShowMoreThreadsPrompt", "Top"]);

/**
 * How a raw response is to be treated, before any parsing of posts.
 * @returns {{ kind: "json", json } | { kind: "stop", reason, detail, pause: boolean } | { kind: "stale", detail }}
 *   `reason` is a session status (rate_limited, login_wall, challenge,
 *   error); `pause` says whether it is X telling the account to back off,
 *   which pauses sessions and fetch runs for 24 hours.
 */
export function classifyResponse({ operation, status, contentType, text, blocked = null, redirected = false, bodyError = null, paused = false }) {
  // The fetcher found the shared pause set just before sending, and sent nothing.
  if (paused) return { kind: "stop", reason: "paused", detail: "the extension was paused just before this request", pause: false };
  // content/fetcher.js found a login wall, challenge or limit message on the
  // page and sent nothing.
  if (blocked) return { kind: "stop", reason: blocked.blocker, detail: `${blocked.evidence} at ${blocked.path}`, pause: true };
  // X redirects a request it will not serve to its login or challenge
  // pages; the fetcher never follows one.
  if (redirected) return { kind: "stop", reason: "login_wall", detail: `${operation} answered with a redirect`, pause: true };
  const where = `${operation} answered`;
  if (status === 429) return { kind: "stop", reason: "rate_limited", detail: `${where} HTTP 429`, pause: true };
  if (status === 401) return { kind: "stop", reason: "login_wall", detail: `${where} HTTP 401`, pause: true };
  if (status === 403) return { kind: "stop", reason: "error", detail: `${where} HTTP 403 (refused; possibly a lock or a challenge)`, pause: true };
  // A replayed query id or client transaction id X no longer accepts comes
  // back as an empty 404. That is fetch mode's problem, not X backing off.
  if (status === 404) return { kind: "stale", detail: `${where} HTTP 404: query id or request headers not accepted` };
  if (status < 200 || status > 299) return { kind: "stop", reason: "error", detail: `${where} HTTP ${status}`, pause: status >= 500 ? false : true };
  if (bodyError) return { kind: "stop", reason: "error", detail: `${where} HTTP ${status} but its body could not be read: ${bodyError}`, pause: true };
  if (!/^application\/json\b/i.test(contentType ?? "")) {
    return { kind: "stop", reason: "error", detail: `${where} ${contentType || "no content type"}, not JSON`, pause: true };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "stop", reason: "error", detail: `${where} a body that is not JSON`, pause: true };
  }
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  if (errors.some((e) => e?.code === 88)) return { kind: "stop", reason: "rate_limited", detail: `${where} X error 88 (rate limit)`, pause: true };
  // Partial errors next to data are normal (a deleted quoted post, say). An
  // error with no data at all is X refusing the request.
  if (errors.length && (json.data === undefined || json.data === null || Object.keys(json.data).length === 0)) {
    const first = errors[0] ?? {};
    return { kind: "stop", reason: "error", detail: `${where} X error ${first.code ?? "?"}: ${String(first.message).slice(0, 160)}`, pause: true };
  }
  return { kind: "json", json };
}
