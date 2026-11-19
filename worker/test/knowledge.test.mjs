// The knowledge store (docs/KNOWLEDGE.md) against a real `wrangler dev` with
// local D1 and R2. The fixture stands in for the Gemini API; a second stack
// runs without GEMINI_API_KEY.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { freshFetch, ROOT, startStack } from "../scripts/harness.mjs";

let s;
let bare;
before(async () => {
  [s, bare] = await Promise.all([
    startStack({ port: 8891, fixturePort: 8892, inspectorPort: 9391 }),
    startStack({ port: 8893, fixturePort: 8894, inspectorPort: 9393, gemini: false }),
  ]);
});
after(async () => {
  await Promise.all([s?.stop(), bare?.stop()]);
});

const sha = (b) => createHash("sha256").update(b).digest("hex");
// The canonical JSON KNOWLEDGE.md defines: keys sorted at every depth, no whitespace.
const canon = (v) =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);

async function k(method, path, body, { token = "knowledge", stack = s, headers = {} } = {}) {
  const h = { ...headers };
  if (token !== "none") h.authorization = `Bearer ${stack.vars[`${token.toUpperCase()}_TOKEN`]}`;
  let payload = body;
  if (body !== undefined && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body);
    h["content-type"] = "application/json";
  }
  // A new connection per call: wrangler dev drops idle keep-alive sockets, and
  // the d1 and r2 helpers between calls take long enough to hit that.
  const res = await freshFetch(stack.base + path, { method, headers: h, body: payload });
  const type = res.headers.get("content-type") ?? "";
  const raw = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, raw, body: type.includes("json") && raw.length ? JSON.parse(raw) : null };
}
const expect = (r, status, error) => {
  assert.equal(r.status, status, `${r.status} ${r.raw}`);
  if (error) assert.equal(r.body.error, error, JSON.stringify(r.body));
  return r.body;
};
const put = (bytes, mime = "application/octet-stream", hex = sha(bytes)) => k("PUT", `/k/blobs/${hex}`, bytes, { headers: { "content-type": mime } });
const stored = async (bytes, mime) => expect(await put(bytes, mime), 201).sha256;

let rpcId = 0;
async function tool(name, args) {
  const r = await k("POST", "/mcp", { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, { token: "mail_t3" });
  expect(r, 200);
  return r.body.result;
}
const toolOk = async (name, args) => {
  const res = await tool(name, args);
  assert.ok(!res.isError, JSON.stringify(res));
  return res.structuredContent;
};

test("route auth: the kworker token reaches /k/ and GET /positives; runner and mail tokens get 403, no token 401, all in the /k/ error shape", async () => {
  expect(await k("GET", "/k/capabilities"), 200);
  expect(await k("GET", "/positives"), 200);
  const runner = expect(await k("GET", "/k/capabilities", undefined, { token: "runner" }), 403, "forbidden");
  assert.match(runner.message, /runner/);
  expect(await k("POST", "/k/jobs/claim", { owner: "x", kinds: ["save"], ttl_s: 60 }, { token: "mail_t3" }), 403, "forbidden");
  expect(await k("GET", "/k/capabilities", undefined, { token: "none" }), 401, "unauthorized");
  // Mailbox routes keep their own refusal shape.
  expect(await k("GET", "/candidates", undefined), 403);
});

test("blob PUT stores the bytes under their hash, serves them back with ranges, and a second PUT of the same hash stores nothing new", async () => {
  const bytes = Buffer.from("hello knowledge store, " + randomBytes(8).toString("hex"));
  const hex = sha(bytes);
  const first = expect(await put(bytes, "text/plain; charset=utf-8"), 201);
  assert.deepEqual(first, { sha256: hex, size: bytes.length, mime: "text/plain; charset=utf-8", r2_key: `sha256/${hex}`, created: true });
  const again = expect(await put(bytes, "text/plain; charset=utf-8"), 200);
  assert.equal(again.created, false);

  const got = await k("GET", `/k/blobs/${hex}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.deepEqual(got.raw, bytes);
  const part = await k("GET", `/k/blobs/${hex}`, undefined, { headers: { range: "bytes=6-14" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 6-14/${bytes.length}`);
  assert.deepEqual(part.raw, bytes.subarray(6, 15));
  expect(await k("GET", `/k/blobs/${hex}`, undefined, { headers: { range: `bytes=${bytes.length}-` } }), 416, "range_not_satisfiable");

  const has = expect(await k("POST", "/k/blobs/has", { sha256s: [hex, sha("never uploaded")] }), 200);
  assert.deepEqual(has.present, [hex]);
});

test("a PUT whose bytes don't match the path's hash is 422 hash_mismatch and leaves neither a row nor an R2 object", async () => {
  const claimed = sha(Buffer.from("what the caller says it is " + Date.now()));
  const r = expect(await put(Buffer.from("something else entirely"), "text/plain", claimed), 422, "hash_mismatch");
  assert.match(r.message, new RegExp(claimed));
  assert.deepEqual(expect(await k("POST", "/k/blobs/has", { sha256s: [claimed] }), 200).present, []);
  expect(await k("GET", `/k/blobs/${claimed}`), 404);
  assert.equal(s.r2Get(`sha256/${claimed}`), null);
});

test("commit: 404 object_missing with no object, 409 checksum_missing for an object R2 holds no SHA-256 for, and a row from R2's checksum otherwise", async () => {
  const absent = sha(Buffer.from("not in r2 " + Date.now()));
  expect(await k("POST", "/k/blobs/commit", { sha256: absent, mime: "image/png" }), 404, "object_missing");

  // An upload without x-amz-checksum-sha256 records only MD5.
  const loose = Buffer.from("uploaded without a checksum " + Date.now());
  s.r2Put(`sha256/${sha(loose)}`, loose);
  expect(await k("POST", "/k/blobs/commit", { sha256: sha(loose), mime: "text/plain" }), 409, "checksum_missing");
  assert.deepEqual(expect(await k("POST", "/k/blobs/has", { sha256s: [sha(loose)] }), 200).present, []);

  // A PUT records R2's checksum; drop its row and commit rebuilds it.
  const bytes = randomBytes(4096);
  const hex = await stored(bytes, "image/png");
  s.d1(`DELETE FROM blobs WHERE sha256 = '${hex}'`);
  const c = expect(await k("POST", "/k/blobs/commit", { sha256: hex, mime: "image/png" }), 201);
  assert.equal(c.size, 4096);
  assert.deepEqual((await k("GET", `/k/blobs/${hex}`)).raw, bytes);
});

const claim = (kinds, extra = {}) => k("POST", "/k/jobs/claim", { owner: "kw-1", kinds, ttl_s: 600, limit: 10, ...extra }).then((r) => expect(r, 200).jobs);
const job = async (kind, key, extra = {}) => expect(await k("POST", "/k/jobs", { kind, key, payload: { key }, ...extra }), 201).job;
const finish = (j, state = "done", extra = {}) => k("POST", `/k/jobs/${j.id}/complete`, { owner: "kw-1", lease_token: j.lease_token, state, ...extra });

test("jobs: a job is held back until every dep is done or failed, and (kind, key) is created once", async () => {
  const a = await job("link", "dep-a");
  const b = await job("link", "dep-b");
  const bundle = await job("bundle", "dep-bundle", { deps: [a.id, b.id] });
  const dup = expect(await k("POST", "/k/jobs", { kind: "link", key: "dep-a", payload: { other: 1 } }), 200);
  assert.equal(dup.created, false);
  assert.equal(dup.job.id, a.id);
  expect(await k("POST", "/k/jobs", { kind: "bundle", key: "dep-x", payload: {}, deps: ["nope"] }), 422, "unknown_dep");

  const links = await claim(["link", "bundle"]);
  assert.deepEqual(links.map((j) => j.key).sort(), ["dep-a", "dep-b"]);
  expect(await finish(links[0], "done", { result: { ok: true } }), 200);
  assert.deepEqual(await claim(["bundle"]), [], "one dep still claimed");
  expect(await finish(links[1], "failed", { error: "blocked" }), 200);
  const [ready] = await claim(["bundle"]);
  assert.equal(ready.id, bundle.id);
  assert.deepEqual(ready.payload, { key: "dep-bundle" });
  expect(await finish(ready), 200);
});

test("jobs: completing needs the current lease token; a reclaimed lease's old token is 409, and heartbeat follows the same rule", async () => {
  const j = await job("image", "lease-1");
  const [first] = await claim(["image"]);
  assert.equal(first.id, j.id);
  expect(await finish({ ...first, lease_token: "0".repeat(32) }), 409, "lease_lost");

  s.d1(`UPDATE knowledge_jobs SET lease_until = 0 WHERE id = '${j.id}'`);
  const [second] = await claim(["image"]);
  assert.equal(second.id, j.id);
  assert.notEqual(second.lease_token, first.lease_token);
  expect(await finish(first), 409, "lease_lost");
  expect(await k("POST", `/k/jobs/${j.id}/heartbeat`, { owner: "kw-1", lease_token: first.lease_token, ttl_s: 60 }), 409, "lease_lost");
  const hb = expect(await k("POST", `/k/jobs/${j.id}/heartbeat`, { owner: "kw-1", lease_token: second.lease_token, ttl_s: 60 }), 200);
  assert.ok(hb.lease_until > Date.now());

  // "queued" hands it back; the next claim gets a new token.
  expect(await finish(second, "queued"), 200);
  const [third] = await claim(["image"]);
  assert.equal(third.attempts, 3);
  const done = expect(await finish(third), 200);
  assert.equal(done.state, "done");
  assert.ok(!("lease_token" in done));
  const listed = expect(await k("GET", "/k/jobs?kind=image&key=lease-1"), 200).jobs;
  assert.equal(listed.length, 1);
  assert.ok(!("lease_token" in listed[0]));
});

test("jobs: the third expired lease fails the job instead of handing it out again", async () => {
  const j = await job("video", "crashes-kworker");
  for (let i = 0; i < 3; i++) {
    const got = await claim(["video"]);
    assert.deepEqual(got.map((x) => x.id), [j.id], `claim ${i + 1}`);
    s.d1(`UPDATE knowledge_jobs SET lease_until = 0 WHERE id = '${j.id}'`);
  }
  assert.deepEqual(await claim(["video"]), []);
  const [row] = expect(await k("GET", "/k/jobs?kind=video&key=crashes-kworker"), 200).jobs;
  assert.equal(row.state, "failed");
  assert.equal(row.expired_leases, 3);
});

test("jobs: again requeues a done job with its new payload and one more run, and replaces a queued one's payload", async () => {
  await job("save", "again-1");
  const [c] = await claim(["save"]);
  expect(await finish(c, "done", { result: { kept: 3 } }), 200);

  const r = expect(await k("POST", "/k/jobs", { kind: "save", key: "again-1", payload: { v: 2 }, again: true }), 200);
  assert.equal(r.requeued, true);
  assert.equal(r.job.state, "queued");
  assert.equal(r.job.runs, 2);
  assert.deepEqual(r.job.payload, { v: 2 });
  // Waiting, it takes the newer payload in place: no extra run (since mvp-loop;
  // the claimed case is in intake.test.mjs).
  const still = expect(await k("POST", "/k/jobs", { kind: "save", key: "again-1", payload: { v: 3 }, again: true }), 200);
  assert.deepEqual([still.requeued, still.replaced], [false, true]);
  assert.equal(still.job.runs, 2);
  assert.deepEqual(still.job.payload, { v: 3 });
  const [next] = await claim(["save"]);
  assert.deepEqual(next.payload, { v: 3 });
  expect(await finish(next), 200);
});

async function bundleBlobs(text) {
  const json = Buffer.from(JSON.stringify({ schema: "kbundle/1", post_id: "1900000000000000001", post: { text }, replies: [{ text: "a reply" }] }));
  return { md_sha: await stored(Buffer.from(`# ${text}\n`), "text/markdown"), json_sha: await stored(json, "application/json"), json };
}

test("bundles: a version is added only when json_sha changes, its copies land under bundles/<id>/v<n>, and search sees only the latest text", async () => {
  const id = "1900000000000000001";
  const one = await bundleBlobs("quokka alpha");
  const reg = (b, search_text) => k("POST", "/k/bundles", { post_id: id, md_sha: b.md_sha, json_sha: b.json_sha, completeness: "complete", missing: [], saved_by: ["sdotgu"], author: "@poteto", search_text });
  const v1 = expect(await reg(one, "quokka alpha original"), 201);
  assert.deepEqual(v1, { created: true, post_id: id, version: 1, r2_key: `bundles/${id}/v1.md`, json_key: `bundles/${id}/v1.json` });
  const same = expect(await reg(one, "ignored text"), 200);
  assert.equal(same.created, false);
  assert.equal(same.version, 1);

  const two = await bundleBlobs("platypus beta");
  const v2 = expect(await reg(two, "platypus beta revised"), 201);
  assert.equal(v2.version, 2);
  assert.deepEqual(s.r2Get(`bundles/${id}/v2.json`), two.json);
  assert.equal(expect(await k("GET", `/k/bundles/${id}`), 200).version, 2);

  const hit = await toolOk("knowledge_search", { query: "platypus" });
  assert.deepEqual(hit.results.map((r) => [r.post_id, r.version]), [[id, 2]]);
  assert.match(hit.results[0].snippet_untrusted, /\[platypus\]/);
  assert.deepEqual((await toolOk("knowledge_search", { query: "quokka" })).results, []);
  // FTS5 syntax in a query is matched as words, not parsed.
  assert.deepEqual((await toolOk("knowledge_search", { query: 'platypus" OR "x' })).results, []);

  expect(await k("POST", "/k/bundles", { post_id: id, md_sha: sha("nope"), json_sha: two.json_sha, completeness: "complete", author: "", search_text: "" }), 422, "blob_missing");
});

test("canonical URLs: every vector in docs/knowledge-canon-vectors.json, through knowledge_has", async () => {
  const vectors = JSON.parse(readFileSync(join(ROOT, "../docs/knowledge-canon-vectors.json"), "utf8"));
  const { urls } = await toolOk("knowledge_has", { urls: vectors.map(([input]) => input) });
  assert.deepEqual(
    urls.map((u) => u.canonical_url),
    vectors.map(([, want]) => want),
  );
});

test("knowledge tools through POST /mcp with a mail agent token: listed read-only, has reports bundles and fetches, bundle and blob read stored data", async () => {
  const list = await k("POST", "/mcp", { jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }, { token: "mail_t3" });
  const tools = list.body.result.tools.filter((t) => t.name.startsWith("knowledge_"));
  assert.deepEqual(tools.map((t) => t.name), ["knowledge_has", "knowledge_search", "knowledge_bundle", "knowledge_digest", "knowledge_blob"]);
  for (const t of tools) assert.equal(t.annotations.readOnlyHint, true, t.name);

  const id = "1900000000000000002";
  const page = Buffer.from("README: a tool for reading repos. " + "x".repeat(100));
  const pageSha = await stored(page, "text/plain");
  const canonical = "https://github.com/capsoftware/cap";
  expect(await k("POST", "/k/fetches", { rows: [{ url_hash: sha("https://github.com/x/y"), canonical_url: canonical, rung: 0, status: "ok" }] }), 400, "invalid_request");
  expect(await k("POST", "/k/fetches", { rows: [{ url_hash: sha(canonical), canonical_url: canonical, rung: 0, status: "ok", content_sha: sha("missing") }] }), 422, "blob_missing");
  expect(await k("POST", "/k/fetches", { rows: [{ url_hash: sha(canonical), canonical_url: canonical, rung: 0, status: "ok", content_sha: pageSha, immutable: false }] }), 200);

  const big = { schema: "kbundle/1", post_id: id, url: `https://x.com/a/status/${id}`, completeness: "partial", post: { text: "post text" }, links: Array.from({ length: 400 }, (_, i) => ({ url: `https://e.com/${i}`, text: "y".repeat(200) })) };
  const json = Buffer.from(JSON.stringify(big));
  const md_sha = await stored(Buffer.from("# post\n"), "text/markdown");
  const json_sha = await stored(json, "application/json");
  expect(await k("POST", "/k/bundles", { post_id: id, md_sha, json_sha, completeness: "partial", author: "a", search_text: "post text" }), 201);

  const has = await toolOk("knowledge_has", { ids: [id, "1900000000000000999"], urls: ["https://www.github.com/CapSoftware/Cap.git", "ftp://nope"] });
  assert.deepEqual(has.ids, [
    { id, version: 1, completeness: "partial" },
    { id: "1900000000000000999", version: null, completeness: null },
  ]);
  assert.equal(has.urls[0].canonical_url, canonical);
  assert.equal(has.urls[0].fetch.status, "ok");
  assert.equal(has.urls[1].canonical_url, null);

  const b = await toolOk("knowledge_bundle", { post_id: id, sections: ["front", "post", "links", "markdown"] });
  assert.equal(b.sections_untrusted.front.completeness, "partial");
  assert.deepEqual(b.sections_untrusted.post, { text: "post text" });
  assert.equal(b.truncated, true);
  assert.ok(b.sections_untrusted.links.length > 0 && b.sections_untrusted.links.length < 400);
  assert.deepEqual(b.sections_untrusted.links[0], big.links[0]);
  assert.ok(Buffer.byteLength(JSON.stringify(b.sections_untrusted)) <= 48 * 1024);
  // A cut bundle names its blobs, so the rest can be read with knowledge_blob.
  assert.equal(b.json_sha, json_sha);
  assert.equal(b.md_sha, md_sha);
  const rest = await toolOk("knowledge_blob", { key: `sha256/${b.json_sha}`, offset: json.length - 40, length: 40 });
  assert.equal(rest.data_untrusted, json.subarray(json.length - 40).toString());

  const t = await toolOk("knowledge_blob", { key: `sha256/${pageSha}`, offset: 8, length: 10 });
  assert.equal(t.encoding, "utf8");
  assert.equal(t.data_untrusted, page.subarray(8, 18).toString());
  assert.equal(t.next_offset, 18);
  const binBytes = randomBytes(300);
  const bin = await toolOk("knowledge_blob", { key: await stored(binBytes, "image/png") });
  assert.equal(bin.encoding, "base64");
  assert.deepEqual(Buffer.from(bin.data_untrusted, "base64"), binBytes);
  assert.equal(bin.next_offset, null);

  const missing = await tool("knowledge_bundle", { post_id: "1900000000000000999" });
  assert.equal(missing.isError, true);
});

const geminiCalls = async (stack = s) => stack.control("gemini-calls");
const run = (extra, stack = s) =>
  k("POST", "/k/model/run", { step: "image_read", provider: "gemini", model: "gemini-3.5-flash-lite", prompt_v: "image-read-v1", prompt: "Read this image.", ...extra }, { stack });

test("gemini adapter, inline: small inputs go inline as base64, the output and its derivation are stored under the documented key, and a repeat is served from the cache without calling Gemini", async () => {
  const img = randomBytes(2048);
  const imgSha = await stored(img, "image/jpeg");
  const schema = { type: "object", properties: { text: { type: "string" } } };
  const before = (await geminiCalls()).length;
  const r = expect(await run({ inputs: [{ sha256: imgSha, mime: "image/jpeg" }], response_schema: schema, max_output_tokens: 256 }), 200);
  assert.equal(r.output, '{"read":"fixture","parts":2}');
  assert.equal(r.output_sha, sha(r.output));
  assert.equal(r.cached, false);
  assert.deepEqual(r.usage, { input_tokens: 11, output_tokens: 7 });

  const calls = (await geminiCalls()).slice(before);
  assert.deepEqual(calls.map((c) => c.op), ["generate"]);
  assert.equal(calls[0].key, "fixture-gemini-key");
  assert.equal(calls[0].model, "gemini-3.5-flash-lite");
  assert.deepEqual(calls[0].parts, [{ inline: "image/jpeg", sha256: imgSha }, { text: "Read this image." }]);
  assert.deepEqual(calls[0].generationConfig, { responseMimeType: "application/json", responseSchema: schema, maxOutputTokens: 256 });

  // kworker looks the call up by the recipe in KNOWLEDGE.md, computed here
  // from the document, not from the Worker.
  const inputSha = sha(canon({ inputs: [imgSha], prompt_sha: sha("Read this image."), response_schema_sha: sha(canon(schema)) }));
  const { derivations } = expect(await k("POST", "/k/derivations/lookup", { keys: [{ input_sha: inputSha, step: "image_read" }] }), 200);
  assert.equal(derivations.length, 1);
  assert.equal(derivations[0].output_sha, r.output_sha);
  assert.equal((await k("GET", `/k/blobs/${r.output_sha}`)).raw.toString(), r.output);

  const again = expect(await run({ inputs: [{ sha256: imgSha, mime: "image/jpeg" }], response_schema: schema, max_output_tokens: 256 }), 200);
  assert.equal(again.cached, true);
  assert.equal(again.output, r.output);
  assert.equal((await geminiCalls()).length, before + 1);

  const cap = expect(await k("GET", "/k/capabilities?step=image_read"), 200).capabilities.find((c) => c.provider === "gemini");
  assert.equal(cap.available, true);
  assert.ok(cap.used_today >= 1);
});

test("gemini adapter, Files API: an input over 512 KiB streams through a resumable upload, is read by uri and deleted after; inline bytes never total over 512 KiB", async () => {
  const video = randomBytes(600 * 1024);
  const videoSha = await stored(video, "video/mp4");
  const before = (await geminiCalls()).length;
  const r = expect(await run({ step: "video_read", model: "gemini-3.6-flash", prompt_v: "video-read-v1", prompt: "Describe the video.", inputs: [{ sha256: videoSha, mime: "video/mp4" }] }), 200);
  assert.equal(r.cached, false);
  const calls = (await geminiCalls()).slice(before);
  assert.deepEqual(calls.map((c) => c.op), ["start", "upload", "status", "generate", "delete"]);
  const [start, upload, , gen, del] = calls;
  assert.equal(start.protocol, "resumable");
  assert.equal(start.command, "start");
  assert.equal(start.declared_length, String(video.length));
  assert.equal(start.declared_type, "video/mp4");
  assert.equal(start.key, "fixture-gemini-key");
  assert.equal(upload.command, "upload, finalize");
  assert.equal(upload.offset, "0");
  assert.equal(upload.content_length, String(video.length));
  assert.equal(upload.bytes, video.length);
  assert.equal(upload.sha256, videoSha);
  assert.equal(gen.parts[0].mime, "video/mp4");
  assert.match(gen.parts[0].file, /\/v1beta\/files\/fx\d+$/);
  assert.equal(del.path, new URL(gen.parts[0].file).pathname);

  // Two 300 KiB inputs: the first fits inline, the second would pass 512 KiB.
  const a = await stored(randomBytes(300 * 1024), "image/png");
  const b = await stored(randomBytes(300 * 1024), "image/png");
  const before2 = (await geminiCalls()).length;
  expect(await run({ prompt: "Compare.", inputs: [{ sha256: a, mime: "image/png" }, { sha256: b, mime: "image/png" }] }), 200);
  const parts = (await geminiCalls()).slice(before2).find((c) => c.op === "generate").parts;
  assert.equal(parts[0].sha256, a);
  assert.ok(parts[1].file, "second input went through the Files API");
});

test("gemini adapter: 429 quota_exhausted at quota_per_day, and 503 capability_unavailable on a Worker without GEMINI_API_KEY", async () => {
  s.d1("UPDATE capabilities SET quota_per_day = 0 WHERE step = 'gate_band' AND provider = 'gemini'");
  expect(await run({ step: "gate_band", prompt_v: "gate-band-v1", prompt: "Judge these replies." }), 429, "quota_exhausted");

  const img = randomBytes(64);
  const hex = sha(img);
  expect(await k("PUT", `/k/blobs/${hex}`, img, { stack: bare, headers: { "content-type": "image/png" } }), 201);
  const before = (await geminiCalls(bare)).length;
  expect(await run({ inputs: [{ sha256: hex, mime: "image/png" }] }, bare), 503, "capability_unavailable");
  assert.equal((await geminiCalls(bare)).length, before);
  const cap = expect(await k("GET", "/k/capabilities?step=image_read", undefined, { stack: bare }), 200).capabilities;
  assert.deepEqual(cap.map((c) => [c.provider, c.available]), [["gemini", false], ["cliproxy", null]]);
});
