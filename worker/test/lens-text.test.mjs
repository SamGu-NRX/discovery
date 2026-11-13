// Which posts a lens embeds with their linked page, and what it adds
// (src/lens-text.ts). Loaded as TypeScript by Node's type stripping.

import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPOSED_MAX, composeText, firstParagraph, imageTexts, isThin, linkContext, readBundle, threadParent, TITLE_MAX } from "../src/lens-text.ts";

test("a failed bundle read or a body that is not JSON gives no context and reports why, instead of failing the request", async () => {
  const seen = [];
  const note = (why) => seen.push(why);
  const failing = {
    get: async () => {
      throw new Error("R2 is down");
    },
  };
  assert.equal(await readBundle(failing, "bundles/1/v1.json", note), null);
  assert.equal(await readBundle({ get: async () => ({ json: async () => JSON.parse("not json") }) }, "bundles/2/v1.json", note), null);
  assert.equal(await readBundle({ get: async () => null }, "bundles/3/v1.json", note), null, "a missing object is no context, not an error");
  assert.deepEqual(await readBundle({ get: async () => ({ json: async () => ({ links: [] }) }) }, "bundles/4/v1.json", note), { links: [] });
  assert.equal(seen.length, 2);
  assert.match(seen[0], /bundles\/1\/v1\.json: R2 is down/);
});

test("a row of markdown links is not prose, a link inside prose keeps its text, and titles, pages and the composed text are bounded", () => {
  const nav = "[Home](https://a.b/) [About us](https://a.b/about) [Pricing plans](https://a.b/p) [Documentation](https://a.b/d) [Contact](https://a.b/c)";
  const prose = "Skills that teach your [coding agent](https://a.b/agent) design engineering, motion and polish.";
  assert.equal(firstParagraph(`${nav}\n\n${prose}`), "Skills that teach your coding agent design engineering, motion and polish.");
  assert.equal(firstParagraph(`${"x\n\n".repeat(15_000)}${prose}`), null, "only the start of a long page is searched");
  const ctx = linkContext({ links: [{ url: "https://a.b", from: "post", status: "ok", title: "T".repeat(5000), text: prose }] });
  assert.equal(ctx.title.length, TITLE_MAX);
  assert.equal(composeText("x ".repeat(3000), { link: { url: "u", title: "t", paragraph: "p" } }).length, COMPOSED_MAX);
});

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
  assert.equal(composeText("@theo https://t.co/x", { link: ctx }), "@theo https://t.co/x\n\nemilkowalski/skills\n\nSkills that teach your coding agent design engineering: prototyping, motion and polish.");
  assert.equal(linkContext({ links: [] }), null);
  assert.equal(linkContext(null), null);
  assert.equal(composeText("text", null), "text");
  assert.equal(firstParagraph("short\n\n<b>tags only</b>"), null, "nothing that reads as prose");
});

test("a thin post adds its parent, then its own images' text, then the link, each cut to 600 characters", () => {
  const bundle = {
    thread: [
      { id: "1", text: "the author's earlier post", is_save: false },
      { id: "2", text: "@theo", is_save: true },
      { id: "3", text: "a later post", is_save: false },
    ],
    media: [
      { id: "m0", post_id: "2", image: { text: "Switch to Claude Fable 5.2 for the toughest work.", ocr_uncertain: false } },
      { id: "m1", post_id: "3", image: { text: "an image of a later post" } },
      { id: "m2", post_id: "2", image: { text: "  " } },
      { id: "m3", post_id: "2", kind: "video", video: {} },
    ],
  };
  assert.equal(threadParent(bundle), "the author's earlier post");
  assert.equal(threadParent({ thread: [{ id: "2", text: "first", is_save: true }] }), null, "a save that starts its thread has no parent there");
  assert.deepEqual(imageTexts(bundle, "2"), ["Switch to Claude Fable 5.2 for the toughest work."]);
  assert.deepEqual(imageTexts(null, "2"), []);

  const link = { url: "https://e.x", title: "Title", paragraph: "Paragraph." };
  assert.equal(
    composeText("@theo", { parent: "parent text", images: ["one", "two"], link }),
    "@theo\n\nparent text\n\none\ntwo\n\nTitle\n\nParagraph.",
  );
  const long = composeText("@theo", { parent: "p".repeat(5000), images: ["i".repeat(5000)] });
  assert.equal(long, `@theo\n\n${"p".repeat(600)}\n\n${"i".repeat(600)}`);
  assert.equal(composeText("@theo", { parent: null, images: [], link: null }), "@theo");
});
