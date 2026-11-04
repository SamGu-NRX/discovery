// Injected by the service worker, after detect.js, into its own session
// window only (never into tabs Sam uses). It is the session's only way to
// touch a page, and it can do two things: read the page (inspect, from
// detect.js) and scroll the window. It has
// no command that clicks, types, focuses or submits anything. A click would
// run the page's own handlers on the clicked element and its ancestors, so
// sessions reach every page by navigating to URLs the extension built.

(() => {
  if (globalThis.__dxAgent) return;

  // `pathPattern` is the regex source of the paths the session expects. It
  // is checked here, in the same synchronous step as the scroll, because the
  // page can change its path between the service worker's check and this
  // script running.
  function scroll({ fraction, pathPattern } = {}) {
    if (typeof fraction !== "number" || !(fraction >= 0.3 && fraction <= 1.2)) {
      throw new Error(`scroll refused: fraction ${fraction}`);
    }
    if (typeof pathPattern !== "string" || !new RegExp(pathPattern).test(location.pathname)) {
      return { scrolled: false, path: location.pathname };
    }
    const root = document.scrollingElement ?? document.documentElement;
    const atBottom = window.scrollY + window.innerHeight >= root.scrollHeight - 8;
    // Instant, so the whole scroll happens inside this checked step; a smooth
    // scroll would keep moving after the page changed its path. The human
    // pace comes from the pause between screens.
    window.scrollBy({ top: Math.round(window.innerHeight * fraction), behavior: "instant" });
    return { scrolled: true, atBottom };
  }

  const COMMANDS = Object.freeze({
    inspect: () => globalThis.__dxDetect.inspect(),
    scroll: (arg) => scroll(arg),
  });

  Object.defineProperty(globalThis, "__dxAgent", {
    value: Object.freeze({
      run(command) {
        const name = command?.name;
        if (typeof name !== "string" || !Object.hasOwn(COMMANDS, name)) {
          throw new Error(`unknown agent command ${JSON.stringify(name)}`);
        }
        return COMMANDS[name](command.arg);
      },
    }),
  });
})();
