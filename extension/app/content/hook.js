// MAIN world, document_start on x.com. Wraps XMLHttpRequest and fetch so X's
// own GraphQL responses for the captured operations are copied to the
// isolated-world bridge (bridge.js). It never changes a request or response.
//
// Channel: window.postMessage would expose every message, and with it any
// nonce, to X's page scripts, which could then forge captures. Instead this
// script makes a detached element and hands it to the bridge with one
// synchronous event during document_start, before any page script runs.
// Later messages are events on that element.
//
// Page scripts share this world and run later, so they can replace built-ins
// such as EventTarget.prototype.dispatchEvent or Response.prototype.text. To
// keep the element and the response bodies out of their reach, this script
// keeps its own references to every built-in it calls, taken before any page
// script exists, and only reads XHR results from trusted load events.

(() => {
  const apply = Reflect.apply;
  const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;
  const unlisten = EventTarget.prototype.removeEventListener;
  const isTrusted = (event) => event.isTrusted === true; // own, unforgeable property of real events
  const MouseEventCtor = MouseEvent;
  const CustomEventCtor = CustomEvent;
  const URLCtor = URL;
  const stringify = JSON.stringify;
  const then = Promise.prototype.then;
  const exec = RegExp.prototype.exec;
  const includes = String.prototype.includes;
  const setHas = Set.prototype.has;
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrStatus = getter(XMLHttpRequest.prototype, "status");
  const xhrResponseType = getter(XMLHttpRequest.prototype, "responseType");
  const xhrResponseText = getter(XMLHttpRequest.prototype, "responseText");
  const xhrResponse = getter(XMLHttpRequest.prototype, "response");
  const resStatus = getter(Response.prototype, "status");
  const resClone = Response.prototype.clone;
  const resText = Response.prototype.text;
  const realFetch = window.fetch;

  // Keep in sync with OPS in lib/ops.js.
  const CAPTURED = new Set([
    "HomeTimeline", "HomeLatestTimeline", "Bookmarks", "TweetDetail", "SearchTimeline",
    "UserTweets", "UserOriginalsTimeline", "UserRepliesTimeline", "ListLatestTweetsTimeline",
  ]);
  const captured = (operation) => apply(setHas, CAPTURED, [operation]);
  const HELLO = "dx-capture-hello";
  const READY = "dx-capture-ready";
  const DATA = "dx-capture-data";
  const OPERATION = /\/graphql\/[^/]+\/([A-Za-z]+)$/;

  const channel = document.createElement("span");
  let connected = false;

  // The bridge calls preventDefault() on the hello it accepts.
  const announce = () => {
    if (connected) return;
    const hello = new MouseEventCtor(HELLO, { relatedTarget: channel, cancelable: true });
    connected = !apply(dispatch, document, [hello]);
    if (connected) apply(unlisten, document, [READY, announce, true]);
  };
  // Whichever of hook.js and bridge.js runs second completes the handshake.
  apply(listen, document, [READY, announce, true]);
  announce();
  // Page scripts start after document_start; stop answering by then.
  setTimeout(() => apply(unlisten, document, [READY, announce, true]), 0);

  const send = (message) => {
    if (!connected) return;
    try {
      apply(dispatch, channel, [new CustomEventCtor(DATA, { detail: stringify(message) })]);
    } catch {
      // Never let capture break X.
    }
  };

  const operationOf = (url) => {
    try {
      const m = apply(exec, OPERATION, [new URLCtor(url, location.href).pathname]);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  };

  // Every GraphQL failure status is reported (a 429 stops a session); bodies
  // only for the captured operations. `body` is a string or a promise of one.
  const report = (url, operation, status, body) => {
    if (status < 200 || status > 299) {
      send({ kind: "status", operation, status });
      return;
    }
    const deliver = (text) => {
      if (typeof text === "string" && text) send({ kind: "response", operation, url, status, body: text });
    };
    if (typeof body === "string") deliver(body);
    else if (body) apply(then, body, [deliver, () => {}]);
  };

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const href = `${url}`;
      const operation = apply(includes, href, ["/graphql/"]) ? operationOf(href) : null;
      if (operation) {
        const xhr = this;
        apply(listen, xhr, ["load", (event) => {
          if (!isTrusted(event)) return;
          const status = apply(xhrStatus, xhr, []);
          let body = null;
          if (captured(operation)) {
            const type = apply(xhrResponseType, xhr, []);
            if (type === "" || type === "text") body = apply(xhrResponseText, xhr, []);
            else if (type === "json") body = stringify(apply(xhrResponse, xhr, []));
          }
          report(href, operation, status, body);
        }]);
      }
    } catch {
      // Fall through to the real open().
    }
    return apply(xhrOpen, this, arguments);
  };

  window.fetch = function (input, init) {
    const pending = apply(realFetch, this, arguments);
    try {
      const href = typeof input === "string" ? input : input instanceof URLCtor ? input.href : input?.url;
      const operation = typeof href === "string" && apply(includes, href, ["/graphql/"]) ? operationOf(href) : null;
      if (operation) {
        // This callback runs before the page's own, because it was attached
        // before the page got the promise. Clone here: by the next microtask
        // the page may have read the body, and a used body cannot be cloned.
        // The saved getters throw on anything that is not a real Response.
        apply(then, pending, [(res) => {
          try {
            const status = apply(resStatus, res, []);
            const ok = status >= 200 && status <= 299;
            const body = ok && captured(operation) ? apply(resText, apply(resClone, res, []), []) : null;
            report(href, operation, status, body);
          } catch {
            // Not a real response.
          }
        }, () => {}]);
      }
    } catch {
      // The page gets its response either way.
    }
    return pending;
  };
})();
