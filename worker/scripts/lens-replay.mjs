// Replays captured X posts through the lens routes of a local Worker, so a
// charter and its exemplars can be checked against real posts before any
// lens account is signed in. Nothing here touches X or a deployed Worker.
//
// It ingests every post of the given fetch-mode bundles into a fresh local
// D1 (each sighting dated at its bundle's start, so a post seen in two runs
// has two samples), creates the lenses, labels every post with each lens,
// records one replay session of reads per lens (which schedules the re-polls
// of its opens), and reads back the re-poll schedule and the cross-lens
// signal table.
//
//   node scripts/lens-replay.mjs --bundles <dir> --lenses <lenses.json> \
//     --embed-url http://127.0.0.1:8899/v1/embeddings --out <report.json>
//
// lenses.json: [{ id, account, charter, exemplar_ids, project_terms }].
// Embeddings come from --embed-url (scripts/local-embeddings.py serves the
// production model locally); labels come from the centroid, since no label
// model is configured.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStack } from "./harness.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, v, i, all) => (i % 2 ? pairs : [...pairs, [v.replace(/^--/, ""), all[i + 1]]]), []),
);
for (const need of ["bundles", "lenses", "embed-url", "out"]) if (!args[need]) throw new Error(`--${need} is required`);

const HOUR = 3600_000;
const DWELL = { skip: 1000, glance: 4000, open: 20000 };
const INGEST_BYTES = 100 * 1024; // under the Worker's 128 KiB limit
const POST_FIELDS = ["id", "author_handle", "author_name", "created_at", "text", "lang", "conversation_id", "in_reply_to_id", "quoted_id", "retweet_of_id", "urls", "media", "metrics"];

const bundles = readdirSync(args.bundles)
  .filter((f) => f.endsWith("-bundle.json"))
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(args.bundles, f), "utf8")) }))
  .filter((b) => b.kind === "x-direct-fetch-bundle")
  .sort((a, b) => a.started_at.localeCompare(b.started_at));
if (!bundles.length) throw new Error(`no fetch-mode bundles in ${args.bundles}`);
const lensSpecs = JSON.parse(readFileSync(args.lenses, "utf8"));

const s = await startStack({ port: 8861, fixturePort: 8862, inspectorPort: 9361, vars: { LENS_EMBED_URL: args["embed-url"] } });
try {
  // ---- ingest
  const texts = new Map();
  let seq = 0;
  for (const b of bundles) {
    const session = `replay:${b.file}`;
    const posts = Object.values(b.posts).map((p) => Object.fromEntries(POST_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])));
    let chunk = [];
    let bytes = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const batch = { batch_id: `replay-${seq++}`, op: "TweetDetail", surface: "detail", posts: chunk };
      await s.call("POST", "/ingest/x", { account: b.account, session_id: session, mode: "fetch", captured_at: b.started_at, batches: [batch] }, { token: "ingest" });
      chunk = [];
      bytes = 0;
    };
    for (const p of posts) {
      const size = JSON.stringify(p).length;
      if (bytes + size > INGEST_BYTES) await flush();
      chunk.push(p);
      bytes += size;
      if (p.text && !p.retweet_of_id) texts.set(p.id, p);
    }
    await flush();
    s.d1(`UPDATE x_sightings SET seen_at = ${Date.parse(b.started_at)} WHERE session_id = '${session.replace(/'/g, "''")}'`);
  }

  // ---- lenses and labels
  const report = { bundles: bundles.map((b) => ({ file: b.file, started_at: b.started_at, posts: Object.keys(b.posts).length })), posts_labeled: texts.size, lenses: [] };
  const all = [...texts.values()];
  const replayAt = Date.now() - 2 * HOUR; // so the 1 h re-poll step is due when read back
  const tasteById = {};
  for (const spec of lensSpecs) {
    const lens = await s.call("POST", "/lenses", spec);
    const labels = [];
    for (let i = 0; i < all.length; i += 40) {
      const posts = all.slice(i, i + 40).map((p) => ({ id: p.id, text: p.text, author_handle: p.author_handle }));
      labels.push(...(await s.call("POST", `/lenses/${spec.id}/label`, { posts }, { token: "ingest" })).labels);
    }
    tasteById[spec.id] = Object.fromEntries(labels.map((l) => [l.id, l.taste]));
    for (let i = 0; i < labels.length; i += 500) {
      const reads = labels.slice(i, i + 500).map((l) => ({
        post_id: l.id, action: l.action, dwell_ms: DWELL[l.action], taste: l.taste, novelty: l.novelty, project: l.project, label_source: "centroid", at: new Date(replayAt).toISOString(),
      }));
      await s.call("POST", `/lenses/${spec.id}/reads`, { session_id: `replay-${spec.id}`, reads }, { token: "ingest" });
    }
    const count = (a) => labels.filter((l) => l.action === a).length;
    const tastes = labels.map((l) => l.taste).sort((a, b) => a - b);
    const q = (p) => tastes[Math.floor(p * (tastes.length - 1))];
    const exemplarSet = new Set(spec.exemplar_ids);
    report.lenses.push({
      id: spec.id,
      charter: spec.charter,
      exemplars: lens.exemplars,
      missing_exemplars: lens.missing_exemplars,
      open_at: lens.open_at,
      glance_at: lens.glance_at,
      labels: { open: count("open"), glance: count("glance"), skip: count("skip") },
      open_share_excluding_exemplars: labels.filter((l) => !exemplarSet.has(l.id) && l.action === "open").length / labels.filter((l) => !exemplarSet.has(l.id)).length,
      taste_quantiles: { p10: q(0.1), p50: q(0.5), p90: q(0.9), p99: q(0.99) },
      top_opens: labels
        .filter((l) => l.action === "open" && !exemplarSet.has(l.id))
        .sort((a, b) => b.taste - a.taste)
        .slice(0, 15)
        .map((l) => ({ id: l.id, taste: +l.taste.toFixed(3), author: texts.get(l.id).author_handle, text: texts.get(l.id).text.replace(/\s+/g, " ").slice(0, 160) })),
    });
  }

  // ---- re-polls: every open got five steps, due 1 h to 7 d after the read
  const steps = s.d1("SELECT lens_id, step, count(*) AS n, min(due_at) AS due_at FROM lens_repolls GROUP BY lens_id, step ORDER BY lens_id, due_at");
  const accounts = [...new Set(lensSpecs.map((l) => l.account))];
  report.repolls = {
    steps: steps.map((r) => ({ lens_id: r.lens_id, step: r.step, posts: r.n, hours_after_read: Math.round((r.due_at - replayAt) / HOUR) })),
    due_now: Object.fromEntries(await Promise.all(accounts.map(async (a) => [a, (await s.call("GET", `/lenses/repolls/due?account=${a}`, undefined, { token: "ingest" })).post_ids.length]))),
  };

  // ---- the cross-lens table over each lens's highest-taste posts
  const ids = [...new Set(lensSpecs.flatMap((l) => Object.entries(tasteById[l.id]).sort((a, b) => b[1] - a[1]).slice(0, Math.floor(100 / lensSpecs.length)).map(([id]) => id)))];
  const table = await s.call("GET", `/lenses/signals?ids=${ids.join(",")}&vs=sdotgu&limit=100`, undefined, { token: "runner" });
  report.signals = {
    summary: table.summary,
    near_counts: Object.fromEntries(table.lenses.map((l) => [l.id, table.posts.filter((r) => r.lenses[l.id].near).length])),
    both: table.posts.filter((r) => r.near_lenses.length >= 2).map((r) => ({ id: r.id, author: r.author_handle, tastes: Object.fromEntries(Object.entries(r.lenses).map(([k, v]) => [k, +v.taste.toFixed(3)])), text: r.text.slice(0, 140) })),
  };

  // ---- view growth between runs, the measure re-polls feed
  const grown = s.d1(
    `SELECT post_id, count(*) AS samples, min(seen_at) AS first_at, max(seen_at) AS last_at,
            (SELECT json_extract(metrics_json, '$.views') FROM x_sightings y WHERE y.post_id = x.post_id ORDER BY seen_at LIMIT 1) AS first_views,
            (SELECT json_extract(metrics_json, '$.views') FROM x_sightings y WHERE y.post_id = x.post_id ORDER BY seen_at DESC LIMIT 1) AS last_views
     FROM x_sightings x GROUP BY post_id HAVING count(DISTINCT seen_at) >= 2 AND max(seen_at) - min(seen_at) >= ${HOUR}`,
  ).filter((r) => r.first_views > 0 && r.last_views !== null);
  const ratios = grown.map((r) => r.last_views / r.first_views).sort((a, b) => a - b);
  report.view_growth_between_runs = {
    posts_with_two_samples_an_hour_apart: grown.length,
    median_hours_apart: grown.length ? grown.map((r) => (r.last_at - r.first_at) / HOUR).sort((a, b) => a - b)[Math.floor(grown.length / 2)] : null,
    growth_p50: ratios[Math.floor(ratios.length / 2)] ?? null,
    growth_p90: ratios[Math.floor(0.9 * (ratios.length - 1))] ?? null,
    grew_2x: ratios.filter((r) => r >= 2).length,
  };

  writeFileSync(args.out, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...report, lenses: report.lenses.map(({ top_opens, ...rest }) => rest), signals: report.signals.summary }, null, 1));
} finally {
  await s.stop();
}
