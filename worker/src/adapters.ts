// Source adapters turn a fetched body into either a list of items with stable
// ids or a normalized page text. None of them call a model.

export type Kind = "atom" | "greenhouse" | "hn" | "page" | "youtube_page";

export interface Item {
  id: string;
  title: string;
  url: string | null;
}

export type Parsed =
  | { shape: "items"; items: Item[] }
  | { shape: "page"; text: string };

export function parse(kind: Kind, body: string): Parsed {
  switch (kind) {
    case "atom":
      return { shape: "items", items: parseAtom(body) };
    case "greenhouse":
      return { shape: "items", items: parseGreenhouse(body) };
    case "hn":
      return { shape: "items", items: parseHn(body) };
    case "page":
      return { shape: "page", text: normalizePage(body) };
    case "youtube_page":
      return { shape: "items", items: parseYoutubeVideosPage(body) };
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function tagText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  return decodeEntities(m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")).trim();
}

// Atom identity is the entry <id>: "yt:video:<videoId>" on YouTube,
// "tag:github.com,2008:Repository/<n>/<tag>" on GitHub releases.
export function parseAtom(xml: string): Item[] {
  const items: Item[] = [];
  for (const m of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const id = tagText(entry, "id");
    if (!id) throw new Error("atom entry without <id>");
    const link = entry.match(/<link\b[^>]*\bhref="([^"]+)"/);
    items.push({ id, title: tagText(entry, "title") ?? "", url: link ? decodeEntities(link[1]) : null });
  }
  if (items.length === 0 && !/<feed[\s>]/.test(xml)) throw new Error("body is not an Atom feed");
  return items;
}

export function parseGreenhouse(body: string): Item[] {
  const data = JSON.parse(body) as { jobs?: { id: number; title: string; absolute_url?: string }[] };
  if (!Array.isArray(data.jobs)) throw new Error("greenhouse body has no jobs array");
  return data.jobs.map((j) => ({ id: String(j.id), title: j.title, url: j.absolute_url ?? null }));
}

export function parseHn(body: string): Item[] {
  const data = JSON.parse(body) as { hits?: { objectID: string; title: string | null; url: string | null }[] };
  if (!Array.isArray(data.hits)) throw new Error("hn body has no hits array");
  return data.hits.map((h) => ({
    id: h.objectID,
    title: h.title ?? "",
    url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
  }));
}

// Fallback for when the channel Atom feed is down (it returned 404 for every
// channel on 2026-11-04). Reads video ids from the ytInitialData JSON embedded
// in a channel's /videos tab. Ids use the Atom form, "yt:video:<id>", so items
// match what the feed and WebSub push would report for the same upload.
export function parseYoutubeVideosPage(html: string): Item[] {
  if (!html.includes("ytInitialData")) throw new Error("no ytInitialData in page; layout changed or consent wall");
  const ids = [...new Set([...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map((m) => m[1]))];
  if (ids.length === 0) throw new Error("no video ids on channel videos page");
  return ids.map((id) => ({ id: `yt:video:${id}`, title: "", url: `https://www.youtube.com/watch?v=${id}` }));
}

// Visible text only. Script, style and markup carry build ids, nonces and
// hashed class names that change on every deploy without the page changing.
export function normalizePage(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fingerprint(parsed: Parsed): Promise<string> {
  if (parsed.shape === "page") return sha256Hex(parsed.text);
  return sha256Hex(parsed.items.map((i) => i.id).sort().join("\n"));
}
