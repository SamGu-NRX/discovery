// Which posts a lens embeds with their linked page, and what it adds
// (src/lens-text.ts). Loaded as TypeScript by Node's type stripping.

import assert from "node:assert/strict";
import { test } from "node:test";
import { composeText, firstParagraph, isThin, linkContext } from "../src/lens-text.ts";

test("a post with under 15 words, or mostly a link, counts as thin; links and mentions are not words", () => {
  assert.equal(isThin("@theo"), true);
  assert.equal(isThin("https://t.co/abc123 https://github.com/emilkowalski/skills"), true);
  assert.equal(isThin("@a @b @c use hex by @kitlangton https://github.com/kitlangton/hex"), true);
  const fifteen = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
  assert.equal(isThin(fifteen), false);
  assert.equal(isThin(`${fifteen} https://example.com/a`), false);
  assert.equal(isThin(`short words here https://example.com/${"x".repeat(80)}`), true, "the link is most of the post");
});

test("the linked page adds its title and first prose paragraph, from the post's own fetched link", () => {
  const bundle = {
    links: [
      { url: "https://x.com/reply-link", from: "reply:1", status: "ok", title: "Reply link", text: "A long enough paragraph from a reply's link that must not be used here." },
      { url: "https://down.example", from: "post", status: "error", title: null, text: null },
      {
        url: "https://github.com/emilkowalski/skills",
        from: "post",
        status: "ok",
        title: "emilkowalski/skills",
        text: '<a href="https://aiforui.dev/"><img alt="og" src="x.png" /></a>\n\n![badge](https://img.shields.io/x)\n\nSkills that teach your coding agent design engineering: prototyping, motion and polish.\n\nSecond paragraph.',
      },
    ],
  };
  const ctx = linkContext(bundle);
  assert.deepEqual(ctx, { url: "https://github.com/emilkowalski/skills", title: "emilkowalski/skills", paragraph: "Skills that teach your coding agent design engineering: prototyping, motion and polish." });
  assert.equal(composeText("@theo https://t.co/x", ctx), "@theo https://t.co/x\n\nemilkowalski/skills\n\nSkills that teach your coding agent design engineering: prototyping, motion and polish.");
  assert.equal(linkContext({ links: [] }), null);
  assert.equal(linkContext(null), null);
  assert.equal(composeText("text", null), "text");
  assert.equal(firstParagraph("short\n\n<b>tags only</b>"), null, "nothing that reads as prose");
});
