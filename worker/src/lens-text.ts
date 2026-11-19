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
export const TITLE_MAX = 200;
// Only the start of a linked page is searched for its first paragraph; a
// page's extracted text can run to hundreds of kilobytes.
const PAGE_SCAN_MAX = 20_000;
// The whole text a thin post embeds as, post included.
export const COMPOSED_MAX = 2_000;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;

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

// The first paragraph of a page's extracted text that reads as prose, within
// its first PAGE_SCAN_MAX characters. HTML tags and markdown images are
// dropped; a markdown link keeps its text but its letters do not count
// toward prose, so a navigation row of [anchor](url) links is skipped.
export function firstParagraph(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const block of text.slice(0, PAGE_SCAN_MAX).split(/\n\s*\n/)) {
    const tidy = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
    const prose = tidy(block).replace(MD_LINK, " ").replace(URL, "").replace(/[^\p{L}]/gu, "");
    if (prose.length < PARAGRAPH_MIN) continue;
    return tidy(block).replace(MD_LINK, "$1").replace(/\s+/g, " ").trim().slice(0, PARAGRAPH_MAX);
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
    const title = typeof l.title === "string" && l.title.trim() ? l.title.trim().slice(0, TITLE_MAX) : null;
    const paragraph = firstParagraph(typeof l.text === "string" ? l.text : null);
    if (title || paragraph) return { url: String(l.final_url ?? l.url ?? ""), title, paragraph };
  }
  return null;
}

export function composeText(text: string, context: LinkContext | null): string {
  if (!context) return text;
  const parts = [text, context.title?.slice(0, TITLE_MAX), context.paragraph?.slice(0, PARAGRAPH_MAX)];
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n\n")
    .slice(0, COMPOSED_MAX);
}

// The knowledge store's bucket, as far as lens scoring uses it.
export interface BundleBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

// Reads one bundle's JSON. A failed read or a body that is not JSON costs
// the post its context, not the request: the post embeds as its own text,
// and onError hears why.
export async function readBundle(bucket: BundleBucket, key: string, onError: (why: string) => void): Promise<unknown> {
  try {
    const obj = await bucket.get(key);
    return obj ? await obj.json() : null;
  } catch (err) {
    onError(`bundle ${key}: ${(err as Error).message}`);
    return null;
  }
}
