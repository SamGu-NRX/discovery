// The click allowlist, run against real Chromium DOM (Playwright), since what
// it guards against is how a browser activates elements.

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
  await page.evaluate(() => {
    document.addEventListener("click", (e) => {
      window.__clicks.push(e.target.closest("[data-name]")?.dataset.name ?? "?");
      // X's router handles tab links itself; keep the fixture page in place.
      e.preventDefault();
    }, true);
  });
  await page.addScriptTag({ path: AGENT });
});

after(() => browser?.close());

// Renders `html` and runs one agent command. Returns the command's result or
// error and the data-name of each element a click reached.
async function runAgent(html, command) {
  return page.evaluate(([markup, cmd]) => {
    document.body.innerHTML = markup;
    window.__clicks = [];
    let outcome;
    try {
      outcome = { result: globalThis.__dxAgent.run(cmd) };
    } catch (err) {
      outcome = { error: err.message };
    }
    return { ...outcome, clicks: window.__clicks };
  }, [html, command]);
}

const homeTabs = (forYou) => `
  <nav role="tablist">
    ${forYou}
    <a href="/home" role="tab" aria-selected="true" data-name="following">Following</a>
  </nav>`;

test("the real For You tab is clicked", async () => {
  const out = await runAgent(homeTabs(`<a href="/home" role="tab" aria-selected="false" data-name="for-you">For you</a>`), { name: "click", arg: "for_you" });
  assert.deepEqual(out.result, { found: true, selected: false, clicked: true });
  assert.deepEqual(out.clicks, ["for-you"]);
});

test("a like button is never a click target, even when it looks like the For You tab", async () => {
  const like = `<div role="tab" data-testid="like" aria-selected="false" data-name="like">For you</div>`;
  const disguised = await runAgent(homeTabs(like), { name: "click", arg: "for_you" });
  assert.match(disguised.error, /click refused on for_you: action control like/);
  assert.deepEqual(disguised.clicks, []);

  const named = await runAgent(`<button data-testid="like" data-name="like">Like</button>`, { name: "click", arg: "like" });
  assert.match(named.error, /"like" is not an allowed target/);
  assert.deepEqual(named.clicks, []);
});

test("a For You lookalike inside a post or a link is refused", async () => {
  const inPost = await runAgent(
    `<article>${homeTabs(`<a href="/home" role="tab" aria-selected="false" data-name="for-you">For you</a>`)}</article>`,
    { name: "click", arg: "for_you" },
  );
  assert.match(inPost.error, /inside a post/);

  const inLink = await runAgent(
    homeTabs(`<a href="/logout" data-name="logout"><span role="tab" aria-selected="false" data-name="for-you">For you</span></a>`),
    { name: "click", arg: "for_you" },
  );
  assert.match(inLink.error, /inside a link/);

  const offsite = await runAgent(homeTabs(`<a href="https://evil.example/home" role="tab" aria-selected="false" data-name="for-you">For you</a>`), {
    name: "click",
    arg: "for_you",
  });
  assert.equal(offsite.result.found, false);
  assert.deepEqual([...inPost.clicks, ...inLink.clicks, ...offsite.clicks], []);
});

test("the agent has no command beyond inspect, scroll and the allowlisted click", async () => {
  const out = await runAgent("<input name='q'>", { name: "type", arg: "hello" });
  assert.match(out.error, /unknown agent command "type"/);
});
