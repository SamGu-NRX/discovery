// Injected by the service worker into its own session window only (never
// into tabs Sam uses). It is the session's only way to touch a page, and it
// can do two things: read the page (inspect) and scroll the window. It has
// no command that clicks, types, focuses or submits anything. A click would
// run the page's own handlers on the clicked element and its ancestors, so
// sessions reach every page by navigating to URLs the extension built.

(() => {
  if (globalThis.__dxAgent) return;

  // Text the page shows outside posts, bios, user cells and the trends
  // sidebar, so a post that merely says "rate limit" cannot stop a session.
  function chromeText() {
    const skip = "article, [data-testid='tweetText'], [data-testid='UserDescription'], [data-testid='UserCell'], " +
      "[data-testid='sidebarColumn'], [contenteditable], script, style, noscript, textarea, input";
    const parts = [];
    let length = 0;
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    while (walker.nextNode() && length < 40_000) {
      const text = walker.currentNode.nodeValue.trim();
      if (text) {
        parts.push(text);
        length += text.length;
      }
    }
    return parts.join(" ");
  }

  const LOGIN_PATH = /^\/(login|logout|signup|i\/flow\/(login|signup|logout|password_reset))(\/|$)/;
  const CHALLENGE_PATH = /^\/(account\/access|account\/locked|i\/flow\/(arkose|challenge|verify))/;
  const LOGIN_SELECTOR =
    "input[name='password'], input[autocomplete='current-password'], [data-testid='loginButton'], " +
    "[data-testid='LoginForm_Login_Button'], [data-testid='login'], [data-testid='signup']";
  const CHALLENGE_SELECTOR =
    "iframe[src*='arkoselabs'], iframe[src*='funcaptcha'], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], " +
    "iframe[src*='challenges.cloudflare.com'], #arkose_iframe";
  const RATE_LIMIT_TEXT =
    /rate limit|rate-limited|over the daily limit|limit for (viewing|reading) posts|temporarily (limited|restricted)|your account is (limited|restricted)/i;
  const CHALLENGE_TEXT =
    /verify (you('|’)re|you are) (a )?human|prove (you('|’)re|you are) (a )?human|unusual (login )?activity|account (has been |is )?(locked|suspended)|authenticate your account|complete the challenge/i;
  const ERROR_TEXT = /something went wrong\. try reloading/i;

  function inspect() {
    const path = location.pathname;
    let blocker = null;
    let evidence = "";
    if (location.hostname !== "x.com") {
      blocker = "error";
      evidence = `left x.com for ${location.hostname}`;
    } else if (LOGIN_PATH.test(path)) {
      blocker = "login_wall";
      evidence = `path ${path}`;
    } else if (CHALLENGE_PATH.test(path)) {
      blocker = "challenge";
      evidence = `path ${path}`;
    } else if (document.querySelector(CHALLENGE_SELECTOR)) {
      blocker = "challenge";
      evidence = "challenge frame";
    } else {
      const login = [...document.querySelectorAll(LOGIN_SELECTOR)].find((el) => !el.closest("article"));
      if (login) {
        blocker = "login_wall";
        evidence = `login control ${login.getAttribute("data-testid") || login.tagName.toLowerCase()}`;
      } else {
        const text = chromeText();
        const challenge = CHALLENGE_TEXT.exec(text);
        const limited = RATE_LIMIT_TEXT.exec(text);
        if (challenge) {
          blocker = "challenge";
          evidence = `"${challenge[0]}"`;
        } else if (limited) {
          blocker = "rate_limited";
          evidence = `"${limited[0]}"`;
        } else if (ERROR_TEXT.test(text)) {
          return { blocker: null, errorPage: true, path, account: account() };
        }
      }
    }
    return { blocker, evidence, errorPage: false, path, account: account() };
  }

  function account() {
    const href = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href");
    const m = href && /^\/([A-Za-z0-9_]{1,15})$/.exec(href);
    return m ? m[1] : null;
  }

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
    // Measured before scrolling: a smooth scroll has not moved yet on return.
    const root = document.scrollingElement ?? document.documentElement;
    const atBottom = window.scrollY + window.innerHeight >= root.scrollHeight - 8;
    window.scrollBy({ top: Math.round(window.innerHeight * fraction), behavior: "smooth" });
    return { scrolled: true, atBottom };
  }

  const COMMANDS = Object.freeze({
    inspect: () => inspect(),
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
