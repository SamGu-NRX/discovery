#!/usr/bin/env node
// Compares a fetch-mode bundle (app/fetch/fetch.js download) with the
// computer-use archive run of Nov 12 (SamGu-NRX/x-bookmarks-eval, branch
// x-archive-2026-11-12) and prints the tables docs/X-DIRECT.md reports.
//
//   node tools/x-direct-compare.mjs --bundle x-fetch-*.json \
//     --list archive/2026-11-12/lists/sdotgu.json \
//     [--pilot archive/2026-11-12/context/raw] [--json out.json]
//
// --list is the Phase 1 list: rows with id and order, the boundary at
// boundary_order. --pilot is the Phase 2 pilot's context/raw folder, one
// folder per save holding views.json.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { bundle: { type: "string" }, list: { type: "string" }, pilot: { type: "string" }, json: { type: "string" } },
});
if (!args.bundle || !args.list) {
  console.error("usage: x-direct-compare.mjs --bundle <bundle.json> --list <sdotgu.json> [--pilot <context/raw>] [--json <out>]");
  process.exit(2);
}

function compareBookmarks(bundle, list) {
  const truth = [...list.rows].sort((a, b) => a.order - b.order).map((r) => String(r.id));
  const fetched = bundle.bookmarks?.ids ?? [];
  const boundary = truth[list.boundary_order];
  const at = fetched.indexOf(boundary);
  // Same window as the ground truth: everything above the boundary, the
  // boundary, and as many rows below it as the list has.
  const window = at < 0 ? fetched : fetched.slice(0, at + 1 + list.rows_below_boundary);
  const inTruth = new Set(truth);
  const inFetched = new Set(window);
  const both = window.filter((id) => inTruth.has(id));
  // Order: pairs of shared ids the two lists put in opposite order.
  const rank = new Map(truth.map((id, i) => [id, i]));
  let discordant = 0;
  for (let i = 0; i < both.length; i += 1) for (let j = i + 1; j < both.length; j += 1) if (rank.get(both[i]) > rank.get(both[j])) discordant += 1;
  const firstDifference = truth.findIndex((id, i) => window[i] !== id);
  return {
    truth: truth.length,
    fetched: window.length,
    fetchedTotal: fetched.length,
    boundaryFound: at >= 0,
    boundaryIndexFetched: at,
    boundaryIndexTruth: list.boundary_order,
    shared: both.length,
    recall: both.length / truth.length,
    precision: window.length ? both.length / window.length : 0,
    exactOrder: firstDifference === -1 && window.length === truth.length,
    discordantPairs: discordant,
    firstDifference,
    missing: truth.filter((id) => !inFetched.has(id)),
    extra: window.filter((id) => !inTruth.has(id)),
    pages: bundle.bookmarks?.pages ?? null,
    wallMs: bundle.bookmarks?.wallMs ?? null,
  };
}

// The pilot's views (views.json, one record per view with the ids it saw in
// order), grouped the way fetch mode collects them. The ids a conversation
// view saw include the saved post, what it replies to and Discover more,
// which the pilot also lists apart; replies are the rest.
const BUCKET = {
  conversation_relevant: "relevance",
  conversation_recent: "recency",
  nested_branch: "branches",
  quotes: "quotes",
  mentions: "mentions",
  linked_url_mentions: "mentions",
};

async function readPilot(dir) {
  const saves = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const views = JSON.parse(await readFile(join(dir, entry.name, "views.json"), "utf8"));
    const buckets = {};
    const add = (bucket, ids) => {
      const set = (buckets[bucket] ??= new Set());
      for (const id of ids ?? []) if (/^\d+$/.test(String(id))) set.add(String(id));
    };
    let wallMs = 0;
    for (const v of views) {
      const bucket = BUCKET[v.view_type] ?? "other";
      const aside = new Set([...(v.recommendation_ids ?? []), ...(v.upstream_ids ?? [])].map(String));
      // A conversation view also saw Discover more and other page furniture;
      // where the pilot separated its replies (reply_ids_seen), those count.
      const seen = bucket !== "other" && v.reply_ids_seen ? v.reply_ids_seen : v.distinct_ids_seen;
      add(bucket, (seen ?? []).filter((x) => !aside.has(String(x))));
      add("discover", v.recommendation_ids);
      add("upstream", v.upstream_ids);
      if (v.started_at && v.ended_at) wallMs += Date.parse(v.ended_at) - Date.parse(v.started_at);
    }
    saves[entry.name] = { buckets, views: views.map((v) => v.view_type), wallMs, xReplies: views.find((v) => v.view_type === "conversation_relevant")?.x_reply_count ?? null };
  }
  return saves;
}

function fetchBuckets(record) {
  const ids = (xs) => new Set(xs ?? []);
  const union = (...sets) => new Set(sets.flatMap((s) => [...s]));
  const focal = record.id;
  const threadIds = (t) => (t ? [...t.op_self_thread_ids, ...t.reply_ids].filter((x) => x !== focal) : []);
  const searchIds = (group) => Object.values(group ?? {}).flatMap((byProduct) => Object.values(byProduct).flatMap((r) => r.ids));
  const relevance = ids(threadIds(record.orders?.Relevance?.thread));
  const recency = ids(threadIds(record.orders?.Recency?.thread));
  const branches = ids((record.branches ?? []).flatMap((b) => threadIds(b.thread).filter((x) => x !== b.id)));
  const conversation = ids(searchIds(record.conversation));
  return {
    relevance,
    recency,
    branches,
    replies: union(relevance, recency, branches, conversation),
    quotes: ids(searchIds(record.quotes)),
    mentions: union(ids(searchIds(record.mentions)), ids(searchIds(record.links))),
    discover: ids([...(record.orders?.Relevance?.thread?.related_ids ?? []), ...(record.orders?.Recency?.thread?.related_ids ?? [])]),
  };
}

async function compareContext(bundle, dir) {
  const pilot = await readPilot(dir);
  const rows = [];
  for (const [id, record] of Object.entries(bundle.context ?? {})) {
    const p = pilot[id];
    if (!p) continue; // a save the pilot never reached
    const f = fetchBuckets(record);
    const focal = bundle.posts?.[id];
    const pilotSet = (...names) => new Set(names.flatMap((n) => [...(p?.buckets[n] ?? [])]).filter((x) => x !== id));
    const compare = (fetchSet, pilotIds) => {
      const both = [...fetchSet].filter((x) => pilotIds.has(x));
      return { fetch: fetchSet.size, pilot: pilotIds.size, both: both.length, pilotOnly: [...pilotIds].filter((x) => !fetchSet.has(x)), fetchOnly: [...fetchSet].filter((x) => !pilotIds.has(x)).length };
    };
    rows.push({
      id,
      author: focal?.author_handle ?? null,
      xReplies: focal?.metrics?.replies ?? null,
      xQuotes: focal?.metrics?.quotes ?? null,
      pilotViews: p?.views ?? [],
      replies: compare(f.replies, pilotSet("relevance", "recency", "branches")),
      quotes: compare(f.quotes, pilotSet("quotes")),
      mentions: compare(f.mentions, pilotSet("mentions")),
      discover: compare(f.discover, pilotSet("discover")),
      detailRequests: record.detailRequests,
      searchRequests: record.searchRequests,
      detailCapped: record.detailCapped,
      error: record.error ?? null,
      wallMs: record.wallMs,
      pilotWallMs: p.wallMs,
    });
  }
  return rows;
}

function runSummary(bundle) {
  const byOp = {};
  for (const row of bundle.ledger ?? []) {
    const s = (byOp[row.operation] ??= { requests: 0, ms: 0, statuses: {} });
    s.requests += 1;
    s.ms += row.ms ?? 0;
    s.statuses[row.status] = (s.statuses[row.status] ?? 0) + 1;
  }
  return {
    requests: bundle.requests,
    primes: bundle.primes?.length ?? 0,
    wallMs: bundle.wall_ms,
    stop: bundle.stop,
    rateWaits: bundle.rateWaits ?? [],
    posts: Object.keys(bundle.posts ?? {}).length,
    modelTokens: bundle.model_tokens,
    byOp,
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const secs = (ms) => (ms === null || ms === undefined ? "?" : `${(ms / 1000).toFixed(1)} s`);

function printBookmarks(b) {
  console.log("## Bookmarks (bookmarks_until)\n");
  console.log("| ground truth rows | fetched in window | shared | recall | precision | exact order | discordant pairs | boundary index (truth / fetched) | pages | wall |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  console.log(`| ${b.truth} | ${b.fetched} | ${b.shared} | ${pct(b.recall)} | ${pct(b.precision)} | ${b.exactOrder ? "yes" : `no (first at ${b.firstDifference})`} | ${b.discordantPairs} | ${b.boundaryIndexTruth} / ${b.boundaryIndexFetched} | ${b.pages} | ${secs(b.wallMs)} |`);
  if (b.missing.length) console.log(`\nMissing from fetch: ${b.missing.join(", ")}`);
  if (b.extra.length) console.log(`\nOnly in fetch: ${b.extra.join(", ")}`);
  console.log();
}

function printContext(rows) {
  console.log("## Context per save (fetch / pilot / both; pilot-only ids listed below)\n");
  console.log("| save | author | X replies | replies | X quotes | quotes | mentions+links | Discover more | TweetDetail / Search requests | wall (fetch / pilot) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  const cell = (c) => `${c.fetch} / ${c.pilot} / ${c.both}`;
  for (const r of rows) {
    console.log(`| ${r.id} | ${r.author ?? "?"} | ${r.xReplies ?? "?"} | ${cell(r.replies)} | ${r.xQuotes ?? "?"} | ${cell(r.quotes)} | ${cell(r.mentions)} | ${cell(r.discover)} | ${r.detailRequests} / ${r.searchRequests}${r.detailCapped ? " (capped)" : ""} | ${secs(r.wallMs)} / ${secs(r.pilotWallMs)} |`);
  }
  console.log();
  for (const r of rows) {
    const missed = ["replies", "quotes", "mentions", "discover"].filter((k) => r[k].pilotOnly.length).map((k) => `${k}: ${r[k].pilotOnly.join(" ")}`);
    if (missed.length) console.log(`- ${r.id} pilot-only ${missed.join("; ")}`);
    if (r.error) console.log(`- ${r.id} error: ${r.error}`);
  }
  console.log();
}

function printRun(run) {
  console.log("## Run\n");
  console.log(`Requests ${run.requests} (page loads ${run.primes}), posts ${run.posts}, wall ${secs(run.wallMs)}, model tokens ${run.modelTokens}, stop ${run.stop ? `${run.stop.reason}: ${run.stop.detail}` : "none"}`);
  for (const [op, s] of Object.entries(run.byOp)) console.log(`- ${op}: ${s.requests} requests, mean ${Math.round(s.ms / s.requests)} ms, statuses ${JSON.stringify(s.statuses)}`);
  for (const w of run.rateWaits) console.log(`- waited ${secs(w.ms)} for ${w.operation}'s rate window (${w.remaining}/${w.limit} left)`);
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const bundle = await readJson(args.bundle);
const list = await readJson(args.list);
const out = { bookmarks: compareBookmarks(bundle, list), context: args.pilot ? await compareContext(bundle, args.pilot) : null, run: runSummary(bundle) };

printBookmarks(out.bookmarks);
if (out.context) printContext(out.context);
printRun(out.run);
if (args.json) await writeFile(args.json, JSON.stringify(out, null, 2));
