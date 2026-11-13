// A run's or session's window is made on about:blank, which goes on loading
// for a moment after chrome.windows.create returns. A navigation asked for
// before that settles can be dropped, and the tab stays blank: on Nov 13 a
// daily e2e run stopped with "the fetch tab is on a page the extension cannot
// read after opening https://x.com/i/bookmarks" (no request reached X), and a
// session run with "the session tab left x.com (unknown url)". Given the tab
// chrome.windows.create returned, this waits for its "complete", up to
// timeoutMs, before the first navigation. A complete that lands before the
// listener is added costs the timeout, not the run.

export function blankTabSettled(tab, { timeoutMs = 5000 } = {}) {
  if (!tab || tab.status === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (tabId, info) => {
      if (tabId === tab.id && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
