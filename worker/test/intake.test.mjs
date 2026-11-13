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
  // The stored blob is the posted body, byte for byte.
  const stored = await k("GET", `/k/blobs/${first.intake_sha}`);
  assert.equal(sha(Buffer.from(stored.text)), first.intake_sha);

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

test("the digest returns cards of saves finished since a time, as stored, under 30 KB", async () => {
  expect(await bundleWithCard("1900000000000000401", { post_id: "1900000000000000401", excerpt: "older" }), 201);
  await new Promise((r) => setTimeout(r, 20));
  const since = Date.now();
  const card = { post_id: "1900000000000000402", url: "https://x.com/a/status/1900000000000000402", verdict: { label: "try", why: "a repo Sam can install" }, links: [{ url: "https://github.com/o/r", repo: { name: "o/r", stars: 12 } }] };
  expect(await bundleWithCard("1900000000000000402", card), 201);

  const d = expect(await k("GET", `/k/digest?since=${since}`), 200);
  assert.deepEqual(d.saves.map((x) => x.card.post_id), ["1900000000000000402"]);
  assert.deepEqual(d.saves[0].card, card);
  assert.equal(d.truncated, false);
  assert.equal(typeof d.pending_saves, "number");
  expect(await k("GET", "/k/digest"), 400, "invalid_request");

  // A card over 4 KiB is refused when the bundle is registered.
  expect(await bundleWithCard("1900000000000000403", { excerpt: "y".repeat(5000) }), 400, "invalid_request");

  // Enough cards to pass 30 KB: the answer stops early and says where to resume.
  const since2 = Date.now();
  for (let i = 0; i < 12; i++) expect(await bundleWithCard(`19000000000000005${String(i).padStart(2, "0")}`, { post_id: "x", excerpt: "z".repeat(3500) }), 201);
  const page = await k("GET", `/k/digest?since=${since2}`);
  expect(page, 200);
  assert.ok(page.text.length <= 31 * 1024, `digest was ${page.text.length} bytes`);
  assert.equal(page.body.truncated, true);
  assert.ok(page.body.next_since);
  const rest = expect(await k("GET", `/k/digest?since=${encodeURIComponent(page.body.next_since)}`), 200);
  assert.equal(page.body.count + rest.count, 12);
});
