// When a run's tab counts as loaded (app/lib/xurl.js, loadedOnX): only on
// "complete" for an x.com page. The about:blank page a run's window starts
// on also completes, sometimes after the x.com navigation was asked for.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadedOnX } from "../app/lib/xurl.js";

test("a load counts only when the tab completes on an x.com page, never on about:blank", () => {
  assert.equal(loadedOnX({ status: "complete" }, { url: "https://x.com/i/bookmarks" }), true);
  assert.equal(loadedOnX({ status: "complete" }, { url: "about:blank" }), false);
  assert.equal(loadedOnX({ status: "complete" }, {}), false, "a URL the extension may not read");
  assert.equal(loadedOnX({ status: "loading" }, { url: "https://x.com/home" }), false);
  assert.equal(loadedOnX({ status: "complete" }, { url: "https://twitter.com/home" }), false);
  assert.equal(loadedOnX({ status: "complete" }, undefined), false);
});
