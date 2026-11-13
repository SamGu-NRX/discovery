// The daily loop's Worker routes (docs/KNOWLEDGE.md, "Daily loop") against a
// real `wrangler dev`: POST /k/intake files one save job per post, and
// GET /k/digest returns finished saves' cards.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { freshFetch, startStack } from "../scripts/harness.mjs";

let s;
before(async () => {
  s = await startStack({ port: 8895, fixturePort: 8896, inspectorPort: 9395, gemini: false });
});
after(async () => {
  await s?.stop();
});

const sha = (b) => createHash("sha256").update(b).digest("hex");

async function k(method, path, body, { token = "knowledge", raw } = {}) {
  const headers = {};
  if (token !== "none") headers.authorization = `Bearer ${s.vars[`${token.toUpperCase()}_TOKEN`]}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body instanceof Uint8Array) payload = body;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined) headers["content-type"] = body instanceof Uint8Array ? "application/octet-stream" : "application/json";
  const res = await freshFetch(s.base + path, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, text, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : null };
}
const expect = (r, status, error) => {
  assert.equal(r.status, status, `${r.status} ${r.text.slice(0, 300)}`);
  if (error) assert.equal(r.body.error, error, r.text);
  return r.body;
};

let seq = 0;
const postFor = (id, extra = {}) => ({ id, url: `https://x.com/a/status/${id}`, author_handle: "a", text: `save ${id}`, ...extra });
const save = (id, extra = {}) => ({
  schema: "kintake/1",
  run_id: `daily-${seq++}`,
  account: "sdotgu",
  post: postFor(id),
  context: [{ id: `${id.slice(0, -3)}999`, author_handle: "b", text: "a reply", reply_to: id }],
  ...extra,
});
const jobOf = async (id) => (await k("GET", `/k/jobs?kind=save&key=${id}`)).body.jobs[0];

test("intake files one save job per post; the same body changes nothing, a new one runs it again", async () => {
  const body = save("1900000000000000101");
  const first = expect(await k("POST", "/k/intake", body, { token: "knowledge_intake" }), 201);
  assert.equal(first.job.created, true);
  const job = await jobOf("1900000000000000101");
  assert.deepEqual(job.payload, { post_id: "1900000000000000101", intake_sha: first.intake_sha });
  // The stored blob is the posted body, byte for byte, under that body's hash.
  const posted = JSON.stringify(body);
  assert.equal(first.intake_sha, sha(posted));
  const stored = await k("GET", `/k/blobs/${first.intake_sha}`);
  assert.equal(stored.text, posted);

  const again = expect(await k("POST", "/k/intake", body, { token: "knowledge_intake" }), 200);
  assert.deepEqual([again.job.created, again.job.requeued, again.job.id], [false, false, first.job.id]);

  // Finish the job, then post a body with more context: it runs again.
  const claimed = expect(await k("POST", "/k/jobs/claim", { owner: "t", kinds: ["save"], ttl_s: 60, limit: 10 }), 200).jobs.find((j) => j.key === "1900000000000000101");
  expect(await k("POST", `/k/jobs/${claimed.id}/complete`, { owner: "t", lease_token: claimed.lease_token, state: "done" }), 200);
  const more = save("1900000000000000101", { context: [...body.context, { id: "1900000000000000103", author_handle: "c", text: "another" }] });
  const third = expect(await k("POST", "/k/intake", more, { token: "knowledge_intake" }), 200);
  assert.equal(third.job.requeued, true);
  const after = await jobOf("1900000000000000101");
  assert.equal(after.state, "queued");
  assert.equal(after.payload.intake_sha, third.intake_sha);
});

test("the intake token files saves and nothing else; kworker's token cannot file", async () => {
  expect(await k("GET", "/k/digest?since=0", undefined, { token: "knowledge_intake" }), 403, "forbidden");
  expect(await k("POST", "/k/blobs/has", { sha256s: [] }, { token: "knowledge_intake" }), 403, "forbidden");
  expect(await k("POST", "/k/intake", save("1900000000000000201")), 403, "forbidden");
  expect(await k("POST", "/k/intake", save("1900000000000000201"), { token: "none" }), 401);
});

test("intake refusals name the field", async () => {
  const bad = save("1900000000000000301");
  delete bad.post.text;
  assert.match(expect(await k("POST", "/k/intake", bad, { token: "knowledge_intake" }), 400, "invalid_request").message, /^post\.text /);
  const badCtx = save("1900000000000000302", { context: [{ id: "not-an-id", author_handle: "b", text: "x" }] });
  assert.match(expect(await k("POST", "/k/intake", badCtx, { token: "knowledge_intake" }), 400, "invalid_request").message, /^context\[0\]\.id /);
  expect(await k("POST", "/k/intake", { ...save("1900000000000000303"), schema: "kintake/2" }, { token: "knowledge_intake" }), 400, "invalid_request");
  const huge = save("1900000000000000304", { context: [{ id: "1900000000000000305", author_handle: "b", text: "x".repeat(200 * 1024) }] });
  expect(await k("POST", "/k/intake", huge, { token: "knowledge_intake" }), 413, "too_large");
});

async function bundleWithCard(id, card) {
  const md = Buffer.from(`# ${id}\n`);
  const js = Buffer.from(JSON.stringify({ schema: "kbundle/1", post_id: id, n: seq++ }));
  for (const [b, mime] of [[md, "text/markdown"], [js, "application/json"]]) {
    const r = await freshFetch(`${s.base}/k/blobs/${sha(b)}`, { method: "PUT", headers: { authorization: `Bearer ${s.vars.KNOWLEDGE_TOKEN}`, "content-type": mime }, body: b });
    assert.ok(r.status === 201 || r.status === 200, String(r.status));
  }
  return k("POST", "/k/bundles", { post_id: id, md_sha: sha(md), json_sha: sha(js), completeness: "complete", missing: [], saved_by: ["sdotgu"], author: "a", search_text: "x", card });
}

test("a changed body while the save is running is kept and runs after it, not acknowledged and lost", async () => {
  // Review of f8c8d6f, P1 3: the newer sha was stored, the claimed job
  // finished on the old one, and nothing ran the new body.
  const id = "1900000000000000601";
  const first = expect(await k("POST", "/k/intake", save(id), { token: "knowledge_intake" }), 201);
  const claimed = expect(await k("POST", "/k/jobs/claim", { owner: "t", kinds: ["save"], ttl_s: 60, limit: 10 }), 200).jobs.find((j) => j.key === id);
  assert.equal(claimed.payload.intake_sha, first.intake_sha);
  const newer = expect(await k("POST", "/k/intake", save(id, { context: [{ id: "1900000000000000602", author_handle: "z", text: "later" }] }), { token: "knowledge_intake" }), 200);
  assert.deepEqual([newer.job.deferred, newer.job.requeued, newer.job.state], [true, false, "claimed"]);
  expect(await k("POST", `/k/jobs/${claimed.id}/complete`, { owner: "t", lease_token: claimed.lease_token, state: "done" }), 200);
  const after = await jobOf(id);
  assert.equal(after.state, "queued");
  assert.equal(after.payload.intake_sha, newer.intake_sha);
  assert.equal(after.pending, null);
});

test("a save that runs again replaces its waiting bundle job and defers a running one", async () => {
  // Review of f8c8d6f, P1 4: again=true left a queued or claimed bundle job
  // on its old payload, so the save's new children were never bundled.
  const job = (payload) => k("POST", "/k/jobs", { kind: "bundle", key: "1900000000000000701", payload, again: true });
  expect(await job({ v: 1 }), 201);
  const replaced = expect(await job({ v: 2 }), 200);
  assert.deepEqual([replaced.replaced, replaced.job.state, replaced.job.payload], [true, "queued", { v: 2 }]);
  const claimed = expect(await k("POST", "/k/jobs/claim", { owner: "t", kinds: ["bundle"], ttl_s: 60, limit: 10 }), 200).jobs.find((j) => j.key === "1900000000000000701");
  assert.deepEqual(claimed.payload, { v: 2 });
  const deferred = expect(await job({ v: 3 }), 200);
  assert.deepEqual([deferred.deferred, deferred.job.state, deferred.job.pending.payload], [true, "claimed", { v: 3 }]);
  const done = expect(await k("POST", `/k/jobs/${claimed.id}/complete`, { owner: "t", lease_token: claimed.lease_token, state: "done" }), 200);
  assert.deepEqual([done.state, done.payload, done.pending], ["queued", { v: 3 }, null]);
});

// Every page from since on, following next_cursor; fails on a repeat.
async function allPages(since, limit) {
  const pages = [];
  let cursor = null;
  for (let n = 0; n < 50; n++) {
    const r = await k("GET", `/k/digest?since=${since}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(r, 200);
    pages.push({ ids: r.body.saves.map((x) => x.card.post_id), bytes: Buffer.byteLength(r.text), body: r.body });
    if (!r.body.truncated) return pages;
    cursor = r.body.next_cursor;
  }
  throw new Error("digest paging did not end");
}

test("the digest returns cards of saves finished since a time, as stored", async () => {
  expect(await bundleWithCard("1900000000000000401", { post_id: "1900000000000000401", excerpt: "older" }), 201);
  await new Promise((r) => setTimeout(r, 20));
  const since = Date.now();
  const card = { post_id: "1900000000000000402", url: "https://x.com/a/status/1900000000000000402", verdict: { label: "try", why: "a repo Sam can install" }, links: [{ url: "https://github.com/o/r", repo: { name: "o/r", stars: 12 } }] };
  expect(await bundleWithCard("1900000000000000402", card), 201);
  const d = expect(await k("GET", `/k/digest?since=${since}`), 200);
  assert.deepEqual(d.saves.map((x) => x.card.post_id), ["1900000000000000402"]);
  assert.deepEqual(d.saves[0].card, card);
  assert.equal(d.truncated, false);
  // A card over 4 KiB is refused when the bundle is registered.
  expect(await bundleWithCard("1900000000000000403", { excerpt: "y".repeat(5000) }), 400, "invalid_request");
});

test("digest pages with saves finished in the same millisecond end, with each save once", async () => {
  // Review of f8c8d6f, P1 2: next_since was the first excluded row's time,
  // so with two saves at the same instant and limit 1 the first came back forever.
  const ids = ["1900000000000000801", "1900000000000000802", "1900000000000000803"];
  for (const id of ids) expect(await bundleWithCard(id, { post_id: id }), 201);
  const t = 4102444800000; // 2100-01-01, after every other bundle in this run
  s.d1(`UPDATE bundles SET created_at = ${t} WHERE post_id IN (${ids.map((i) => `'${i}'`).join(",")})`);
  const pages = await allPages(t, 1);
  assert.deepEqual(pages.map((p) => p.ids), [[ids[0]], [ids[1]], [ids[2]]]);
});

test("a digest page stays under 30 KB of UTF-8 and moves on", async () => {
  // 12 cards of about 3.9 KB of two-byte characters: counted in UTF-16 units
  // they look half that size.
  const ids = Array.from({ length: 12 }, (_, i) => `19000000000000009${String(i).padStart(2, "0")}`);
  for (const id of ids) expect(await bundleWithCard(id, { post_id: id, excerpt: "é".repeat(1900) }), 201);
  const t = 4102444900000;
  s.d1(`UPDATE bundles SET created_at = ${t} WHERE post_id IN (${ids.map((i) => `'${i}'`).join(",")})`);
  const pages = await allPages(t, 100);
  assert.ok(pages.length >= 2, `${pages.length} page(s)`);
  for (const p of pages) assert.ok(p.bytes <= 30 * 1024, `a page was ${p.bytes} bytes`);
  assert.deepEqual(pages.flatMap((p) => p.ids), ids);
});

test("pending_saves counts saves whose bundle is still to come; since is checked", async () => {
  const before = expect(await k("GET", "/k/digest?since=0&limit=1"), 200).pending_saves;
  // A save whose save job is done but whose bundle job waits still counts.
  expect(await k("POST", "/k/jobs", { kind: "bundle", key: "1900000000000001001", payload: {} }), 201);
  assert.equal(expect(await k("GET", "/k/digest?since=0&limit=1"), 200).pending_saves, before + 1);
  for (const bad of ["99999999999999999", "2026-11-13", "yesterday", "2026-11-13T07:00:00"]) {
    expect(await k("GET", `/k/digest?since=${bad}`), 400, "invalid_request");
  }
  expect(await k("GET", "/k/digest?since=2026-11-13T07:00:00Z"), 200);
  expect(await k("GET", "/k/digest?since=2026-11-13T02:00:00.5-05:00"), 200);
});
