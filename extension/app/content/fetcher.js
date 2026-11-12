// Injected by app/fetch/fetch.js, after detect.js, into fetch mode's own
// x.com tab only, never into tabs Sam uses. It runs in the extension's
// isolated world, beside bridge.js, so page scripts can neither call it nor
// see what it fetches.
//
// It has three commands: list the templates the bridge has learned (without
// header values), inspect the page for a blocker (detect.js), and GET one
// GraphQL read. A GET goes to https://x.com/i/api/graphql/<id>/<operation>
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
    const headers = new Headers();
    // A GET has no body, so the page's content-type for a POST is dropped.
    for (const [name, value] of learned) if (name !== "content-type") headers.set(name, value);
    const started = performance.now();
    const res = await fetch(target.href, {
      method: "GET",
      headers,
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", text, ms: Math.round(performance.now() - started) };
  }

  const COMMANDS = Object.freeze({
    templates: () => templates(),
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
