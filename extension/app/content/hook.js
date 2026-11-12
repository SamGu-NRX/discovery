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
  const jsonParse = JSON.parse;
  const isArray = Array.isArray;
  const setHas = Set.prototype.has;
  const weakHas = WeakSet.prototype.has;
  const weakAdd = WeakSet.prototype.add;
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrSend = XMLHttpRequest.prototype.send;
  const reqMethod = getter(Request.prototype, "method");
  const reqHeaders = getter(Request.prototype, "headers");
  const headersForEach = Headers.prototype.forEach;
  const weakGet = WeakMap.prototype.get;
  const weakSet = WeakMap.prototype.set;
  const toLower = String.prototype.toLowerCase;
  const xhrStatus = getter(XMLHttpRequest.prototype, "status");
  const xhrResponseType = getter(XMLHttpRequest.prototype, "responseType");
  const xhrResponseText = getter(XMLHttpRequest.prototype, "responseText");
  const xhrResponse = getter(XMLHttpRequest.prototype, "response");
  const xhrResponseURL = getter(XMLHttpRequest.prototype, "responseURL");
  const resStatus = getter(Response.prototype, "status");
  const resUrl = getter(Response.prototype, "url");
  const resClone = Response.prototype.clone;
  const resText = Response.prototype.text;
  const urlHref = getter(URL.prototype, "href");
  const urlPathname = getter(URL.prototype, "pathname");
  const urlProtocol = getter(URL.prototype, "protocol");
  const urlHostname = getter(URL.prototype, "hostname");
  const realFetch = window.fetch;

  // Keep in sync with OPS in lib/ops.js.
  const CAPTURED = new Set([
    "HomeTimeline", "HomeLatestTimeline", "Bookmarks", "TweetDetail", "SearchTimeline",
    "UserTweets", "UserOriginalsTimeline", "UserRepliesTimeline", "ListLatestTweetsTimeline",
  ]);
  const captured = (operation) => apply(setHas, CAPTURED, [operation]);
  // Read operations fetch mode may replay (lib/fetchops.js READ_OPERATIONS).
  // For these the request X's page made is also sent to the bridge, which
  // keeps it inside this tab: see "Templates" below.
  const TEMPLATED = new Set([
    "Bookmarks", "TweetDetail", "SearchTimeline", "UserTweets", "UserOriginalsTimeline", "UserRepliesTimeline",
  ]);
  const templated = (operation) => apply(setHas, TEMPLATED, [operation]);
  // Only these request headers are kept: X's auth and client headers.
  const TEMPLATE_HEADER = /^(authorization|content-type|x-[a-z0-9-]+)$/;
  const LINE_BREAK = /[\r\n]/;
  const HELLO = "dx-capture-hello";
  const READY = "dx-capture-ready";
  const DATA = "dx-capture-data";
  const OPERATION = /\/graphql\/[^/]+\/([A-Za-z]+)$/;
  const MAYBE_RATE_LIMIT = /"code"\s*:\s*88\b/;

  // X's rate-limit error (code 88) can arrive with HTTP 200 on any GraphQL
  // operation. Bodies of captured operations go to the service worker, which
  // checks them; for every other operation only this verdict leaves the page.
  const hasRateLimitError = (parsed) => {
    const errors = parsed?.errors;
    if (!isArray(errors)) return false;
    for (let i = 0; i < errors.length; i += 1) if (errors[i]?.code === 88) return true;
    return false;
  };
  const isRateLimitBody = (text) => {
    if (!apply(exec, MAYBE_RATE_LIMIT, [text])) return false;
    try {
      return hasRateLimitError(jsonParse(text));
    } catch {
      return false;
    }
  };

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

  // The absolute URL and operation name, or null for anything that is not an
  // X GraphQL URL. data: and blob: URLs can carry any path, so only https on
  // X's own hosts counts.
  const parseGraphql = (url) => {
    if (typeof url !== "string" || url === "") return null;
    try {
      const parsed = new URLCtor(url);
      if (apply(urlProtocol, parsed, []) !== "https:") return null;
      const host = apply(urlHostname, parsed, []);
      if (host !== "x.com" && host !== "api.x.com") return null;
      const m = apply(exec, OPERATION, [apply(urlPathname, parsed, [])]);
      return m ? { href: apply(urlHref, parsed, []), operation: m[1] } : null;
    } catch {
      return null;
    }
  };

  // Templates. Fetch mode (app/fetch/) replays X's own read requests, so it
  // needs the query id, features and headers X's page used last. The page's
  // request arguments are read here, unlike for responses: a page script
  // that lies about them can only make fetch mode's own request fail. The
  // headers (the CSRF token among them) go only to the bridge in this tab,
  // which never sends them to the service worker. Format of the body:
  // method, then one "name: value" line per header, a blank line, and the
  // request body if it was a string.
  const NL = "\n";
  const templateBody = (method, headers, body) => {
    let out = method + NL;
    for (let i = 0; i < headers.length; i += 1) out += headers[i][0] + ": " + headers[i][1] + NL;
    return out + NL + (typeof body === "string" ? body : "");
  };
  const keepHeader = (list, name, value) => {
    if (typeof name !== "string" || typeof value !== "string") return;
    const lower = apply(toLower, name, []);
    if (!apply(exec, TEMPLATE_HEADER, [lower]) || value.length > 4096 || apply(exec, LINE_BREAK, [value])) return;
    list[list.length] = [lower, value];
  };
  const methodOf = (value) => (typeof value === "string" && apply(toLower, value, []) === "post" ? "POST" : "GET");
  const sendTemplate = (href, operation, status, request) => {
    if (!request || !templated(operation) || status < 200 || status > 299) return;
    send("template", operation, status, href, templateBody(request.method, request.headers, request.body));
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
      if (typeof text !== "string" || !text) return;
      if (captured(operation)) send("response", operation, status, url, text);
      // Sent on its own as well for captured operations, so it is retried
      // until the service worker acknowledges the pause (bridge.js).
      if (isRateLimitBody(text)) send("limit", operation, status, url, "");
    };
    if (typeof body === "string") deliver(body);
    else if (body) apply(then, body, [deliver, () => {}]);
  };

  // One load listener per XHR, however many times it is opened; at load it
  // reads the URL the browser actually requested.
  const watched = new WeakSet();
  // The method, headers and body each XHR was sent with, since its last open().
  const requests = new WeakMap();
  const onXhrLoad = (event) => {
    if (!isTrusted(event)) return;
    const xhr = event.target;
    const graphql = parseGraphql(apply(xhrResponseURL, xhr, []));
    if (!graphql) return;
    const { href, operation } = graphql;
    const status = apply(xhrStatus, xhr, []);
    let body = null;
    const type = apply(xhrResponseType, xhr, []);
    if (type === "" || type === "text") {
      body = apply(xhrResponseText, xhr, []);
    } else if (type === "json") {
      // A "json" response has no raw text to copy, and re-serializing the
      // object would run page code (toJSON), so nothing of it is forwarded.
      // Its rate-limit verdict still is, for any operation.
      if (status >= 200 && status <= 299 && hasRateLimitError(apply(xhrResponse, xhr, []))) {
        send("limit", operation, status, href, "");
        return;
      }
    }
    report(href, operation, status, body);
    try {
      sendTemplate(href, operation, status, apply(weakGet, requests, [xhr]));
    } catch {
      // Never let capture break X.
    }
  };

  XMLHttpRequest.prototype.open = function () {
    try {
      if (!apply(weakHas, watched, [this])) {
        apply(weakAdd, watched, [this]);
        apply(listen, this, ["load", onXhrLoad]);
      }
      apply(weakSet, requests, [this, { method: methodOf(arguments[0]), headers: [], body: null }]);
    } catch {
      // Fall through to the real open().
    }
    return apply(xhrOpen, this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      const request = apply(weakGet, requests, [this]);
      if (request) keepHeader(request.headers, name, value);
    } catch {
      // Fall through to the real setRequestHeader().
    }
    return apply(xhrSetHeader, this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const request = apply(weakGet, requests, [this]);
      if (request && typeof body === "string") request.body = body;
    } catch {
      // Fall through to the real send().
    }
    return apply(xhrSend, this, arguments);
  };

  // What a fetch() call asked for: method, kept headers and a string body,
  // from a Request, the init dictionary, or both (init wins, as in fetch).
  const fetchRequest = (input, init) => {
    let headers = [];
    let method = "GET";
    let body = null;
    const fromHeaders = (h) => {
      const list = [];
      try {
        apply(headersForEach, h, [(value, name) => keepHeader(list, name, value)]);
        return list;
      } catch {
        // Not a Headers object.
      }
      if (isArray(h)) {
        for (let i = 0; i < h.length; i += 1) if (isArray(h[i])) keepHeader(list, h[i][0], h[i][1]);
      } else if (typeof h === "object" && h !== null) {
        for (const name in h) keepHeader(list, name, h[name]);
      }
      return list;
    };
    try {
      method = apply(reqMethod, input, []);
      headers = fromHeaders(apply(reqHeaders, input, []));
    } catch {
      // Not a Request.
    }
    if (init && typeof init === "object") {
      if (typeof init.method === "string") method = init.method;
      if (init.headers) headers = fromHeaders(init.headers);
      if (typeof init.body === "string") body = init.body;
    }
    return { method: methodOf(method), headers, body };
  };

  window.fetch = function () {
    let request = null;
    try {
      request = fetchRequest(arguments[0], arguments[1]);
    } catch {
      // The page gets its response either way.
    }
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
          const body = ok ? apply(resText, apply(resClone, res, []), []) : null;
          report(href, operation, status, body);
          sendTemplate(href, operation, status, request);
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
