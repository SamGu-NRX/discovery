// Reads an x.com page and says whether X is showing a login wall, a
// challenge or a rate limit. Read-only: it looks at the URL, selectors and
// text it shows, and never clicks, focuses, types or touches a form. It runs
// in Sam's own X tabs, where bridge.js reports what it finds, and in session
// windows, where page-agent.js uses it.

(() => {
  if (globalThis.__dxDetect) return;

  // Shown on screen: rendered, not hidden by visibility or opacity, and
  // more than 1 px each way once every ancestor that clips its overflow has
  // cut it down (the usual visually-hidden pattern leaves 1 px). X's pages
  // carry hidden inputs and text that a person never sees; only what is
  // shown is a blocker. Found in a readiness review of fa4efb8.
  function shown(el, clips = new Map()) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = intersect(el.getBoundingClientRect(), clipBox(el.parentElement, clips));
    return box.right - box.left > 1 && box.bottom - box.top > 1;
  }

  // The area an element's overflow-clipping ancestors leave visible, cached
  // per element for one inspect() so siblings share the walk.
  const UNCLIPPED = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
  function clipBox(el, clips) {
    if (!el || el === document.documentElement) return UNCLIPPED;
    if (clips.has(el)) return clips.get(el);
    const style = getComputedStyle(el);
    const outer = clipBox(el.parentElement, clips);
    const box = style.overflowX === "visible" && style.overflowY === "visible" ? outer : intersect(el.getBoundingClientRect(), outer);
    clips.set(el, box);
    return box;
  }

  const intersect = (a, b) => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });

  // Text the page shows outside posts, bios, user cells and the trends
  // sidebar, so a post that merely says "rate limit" cannot stop a session.
  function chromeText() {
    const skip = "article, [data-testid='tweetText'], [data-testid='UserDescription'], [data-testid='UserCell'], " +
      "[data-testid='sidebarColumn'], [contenteditable], script, style, noscript, textarea, input";
    const parts = [];
    let length = 0;
    // Many text nodes share a parent; each element is measured once.
    const seen = new Map();
    const clips = new Map();
    const visible = (el) => {
      if (!seen.has(el)) seen.set(el, shown(el, clips));
      return seen.get(el);
    };
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        return !parent || parent.closest(skip) || !visible(parent) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
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
      const login = [...document.querySelectorAll(LOGIN_SELECTOR)].find((el) => !el.closest("article") && shown(el));
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

  Object.defineProperty(globalThis, "__dxDetect", { value: Object.freeze({ inspect }) });
})();
