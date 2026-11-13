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
  const after = await jobOf("1900000000000000101");
  assert.equal(after.state, "queued");
  assert.equal(after.payload.intake_sha, third.intake_sha);
  assert.equal(third.job.requeued, true);
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


const claimKey = async (kind, key, ttl_s = 60) => expect(await k("POST", "/k/jobs/claim", { owner: "t", kinds: [kind], ttl_s, limit: 10 }), 200).jobs.find((j) => j.key === key);
const complete = (j, state = "done") => k("POST", `/k/jobs/${j.id}/complete`, { owner: "t", lease_token: j.lease_token, state });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a changed body while the save is running runs after it instead of being dropped", async () => {
  // Review of f8c8d6f, P1 3: the newer body was acknowledged, the running
  // attempt finished on the old one, and nothing ran the new body.
  const id = "1900000000000000601";
  const first = expect(await k("POST", "/k/intake", save(id), { token: "knowledge_intake" }), 201);
  const claimed = await claimKey("save", id);
  assert.equal(claimed.payload.intake_sha, first.intake_sha);
  const newer = expect(await k("POST", "/k/intake", save(id, { context: [{ id: "1900000000000000602", author_handle: "z", text: "later" }] }), { token: "knowledge_intake" }), 200);
  expect(await complete(claimed), 200);
  const after = await jobOf(id);
  assert.deepEqual([after.state, after.payload.intake_sha], ["queued", newer.intake_sha]);
  assert.equal(newer.job.deferred, true);
});

test("a bundle job asked to run again takes the newest payload, waiting or running", async () => {
  // Review of f8c8d6f, P1 4: again=true left a queued or claimed bundle job on
  // its old payload, so a save that ran again was bundled from old children.
  const key = "1900000000000000701";
  const job = (payload) => k("POST", "/k/jobs", { kind: "bundle", key, payload, again: true });
  expect(await job({ v: 1 }), 201);
  const waiting = expect(await job({ v: 2 }), 200);
  const claimed = await claimKey("bundle", key);
  assert.deepEqual(claimed.payload, { v: 2 });
  const running = expect(await job({ v: 3 }), 200);
  expect(await complete(claimed), 200);
  const next = await claimKey("bundle", key);
  assert.deepEqual(next.payload, { v: 3 });
  expect(await complete(next), 200);
  assert.deepEqual([waiting.replaced, running.deferred], [true, true]);
});

test("payload changes to a waiting job all apply, however close together", async () => {
  // Review of 7d6fe20, P1 2: a change in the same millisecond as the job's
  // last update was skipped and still answered 200. Twenty at once make a
  // shared millisecond likely; every one must report that it applied.
  const key = "1900000000000000751";
  expect(await k("POST", "/k/jobs", { kind: "bundle", key, payload: { v: 0 }, again: true }), 201);
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => k("POST", "/k/jobs", { kind: "bundle", key, payload: { v: i + 1 }, again: true })));
  const flags = answers.map((r) => expect(r, 200)).map((b) => b.replaced || b.requeued || b.deferred);
  assert.deepEqual(flags, Array(20).fill(true));
});

test("a run requested during an attempt whose lease expires runs next, and the expiry still counts", async () => {
  // Review of 7d6fe20, P1 1: an expiry failed the job and stranded the
  // pending run. Review of 7854bef, P1 1: the promotion reset the expiry
  // count, so a crashing job never failed.
  const id = "1900000000000000781";
  expect(await k("POST", "/k/intake", save(id), { token: "knowledge_intake" }), 201);
  const crashed = await claimKey("save", id, 0.05);
  const newer = expect(await k("POST", "/k/intake", save(id, { context: [{ id: "1900000000000000782", author_handle: "z", text: "later" }] }), { token: "knowledge_intake" }), 200);
  await sleep(100);
  const next = await claimKey("save", id);
  assert.ok(next, "the pending run was not claimable after the expiry");
  assert.equal(next.payload.intake_sha, newer.intake_sha);
  const row = await jobOf(id);
  assert.deepEqual([row.state, row.expired_leases, row.pending], ["claimed", 1, null]);
  assert.notEqual(next.lease_token, crashed.lease_token);
  expect(await complete(next), 200);
});

test("a job that keeps crashing with new work pending fails at the expiry limit and keeps that work", async () => {
  // Review of 7854bef, P1 1: crash, a pending update, expiry, again and
  // again, looped forever while each promotion reset the count.
  const id = "1900000000000000791";
  expect(await k("POST", "/k/intake", save(id), { token: "knowledge_intake" }), 201);
  let held = await claimKey("save", id, 0.05);
  let last;
  for (let round = 1; round <= 5 && held; round++) {
    last = expect(await k("POST", "/k/intake", save(id, { context: [{ id: `19000000000000007${90 + round}`, author_handle: "z", text: `update ${round}` }] }), { token: "knowledge_intake" }), 200);
    await sleep(100);
    held = await claimKey("save", id, 0.05);
  }
  const row = await jobOf(id);
  assert.equal(row.state, "failed");
  assert.equal(row.expired_leases, 3);
  assert.equal(row.pending.payload.intake_sha, last.intake_sha);
  assert.match(row.error, /kept in pending/);
});

test("deps that lead back to the job are refused, through other jobs and pending deps", async () => {
  // Review of 7d6fe20, P2 3: only a job naming itself was refused, so A -> B -> A
  // went through and neither job could ever be claimed.
  const make = async (key, deps = []) => expect(await k("POST", "/k/jobs", { kind: "link", key, payload: {}, deps }), 201).job.id;
  const a = await make("cycle-a");
  const b = await make("cycle-b", [a]);
  const c = await make("cycle-c", [b]);
  const r = await k("POST", "/k/jobs", { kind: "link", key: "cycle-a", payload: { again: 1 }, deps: [c], again: true });
  const row = (await k("GET", "/k/jobs?kind=link&key=cycle-a")).body.jobs[0];
  assert.deepEqual(row.deps, []);
  expect(r, 422, "dep_cycle");
  // Through a pending deps list: d is claimed and its pending run names a.
  const d = await make("cycle-d");
  const claimed = await claimKey("link", "cycle-d");
  expect(await k("POST", "/k/jobs", { kind: "link", key: "cycle-d", payload: {}, deps: [a], again: true }), 200);
  expect(await k("POST", "/k/jobs", { kind: "link", key: "cycle-a", payload: {}, deps: [d], again: true }), 422, "dep_cycle");
  expect(await complete(claimed), 200);
});

test("the digest returns cards of saves finished since a time, as stored", async () => {
  expect(await bundleWithCard("1900000000000000401", { post_id: "1900000000000000401", excerpt: "older" }), 201);
  await sleep(20);
  const since = Date.now();
  const card = { post_id: "1900000000000000402", url: "https://x.com/a/status/1900000000000000402", verdict: { label: "try", why: "a repo Sam can install" }, links: [{ url: "https://github.com/o/r", repo: { name: "o/r", stars: 12 } }] };
  expect(await bundleWithCard("1900000000000000402", card), 201);
  const d = expect(await k("GET", `/k/digest?since=${since}`), 200);
  assert.deepEqual(d.saves.map((x) => x.card.post_id), ["1900000000000000402"]);
  assert.deepEqual(d.saves[0].card, card);
  // A card over 4 KiB is refused when the bundle is registered.
  expect(await bundleWithCard("1900000000000000403", { excerpt: "y".repeat(5000) }), 400, "invalid_request");
});

// Follows the digest's own resume pointer (next_cursor, or next_since on the
// old interface) until it says there is no more, at most 20 pages.
async function allPages(since, limit) {
  const pages = [];
  let query = `since=${since}&limit=${limit}`;
  for (let n = 0; n < 20; n++) {
    const r = await k("GET", `/k/digest?${query}`);
    expect(r, 200);
    pages.push({ ids: r.body.saves.map((x) => x.card?.post_id ?? null), bytes: Buffer.byteLength(r.text), body: r.body });
    if (!r.body.truncated) return pages;
    query = r.body.next_cursor ? `since=${since}&limit=${limit}&cursor=${r.body.next_cursor}` : `since=${encodeURIComponent(r.body.next_since)}&limit=${limit}`;
  }
  return pages;
}
const pinTime = (ids, t) => s.d1(`UPDATE bundles SET created_at = ${t} WHERE post_id IN (${ids.map((i) => `'${i}'`).join(",")})`);

test("saves finished in the same millisecond page once each, in order", async () => {
  // Review of f8c8d6f, P1 2: with a resume time instead of a cursor, two
  // saves at one instant and limit 1 returned the first one forever.
  const ids = ["1900000000000000801", "1900000000000000802", "1900000000000000803"];
  for (const id of ids) expect(await bundleWithCard(id, { post_id: id }), 201);
  const t = 4102444800000; // 2100-01-01, after every other bundle in this run
  pinTime(ids, t);
  const pages = await allPages(t, 1);
  assert.deepEqual(pages.map((p) => p.ids), [[ids[0]], [ids[1]], [ids[2]]]);
});

test("a malformed cursor is refused", async () => {
  for (const bad of ["abc", "123", "123.", ".1900000000000000801", "123.0", "1".repeat(17) + ".1"]) {
    expect(await k("GET", `/k/digest?since=0&cursor=${bad}`), 400, "invalid_request");
  }
});

test("a digest page stays within 30 KiB of UTF-8 and paging moves on", async () => {
  // 12 cards of about 3.9 KB of two-byte characters: counted in UTF-16 units
  // they look half that size.
  const ids = Array.from({ length: 12 }, (_, i) => `19000000000000009${String(i).padStart(2, "0")}`);
  for (const id of ids) expect(await bundleWithCard(id, { post_id: id, excerpt: "é".repeat(1900) }), 201);
  const t = 4102444900000;
  pinTime(ids, t);
  const pages = await allPages(t, 100);
  for (const p of pages) assert.ok(p.bytes <= 30 * 1024, `a page was ${p.bytes} bytes`);
  assert.deepEqual(pages.flatMap((p) => p.ids), ids);
});

test("a bundle from before cards existed stays small in the digest", async () => {
  // Review of 7d6fe20, P2 4: a fallback card took missing[].what whole, and the
  // first save on a page is admitted at any size.
  const t = 4103000000000;
  const id = "1900000000000001101";
  const md = Buffer.from(`# ${id}
`);
  const js = Buffer.from(JSON.stringify({ schema: "kbundle/1", post_id: id, legacy: true }));
  for (const [bytes, mime] of [[md, "text/markdown"], [js, "application/json"]]) {
    const put = await freshFetch(`${s.base}/k/blobs/${sha(bytes)}`, { method: "PUT", headers: { authorization: `Bearer ${s.vars.KNOWLEDGE_TOKEN}`, "content-type": mime }, body: bytes });
    assert.ok(put.status === 201 || put.status === 200, String(put.status));
  }
  // No card, as bundles registered before 0021 have, and one huge gap.
  const missing = [{ what: "w".repeat(40000), ref: "x", reason: "r" }];
  expect(await k("POST", "/k/bundles", { post_id: id, md_sha: sha(md), json_sha: sha(js), completeness: "partial", missing, saved_by: [], author: "a", search_text: "x" }), 201);
  pinTime([id], t);
  const r = await k("GET", `/k/digest?since=${t}`);
  expect(r, 200);
  assert.equal(r.body.saves[0].card.post_id, "1900000000000001101");
  assert.ok(Buffer.byteLength(r.text) <= 2048, `the page was ${Buffer.byteLength(r.text)} bytes`);
});

test("pending_saves counts a save whose bundle is still to come", async () => {
  const before = expect(await k("GET", "/k/digest?since=0&limit=1"), 200).pending_saves;
  expect(await k("POST", "/k/jobs", { kind: "bundle", key: "1900000000000001001", payload: {} }), 201);
  assert.equal(expect(await k("GET", "/k/digest?since=0&limit=1"), 200).pending_saves, before + 1);
});

test("since takes epoch milliseconds in range or an ISO time with a zone", async () => {
  for (const bad of ["99999999999999999", "2026-11-13", "yesterday", "2026-11-13T07:00:00"]) {
    expect(await k("GET", `/k/digest?since=${bad}`), 400, "invalid_request");
  }
  expect(await k("GET", "/k/digest?since=2026-11-13T07:00:00Z"), 200);
  expect(await k("GET", "/k/digest?since=2026-11-13T02:00:00.5-05:00"), 200);
});

// knowledge_digest, the digest as a tool on the mailbox MCP endpoint.
let rpcId = 0;
async function digestTool(args, { token = "mail_dot", path = "/mcp" } = {}) {
  return k("POST", path, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "knowledge_digest", arguments: args } }, { token });
}
async function digestToolOk(args, opts) {
  const r = expect(await digestTool(args, opts), 200);
  assert.ok(!r.result.isError, JSON.stringify(r.result));
  assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent);
  return r.result.structuredContent;
}
async function toolPages(since, limit, opts) {
  const pages = [];
  let cursor;
  for (let n = 0; n < 20; n++) {
    const d = await digestToolOk({ since, limit, ...(cursor ? { cursor } : {}) }, opts);
    pages.push(d);
    if (!d.truncated) return pages;
    cursor = d.next_cursor;
  }
  return pages;
}
// The route's page with each card under the tool's field name; until is the
// time of the call, so it is left out.
const asTool = ({ until, saves, ...rest }) => ({ ...rest, saves: saves.map(({ card, ...s }) => ({ ...s, card_untrusted: card })) });
const withoutUntil = ({ until, ...rest }) => rest;

test("knowledge_digest returns the route's pages card for card, through every mail agent token", async () => {
  const ids = ["1900000000000001201", "1900000000000001202", "1900000000000001203"];
  for (const [i, id] of ids.entries()) expect(await bundleWithCard(id, { post_id: id, excerpt: `card ${i}`, verdict: { label: "try", why: "w", action: "a" } }), 201);
  const t = 4105000000000;
  pinTime(ids, t);
  const route = (await allPages(t, 2)).map((p) => asTool(p.body));
  assert.deepEqual(route.flatMap((p) => p.saves.map((x) => x.card_untrusted.post_id)), ids);
  const viaPath = { token: "none", path: `/mcp/dot/${s.vars.MAIL_DOT_TOKEN}` };
  for (const opts of [viaPath, { token: "mail_dot" }, { token: "mail_t3" }, { token: "mail_grok" }]) {
    assert.deepEqual((await toolPages(t, 2, opts)).map(withoutUntil), route, JSON.stringify(opts));
  }
  // since as epoch milliseconds in a number or a string, or as ISO, is the same start.
  const iso = new Date(t).toISOString();
  for (const since of [String(t), iso]) assert.deepEqual((await toolPages(since, 2)).map(withoutUntil), route, since);
});

test("knowledge_digest counts a page's bytes under the tool's own field name", async () => {
  // Review of 4eac53d, P3 2: twelve big cards needed two pages under either
  // field name, so a page measured as "card" but sent as "card_untrusted"
  // (10 more bytes per save) still passed. These eight cards fit one 30 KiB
  // page as "card" and not as "card_untrusted".
  const n = 8;
  const ids = Array.from({ length: n }, (_, i) => `19000000000000014${String(i).padStart(2, "0")}`);
  const t = 4105200000000;
  const iso = new Date(t).toISOString();
  const pending = expect(await k("GET", `/k/digest?since=${t}&limit=1`), 200).pending_saves;
  // digestPage reserves room for the largest envelope, then adds each save
  // and a comma.
  const envelope = Buffer.byteLength(JSON.stringify({ since: iso, until: iso, pending_saves: pending, count: 100, truncated: true, next_cursor: "9".repeat(16) + "." + "9".repeat(19), saves: [] }));
  const item = (card) => Buffer.byteLength(JSON.stringify({ version: 1, finished_at: iso, card })) + 1;
  const cards = ids.map((id) => ({ post_id: id, excerpt: "" }));
  const target = 30 * 1024 - 5 * n; // in (30 KiB - 10n, 30 KiB]
  let extra = target - envelope - cards.reduce((sum, c) => sum + item(c), 0);
  for (const c of cards) c.excerpt = "é".repeat(Math.floor(extra / n / 2)); // two bytes each
  extra = target - envelope - cards.reduce((sum, c) => sum + item(c), 0);
  cards[n - 1].excerpt += "a".repeat(extra);
  assert.equal(envelope + cards.reduce((sum, c) => sum + item(c), 0), target);
  for (const c of cards) expect(await bundleWithCard(c.post_id, c), 201);
  pinTime(ids, t);

  const route = await allPages(t, 100);
  assert.deepEqual(route.map((p) => p.ids), [ids], "as card, the eight fit one page");
  const pages = await toolPages(t, 100);
  assert.ok(pages.length > 1, `as card_untrusted they need two pages; got ${pages.length}`);
  for (const p of pages) assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 30 * 1024, `a page was ${Buffer.byteLength(JSON.stringify(p))} bytes`);
  assert.deepEqual(pages.flatMap((p) => p.saves.map((x) => x.card_untrusted.post_id)), ids);
});

test("knowledge_digest is listed and callable only with the dot, t3 and grok tokens", async () => {
  for (const token of ["mail_dot", "mail_t3", "mail_grok"]) {
    const list = expect(await k("POST", "/mcp", { jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }, { token }), 200);
    const t = list.result.tools.find((x) => x.name === "knowledge_digest");
    assert.ok(t, token);
    assert.equal(t.annotations.readOnlyHint, true);
  }
  for (const token of ["knowledge", "knowledge_intake", "runner", "inbox", "ingest"]) expect(await digestTool({ since: 0 }, { token }), 403);
  // The room token is a path credential (/room/<token>), not a bearer one.
  for (const token of ["none", "mail_room"]) expect(await digestTool({ since: 0 }, { token }), 401);
  expect(await digestTool({ since: 0 }, { token: "none", path: `/mcp/dot/${s.vars.MAIL_DOT_TOKEN}x` }), 401);
  // Only the dot authenticates by path.
  expect(await digestTool({ since: 0 }, { token: "none", path: `/mcp/t3/${s.vars.MAIL_T3_TOKEN}` }), 401);
});

test("knowledge_digest refusals are tool results that name the argument", async () => {
  for (const [args, word] of [
    [{}, "since"],
    [{ since: "yesterday" }, "since"],
    [{ since: -1 }, "since"],
    [{ since: 1.5 }, "since"],
    [{ since: 0, limit: "5" }, "limit"],
    [{ since: 0, limit: 101 }, "limit"],
    [{ since: 0, cursor: "123" }, "cursor"],
    [{ since: 0, cursor: 5 }, "cursor"],
    // An explicit null is a value, not an omitted argument (review of 4eac53d, P3 1).
    [{ since: null }, "since"],
    [{ since: 0, limit: null }, "limit"],
    [{ since: 0, cursor: null }, "cursor"],
    [{ since: 0, lmit: 5 }, "lmit"],
  ]) {
    const r = expect(await digestTool(args), 200).result;
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(r.structuredContent.status, 400, JSON.stringify(args));
    assert.match(r.structuredContent.error, new RegExp(word), JSON.stringify(args));
  }
});
