// Injected by the service worker into its own session window only (never
// into tabs Sam uses). It is the session's only way to touch a page, and it
// can do three things: read the page (inspect), scroll the window, and click
// one of two tabs named in CLICK_TARGETS below. It has no command that types,
// submits, or clicks anything else, and the target list is a frozen constant:
// nothing from the page or the Worker reaches it.

(() => {
  if (globalThis.__dxAgent) return;

  const isTab = (el) =>
    el.getAttribute("role") === "tab" && el.closest('[role="tablist"]') !== null && /^(A|DIV|SPAN)$/.test(el.tagName);

  const label = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  // An anchor's resolved path, or null for an element without href.
  const hrefPath = (el) => {
    if (!el.hasAttribute("href")) return null;
    try {
      const url = new URL(el.getAttribute("href"), location.href);
      return url.origin === "https://x.com" ? url.pathname : "offsite";
    } catch {
      return "offsite";
    }
  };

  const CLICK_TARGETS = Object.freeze({
    // Home's "For you" tab. Both home tabs link to /home and differ only by label.
    for_you: Object.freeze({
      page: (path) => path === "/home",
      matches: (el) => isTab(el) && label(el) === "For you" && [null, "/home"].includes(hrefPath(el)),
    }),
    // The Bookmarks tab, when X shows bookmarks as a tab of /i/history.
    bookmarks: Object.freeze({
      page: (path) => path.startsWith("/i/history") || path.startsWith("/i/bookmarks"),
      matches: (el) =>
        isTab(el) &&
        [null, "/i/bookmarks", "/i/history/bookmarks"].includes(hrefPath(el)) &&
        (label(el) === "Bookmarks" || hrefPath(el) !== null),
    }),
  });

  // Checked for every click on top of the target's own match. A click event
  // bubbles through every ancestor, and clicking inside a link, button, label
  // or summary activates that ancestor. So the tab may sit only in plain
  // wrappers: no ancestor may be a control or look like one, and nothing on
  // the path may carry a post-action test id (like, repost, reply, bookmark,
  // follow, the "..." caret, compose, login), in any variant such as
  // "123-follow".
  const CONTROL_TAGS = new Set(["A", "BUTTON", "LABEL", "FORM", "ARTICLE", "SUMMARY", "DETAILS", "SELECT", "OPTION", "INPUT", "TEXTAREA"]);
  const CONTROL_ROLES = new Set([
    "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "switch", "radio", "option",
    "menu", "menubar", "dialog", "alertdialog", "combobox", "textbox", "listbox", "slider", "spinbutton",
    "treeitem", "gridcell", "row", "article",
  ]);
  const ACTION_TESTID = /like|retweet|repost|reply|bookmark|caret|follow|block|mute|share|report|delete|tweetbutton|newtweet|senddm|confirmationsheet|login|signup|logout/i;

  function refuseReason(el) {
    if (!(el instanceof HTMLElement) || !el.isConnected) return "not an element in the page";
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const testid = node.getAttribute("data-testid");
      if (testid && ACTION_TESTID.test(testid)) return `action control ${testid}`;
      if (node === el) continue;
      const role = node.getAttribute("role");
      if (CONTROL_TAGS.has(node.tagName)) return `inside a ${node.tagName.toLowerCase()} element`;
      if (role && CONTROL_ROLES.has(role)) return `inside role=${role}`;
      if (node.isContentEditable || node.hasAttribute("onclick") || node.hasAttribute("aria-haspopup")) {
        return "inside an interactive element";
      }
      const tabindex = node.getAttribute("tabindex");
      if (role !== "tablist" && tabindex !== null && Number(tabindex) >= 0) return "inside a focusable element";
    }
    if (el.querySelector("a, button, input, textarea, select, form, label, [role='button'], [role='link'], [role='menuitem']")) {
      return "contains a control";
    }
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return "not visible";
    return null;
  }

  // A refusal clicks nothing and is not an error: the session notes it and
  // carries on reading whatever tab is selected.
  function clickTarget(id) {
    if (typeof id !== "string" || !Object.hasOwn(CLICK_TARGETS, id)) {
      throw new Error(`click refused: ${JSON.stringify(id)} is not an allowed target`);
    }
    const target = CLICK_TARGETS[id];
    if (!target.page(location.pathname)) return { found: false, reason: `not on the page for ${id}` };
    const candidates = [...document.querySelectorAll('[role="tab"]')].filter(target.matches);
    if (candidates.length !== 1) return { found: false, reason: `${candidates.length} elements match ${id}` };
    const el = candidates[0];
    if (el.getAttribute("aria-selected") === "true") return { found: true, selected: true, clicked: false };
    const refused = refuseReason(el);
    if (refused) return { found: false, refused: `click refused on ${id}: ${refused}` };
    el.click();
    return { found: true, selected: false, clicked: true };
  }

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

  function scroll(fraction) {
    if (typeof fraction !== "number" || !(fraction >= 0.3 && fraction <= 1.2)) {
      throw new Error(`scroll refused: fraction ${fraction}`);
    }
    // Measured before scrolling: a smooth scroll has not moved yet on return.
    const root = document.scrollingElement ?? document.documentElement;
    const atBottom = window.scrollY + window.innerHeight >= root.scrollHeight - 8;
    window.scrollBy({ top: Math.round(window.innerHeight * fraction), behavior: "smooth" });
    return { atBottom };
  }

  const COMMANDS = Object.freeze({
    inspect: () => inspect(),
    scroll: (arg) => scroll(arg),
    click: (arg) => clickTarget(arg),
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
