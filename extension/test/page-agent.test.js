// The page agent in real Chromium DOM. A click would run the page's own
// handlers on the element and its ancestors, so the agent must not be able to
// click at all, whatever the page looks like.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const DETECT = fileURLToPath(new URL("../app/content/detect.js", import.meta.url));
const AGENT = fileURLToPath(new URL("../app/content/page-agent.js", import.meta.url));

let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("https://x.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://x.com/home");
  // The session injects detect.js, then the agent.
  await page.addScriptTag({ path: DETECT });
  await page.addScriptTag({ path: AGENT });
});

after(() => browser?.close());

// Renders `html`, runs one agent command, and reports its result or error and
// every click and keystroke that reached the document.
function runAgent(html, command) {
  return page.evaluate(([markup, cmd]) => {
    document.body.innerHTML = markup;
    const events = [];
    const record = (e) => events.push(`${e.type}:${e.target.closest("[data-name]")?.dataset.name ?? e.target.tagName}`);
    for (const type of ["click", "keydown", "input", "submit"]) document.addEventListener(type, record, true);
    let outcome;
    try {
      outcome = { result: globalThis.__dxAgent.run(cmd) };
    } catch (err) {
      outcome = { error: err.message };
    }
    for (const type of ["click", "keydown", "input", "submit"]) document.removeEventListener(type, record, true);
    return { ...outcome, events };
  }, [html, command]);
}

const HOME_TABS = `
  <nav role="tablist">
    <a href="/home" role="tab" aria-selected="false" data-name="for-you">For you</a>
    <a href="/home" role="tab" aria-selected="true" data-name="following">Following</a>
  </nav>
  <article><button data-testid="like" data-name="like">Like</button></article>
  <form><input name="q" data-name="search"></form>`;

test("the agent cannot click, type or submit, even the For You tab", async () => {
  for (const command of [
    { name: "click", arg: "for_you" },
    { name: "click", arg: "like" },
    { name: "type", arg: "hello" },
    { name: "submit" },
  ]) {
    const out = await runAgent(HOME_TABS, command);
    assert.match(out.error ?? "", new RegExp(`unknown agent command "${command.name}"`), command.name);
    assert.deepEqual(out.events, [], command.name);
  }
});

test("reading and scrolling a page fire no clicks or input", async () => {
  for (const command of [{ name: "inspect" }, { name: "scroll", arg: { fraction: 0.8, pathPattern: "^/home$" } }]) {
    const out = await runAgent(HOME_TABS, command);
    assert.equal(out.error, undefined, command.name);
    assert.deepEqual(out.events, [], command.name);
  }
});

// The service worker checks the tab's path before injecting the agent, but
// the page can change its path in between. Found in review at 022960d.
test("the agent scrolls only when the page is still on the expected path", async () => {
  const moved = await page.evaluate(() => {
    history.replaceState(null, "", "/settings");
    return globalThis.__dxAgent.run({ name: "scroll", arg: { fraction: 0.8, pathPattern: "^/home$" } });
  });
  await page.evaluate(() => history.replaceState(null, "", "/home"));
  assert.deepEqual(moved, { scrolled: false, path: "/settings" });
});

// A smooth scroll keeps moving after the agent returns, so the page could
// change its path mid-scroll. Found in review at 1c7ec61.
test("a scroll is finished when the checked step returns", async () => {
  const moved = await page.evaluate(() => {
    document.body.innerHTML = '<div style="height:20000px"></div>';
    window.scrollTo({ top: 0, behavior: "instant" });
    const result = globalThis.__dxAgent.run({ name: "scroll", arg: { fraction: 0.8, pathPattern: "^/home$" } });
    return { result, y: window.scrollY, expected: Math.round(window.innerHeight * 0.8) };
  });
  assert.equal(moved.result.scrolled, true);
  assert.equal(moved.y, moved.expected);
});

// A lens reader's dwell: the post must be the one in view, found by the time
// link to its own permalink, never by a quoted post's link inside another.
test("scrollToPost brings that post into view by its own permalink, and scrolls only on the expected path", async () => {
  const out = await page.evaluate(() => {
    const filler = '<div style="height:3000px"></div>';
    document.body.innerHTML = `${filler}
      <article id="quoter"><a href="/a/status/111"><time>1h</time></a><div><a href="/b/status/222">quoted</a></div></article>
      ${filler}
      <article id="target"><a href="/b/status/222"><time>2h</time></a><button data-name="like">Like</button></article>
      ${filler}`;
    window.scrollTo({ top: 0, behavior: "instant" });
    const events = [];
    for (const type of ["click", "keydown", "input", "submit"]) document.addEventListener(type, (e) => events.push(e.type), true);
    const found = globalThis.__dxAgent.run({ name: "scrollToPost", arg: { postId: "222", pathPattern: "^/home$" } });
    const top = document.getElementById("target").getBoundingClientRect().top;
    const missing = globalThis.__dxAgent.run({ name: "scrollToPost", arg: { postId: "333", pathPattern: "^/home$" } });
    history.replaceState(null, "", "/settings");
    const moved = globalThis.__dxAgent.run({ name: "scrollToPost", arg: { postId: "222", pathPattern: "^/home$" } });
    history.replaceState(null, "", "/home");
    let refused = null;
    try {
      globalThis.__dxAgent.run({ name: "scrollToPost", arg: { postId: "222 or 1=1", pathPattern: "^/home$" } });
    } catch (err) {
      refused = err.message;
    }
    return { found, top, viewport: window.innerHeight, missing, moved, refused, events };
  });
  assert.deepEqual(out.found, { found: true });
  assert.ok(out.top >= 0 && out.top < out.viewport / 2, `the post's top is at ${out.top} of ${out.viewport}`);
  assert.deepEqual(out.missing, { found: false });
  assert.deepEqual(out.moved, { found: false, wrongPath: true, path: "/settings" });
  assert.match(out.refused, /refused/);
  assert.deepEqual(out.events, []);
});
