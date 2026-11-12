// Isolated world, document_start on x.com. Receives captured responses from
// hook.js over the private channel described there and forwards them to the
// service worker. It also reports when detect.js finds a login wall, a
// challenge or a rate limit on the page, so one in Sam's own tab pauses
// sessions too. It only reads the page and never touches X otherwise.

(() => {
  const HELLO = "dx-capture-hello";
  const READY = "dx-capture-ready";
  const DATA = "dx-capture-data";
  // Positions and permalink threads are counted per page load.
  const pageLoadId = crypto.randomUUID();
  let channel = null;

  const onHello = (event) => {
    if (channel || !(event.relatedTarget instanceof Element)) return;
    channel = event.relatedTarget;
    event.preventDefault();
    event.stopImmediatePropagation();
    document.removeEventListener(HELLO, onHello, true);
    channel.addEventListener(DATA, onData);
  };
  document.addEventListener(HELLO, onHello, true);
  document.dispatchEvent(new CustomEvent(READY));
  // Only hook.js, which runs during document_start like this script, may connect.
  setTimeout(() => document.removeEventListener(HELLO, onHello, true), 0);

  let handle = null;
  const account = () => {
    if (handle) return handle;
    const href = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href");
    const m = href && /^\/([A-Za-z0-9_]{1,15})$/.exec(href);
    handle = m ? m[1] : null;
    return handle;
  };

  // A blocker can appear at any time, on a new URL or on the same one (a
  // login wall or a limit message over the timeline), so the page is checked
  // every 5 s while visible and every 30 s while hidden, and 1.5 s after each
  // URL change. A blocker is reported when it appears, again every 30
  // minutes while it stays (each report extends the pause), and anew if it
  // clears and comes back.
  const VISIBLE_MS = 5_000;
  const HIDDEN_MS = 30_000;
  const REPEAT_MS = 30 * 60_000;
  // A back-off message counts as delivered only when the service worker
  // answers { ok: true }, which it does after the pause is stored. Anything
  // else (a rejected send while the worker restarts, an { error } reply) is
  // tried again.
  const acknowledged = (reply) => reply?.ok === true;
  // Each signal is also stored before it is sent, under a key of its own,
  // so one the service worker never acknowledges is still paused on: the
  // worker removes the key once paused, drains any left at startup and
  // every minute, and starts no session while one is stored. Returns the
  // key, or null if storage is unavailable (the extension was reloaded).
  const store = async (payload) => {
    const key = `pageSignal:${crypto.randomUUID()}`;
    try {
      await chrome.storage.local.set({ [key]: payload });
      return key;
    } catch {
      return null;
    }
  };
  let shown = null; // { key, reportedAt } for the blocker on screen, once acknowledged
  let sendingBlocker = false;
  let storedBlocker = null; // { key, signalKey } stored for the blocker on screen
  let lastHref = null;
  let lastCheck = 0;
  const checkForBlocker = () => {
    lastCheck = Date.now();
    const seen = globalThis.__dxDetect?.inspect();
    if (!seen || !["login_wall", "challenge", "rate_limited"].includes(seen.blocker)) {
      shown = null;
      return;
    }
    const key = `${seen.blocker}|${seen.path}`;
    if (shown?.key === key && Date.now() - shown.reportedAt < REPEAT_MS) return;
    if (sendingBlocker) return;
    sendingBlocker = true;
    const payload = { type: "x-blocker", blocker: seen.blocker, evidence: seen.evidence, path: seen.path };
    // Not acknowledged: `shown` stays as it was, so the next check sends
    // again, under the key already stored for this blocker.
    (async () => {
      if (storedBlocker?.key !== key) storedBlocker = { key, signalKey: await store(payload) };
      const reply = await chrome.runtime.sendMessage({ ...payload, signalKey: storedBlocker.signalKey });
      if (acknowledged(reply)) {
        shown = { key, reportedAt: Date.now() };
        storedBlocker = null;
      }
    })()
      .catch(() => {})
      .finally(() => {
        sendingBlocker = false;
      });
  };
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(checkForBlocker, 1500);
      return;
    }
    const every = document.visibilityState === "visible" ? VISIBLE_MS : HIDDEN_MS;
    if (Date.now() - lastCheck >= every) checkForBlocker();
  }, 1000);

  // One message in flight at a time keeps captures in the order X sent them,
  // which the service worker relies on for positions and thread pages.
  let queue = Promise.resolve();
  // hook.js sends "dx1", kind, operation, status, url and body joined by NUL;
  // the body is last and may itself contain NUL.
  function decode(detail) {
    if (typeof detail !== "string") return null;
    const fields = [];
    let start = 0;
    for (let i = 0; i < 5; i += 1) {
      const end = detail.indexOf("\u0000", start);
      if (end < 0) return null;
      fields.push(detail.slice(start, end));
      start = end + 1;
    }
    const [version, kind, operation, status, url] = fields;
    if (version !== "dx1" || !["response", "status", "limit", "template"].includes(kind)) return null;
    if (!/^[A-Za-z]+$/.test(operation) || !/^\d{3}$/.test(status)) return null;
    return { kind, operation, status: Number(status), url, body: detail.slice(start) };
  }

  // A 429, a 401 or an X error 88 is stored, then sent until acknowledged:
  // every 2 s, up to 30 times, outside the capture queue so captures keep
  // flowing. After that the stored copy waits for the worker. One of each
  // kind is in flight per page at a time.
  const BACK_OFF_TRIES = 30;
  const delivering = new Set();
  const deliverBackOff = async (payload) => {
    const kind = `${payload.type}:${payload.status}`;
    if (delivering.has(kind)) return;
    delivering.add(kind);
    try {
      const signalKey = await store(payload);
      for (let attempt = 0; attempt < BACK_OFF_TRIES; attempt += 1) {
        try {
          if (acknowledged(await chrome.runtime.sendMessage({ ...payload, signalKey }))) return;
        } catch {
          // The worker is restarting; try again.
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } finally {
      delivering.delete(kind);
    }
  };

  // The last request X's page made for each read operation fetch mode may
  // replay (hook.js, "Templates"). Kept in this isolated world only: the
  // headers carry the CSRF token, so they are never sent to the service
  // worker or stored. content/fetcher.js reads them through __dxTemplates,
  // which page scripts cannot reach. A new page load starts empty.
  const TEMPLATED = ["Bookmarks", "TweetDetail", "SearchTimeline", "UserTweets", "UserOriginalsTimeline", "UserRepliesTimeline"];
  const templates = new Map();
  function keepTemplate({ operation, url, body }) {
    if (!TEMPLATED.includes(operation)) return;
    const split = body.indexOf("\n\n");
    if (split < 0) return;
    const [method, ...lines] = body.slice(0, split).split("\n");
    if (method !== "GET" && method !== "POST") return;
    const headers = [];
    for (const line of lines) {
      const at = line.indexOf(": ");
      if (at > 0) headers.push([line.slice(0, at), line.slice(at + 2)]);
    }
    templates.set(operation, { url, method, body: body.slice(split + 2), headers, learnedAt: Date.now() });
  }
  Object.defineProperty(globalThis, "__dxTemplates", {
    value: Object.freeze({
      // Everything but the headers' values: safe to hand to extension pages.
      summary(operation) {
        const t = templates.get(operation);
        return t ? { url: t.url, method: t.method, body: t.body, headerNames: t.headers.map(([name]) => name), learnedAt: t.learnedAt } : null;
      },
      headers(operation) {
        const t = templates.get(operation);
        return t ? t.headers.map(([name, value]) => [name, value]) : null;
      },
    }),
  });

  function onData(event) {
    const message = decode(event.detail);
    if (!message) return;
    if (message.kind === "template") {
      keepTemplate(message);
      return;
    }
    if (message.kind === "limit" || (message.kind === "status" && (message.status === 429 || message.status === 401))) {
      deliverBackOff({
        type: message.kind === "limit" ? "x-limit" : "x-status",
        operation: message.operation,
        url: message.url,
        status: message.status,
        pageLoadId,
      });
      return;
    }
    queue = queue
      .then(() =>
        chrome.runtime.sendMessage({
          type: { response: "capture", status: "x-status", limit: "x-limit" }[message.kind],
          operation: message.operation,
          url: message.url,
          status: message.status,
          body: message.kind === "response" ? message.body : undefined,
          pageLoadId,
          account: account(),
        }),
      )
      .catch(() => {
        // The extension was reloaded or the worker is restarting; the page is unaffected.
      });
  }
})();
