// MAIN world, document_start on x.com. Wraps XMLHttpRequest and fetch so X's
// own GraphQL responses for the captured operations are copied to the
// isolated-world bridge (bridge.js). It never changes a request or response.
//
// Channel: window.postMessage would expose every message, and with it any
// nonce, to X's page scripts, which could then forge captures. Instead this
// script makes a detached element and hands it to the bridge with one
// synchronous event during document_start, before any page script runs.
// Later messages are events on that element, which page scripts never get a
// reference to.

(() => {
  // Keep in sync with OPS in lib/ops.js.
  const CAPTURED = new Set([
    "HomeTimeline", "HomeLatestTimeline", "Bookmarks", "TweetDetail", "SearchTimeline",
    "UserTweets", "UserOriginalsTimeline", "UserRepliesTimeline", "ListLatestTweetsTimeline",
  ]);
  const HELLO = "dx-capture-hello";
  const READY = "dx-capture-ready";
  const DATA = "dx-capture-data";

  const channel = document.createElement("span");
  let connected = false;

  // The bridge calls preventDefault() on the hello it accepts.
  const announce = () => {
    if (connected) return;
    const hello = new MouseEvent(HELLO, { relatedTarget: channel, cancelable: true });
    connected = !document.dispatchEvent(hello);
    if (connected) document.removeEventListener(READY, announce, true);
  };
  // Whichever of hook.js and bridge.js runs second completes the handshake.
  document.addEventListener(READY, announce, true);
  announce();
  // Page scripts start after document_start; stop answering by then.
  setTimeout(() => document.removeEventListener(READY, announce, true), 0);

  const send = (message) => {
    if (!connected) return;
    try {
      channel.dispatchEvent(new CustomEvent(DATA, { detail: JSON.stringify(message) }));
    } catch {
      // Never let capture break X.
    }
  };

  const operationOf = (url) => {
    try {
      const m = /\/graphql\/[^/]+\/([A-Za-z]+)$/.exec(new URL(url, location.href).pathname);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  };

  // Every GraphQL failure status is reported (a 429 stops a session); bodies
  // only for the captured operations.
  const report = (url, status, readBody) => {
    const operation = operationOf(url);
    if (!operation) return;
    if (status < 200 || status > 299) {
      send({ kind: "status", operation, status });
      return;
    }
    if (!CAPTURED.has(operation)) return;
    Promise.resolve()
      .then(readBody)
      .then((body) => {
        if (typeof body === "string" && body) send({ kind: "response", operation, url: String(url), status, body });
      })
      .catch(() => {});
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const href = String(url);
      if (href.includes("/graphql/")) {
        this.addEventListener("load", () => {
          report(href, this.status, () => {
            if (this.responseType === "" || this.responseType === "text") return this.responseText;
            if (this.responseType === "json") return JSON.stringify(this.response);
            return null;
          });
        });
      }
    } catch {
      // Fall through to the real open().
    }
    return xhrOpen.apply(this, arguments);
  };

  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    const pending = realFetch.apply(this, arguments);
    try {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      if (typeof href === "string" && href.includes("/graphql/")) {
        // This callback runs before the page's own, because it was attached
        // before the page got the promise. Clone here: by the next microtask
        // the page may have read the body, and a used body cannot be cloned.
        pending.then((res) => {
          const copy = res.ok && CAPTURED.has(operationOf(href)) ? res.clone() : null;
          report(href, res.status, () => copy?.text());
        }, () => {});
      }
    } catch {
      // The page gets its response either way.
    }
    return pending;
  };
})();
