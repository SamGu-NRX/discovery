// GraphQL operations the extension captures, and the contract's op and
// surface for each. content/hook.js keeps its own copy of these names because
// a MAIN-world content script cannot import modules; change both together.

// X retired UserTweets in 2026-08 in favor of the User*Timeline operations
// (see twitter-web-exporter src/modules/user-tweets/api.ts). The contract's op
// enum only has UserTweets, so the successors are reported under that op.
const OPS = {
  HomeTimeline: { op: "HomeTimeline", surface: "home_for_you" },
  HomeLatestTimeline: { op: "HomeLatestTimeline", surface: "home_following" },
  Bookmarks: { op: "Bookmarks", surface: "bookmarks" },
  TweetDetail: { op: "TweetDetail", surface: "detail" },
  SearchTimeline: { op: "SearchTimeline", surface: "search" },
  UserTweets: { op: "UserTweets", surface: "profile" },
  UserOriginalsTimeline: { op: "UserTweets", surface: "profile" },
  UserRepliesTimeline: { op: "UserTweets", surface: "profile" },
  ListLatestTweetsTimeline: { op: "ListLatestTweetsTimeline", surface: "list" },
};

// Only an absolute https URL on X's own hosts names an operation; a data: or
// blob: URL can carry any path.
export function operationFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !["x.com", "api.x.com"].includes(parsed.hostname)) return null;
  const m = /\/graphql\/[^/]+\/([A-Za-z]+)$/.exec(parsed.pathname);
  return m && Object.hasOwn(OPS, m[1]) ? m[1] : null;
}

export function contractOp(operation) {
  const entry = OPS[operation];
  if (!entry) throw new Error(`not a captured operation: ${operation}`);
  return entry;
}

// TweetDetail is a GET whose `variables` query parameter is JSON holding the
// permalink's id as focalTweetId.
export function focalTweetIdFromUrl(url) {
  try {
    const raw = new URL(url, "https://x.com").searchParams.get("variables");
    const id = raw && JSON.parse(raw).focalTweetId;
    return typeof id === "string" && /^\d{1,25}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
