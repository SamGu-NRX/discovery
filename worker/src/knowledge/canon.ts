// Canonical URL (docs/KNOWLEDGE.md, "Canonical URL"). kworker implements the
// same rules in Python and both must pass docs/knowledge-canon-vectors.json,
// so this parses by hand instead of through WHATWG URL, which would
// re-encode the path and query and punycode the host.

const TRACKING = ["fbclid", "gclid", "mc_cid", "mc_eid", "igshid", "ref_src", "ref_url"];
const HOST_DROP: Record<string, string[]> = { "x.com": ["s", "t", "ref"], "www.youtube.com": ["si", "feature", "pp"] };
const HOST_ALIAS: Record<string, string> = {
  "twitter.com": "x.com",
  "www.twitter.com": "x.com",
  "mobile.twitter.com": "x.com",
  "www.x.com": "x.com",
  "mobile.x.com": "x.com",
  "m.youtube.com": "www.youtube.com",
  "youtube.com": "www.youtube.com",
  "www.github.com": "github.com",
};
const DEFAULT_PORT: Record<string, string> = { http: "80", https: "443" };

// Python compares str by code point; JS < compares UTF-16 code units, which
// orders astral characters differently.
function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

// Returns null for anything that is not an absolute http(s) URL with a host.
export function canonicalUrl(input: string): string | null {
  const m = input.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/);
  if (!m) return null;
  let scheme = m[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  const authority = m[2].slice(m[2].lastIndexOf("@") + 1);
  const hp = authority.match(/^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/);
  if (!hp) return null;
  let host = hp[1].toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  const port = hp[2] && hp[2] !== DEFAULT_PORT[scheme] ? `:${hp[2]}` : "";
  let path = m[3];
  let params = (m[4] ?? "").split("&").filter((p) => p !== "");

  host = HOST_ALIAS[host] ?? host;
  if (host === "youtu.be") {
    const id = path.split("/")[1];
    if (id) {
      scheme = "https";
      host = "www.youtube.com";
      path = "/watch";
      params = [`v=${id}`, ...params];
    }
  }

  const drop = HOST_DROP[host] ?? [];
  const nameOf = (p: string) => (p.includes("=") ? p.slice(0, p.indexOf("=")) : p);
  params = params
    .filter((p) => {
      const name = nameOf(p);
      return !name.startsWith("utm_") && !TRACKING.includes(name) && !drop.includes(name);
    })
    // Array.prototype.sort is stable, which keeps repeated names in order.
    .sort((a, b) => byCodePoint(nameOf(a), nameOf(b)));

  if (path === "") path = "/";
  if (host === "x.com") {
    const s = path.match(/^\/([^/]+)\/status\/([^/]+)(?:\/.*)?$/);
    if (s) path = `/${s[1].toLowerCase()}/status/${s[2]}`;
  } else if (host === "github.com") {
    const seg = path.split("/");
    if (seg[1]) seg[1] = seg[1].toLowerCase();
    if (seg[2]) seg[2] = seg[2].toLowerCase().replace(/\.git$/, "");
    path = seg.join("/");
  } else if (host === "arxiv.org") {
    const a = path.match(/^\/pdf\/(.+?)(?:\.pdf)?$/);
    if (a) path = `/abs/${a[1]}`;
  }

  return `${scheme}://${host}${port}${path}${params.length ? `?${params.join("&")}` : ""}`;
}
