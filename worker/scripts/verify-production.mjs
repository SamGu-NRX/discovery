// Prints what a deployment is doing: /health, each watcher's fetch_log and
// events, and the watcher_event candidates. Read-only unless --recheck is
// given, which forces one check of every watcher first (one request per
// source) to show that a second run adds no duplicate candidate.
//
// Usage: node scripts/verify-production.mjs <base-url> <admin-token-file> [--recheck]

import { readFileSync } from "node:fs";

const [base, tokenFile, flag] = process.argv.slice(2);
if (!base || !tokenFile) throw new Error("usage: verify-production.mjs <base-url> <admin-token-file> [--recheck]");
const token = readFileSync(tokenFile, "utf8").trim();
const get = async (path, method = "GET") => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
};
const iso = (ms) => (ms ? new Date(ms).toISOString() : "-");

const watcherCandidates = async () => (await get("/candidates?kind=watcher_event")).candidates;
const before = flag === "--recheck" ? (await watcherCandidates()).length : null;
if (flag === "--recheck") {
  for (const w of await get("/admin/watchers")) {
    const r = await get(`/admin/watchers/${w.id}/check`, "POST");
    console.log(`recheck ${w.id}: source=${r.source} status=${r.status} outcome=${r.outcome} events=${r.events_created} candidates=${r.candidates_created}`);
  }
}

console.log("health:", JSON.stringify(await (await fetch(`${base}/health`)).json()));
for (const w of await get("/admin/watchers")) {
  const d = await get(`/admin/watchers/${w.id}`);
  console.log(`\n${w.id}  seen_items=${d.seen_items}  alarm_at=${iso(d.alarm_at)}  mode=${w.mode}  failures=${w.consecutive_failures}`);
  for (const f of d.fetch_log) {
    console.log(`  ${iso(f.ts)} via=${f.via} source=${f.source ?? "-"} status=${f.status} bytes=${f.bytes} ${f.latency_ms}ms outcome=${f.outcome} items=${f.items_seen} events=${f.events_created} model_calls=${f.model_calls}${f.error ? ` error=${f.error}` : ""}`);
  }
  for (const e of d.events) console.log(`  event ${e.id} ${e.kind} ${e.dedupe_key}`);
}
const cands = await watcherCandidates();
console.log(`\nwatcher_event candidates: ${cands.length}`);
for (const c of cands) console.log(`  ${c.state} ${c.ref} "${c.title}" ${c.url ?? ""}`);
if (before !== null) console.log(`\ncandidates before recheck=${before} after=${cands.length}`);
