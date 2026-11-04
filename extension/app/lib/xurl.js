// The only x.com URLs a session may open, each with the paths X may show for
// it. Session code navigates through navigate() in session.js, which accepts
// nothing but values minted here, and after loading checks that the tab is on
// one of the minted URL's expected paths. A URL taken from page content or
// from a Worker response cannot be opened. The detail queue supplies post ids
// only; they must be all digits before one is placed into the permalink.

const minted = new WeakSet();

function mint(href, expects) {
  const url = Object.freeze({ href, expects });
  minted.add(url);
  return url;
}

const HOME = mint("https://x.com/home", (path) => path === "/home");

// X has moved bookmarks under /i/history. Opening /i/bookmarks may land on
// /i/history (another history tab) or on /i/history/bookmarks.
const BOOKMARKS = mint("https://x.com/i/bookmarks", (path) =>
  ["/i/bookmarks", "/i/history", "/i/history/bookmarks"].includes(path),
);
const HISTORY_BOOKMARKS = mint("https://x.com/i/history/bookmarks", (path) =>
  ["/i/history/bookmarks", "/i/bookmarks"].includes(path),
);

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
  const canonical = new RegExp(`^/(i|[A-Za-z0-9_]{1,15})/status/${postId}$`);
  return mint(`https://x.com/i/status/${postId}`, (path) => canonical.test(path));
}

export function isMintedXUrl(value) {
  return typeof value === "object" && value !== null && minted.has(value);
}

// The path of an https://x.com URL, or null for anything else.
export function xPath(href) {
  try {
    const u = new URL(href);
    return u.protocol === "https:" && u.hostname === "x.com" ? u.pathname : null;
  } catch {
    return null;
  }
}
