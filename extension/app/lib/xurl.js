// The only x.com URLs a session may open, each with the paths X may show for
// it. Session code navigates through navigate() in session.js, which accepts
// nothing but values minted here, and after loading checks that the tab is on
// one of the minted URL's expected paths. A URL taken from page content or
// from a Worker response cannot be opened. The detail queue supplies post ids
// only; they must be all digits before one is placed into the permalink.

const minted = new WeakSet();

// `pathPattern` is regex source, so it can also travel to the page agent,
// which checks the path again in the same step that scrolls.
function mint(href, pathPattern) {
  const regex = new RegExp(pathPattern);
  const url = Object.freeze({ href, pathPattern, expects: (path) => regex.test(path) });
  minted.add(url);
  return url;
}

const HOME = mint("https://x.com/home", "^/home$");

// X has moved bookmarks under /i/history. Opening /i/bookmarks may land on
// /i/history (another history tab) or on /i/history/bookmarks.
const BOOKMARKS = mint("https://x.com/i/bookmarks", "^/i/(bookmarks|history|history/bookmarks)$");
const HISTORY_BOOKMARKS = mint("https://x.com/i/history/bookmarks", "^/i/(history/bookmarks|bookmarks)$");

export function homeUrl() {
  return HOME;
}

export function bookmarksUrl() {
  return BOOKMARKS;
}

export function historyBookmarksUrl() {
  return HISTORY_BOOKMARKS;
}

// X rewrites /i/status/<id> to /<handle>/status/<id>.
export function permalinkUrl(postId) {
  if (typeof postId !== "string" || !/^\d{1,25}$/.test(postId)) {
    throw new Error(`refusing permalink for post id ${JSON.stringify(postId)}`);
  }
  return mint(`https://x.com/i/status/${postId}`, `^/(i|[A-Za-z0-9_]{1,15})/status/${postId}$`);
}

// A search results page, for fetch mode to learn SearchTimeline's template.
// The query comes from fetch mode's own job (quoted_tweet_id:<id>, url:...),
// one line of at most 200 characters.
// `product` is the search tab: Latest (f=live) or Top (f=top).
export function searchUrl(query, product = "Latest") {
  if (typeof query !== "string" || !query || query.length > 200 || /[\r\n]/.test(query)) {
    throw new Error(`refusing search URL for query ${JSON.stringify(query)}`);
  }
  const tab = { Latest: "live", Top: "top" }[product];
  if (!tab) throw new Error(`refusing search URL for product ${JSON.stringify(product)}`);
  return mint(`https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${tab}`, "^/search$");
}

export function isMintedXUrl(value) {
  return typeof value === "object" && value !== null && minted.has(value);
}

// The path of an https://x.com URL, or null for anything else.
// Whether a chrome.tabs.onUpdated event says the tab finished loading an
// x.com page. A run's window starts on about:blank, and that page's own
// "complete" can arrive after the navigation to x.com was asked for; counted
// as the x.com load, it let a run check the tab while it was still on
// about:blank (whose URL an extension without the tabs permission reads as
// undefined), and stop with "the fetch tab is on undefined". That failed 1
// daily e2e run in 20 on Nov 13.
export function loadedOnX(info, tab) {
  return info?.status === "complete" && xPath(tab?.url ?? "") !== null;
}

export function xPath(href) {
  try {
    const u = new URL(href);
    return u.protocol === "https:" && u.hostname === "x.com" ? u.pathname : null;
  } catch {
    return null;
  }
}
