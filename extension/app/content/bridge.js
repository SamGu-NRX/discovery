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

  // X is a single-page app, so the page is checked shortly after each URL
  // change (and the first load), once the new view has rendered. Each
  // blocker is reported once per path.
  const reportedBlockers = new Set();
  const checkForBlocker = () => {
    const seen = globalThis.__dxDetect?.inspect();
    if (!seen || !["login_wall", "challenge", "rate_limited"].includes(seen.blocker)) return;
    const key = `${seen.blocker}|${seen.path}`;
    if (reportedBlockers.has(key)) return;
    reportedBlockers.add(key);
    chrome.runtime
      .sendMessage({ type: "x-blocker", blocker: seen.blocker, evidence: seen.evidence, path: seen.path })
      .catch(() => {});
  };
  let lastHref = null;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    setTimeout(checkForBlocker, 1500);
    setTimeout(checkForBlocker, 5000);
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
    if (version !== "dx1" || (kind !== "response" && kind !== "status")) return null;
    if (!/^[A-Za-z]+$/.test(operation) || !/^\d{3}$/.test(status)) return null;
    return { kind, operation, status: Number(status), url, body: detail.slice(start) };
  }

  function onData(event) {
    const message = decode(event.detail);
    if (!message) return;
    queue = queue
      .then(() =>
        chrome.runtime.sendMessage({
          type: message.kind === "response" ? "capture" : "x-status",
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
