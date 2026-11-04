// The evidence run: live sources twice, then the fixture change-detection,
// adaptive-interval, backstop and lease phases. Writes the raw wrangler log and
// every API response it used to evidence/<timestamp>/.
//
// Each live source gets three requests in total (run 1, run 2, run 3).

import { mkdirSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { ROOT, startStack } from "./harness.mjs";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, "evidence", stamp);
mkdirSync(outDir, { recursive: true });
const record = {};
const save = (name, data) => {
  record[name] = data;
  writeFileSync(join(outDir, "results.json"), JSON.stringify(record, null, 2));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (msg) => console.log(`[evidence ${new Date().toISOString()}] ${msg}`);

const LIVE = [
  { id: "yt-theo", kind: "atom", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCbRP3c757lWg9M-U7TyEkXA", interval_s: 900 },
  // Same channel through the videos tab, because the Atom feed above returned
  // 404 for every channel during the first evidence run.
  { id: "yt-theo-page", kind: "youtube_page", url: "https://www.youtube.com/@t3dotgg/videos", interval_s: 1800 },
  { id: "gh-claude-code", kind: "atom", url: "https://github.com/anthropics/claude-code/releases.atom", interval_s: 1800 },
  { id: "greenhouse-anthropic", kind: "greenhouse", url: "https://boards-api.greenhouse.io/v1/boards/anthropic/jobs", interval_s: 3600, hot_interval_s: 300, hot_window_s: 21600, hot_rule: "fellow" },
  { id: "hn-anthropic", kind: "hn", url: "https://hn.algolia.com/api/v1/search_by_date?query=anthropic&tags=story", interval_s: 900 },
  { id: "page-anthropic-careers", kind: "page", url: "https://www.anthropic.com/careers", interval_s: 21600, hot_interval_s: 1800, hot_window_s: 86400, hot_rule: "applications (are )?open" },
];

const s = await startStack({ port: 8787, fixturePort: 8799, inspectorPort: 9229, logFile: join(outDir, "wrangler.log"), persistTo: join(ROOT, ".wrangler", "evidence-state", stamp) });
const fx = (p) => `${s.fixtureBase}${p}`;
const detail = (id) => s.call("GET", `/admin/watchers/${id}`);
const check = (id) => s.call("POST", `/admin/watchers/${id}/check`);
const cron = () => fetch(`${s.base}/__scheduled?cron=${encodeURIComponent("*/15 * * * *")}`).then((r) => r.status);

try {
  // Run 1: alarms fire immediately after registration and seed state.
  say("run 1: registering live watchers; their first alarm fires now");
  for (const w of LIVE) await s.call("POST", "/admin/watchers", { ...w, first_check_in_s: 0 });
  const run1 = {};
  for (const w of LIVE) {
    const d = await s.waitForFetches(w.id, 1, 60_000);
    run1[w.id] = { fetch: d.fetch_log[0], seen_items: d.seen_items, etag: d.watcher.etag, last_modified: d.watcher.last_modified, events: d.events.length };
  }
  save("run1", run1);

  // Run 2: immediately after, forced.
  say("run 2: forcing an immediate re-check of every live watcher");
  const run2 = {};
  for (const w of LIVE) run2[w.id] = await check(w.id);
  for (const w of LIVE) run2[w.id].events_total = (await detail(w.id)).events.length;
  save("run2", run2);

  // Fixture: alarm-driven change detection.
  say("fixture: fx-feed polls every 5s on its own alarm");
  await s.call("POST", "/admin/watchers", { id: "fx-feed", kind: "atom", url: fx("/feed.xml"), interval_s: 5 });
  await s.waitForFetches("fx-feed", 3, 30_000);
  await s.control("add-entry", { id: "fx:entry:new-1", title: "Fixture video one" });
  await s.control("add-entry", { id: "fx:entry:new-2", title: "Fixture video two" });
  say("fixture: added 2 entries; waiting for the next alarm-driven fetch");
  let d = await s.waitForFetches("fx-feed", 4, 30_000);
  while (!d.fetch_log.some((f) => f.outcome === "changed")) {
    await sleep(500);
    d = await detail("fx-feed");
  }
  const afterChange = d;
  await s.waitForFetches("fx-feed", afterChange.fetch_log.length + 1, 30_000);

  // Re-delivery of the same entries through the push path.
  const atom = await s.control("atom");
  const sig = "sha1=" + createHmac("sha1", s.vars.WEBSUB_SECRET).update(atom).digest("hex");
  const pushStatuses = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${s.base}/websub/fx-feed`, { method: "POST", body: atom, headers: { "x-hub-signature": sig } });
    pushStatuses.push(r.status);
  }
  const forged = await fetch(`${s.base}/websub/fx-feed`, { method: "POST", body: atom, headers: { "x-hub-signature": "sha1=" + "0".repeat(40) } });
  const afterRedelivery = await detail("fx-feed");
  save("fixture_feed", { after_change: afterChange, push_statuses: pushStatuses, forged_status: forged.status, after_redelivery: afterRedelivery, fixture_hits: await s.control("hits") });

  // Adaptive interval on a Greenhouse-shaped board.
  say("fixture: fx-jobs adaptive interval");
  await s.call("POST", "/admin/watchers", { id: "fx-jobs", kind: "greenhouse", url: fx("/jobs.json"), interval_s: 600, hot_interval_s: 30, hot_window_s: 3600, hot_rule: "fellow", first_check_in_s: 0 });
  await s.waitForFetches("fx-jobs", 1);
  const jobsSteps = { unchanged: await check("fx-jobs") };
  await s.control("add-job", { id: 3001, title: "Recruiting Coordinator" });
  jobsSteps.plain_new_job = await check("fx-jobs");
  jobsSteps.alarm_after_plain = (await detail("fx-jobs")).alarm_at - Date.now();
  await s.control("add-job", { id: 3002, title: "Anthropic Fellows Program, AI Security" });
  jobsSteps.fellows_job = await check("fx-jobs");
  jobsSteps.alarm_after_hot = (await detail("fx-jobs")).alarm_at - Date.now();

  // Page fingerprint fallback.
  say("fixture: fx-page fingerprint fallback");
  await s.call("POST", "/admin/watchers", { id: "fx-page", kind: "page", url: fx("/page.html"), interval_s: 600, hot_interval_s: 60, hot_window_s: 3600, hot_rule: "applications (are )?open", first_check_in_s: 0 });
  await s.waitForFetches("fx-page", 1);
  const pageSteps = { nonce_only: await check("fx-page") };
  await s.control("page", { text: "Anthropic Fellows: applications open now." });
  pageSteps.text_changed = await check("fx-page");
  pageSteps.events = (await detail("fx-page")).events;

  // Backstop: baseline sweep, then a lost alarm.
  say("backstop: baseline cron sweep");
  const cronBaseline = await cron();
  await s.call("POST", "/admin/watchers/fx-feed/drop-alarm");
  const droppedAt = Date.now();
  const fetchesAtDrop = (await detail("fx-feed")).fetch_log.length;
  say("backstop: dropped fx-feed alarm; waiting 70s so it is past the 60s grace (fx-jobs hot alarm keeps firing meanwhile)");
  await sleep(70_000);
  const beforeSweep = await detail("fx-feed");
  const cronOverdue = await cron();
  await sleep(1000);
  const afterSweep = await detail("fx-feed");
  jobsSteps.after_wait = await detail("fx-jobs");
  save("fixture_jobs", jobsSteps);
  save("fixture_page", pageSteps);
  save("backstop", {
    cron_status: [cronBaseline, cronOverdue],
    dropped_at: droppedAt,
    fetches_at_drop: fetchesAtDrop,
    fetches_before_sweep: beforeSweep.fetch_log.length,
    alarm_before_sweep: beforeSweep.alarm_at,
    fetches_after_sweep: afterSweep.fetch_log.length,
    last_fetch: afterSweep.fetch_log.at(-1),
    alarm_after_sweep_in_ms: afterSweep.alarm_at - Date.now(),
  });

  // Leases.
  say("leases");
  const type = "evidence-lease";
  const job = await s.call("POST", "/jobs", { type, input: { note: "lease demo" } });
  const leases = { job };
  leases.a_claim = await s.call("POST", "/jobs/claim", { types: [type], owner: "runner-a", ttl_s: 2 });
  leases.b_claim_while_live = (await s.call("POST", "/jobs/claim", { types: [type], owner: "runner-b", ttl_s: 600 }, { raw: true })).status;
  await sleep(2200);
  leases.b_claim_after_expiry = await s.call("POST", "/jobs/claim", { types: [type], owner: "runner-b", ttl_s: 600 });
  const stale = await s.call("POST", `/jobs/${job.id}/complete`, { owner: "runner-a", output: "late" }, { raw: true });
  leases.a_complete_stale = { status: stale.status, body: await stale.json() };
  leases.b_complete = await s.call("POST", `/jobs/${job.id}/complete`, { owner: "runner-b", output: "ok" });
  await sleep(2200);
  leases.c_claim_after_done = (await s.call("POST", "/jobs/claim", { types: [type], owner: "runner-c", ttl_s: 2 }, { raw: true })).status;
  save("leases", leases);

  // Run 3: live sources again, a few minutes after run 1.
  say("run 3: live re-check");
  const run3 = {};
  for (const w of LIVE) run3[w.id] = await check(w.id);
  for (const w of LIVE) {
    const dd = await detail(w.id);
    run3[w.id].events = dd.events;
  }
  save("run3", run3);

  save("stats", await s.call("GET", "/admin/stats"));
  say(`done; results in ${outDir}`);
} finally {
  await s.stop();
}
