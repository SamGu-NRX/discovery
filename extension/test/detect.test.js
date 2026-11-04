// detect.js in real Chromium DOM: what it reports as a blocker. Only what
// the page shows counts; X's pages carry hidden inputs and text. Found in a
// readiness review of fa4efb8.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const DETECT = fileURLToPath(new URL("../app/content/detect.js", import.meta.url));

let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("https://x.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://x.com/home");
  await page.addScriptTag({ path: DETECT });
});

after(() => browser?.close());

const blockerFor = (html) =>
  page.evaluate((markup) => {
    document.body.innerHTML = `<p>A healthy timeline</p>${markup}`;
    return globalThis.__dxDetect.inspect().blocker;
  }, html);

const LOGIN = '<input name="password">';
const LIMIT = "<p>Your account is temporarily limited</p>";
const CHALLENGE = "<p>Verify you are human</p>";

// Each wrapper hides its content from a person in a different way.
const HIDDEN = {
  "the hidden attribute": (inner) => `<div hidden>${inner}</div>`,
  "display: none": (inner) => `<div style="display:none">${inner}</div>`,
  "visibility: hidden": (inner) => `<div style="visibility:hidden">${inner}</div>`,
  "opacity: 0": (inner) => `<div style="opacity:0">${inner}</div>`,
  "a box with no size": (inner) => `<div style="width:0;height:0;overflow:hidden">${inner}</div>`,
  "a 1 px clipped box": (inner) => `<div style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">${inner}</div>`,
};

test("a hidden login control or hidden warning text is not a blocker", async () => {
  for (const [how, wrap] of Object.entries(HIDDEN)) {
    for (const blocker of [LOGIN, LIMIT, CHALLENGE]) {
      assert.equal(await blockerFor(wrap(blocker)), null, `${blocker} under ${how}`);
    }
  }
  assert.equal(await blockerFor('<input hidden name="password">'), null, "a hidden password input");
  assert.equal(await blockerFor('<input type="hidden" name="password">'), null, "an input of type hidden");
});

test("a login control or warning text the page shows is a blocker", async () => {
  assert.equal(await blockerFor(LOGIN), "login_wall");
  assert.equal(await blockerFor('<div data-testid="loginButton">Log in</div>'), "login_wall");
  assert.equal(await blockerFor(LIMIT), "rate_limited");
  assert.equal(await blockerFor(CHALLENGE), "challenge");
  // Shown next to hidden copies of itself, it still counts.
  assert.equal(await blockerFor(`${HIDDEN["display: none"](LOGIN)}${LOGIN}`), "login_wall");
});
