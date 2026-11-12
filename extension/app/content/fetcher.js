// Injected by app/fetch/fetch.js, after detect.js, into fetch mode's own
// x.com tab only, never into tabs Sam uses. It runs in the extension's
// isolated world, beside bridge.js, so page scripts can neither call it nor
// see what it fetches.
//
// Its commands: list the templates the bridge has learned (without header
// values), read the logged-in handle, inspect the page for a blocker
// (detect.js), and GET one GraphQL read. A GET goes to https://x.com/i/api/graphql/<id>/<operation>
// for an operation on the read list only, with the headers X's own page sent
// for that operation; the browser adds the page's cookies. It never sends
// any other method, never follows a redirect, and returns the raw response
// for the extension page to check and parse.

(() => {
  if (globalThis.__dxFetcher) return;

  // Keep in sync with READ_OPERATIONS in lib/fetchops.js.
  const READ = Object.freeze(["Bookmarks", "TweetDetail", "SearchTimeline", "UserTweets", "UserOriginalsTimeline", "UserRepliesTimeline"]);
  const GRAPHQL = /^\/i\/api\/graphql\/[A-Za-z0-9_-]{10,40}\/([A-Za-z]+)$/;
  const TIMEOUT_MS = 20_000;

  function templates() {
    const out = {};
    for (const operation of READ) out[operation] = globalThis.__dxTemplates?.summary(operation) ?? null;
    return out;
  }

  // The extension's shared pause, as lib/store.js pausedOrPausing() reads it:
  // a stored pause still running, or a back-off signal a page stored and the
  // service worker has not handled yet.
  async function pausedNow() {
    const { pauseUntil } = await chrome.storage.local.get("pauseUntil");
    if (pauseUntil && Date.parse(pauseUntil) > Date.now()) return true;
    const keys = await chrome.storage.local.getKeys();
    return keys.some((key) => key.startsWith("pageSignal:"));
  }

  async function get({ operation, url } = {}) {
    if (!READ.includes(operation)) throw new Error(`fetcher refused operation ${JSON.stringify(operation)}`);
    const target = new URL(url);
    const path = GRAPHQL.exec(target.pathname);
    if (target.origin !== "https://x.com" || !path || path[1] !== operation) {
      throw new Error(`fetcher refused URL ${target.origin}${target.pathname} for ${operation}`);
    }
    // A blocker on screen stops the run before anything is sent.
    const seen = globalThis.__dxDetect?.inspect();
    if (seen && ["login_wall", "challenge", "rate_limited"].includes(seen.blocker)) {
      return { status: 0, contentType: "", text: "", ms: 0, blocked: { blocker: seen.blocker, evidence: seen.evidence, path: seen.path } };
    }
    const learned = globalThis.__dxTemplates?.headers(operation);
    if (!learned) throw new Error(`no ${operation} template in this tab: X has not called it on this page`);
    // The run checked the shared pause before handing this request over, but
    // a signal from another tab can land in between; this is the last check
    // before the request exists.
    if (await pausedNow()) return { status: 0, contentType: "", text: "", ms: 0, paused: true };
    const headers = new Headers();
    // A GET has no body, so the page's content-type for a POST is dropped.
    for (const [name, value] of learned) if (name !== "content-type") headers.set(name, value);
    const started = performance.now();
    const res = await fetch(target.href, {
      method: "GET",
      headers,
      credentials: "include",
      // A redirect comes back as an opaque response instead of being followed.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = () => Math.round(performance.now() - started);
    if (res.type === "opaqueredirect") return { status: 0, contentType: "", text: "", ms: ms(), redirected: true };
    // Statuses that stop the run are returned before the body is read, so a
    // body that fails to arrive cannot hide them.
    if ([401, 403, 429].includes(res.status)) return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: "", ms: ms() };
    let text = "";
    let bodyError = null;
    try {
      text = await res.text();
    } catch (err) {
      bodyError = String(err?.message ?? err);
    }
    // X's per-endpoint budget for this account, shared with every X tab.
    const header = (name) => {
      const value = res.headers.get(name);
      return value !== null && /^\d+$/.test(value) ? Number(value) : null;
    };
    const rate = { limit: header("x-rate-limit-limit"), remaining: header("x-rate-limit-remaining"), reset: header("x-rate-limit-reset") };
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", text, ms: ms(), rate, bodyError };
  }

  // The logged-in handle, from X's side nav, as bridge.js reads it.
  function account() {
    const href = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href");
    return (href && /^\/([A-Za-z0-9_]{1,15})$/.exec(href)?.[1]) ?? null;
  }

  const COMMANDS = Object.freeze({
    templates: () => templates(),
    account: () => account(),
    inspect: () => globalThis.__dxDetect.inspect(),
    get: (arg) => get(arg),
  });

  Object.defineProperty(globalThis, "__dxFetcher", {
    value: Object.freeze({
      run(command) {
        const name = command?.name;
        if (typeof name !== "string" || !Object.hasOwn(COMMANDS, name)) throw new Error(`unknown fetcher command ${JSON.stringify(name)}`);
        return COMMANDS[name](command.arg);
      },
    }),
  });
})();
