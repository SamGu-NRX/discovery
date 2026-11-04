// The only x.com URLs a session may open. Session code navigates through
// navigateTo() in session.js, which accepts nothing but values minted here, so
// a URL taken from page content or from a Worker response cannot be opened.
// The detail queue supplies post ids only; they must be all digits before one
// is placed into the fixed permalink template.

const minted = new WeakSet();

function mint(href) {
  const url = Object.freeze({ href });
  minted.add(url);
  return url;
}

const HOME = mint("https://x.com/home");
const BOOKMARKS = mint("https://x.com/i/bookmarks");

export function homeUrl() {
  return HOME;
}

export function bookmarksUrl() {
  return BOOKMARKS;
}

export function permalinkUrl(postId) {
  if (typeof postId !== "string" || !/^\d{1,25}$/.test(postId)) {
    throw new Error(`refusing permalink for post id ${JSON.stringify(postId)}`);
  }
  return mint(`https://x.com/i/status/${postId}`);
}

export function isMintedXUrl(value) {
  return typeof value === "object" && value !== null && minted.has(value);
}

// Pages a session may read: x.com over https, nothing else. X redirects
// /i/bookmarks under /i/history, and a session may land on a login or
// challenge page, which inspection then reports.
export function isXPage(href) {
  try {
    const u = new URL(href);
    return u.protocol === "https:" && u.hostname === "x.com";
  } catch {
    return false;
  }
}
