// The text a lens embeds for a post (src/lens.ts). A post with little text of
// its own, a bare mention, a link or a one-line reply, embeds as noise; on the
// 170 Nov 12 saves, 4 of the 7 harness saves the agent-harnesses lens missed
// were such posts (docs/LENS.md). Such a post is embedded together with the
// title and first paragraph of the page it links, taken from the knowledge
// store's bundle for the post when one exists. No imports, so the tests load
// this file directly.

// Fewer words than this, not counting links and @mentions, is "little text".
export const THIN_WORDS = 15;
const URL = /https?:\/\/\S+/g;
const PARAGRAPH_MIN = 40;
const PARAGRAPH_MAX = 600;

export function isThin(text: string): boolean {
  const urls = text.match(URL) ?? [];
  const words = text
    .replace(URL, " ")
    .replace(/@\w+/g, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  // "Mostly a link": the links are more than half the post's characters.
  const linkChars = urls.join("").length;
  return words < THIN_WORDS || linkChars * 2 > text.trim().length;
}

export interface LinkContext {
  url: string;
  title: string | null;
  paragraph: string | null;
}

// The first paragraph of a page's extracted text that reads as prose: HTML
// tags, markdown images and link-only lines are skipped.
export function firstParagraph(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const block of text.split(/\n\s*\n/)) {
    const clean = block
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (clean.replace(URL, "").replace(/[^\p{L}]/gu, "").length >= PARAGRAPH_MIN) return clean.slice(0, PARAGRAPH_MAX);
  }
  return null;
}

// From a knowledge-store bundle (kworker's bundle.py writes `links`): the
// first link the post itself makes that was fetched, not one from a reply.
export function linkContext(bundle: unknown): LinkContext | null {
  const links = (bundle as { links?: unknown })?.links;
  if (!Array.isArray(links)) return null;
  for (const l of links as Record<string, unknown>[]) {
    if (l?.status !== "ok" || String(l.from ?? "").startsWith("reply")) continue;
    const title = typeof l.title === "string" && l.title.trim() ? l.title.trim() : null;
    const paragraph = firstParagraph(typeof l.text === "string" ? l.text : null);
    if (title || paragraph) return { url: String(l.final_url ?? l.url ?? ""), title, paragraph };
  }
  return null;
}

export function composeText(text: string, context: LinkContext | null): string {
  if (!context) return text;
  return [text, context.title, context.paragraph].filter((part) => part && part.trim()).join("\n\n");
}
