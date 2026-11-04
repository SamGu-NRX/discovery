// Isolated world, document_start on x.com. Receives captured responses from
// hook.js over the private channel described there and forwards them to the
// service worker. It only reads the page (the logged-in handle from the side
// nav) and never touches X otherwise.

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

  // One message in flight at a time keeps captures in the order X sent them,
  // which the service worker relies on for positions and thread pages.
  let queue = Promise.resolve();
  function onData(event) {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (message?.kind !== "response" && message?.kind !== "status") return;
    queue = queue
      .then(() =>
        chrome.runtime.sendMessage({
          type: message.kind === "response" ? "capture" : "x-status",
          operation: message.operation,
          url: message.url,
          status: message.status,
          body: message.body,
          pageLoadId,
          account: account(),
        }),
      )
      .catch(() => {
        // The extension was reloaded or the worker is restarting; the page is unaffected.
      });
  }
})();
