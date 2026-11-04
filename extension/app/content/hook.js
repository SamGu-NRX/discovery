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
//
// A message is one string joined with NUL separators, built by string
// concatenation of primitives, never by JSON.stringify: stringify calls any
// toJSON a page script puts on Object.prototype, which could replace the
// whole message. Event init dictionaries have a null prototype, so getters a
// page adds to Object.prototype are not consulted either.
//
// Which operation a response belongs to is read from the response itself
// (Response.url, XMLHttpRequest.responseURL), never from the arguments the
// page passed: a Request with its own `url` property, an object whose
// toString changes between calls, or an XHR opened twice can all name one URL
// while the browser fetches another. A Response a page substitutes through a
// `then` getter has an empty url (constructed responses have none) and is
// ignored.

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
  const then = Promise.prototype.then;
  const exec = RegExp.prototype.exec;
  const setHas = Set.prototype.has;
  const weakHas = WeakSet.prototype.has;
  const weakAdd = WeakSet.prototype.add;
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrStatus = getter(XMLHttpRequest.prototype, "status");
  const xhrResponseType = getter(XMLHttpRequest.prototype, "responseType");
  const xhrResponseText = getter(XMLHttpRequest.prototype, "responseText");
  const xhrResponseURL = getter(XMLHttpRequest.prototype, "responseURL");
  const resStatus = getter(Response.prototype, "status");
  const resUrl = getter(Response.prototype, "url");
  const resClone = Response.prototype.clone;
  const resText = Response.prototype.text;
  const urlHref = getter(URL.prototype, "href");
  const urlPathname = getter(URL.prototype, "pathname");
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
    const hello = new MouseEventCtor(HELLO, { __proto__: null, relatedTarget: channel, cancelable: true });
    connected = !apply(dispatch, document, [hello]);
    if (connected) apply(unlisten, document, [READY, announce, true]);
  };
  // Whichever of hook.js and bridge.js runs second completes the handshake.
  apply(listen, document, [READY, announce, true]);
  announce();
  // Page scripts start after document_start; stop answering by then.
  setTimeout(() => apply(unlisten, document, [READY, announce, true]), 0);

  // Format read by bridge.js: "dx1", kind, operation, status, url, body.
  // Only the body, which comes last, may contain NUL.
  const SEP = "\u0000";
  const send = (kind, operation, status, url, body) => {
    if (!connected) return;
    try {
      const detail = "dx1" + SEP + kind + SEP + operation + SEP + status + SEP + url + SEP + body;
      apply(dispatch, channel, [new CustomEventCtor(DATA, { __proto__: null, detail })]);
    } catch {
      // Never let capture break X.
    }
  };

  // The absolute URL and operation name, or null for anything that is not a
  // GraphQL operation URL.
  const parseGraphql = (url) => {
    if (typeof url !== "string" || url === "") return null;
    try {
      const parsed = new URLCtor(url);
      const m = apply(exec, OPERATION, [apply(urlPathname, parsed, [])]);
      return m ? { href: apply(urlHref, parsed, []), operation: m[1] } : null;
    } catch {
      return null;
    }
  };

  // Every GraphQL failure status is reported (a 429 stops a session); bodies
  // only for the captured operations. `body` is a string or a promise of one.
  const report = (url, operation, status, body) => {
    if (typeof status !== "number") return;
    if (status < 200 || status > 299) {
      send("status", operation, status, url, "");
      return;
    }
    const deliver = (text) => {
      if (typeof text === "string" && text) send("response", operation, status, url, text);
    };
    if (typeof body === "string") deliver(body);
    else if (body) apply(then, body, [deliver, () => {}]);
  };

  // One load listener per XHR, however many times it is opened; at load it
  // reads the URL the browser actually requested.
  const watched = new WeakSet();
  const onXhrLoad = (event) => {
    if (!isTrusted(event)) return;
    const xhr = event.target;
    const graphql = parseGraphql(apply(xhrResponseURL, xhr, []));
    if (!graphql) return;
    const { href, operation } = graphql;
    const status = apply(xhrStatus, xhr, []);
    let body = null;
    // X reads GraphQL as text. A "json" responseType has no raw text to
    // copy, and re-serializing it would run page code (toJSON).
    if (captured(operation)) {
      const type = apply(xhrResponseType, xhr, []);
      if (type === "" || type === "text") body = apply(xhrResponseText, xhr, []);
    }
    report(href, operation, status, body);
  };

  XMLHttpRequest.prototype.open = function () {
    try {
      if (!apply(weakHas, watched, [this])) {
        apply(weakAdd, watched, [this]);
        apply(listen, this, ["load", onXhrLoad]);
      }
    } catch {
      // Fall through to the real open().
    }
    return apply(xhrOpen, this, arguments);
  };

  window.fetch = function () {
    const pending = apply(realFetch, this, arguments);
    try {
      // This callback runs before the page's own, because it was attached
      // before the page got the promise. Clone here: by the next microtask
      // the page may have read the body, and a used body cannot be cloned.
      // The saved getters throw on anything that is not a real Response.
      apply(then, pending, [(res) => {
        try {
          const graphql = parseGraphql(apply(resUrl, res, []));
          if (!graphql) return;
          const { href, operation } = graphql;
          const status = apply(resStatus, res, []);
          const ok = status >= 200 && status <= 299;
          const body = ok && captured(operation) ? apply(resText, apply(resClone, res, []), []) : null;
          report(href, operation, status, body);
        } catch {
          // Not a real response.
        }
      }, () => {}]);
    } catch {
      // The page gets its response either way.
    }
    return pending;
  };
})();
