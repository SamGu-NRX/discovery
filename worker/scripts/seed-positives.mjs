// Seeds POST /positives with Sam's past X saves that have text.
// docs/CONTRACT.md, "Scoring and candidates". Reads the sources read-only.
//
// A post counts as a save only if a bookmark list names it: the archive and
// gold lists, the Oct 6 supplement, and the bookmark scans under
// ~/.codex/visualizations/2026/09/24/. Those folders also hold replies and
// thread context written by other people, which are not Sam's taste, so text
// is collected from every file but kept only for saved ids. Each save keeps
// the longest text any source has for it.
//
// Usage: node scripts/seed-positives.mjs [--dry-run] [base-url] [token-file]
//   defaults: https://discovery-watcher.sgu07966.workers.dev, ~/.agent-secrets/discovery-runner-token

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [base = "https://discovery-watcher.sgu07966.workers.dev", tokenFile = join(homedir(), ".agent-secrets/discovery-runner-token")] = args.filter((a) => a !== "--dry-run");

const EVAL = join(homedir(), "Programming Projects/x-bookmarks-eval");
const VIS = join(homedir(), ".codex/visualizations/2026/09/24");
const ARCHIVE = join(EVAL, "archive/2026-10-26/data.json");
const GOLD = [join(EVAL, "gold/sdotgu.json"), join(EVAL, "gold/_sgu_.json")];
const BASELINE = join(EVAL, "baseline/oct06-posts-example.json");

const STATUS = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,20})(?![\d])/;
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

function need(value, what) {
  if (value === undefined || value === null) throw new Error(`missing ${what}; the source format changed`);
  return value;
}

const saved = new Map(); // id -> source label
const texts = new Map(); // id -> { text, author_handle }

function save(idOrUrl, source) {
  const id = String(idOrUrl).match(/^\d{5,20}$/) ? String(idOrUrl) : String(idOrUrl).match(STATUS)?.[2];
  if (!id) throw new Error(`${source}: not a post id or status URL: ${String(idOrUrl).slice(0, 100)}`);
  if (!saved.has(id)) saved.set(id, source);
}

function offerText(id, text, handle) {
  if (typeof text !== "string" || !text.trim()) return;
  const t = text.trim();
  const prev = texts.get(id);
  if (!prev || t.length > prev.text.length) texts.set(id, { text: t, author_handle: handle ?? prev?.author_handle ?? null });
  else if (!prev.author_handle && handle) prev.author_handle = handle;
}

// Walks any JSON value and offers every post-shaped object's text: an object
// with a status URL or a numeric id, and a text-like field.
function harvestText(v, keyHint) {
  if (Array.isArray(v)) return v.forEach((x) => harvestText(x));
  if (!v || typeof v !== "object") return;
  const url = typeof v.url === "string" ? v.url.match(STATUS) : null;
  const id = url?.[2] ?? (typeof v.id === "string" && /^\d{5,20}$/.test(v.id) ? v.id : keyHint);
  const text = v.text ?? v.full_text ?? v.captured_text ?? v.excerpt;
  const handle = v.author_handle ?? v.handle ?? v.author?.screen_name ?? url?.[1] ?? null;
  if (id && typeof text === "string") offerText(id, text, typeof handle === "string" ? handle.replace(/^@/, "") : null);
  for (const [k, child] of Object.entries(v)) harvestText(child, /^\d{5,20}$/.test(k) ? k : undefined);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(json|jsonl)$/.test(name)) out.push(p);
  }
  return out;
}

function readAny(p) {
  const raw = readFileSync(p, "utf8");
  return p.endsWith(".jsonl") ? raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : JSON.parse(raw);
}

// --- saved ids, from bookmark lists only ---
const archive = read(ARCHIVE);
for (const a of need(archive.accounts, "archive accounts")) for (const b of need(a.bookmarks, "archive bookmarks")) save(b.id, "archive");
for (const p of GOLD) for (const b of need(read(p).bookmarks, `${p} bookmarks`)) save(b.id, "gold");
for (const p of need(read(BASELINE).posts, "baseline posts")) save(p.url, "baseline");

const visFiles = walk(VIS);
const visByName = (name) => {
  const hits = visFiles.filter((f) => f.endsWith(`/${name}`));
  if (hits.length !== 1) throw new Error(`expected one ${name} under ${VIS}, found ${hits.length}`);
  return read(hits[0]);
};
for (const ids of Object.values(visByName("bookmark-ids.json"))) for (const id of ids) save(id, "vis:bookmark-ids");
for (const list of Object.values(need(visByName("x-bookmark-source-2026-09-24.json").accounts, "x-bookmark-source accounts"))) for (const e of list) save(e.url, "vis:x-bookmark-source");
for (const e of need(visByName("bookmark-source-posts-2026-09-24.json").entries, "bookmark-source-posts entries")) {
  const first = e.links?.find((l) => l.class === "post" && STATUS.test(l.url));
  if (first) save(first.url, "vis:bookmark-source-posts");
}
const oct06 = visByName("bookmark-source-data-2026-10-06.json");
for (const p of need(oct06.posts, "bookmark-source-data posts")) save(p.url, "vis:bookmark-source-data");
for (const list of Object.values(need(oct06.inventory, "bookmark-source-data inventory"))) for (const e of list) if (STATUS.test(e.url ?? "")) save(e.url, "vis:bookmark-inventory");
const refresh = visByName("bookmark-refresh-source-data-2026-10-07.json");
for (const list of Object.values(need(refresh.accounts, "bookmark-refresh accounts"))) for (const e of list) save(e.url, "vis:bookmark-refresh");
for (const p of need(visByName("bookmarks-sdotgu.json").posts, "bookmarks-sdotgu posts")) save(p.url, "vis:bookmarks-sdotgu");
for (const g of need(visByName("bookmark-refresh-grouped-data-2026-10-07.json").groups, "grouped-data groups")) for (const id of g.bookmarkIds ?? []) save(id, "vis:grouped");

// --- text, from every source ---
harvestText(archive);
for (const p of GOLD) harvestText(read(p));
harvestText(read(BASELINE));
let unreadable = 0;
for (const f of visFiles) {
  try {
    harvestText(readAny(f));
  } catch {
    unreadable++;
  }
}

// A post whose text is only links (an X article stub, a bare URL) has no
// words to embed.
const hasWords = (t) => /\p{L}{2,}/u.test(t.replace(/https?:\/\/\S+/g, ""));
const items = [...saved.keys()]
  .filter((id) => texts.has(id) && hasWords(texts.get(id).text))
  .map((id) => ({ id, text: texts.get(id).text, author_handle: texts.get(id).author_handle, source: saved.get(id) }));
const bySource = items.reduce((m, i) => ((m[i.source] = (m[i.source] ?? 0) + 1), m), {});
console.log(`saved ids: ${saved.size}; with text: ${items.length}; without text or only links: ${saved.size - items.length}; unparseable files skipped: ${unreadable}`);
console.log("by first source:", JSON.stringify(bySource));
if (dryRun) {
  const lengths = items.map((i) => i.text.length).sort((a, b) => a - b);
  const pct = (q) => lengths[Math.floor((lengths.length - 1) * q)];
  console.log(`text length p10=${pct(0.1)} p50=${pct(0.5)} p90=${pct(0.9)}; no author handle: ${items.filter((i) => !i.author_handle).length}`);
  for (const i of items.filter((_, k) => k % Math.ceil(items.length / 8) === 0)) console.log(`  ${i.source} ${i.id} @${i.author_handle} ${JSON.stringify(i.text.slice(0, 120))}`);
  process.exit(0);
}

const token = readFileSync(tokenFile, "utf8").trim();
let inserted = 0;
for (let i = 0; i < items.length; i += 200) {
  const res = await fetch(`${base}/positives`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ items: items.slice(i, i + 200) }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`POST /positives -> ${res.status} ${body.slice(0, 300)}`);
  inserted += JSON.parse(body).inserted;
}
const total = await fetch(`${base}/positives?limit=1`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
console.log(`posted ${items.length}; newly inserted ${inserted}; positives in D1: ${total.total}`);
