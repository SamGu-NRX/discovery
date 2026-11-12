#!/usr/bin/env node
// Scores collectors against the archive's judged context: for each save, how
// many of the posts the judge kept each collector had found.
//
//   node extension/tools/x-direct-score-judged.mjs --judged <dir> \
//     [--bundle <fetch bundle.json> ...] [--grokbot <inbox export.json> ...] \
//     [--saves <id,id,...>]
//
// --judged    archive/2026-11-12/context/judged in x-bookmarks-eval
// --bundle    fetch-mode bundles; a save counts as found when its id appears
//             anywhere in that save's context entry
// --grokbot   what GrokBot sent to POST /inbox/x: one part, an array of parts,
//             or any JSON holding items with thread_root_id and post.id
// --saves     saves to score; default: the 7 saves the computer-use pilot read
//
// "pilot" counts kept posts whose judged views name a view the computer-use
// pilot read (relevant, recent, branch_*, link_*, mentions_*, upstream). Views
// prefixed "fetch:" came from fetch mode, and "quoted-in:" posts were added by
// the judge, so neither counts as the pilot's.
import fs from "node:fs";
import path from "node:path";

const PILOT_SAVES = [
  "2119124661443457189", "2120252783953871317", "2119879610724720702", "2119930229661503893",
  "2120494222516339134", "2119870150845599972", "2115876931749200320",
];

function parseArgs(argv) {
  const out = { bundle: [], grokbot: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--judged") out.judged = value;
    else if (flag === "--bundle") out.bundle.push(value);
    else if (flag === "--grokbot") out.grokbot.push(value);
    else if (flag === "--saves") out.saves = value.split(",");
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!out.judged) throw new Error("--judged is required");
  return out;
}

const idsIn = (value, into = new Set()) => {
  if (typeof value === "string" && /^\d{15,20}$/.test(value)) into.add(value);
  else if (Array.isArray(value)) for (const v of value) idsIn(v, into);
  else if (value && typeof value === "object") for (const v of Object.values(value)) idsIn(v, into);
  return into;
};

function fetchFound(files) {
  const bySave = new Map();
  for (const file of files) {
    const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
    if (bundle.kind !== "x-direct-fetch-bundle") throw new Error(`${file} is not a fetch-mode bundle`);
    for (const [save, entry] of Object.entries(bundle.context ?? {})) {
      if (!bySave.has(save)) bySave.set(save, new Set());
      idsIn(entry, bySave.get(save));
    }
  }
  return bySave;
}

function grokbotFound(files) {
  const bySave = new Map();
  let items = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (typeof node.thread_root_id === "string" && typeof node.post?.id === "string") {
      if (!bySave.has(node.thread_root_id)) bySave.set(node.thread_root_id, new Set());
      bySave.get(node.thread_root_id).add(node.post.id);
      items += 1;
      return;
    }
    Object.values(node).forEach(walk);
  };
  for (const file of files) walk(JSON.parse(fs.readFileSync(file, "utf8")));
  if (files.length && items === 0) throw new Error("no thread items (thread_root_id and post.id) in the GrokBot files");
  return bySave;
}

const isPilotView = (view) => !view.startsWith("fetch:") && !view.startsWith("quoted-in:");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fetched = fetchFound(args.bundle);
  const grok = grokbotFound(args.grokbot);
  const saves = args.saves ?? PILOT_SAVES;
  const rows = [];
  for (const save of saves) {
    const file = path.join(args.judged, `${save}.json`);
    if (!fs.existsSync(file)) throw new Error(`no judged file for ${save} in ${args.judged}`);
    const judged = JSON.parse(fs.readFileSync(file, "utf8"));
    const kept = judged.kept ?? [];
    const row = { save, kept: kept.length, pilot: 0 };
    if (args.bundle.length) row.fetch = 0;
    if (args.grokbot.length) row.grokbot = 0;
    for (const k of kept) {
      const views = k.views ?? [];
      if (views.some(isPilotView)) row.pilot += 1;
      if (args.bundle.length && (fetched.get(save)?.has(k.id) || views.some((v) => v.startsWith("fetch:")))) row.fetch += 1;
      if (args.grokbot.length && grok.get(save)?.has(k.id)) row.grokbot += 1;
    }
    rows.push(row);
  }
  const total = rows.reduce((t, r) => {
    for (const [k, v] of Object.entries(r)) if (k !== "save") t[k] = (t[k] ?? 0) + v;
    return t;
  }, { save: "total" });
  console.log(JSON.stringify({ rows, total }, null, 1));
}

try {
  main();
} catch (err) {
  console.error(`x-direct-score-judged: ${err.message}`);
  process.exit(1);
}
