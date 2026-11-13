// daily.html is fetch.html under another title (app/fetch/fetch.js runs both).
// The archive's runner finds its page by the title "X fetch mode", so the
// daily run's page must not carry it, and the two must not drift apart.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (name) => readFileSync(new URL(`../app/fetch/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("daily.html is fetch.html with the title X daily fetch", () => {
  const fetchPage = read("fetch.html");
  const dailyPage = read("daily.html");
  assert.match(fetchPage, /<title>X fetch mode<\/title>/);
  assert.match(dailyPage, /<title>X daily fetch<\/title>/);
  assert.equal(dailyPage.replace("<title>X daily fetch</title>", "<title>X fetch mode</title>"), fetchPage);
});
