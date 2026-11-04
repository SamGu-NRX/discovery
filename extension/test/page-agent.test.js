// The page agent in real Chromium DOM. A click would run the page's own
// handlers on the element and its ancestors, so the agent must not be able to
// click at all, whatever the page looks like.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const AGENT = fileURLToPath(new URL("../app/content/page-agent.js", import.meta.url));

let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("https://x.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://x.com/home");
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
  for (const command of [{ name: "inspect" }, { name: "scroll", arg: 0.8 }]) {
    const out = await runAgent(HOME_TABS, command);
    assert.equal(out.error, undefined, command.name);
    assert.deepEqual(out.events, [], command.name);
  }
});
