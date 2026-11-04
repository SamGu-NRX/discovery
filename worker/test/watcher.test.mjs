// Runs against a real `wrangler dev` (local D1 + Durable Objects) and the
// fixture server. Watchers start with a first check an hour out, so their
// alarms never fire during a test and every check here is an explicit one.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { startStack } from "../scripts/harness.mjs";

let s;
before(async () => {
  s = await startStack({ port: 8831, fixturePort: 8832, inspectorPort: 9331 });
});
after(async () => {
  await s?.stop();
});

const fx = (path) => `http://127.0.0.1:8832${path}`;
const check = (id) => s.call("POST", `/admin/watchers/${id}/check`);
const events = async (id) => (await s.call("GET", `/admin/watchers/${id}`)).events;
const addWatcher = (w) => s.call("POST", "/admin/watchers", { first_check_in_s: 3600, ...w });
// Watcher rule matches become watcher_event candidates keyed "<watcher>:<item id>".
const candidates = async (watcherId) =>
  (await s.call("GET", "/candidates?kind=watcher_event")).candidates.filter((c) => c.ref.startsWith(`${watcherId}:`));

test("unchanged sources emit no events: 304, volatile JSON metadata, per-request page nonces", async () => {
  await addWatcher({ id: "t-unch-feed", kind: "atom", url: fx("/feed.xml"), interval_s: 600 });
  await addWatcher({ id: "t-unch-jobs", kind: "greenhouse", url: fx("/jobs.json"), interval_s: 600 });
  await addWatcher({ id: "t-unch-page", kind: "page", url: fx("/page.html"), interval_s: 600 });

  for (const id of ["t-unch-feed", "t-unch-jobs", "t-unch-page"]) assert.equal((await check(id)).outcome, "seeded");

  const feed = await check("t-unch-feed");
  assert.equal(feed.status, 304);
  assert.equal(feed.outcome, "not_modified");
  assert.equal((await check("t-unch-jobs")).outcome, "same_fingerprint");
  assert.equal((await check("t-unch-page")).outcome, "same_fingerprint");

  for (const id of ["t-unch-feed", "t-unch-jobs", "t-unch-page"]) assert.deepEqual(await events(id), [], id);
});

test("a change emits exactly one event per new item, and seeded items never emit", async () => {
  await addWatcher({ id: "t-chg-feed", kind: "atom", url: fx("/feed.xml"), interval_s: 600 });
  await check("t-chg-feed");

  await s.control("add-entry", { id: "fx:entry:chg-a", title: "New A" });
  await s.control("add-entry", { id: "fx:entry:chg-b", title: "New B" });
  const r = await check("t-chg-feed");
  assert.equal(r.outcome, "changed");

  const ev = await events("t-chg-feed");
  assert.deepEqual(ev.map((e) => e.dedupe_key).sort(), ["t-chg-feed:fx:entry:chg-a", "t-chg-feed:fx:entry:chg-b"]);

  await check("t-chg-feed");
  assert.equal((await events("t-chg-feed")).length, 2);
});

test("duplicate WebSub delivery creates one event and one candidate, a bad signature none, and the poller agrees", async () => {
  await addWatcher({ id: "t-push", kind: "atom", url: fx("/feed.xml"), interval_s: 600, notify_all_new: true });
  await check("t-push");

  await s.control("add-entry", { id: "fx:entry:pushed", title: "Pushed video" });
  const atom = await s.control("atom");
  const sign = (body, secret) => "sha1=" + createHmac("sha1", secret).update(body).digest("hex");
  const deliver = (sig) => fetch(`${s.base}/websub/t-push`, { method: "POST", body: atom, headers: { "x-hub-signature": sig, "content-type": "application/atom+xml" } });

  const forged = await deliver(sign(atom, "not-the-secret"));
  assert.equal(forged.status, 202);
  assert.deepEqual(await events("t-push"), []);

  const good = sign(atom, s.vars.WEBSUB_SECRET);
  const results = await Promise.all([deliver(good), deliver(good)]);
  assert.deepEqual(results.map((r) => r.status), [202, 202]);
  await deliver(good);

  // The poller sees the same new entry in the feed it fetches.
  assert.equal((await check("t-push")).outcome, "changed");

  const d = await s.call("GET", "/admin/watchers/t-push");
  assert.deepEqual(d.events.map((e) => e.dedupe_key), ["t-push:fx:entry:pushed"]);
  assert.equal(d.jobs.length, 1, "a duplicate delivery must not enqueue a second triage job");
  const c = await candidates("t-push");
  assert.deepEqual(c.map((x) => x.ref), ["t-push:fx:entry:pushed"], "seeding must not create candidates under notify_all_new, and a duplicate delivery must not create a second");
  assert.equal(c[0].title, "Pushed video");
});

test("an expired lease is reclaimed by a second claimant; a done job and a stale owner are refused", async () => {
  const type = "lease-test";
  const job = await s.call("POST", "/jobs", { type, input: { n: 1 } });

  const a = await s.call("POST", "/jobs/claim", { types: [type], owner: "worker-a", ttl_s: 1 });
  assert.equal(a.id, job.id);
  assert.equal((await s.call("POST", "/jobs/claim", { types: [type], owner: "worker-b", ttl_s: 60 }, { raw: true })).status, 204, "live lease must not be reclaimed");

  await new Promise((r) => setTimeout(r, 1200));
  const b = await s.call("POST", "/jobs/claim", { types: [type], owner: "worker-b", ttl_s: 60 });
  assert.equal(b.id, job.id);
  assert.equal(b.owner, "worker-b");
  assert.equal(b.attempts, 2);

  const stale = await s.call("POST", `/jobs/${job.id}/complete`, { owner: "worker-a", output: "late" }, { raw: true });
  assert.equal(stale.status, 409, "the worker whose lease was reclaimed must not complete the job");

  const done = await s.call("POST", `/jobs/${job.id}/complete`, { owner: "worker-b", output: "ok" });
  assert.equal(done.state, "done");

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal((await s.call("POST", "/jobs/claim", { types: [type], owner: "worker-c", ttl_s: 1 }, { raw: true })).status, 204, "done job must not be reclaimed");
  assert.equal((await s.call("GET", `/jobs/${job.id}`)).output, '"ok"');
});

test("a matching new item switches the watcher to the hot interval, and it returns to normal after the window", async () => {
  await addWatcher({ id: "t-hot", kind: "greenhouse", url: fx("/jobs.json"), interval_s: 3600, hot_interval_s: 60, hot_window_s: 2, hot_rule: "fellow" });
  await check("t-hot");
  const alarmIn = async () => (await s.call("GET", "/admin/watchers/t-hot")).alarm_at - Date.now();

  await s.control("add-job", { id: 2001, title: "Recruiting Coordinator" });
  const plain = await check("t-hot");
  assert.equal(plain.events_created, 1);
  assert.equal(plain.mode, "normal");
  assert.ok((await alarmIn()) > 3500_000, "non-matching item must not shorten the interval");

  await s.control("add-job", { id: 2002, title: "Anthropic Fellows Program, AI Safety" });
  const hot = await check("t-hot");
  assert.equal(hot.mode, "hot");
  const inHot = await alarmIn();
  assert.ok(inHot > 50_000 && inHot <= 60_000, `alarm should be ~60s out, was ${inHot}ms`);

  await new Promise((r) => setTimeout(r, 2200));
  const cooled = await check("t-hot");
  assert.equal(cooled.mode, "normal");
  assert.ok((await alarmIn()) > 3500_000);
  assert.ok(s.lines.some((l) => l.includes("[t-hot] interval switch normal(3600s) -> hot(60s)")));
});

test("a seeded rule match becomes one candidate per open item, never sets hot, later checks add only new matches, and nothing POSTs", async () => {
  await s.control("add-job", { id: 4001, title: "Anthropic Fellows Program, Safety" });
  await s.control("add-job", { id: 4002, title: "Anthropic Fellows Program, Policy" });
  await addWatcher({ id: "t-seed", kind: "greenhouse", url: fx("/jobs.json"), interval_s: 1800, hot_interval_s: 60, hot_window_s: 3600, hot_rule: "fellow" });

  const seeded = await check("t-seed");
  assert.equal(seeded.outcome, "seeded");
  assert.equal(seeded.mode, "normal", "a seeded match must not set hot");
  const ev = await events("t-seed");
  assert.deepEqual(ev.map((e) => e.kind), ["seed.match"]);
  const openFellows = s.fixtureState.jobs.filter((j) => /fellow/i.test(j.title)).length;
  assert.ok(openFellows >= 2);
  assert.equal(JSON.parse(ev[0].payload).count, openFellows);
  const fellows = s.fixtureState.jobs.filter((j) => /fellow/i.test(j.title));
  let c = await candidates("t-seed");
  assert.deepEqual(c.map((x) => x.ref).sort(), fellows.map((j) => `t-seed:${j.id}`).sort());
  assert.ok(c.every((x) => x.state === "new" && x.origin === "watcher" && x.url.startsWith("http")));

  await s.control("add-job", { id: 4003, title: "Office Manager" });
  const plain = await check("t-seed");
  assert.equal(plain.events_created, 1);
  assert.equal((await candidates("t-seed")).length, fellows.length, "an unmatched new item and a re-check must not add candidates");

  await s.control("add-job", { id: 4004, title: "Fellows Program, Interpretability" });
  await s.control("add-job", { id: 4005, title: "Fellows Program, Alignment" });
  const two = await check("t-seed");
  assert.equal(two.events_created, 2);
  assert.equal(two.candidates_created, 2);
  c = await candidates("t-seed");
  assert.equal(c.length, fellows.length + 2);
  assert.equal((await events("t-seed")).filter((e) => e.kind === "seed.match").length, 1);
  assert.equal((await check("t-seed")).candidates_created, 0);
  assert.deepEqual((await s.control("webhooks")).filter((p) => p.body.watcher_id), [], "watcher matches must not POST to any webhook");
});

test("the cron re-arms a watcher whose alarm was lost, and /health reports the run", async () => {
  await addWatcher({ id: "t-cron", kind: "atom", url: fx("/feed.xml"), interval_s: 600, first_check_in_s: 0 });
  await s.waitForFetches("t-cron", 1);
  await s.call("POST", "/admin/watchers/t-cron/drop-alarm");
  assert.equal((await s.call("GET", "/admin/watchers/t-cron")).alarm_at, null);
  // A lost alarm is only presumed after the grace period; backdate instead of waiting.
  await s.d1(`UPDATE watchers SET next_check_at = ${Date.now() - 120_000} WHERE id = 't-cron'`);
  assert.equal((await fetch(`${s.base}/__scheduled?cron=*/15+*+*+*+*`)).status, 200);
  const d = await s.call("GET", "/admin/watchers/t-cron");
  assert.equal(d.fetch_log.at(-1).via, "backstop");
  assert.ok(d.alarm_at > Date.now(), "the backstop check must re-arm the alarm");
  const health = await (await fetch(`${s.base}/health`)).json();
  assert.ok(Date.now() - Date.parse(health.last_cron_at) < 10_000, "health must report the cron run");
});

test("a failing primary URL falls back without counting as a failure, and the switch emits nothing", async () => {
  await addWatcher({ id: "t-fallback", kind: "atom", url: fx("/gone.xml"), fallback_url: fx("/feed.xml"), fallback_kind: "atom", interval_s: 600 });
  const r = await check("t-fallback");
  assert.equal(r.source, "fallback");
  assert.equal(r.outcome, "seeded");
  assert.equal(r.next_interval_s, 600, "a working fallback must not trigger failure backoff");
  assert.equal((await check("t-fallback")).outcome, "same_fingerprint");
  assert.deepEqual(await events("t-fallback"), []);
});
