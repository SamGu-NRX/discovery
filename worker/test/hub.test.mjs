// Device-signed approvals, the PR executor, the inbox, the brief and voice
// notes (docs/APPROVALS.md) against a real `wrangler dev`. The fixture stands
// in for APNs, GitHub and Gemini. Device keys are P-256 keys made here and
// signed with DER encoding, the form SecKeyCreateSignature returns.

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { freshFetch, startStack } from "../scripts/harness.mjs";

const apnsKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const APNS = { APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM765432", APNS_TOPIC: "dev.samgu.discovery" };
let s;
before(async () => {
  const p8 = apnsKey.privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\r?\n/g, "");
  s = await startStack({ port: 8901, fixturePort: 8902, inspectorPort: 9401, vars: { APNS_KEY_P8: p8, ...APNS } });
  await s.call("POST", "/admin/pr-allowlist", { repos: ["SamGu-NRX/discovery"] });
});
after(async () => {
  await s?.stop();
});

async function req(token, method, path, body) {
  const res = await s.call(method, path, body, { raw: true, token });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, body: data };
}
const ok = async (p, status = 200) => {
  const r = await p;
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
async function until(fn, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---- devices ----

const devices = {};
async function enrollDevice(name, apnsEnv = "production") {
  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { code } = await ok(req("admin", "POST", "/devices/enroll-codes"), 201);
  const apns = randomBytes(32).toString("hex");
  const body = { code, name, public_key_spki_b64: kp.publicKey.export({ type: "spki", format: "der" }).toString("base64"), apns_token: apns, apns_env: apnsEnv };
  const r = await ok(req("none", "POST", "/devices/enroll", body), 201);
  const d = { id: r.device_id, bearer: { bearer: r.device_token }, key: kp.privateKey, apns, name, code, body };
  devices[name] = d;
  return d;
}

const message = (id, hash, decision, nonce, at) => ["discovery-approval-v1", id, hash, decision, nonce, String(at)].join("\n");
const now = () => Math.floor(Date.now() / 1000);
function signed(device, r, decision, { at = now(), key = device.key, nonce = r.nonce, hash = r.inputs_hash, signDecision = decision } = {}) {
  const der = sign("sha256", Buffer.from(message(r.id, hash, signDecision, nonce, at)), { key, dsaEncoding: "der" });
  return { device_id: device.id, decision, signed_at: at, signature_der_b64: der.toString("base64") };
}
const decide = (r, body) => req("none", "POST", `/approvals/${r.id}/decide`, body);
const refusedBy = async (p, status, check) => {
  const r = await p;
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.check, check, JSON.stringify(r.body));
};

// ---- proposals ----

let seq = 0;
const b64 = (s) => Buffer.from(s).toString("base64");
function prInputs(extra = {}) {
  seq++;
  return { repo: "SamGu-NRX/discovery", base: "main", head_branch: `agent/hub-${seq}-${process.pid}`, title: `Add note ${seq}`, body: "Prepared by an agent.", files: [{ path: `notes/n${seq}.md`, content_b64: b64(`note ${seq}\n`) }], ...extra };
}
const proposal = (inputs, kind = "open_pr", title = `PR proposal ${++seq}`) =>
  req("runner", "POST", "/proposals", { candidate_ids: [], kind: "project_idea", title, why: "Because it helps.\nSecond line.", evidence: [], prepared: [], final_step_kind: kind, final_step: kind === "open_pr" ? "Open a draft PR" : "Send the email", inputs });
const requestFor = async (proposalId) => {
  const { approvals } = await ok(req("admin", "GET", "/approvals?state=pending&limit=200"));
  return approvals.find((a) => a.proposal_id === proposalId);
};
const ghWrites = async (repoFilter = () => true) => (await s.control("github")).requests.filter((r) => r.method !== "GET" && repoFilter(r));
const resetNotifyCap = () => s.d1("UPDATE proposals SET notify_day = 'reset'");

test("the bearer link decides until a device enrolls; then it refuses with 403 and the waiting proposal joins the device queue", async () => {
  const before = await ok(proposal({ to: "x@example.com" }, "send", "Email before devices"), 201);
  const token = before.approve_url.split("/a/")[1];
  assert.equal((await freshFetch(`${s.base}/a/${token}`)).status, 200);

  await enrollDevice("phone");
  const page = await freshFetch(`${s.base}/a/${token}`);
  assert.equal(page.status, 403);
  assert.match(await page.text(), /Device signature required/);
  const post = await req("none", "POST", `/a/${token}`, { decision: "approve" });
  assert.equal(post.status, 403);
  assert.equal(post.body.error, "device signature required");
  assert.deepEqual(await s.d1(`SELECT state FROM proposals WHERE id = '${before.id}'`), [{ state: "awaiting_approval" }]);
  const r = await requestFor(before.id);
  assert.ok(r, "the proposal that was waiting got an approval request at enrollment");
  assert.equal(r.inputs_hash, (await s.d1(`SELECT inputs_hash FROM proposals WHERE id = '${before.id}'`))[0].inputs_hash);

  // Revoking every device does not bring the bearer link back.
  const tmp = await enrollDevice("tmp");
  await ok(req("admin", "POST", `/devices/${tmp.id}/revoke`));
  assert.equal((await req("none", "POST", `/a/${token}`, { decision: "skip" })).status, 403);
});

test("enrollment: a code works once, within 10 minutes, is stored only as a hash, and the key must be an uncompressed P-256 SPKI", async () => {
  const d = devices.phone;
  const again = await req("none", "POST", "/devices/enroll", d.body);
  assert.equal(again.status, 403, "a spent code");
  const { code } = await ok(req("admin", "POST", "/devices/enroll-codes"), 201);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  const stored = await s.d1("SELECT code_hash FROM device_enroll_codes");
  const plain = code.replace(/-/g, "");
  assert.ok(stored.some((r) => r.code_hash === createHash("sha256").update(plain).digest("hex")));
  assert.ok(!JSON.stringify(stored).includes(plain));

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  for (const key of [rsa, p384, "bm90IGEga2V5"]) {
    const r = await req("none", "POST", "/devices/enroll", { ...d.body, code, public_key_spki_b64: key });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /^public_key_spki_b64 /);
  }
  const extra = await req("none", "POST", "/devices/enroll", { ...d.body, code, admin: true });
  assert.match(extra.body.error, /^body\.admin is not a field/);
  // The refusals above spent nothing; the code is lower-case and unspaced here.
  await s.d1(`UPDATE device_enroll_codes SET expires_at = 1 WHERE code_hash = '${createHash("sha256").update(plain).digest("hex")}'`);
  assert.equal((await req("none", "POST", "/devices/enroll", { ...d.body, code: plain.toLowerCase() })).status, 403, "an expired code");

  // A device token reads the queue but nothing admin-only, and can't be used once revoked.
  await ok(req(d.bearer, "GET", "/approvals"));
  assert.equal((await req(d.bearer, "GET", "/devices")).status, 403);
  assert.equal((await req(d.bearer, "POST", "/devices/enroll-codes")).status, 403);
  assert.equal((await req(d.bearer, "POST", "/inbox/x", {})).status, 403);
  assert.equal((await req(devices.tmp.bearer, "GET", "/approvals")).status, 401, "a revoked device's token");
});

test("a device updates only its own push token", async () => {
  const other = await enrollDevice("ipad", "development");
  const fresh = randomBytes(32).toString("hex");
  assert.equal((await req(other.bearer, "POST", `/devices/${devices.phone.id}/apns-token`, { apns_token: fresh })).status, 403);
  await ok(req(other.bearer, "POST", `/devices/${other.id}/apns-token`, { apns_token: fresh.toUpperCase() }));
  assert.deepEqual(await s.d1(`SELECT apns_token FROM devices WHERE id = '${other.id}'`), [{ apns_token: fresh }]);
  other.apns = fresh;
  assert.match((await req(other.bearer, "POST", `/devices/${other.id}/apns-token`, { apns_token: "xyz" })).body.error, /^apns_token /);
});

test("an irreversible proposal sends every live device a time-sensitive APPROVAL alert over its APNs host, with an ES256 provider token", async () => {
  await resetNotifyCap();
  const p = await ok(proposal(prInputs()), 201);
  assert.equal(p.notify_state, "sent");
  const r = await requestFor(p.id);
  assert.equal(p.approval_request_id, r.id);
  const pushes = (await s.control("pushes")).filter((x) => x.body.request_id === r.id);
  assert.deepEqual(pushes.map((x) => x.token).sort(), [devices.phone.apns, devices.ipad.apns].sort(), "every unrevoked device, not the revoked one");
  const host = (d) => pushes.find((x) => x.token === d.apns).host;
  assert.equal(host(devices.phone), "api.push.apple.com");
  assert.equal(host(devices.ipad), "api.sandbox.push.apple.com");
  const x = pushes[0];
  assert.deepEqual(x.body, {
    aps: { alert: { title: r.title, body: r.body }, category: "APPROVAL", "interruption-level": "time-sensitive", "mutable-content": 1 },
    request_id: r.id,
    inputs_hash: r.inputs_hash,
    nonce: r.nonce,
    expires_at: r.expires_at,
  });
  assert.match(r.nonce, /^[0-9a-f]{32}$/);
  assert.ok(r.body.split("\n").length <= 3);
  assert.match(r.body, /SamGu-NRX\/discovery: agent\/hub-\d+-\d+ into main/);
  assert.equal(x.headers["apns-topic"], APNS.APNS_TOPIC);
  assert.equal(x.headers["apns-push-type"], "alert");
  assert.equal(x.headers["apns-priority"], "10");
  assert.equal(x.headers["apns-expiration"], String(Math.floor(Date.parse(r.expires_at) / 1000)));
  const [scheme, jwt] = x.headers.authorization.split(" ");
  assert.equal(scheme, "bearer");
  const [h, c, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: APNS.APNS_KEY_ID });
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.equal(claims.iss, APNS.APNS_TEAM_ID);
  assert.ok(Math.abs(claims.iat - now()) < 120);
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: apnsKey.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")), "the JWT verifies with the .p8 key's public half");

  // A token APNs calls dead is not pushed to again.
  await s.control("apns", { token: devices.ipad.apns, reply: { status: 410, reason: "Unregistered" } });
  const p2 = await ok(proposal(prInputs()), 201);
  const r2 = await requestFor(p2.id);
  assert.deepEqual(await s.d1(`SELECT apns_invalid_reason FROM devices WHERE id = '${devices.ipad.id}'`), [{ apns_invalid_reason: "Unregistered" }]);
  await ok(proposal(prInputs()), 201);
  const pushed = (await s.control("pushes")).filter((x) => x.token === devices.ipad.apns);
  assert.ok(!pushed.some((x) => x.body.request_id !== r.id && x.body.request_id !== r2.id), "no push after the 410");
  // A new push token clears it.
  await ok(req(devices.ipad.bearer, "POST", `/devices/${devices.ipad.id}/apns-token`, { apns_token: devices.ipad.apns }));
  assert.deepEqual(await s.d1(`SELECT apns_invalid_at IS NULL AS live FROM devices WHERE id = '${devices.ipad.id}'`), [{ live: 1 }]);
});

test("deciding checks the device, the request, the clock, then the signature, in that order, and records nothing on a refusal", async () => {
  const p = await ok(proposal(prInputs()), 201);
  const r = await requestFor(p.id);
  const phone = devices.phone;
  const writesBefore = (await ghWrites()).length;

  await refusedBy(decide(r, { ...signed(phone, r, "approve"), device_id: "d_0000000000000000" }), 403, "device");
  // A revoked device, with a signature its own key made.
  await refusedBy(decide(r, signed(devices.tmp, r, "approve")), 403, "device");
  await refusedBy(decide({ ...r, id: "ar_000000000000000000000000" }, signed(phone, r, "approve")), 404, "request");
  await refusedBy(decide(r, signed(phone, r, "approve", { at: now() - 301 })), 401, "signed_at");
  await refusedBy(decide(r, signed(phone, r, "approve", { at: now() + 301, key: devices.ipad.key })), 401, "signed_at");
  // Valid signatures over anything but this exact message fail.
  await refusedBy(decide(r, signed(phone, r, "approve", { key: devices.ipad.key })), 401, "signature");
  await refusedBy(decide(r, signed(phone, r, "deny", { signDecision: "approve" })), 401, "signature");
  await refusedBy(decide(r, signed(phone, r, "approve", { nonce: "0".repeat(32) })), 401, "signature");
  await refusedBy(decide(r, signed(phone, r, "approve", { hash: "f".repeat(64) })), 401, "signature");
  // The same r and s, encoded with a leading zero DER forbids. ECDSA is
  // randomized, so sign until r needs no zero of its own.
  let good;
  do good = signed(phone, r, "approve");
  while (Buffer.from(good.signature_der_b64, "base64")[4] >= 0x80);
  const der = Buffer.from(good.signature_der_b64, "base64");
  const padded = Buffer.concat([Buffer.from([0x30, der[1] + 1, 0x02, der[3] + 1, 0x00]), der.subarray(4)]);
  await refusedBy(decide(r, { ...good, signature_der_b64: padded.toString("base64") }), 401, "signature");
  for (const [field, value] of [["decision", "yes"], ["signed_at", 1.5], ["signature_der_b64", "not base64!"], ["device_id", 7]]) {
    const bad = await decide(r, { ...good, [field]: value });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, new RegExp(`^${field} `));
  }

  assert.equal((await ok(req(phone.bearer, "GET", `/approvals/${r.id}`))).state, "pending", "no refusal recorded anything");
  assert.equal((await ghWrites()).length, writesBefore, "no refusal wrote to GitHub");

  // An expired request.
  const late = await ok(proposal(prInputs()), 201);
  const lr = await requestFor(late.id);
  await s.d1(`UPDATE approval_requests SET expires_at = ${Date.now() - 1} WHERE id = '${lr.id}'`);
  await refusedBy(decide(lr, signed(phone, lr, "approve")), 410, "request");
});

test("an approve opens a draft PR from a new agent/ branch off base, once; a replay or a second device gets 409", async () => {
  const inputs = prInputs({ files: [{ path: "a/one.txt", content_b64: b64("one") }, { path: "b/two.bin", content_b64: randomBytes(9).toString("base64") }] });
  const p = await ok(proposal(inputs), 201);
  const r = await requestFor(p.id);
  const mark = (await s.control("github")).requests.length;
  const body = signed(devices.phone, r, "approve");
  const res = await ok(decide(r, body));
  assert.equal(res.state, "executed");
  assert.match(res.result_url, /^https:\/\/github\.com\/SamGu-NRX\/discovery\/pull\/\d+$/);

  const calls = (await s.control("github")).requests.slice(mark);
  assert.ok(calls.every((c) => c.auth === `Bearer ${s.vars.GITHUB_PR_TOKEN}`));
  const writes = calls.filter((c) => c.method !== "GET");
  // Blobs go up in parallel, so their order varies.
  assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), ["POST /git/blobs", "POST /git/blobs", "POST /git/trees", "POST /git/commits", "POST /git/refs", "POST /pulls"]);
  const baseSha = createHash("sha1").update("main").digest("hex");
  const commit = writes.find((c) => c.path === "/git/commits").body;
  assert.deepEqual(commit.parents, [baseSha], "the branch starts at base's head");
  assert.deepEqual(writes.find((c) => c.path === "/git/trees").body.tree.map((t) => t.path), ["a/one.txt", "b/two.bin"]);
  assert.deepEqual(writes.filter((c) => c.path === "/git/blobs").map((c) => c.body.content).sort(), inputs.files.map((f) => f.content_b64).sort());
  assert.equal(writes.find((c) => c.path === "/git/refs").body.ref, `refs/heads/${inputs.head_branch}`);
  assert.deepEqual(writes.find((c) => c.path === "/pulls").body, { title: inputs.title, body: inputs.body, head: inputs.head_branch, base: "main", draft: true });
  assert.equal((await s.control("github")).repos["SamGu-NRX/discovery"].refs.main, baseSha, "base untouched");

  const replay = await decide(r, body);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.state, "executed");
  assert.equal(replay.body.result_url, res.result_url);
  await refusedBy(decide(r, signed(devices.ipad, r, "approve")), 409, "request");
  assert.equal((await s.control("github")).requests.slice(mark).filter((c) => c.path === "/pulls").length, 1);
  const [stored] = await s.d1(`SELECT state, result_json FROM proposals WHERE id = '${p.id}'`);
  assert.equal(stored.state, "executed");
  assert.equal(JSON.parse(stored.result_json).result_url, res.result_url);
  const got = await ok(req(devices.phone.bearer, "GET", `/approvals/${r.id}`));
  assert.equal(got.state, "approved");
  assert.equal(got.outcome, "executed");
});

test("two devices deciding at once: exactly one wins", async () => {
  const p = await ok(proposal(prInputs()), 201);
  const r = await requestFor(p.id);
  const [a, b] = await Promise.all([decide(r, signed(devices.phone, r, "deny")), decide(r, signed(devices.ipad, r, "deny"))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test("a deny records the decision and runs nothing", async () => {
  const p = await ok(proposal(prInputs()), 201);
  const r = await requestFor(p.id);
  const mark = (await s.control("github")).requests.length;
  assert.deepEqual(await ok(decide(r, signed(devices.ipad, r, "deny"))), { state: "denied" });
  assert.equal((await s.control("github")).requests.length, mark);
  assert.deepEqual(await s.d1(`SELECT state FROM proposals WHERE id = '${p.id}'`), [{ state: "skipped" }]);
  assert.equal((await ok(req("admin", "GET", `/approvals/${r.id}`))).state, "denied");
});

test("open_pr inputs are refused when filed if the branch, repository or paths break a rule", async () => {
  const refused = async (inputs, status, field) => {
    const r = await proposal(inputs);
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.match(r.body.error, new RegExp(`^${field.replace(/[.[\]]/g, "\\$&")}`));
  };
  await refused(prInputs({ head_branch: "feature/x" }), 400, "inputs.head_branch");
  await refused(prInputs({ head_branch: "main" }), 400, "inputs.head_branch");
  await refused(prInputs({ head_branch: "agent/../main" }), 400, "inputs.head_branch");
  await refused(prInputs({ base: "agent/x", head_branch: "agent/x" }), 400, "inputs.head_branch");
  await refused(prInputs({ repo: "SamGu-NRX/other" }), 403, "inputs.repo");
  await refused(prInputs({ repo: "someone/discovery" }), 403, "inputs.repo");
  await refused(prInputs({ files: [{ path: ".github/workflows/x.yml", content_b64: b64("on: push") }] }), 400, "inputs.files[0].path");
  await refused(prInputs({ files: [{ path: "../etc/passwd", content_b64: b64("x") }] }), 400, "inputs.files[0].path");
  await refused(prInputs({ files: [{ path: "x/.git/config", content_b64: b64("x") }] }), 400, "inputs.files[0].path");
  await refused(prInputs({ head_sha: "a".repeat(40) }), 400, "inputs needs exactly one");
  await refused(prInputs({ files: [], extra: 1 }), 400, "inputs.extra");
  await refused({ ...prInputs(), files: Array.from({ length: 31 }, (_, i) => ({ path: `f${i}`, content_b64: b64("x") })) }, 400, "inputs.files");
});

test("at execution: a repository taken off the allowlist, an existing branch, a moved head_sha or a failed PR call", async () => {
  // Off the allowlist after filing: refused before any write.
  const off = await ok(proposal(prInputs()), 201);
  const offR = await requestFor(off.id);
  await s.call("POST", "/admin/pr-allowlist", { repos: [] });
  let mark = (await s.control("github")).requests.length;
  try {
    const res = await ok(decide(offR, signed(devices.phone, offR, "approve")));
    assert.equal(res.state, "failed");
    assert.match(res.error, /allowlist/);
  } finally {
    await s.call("POST", "/admin/pr-allowlist", { repos: ["SamGu-NRX/discovery"] });
  }
  assert.equal((await s.control("github")).requests.length, mark, "no GitHub call at all");
  assert.deepEqual(await s.d1(`SELECT state FROM proposals WHERE id = '${off.id}'`), [{ state: "failed" }]);

  // A branch that already exists is never updated.
  const existing = await ok(proposal(prInputs({ head_branch: "agent/pushed" })), 201);
  const exR = await requestFor(existing.id);
  const before = (await s.control("github")).repos["SamGu-NRX/discovery"].refs["agent/pushed"];
  const exRes = await ok(decide(exR, signed(devices.phone, exR, "approve")));
  assert.equal(exRes.state, "failed");
  assert.equal((await s.control("github")).repos["SamGu-NRX/discovery"].refs["agent/pushed"], before);
  assert.ok(!(await ghWrites()).some((c) => c.method === "PATCH" || c.path === "/pulls" && c.body.head === "agent/pushed"));

  // A pushed branch is opened only at the approved commit.
  const pushedSha = createHash("sha1").update("pushed").digest("hex");
  const wrongSha = await ok(proposal(prInputs({ files: undefined, head_branch: "agent/pushed", head_sha: "b".repeat(40) })), 201);
  const wsR = await requestFor(wrongSha.id);
  mark = (await s.control("github")).requests.length;
  const ws = await ok(decide(wsR, signed(devices.phone, wsR, "approve")));
  assert.equal(ws.state, "failed");
  assert.match(ws.error, /not the approved head_sha/);
  assert.deepEqual((await s.control("github")).requests.slice(mark).filter((c) => c.method !== "GET"), []);
  const rightSha = await ok(proposal(prInputs({ files: undefined, head_branch: "agent/pushed", head_sha: pushedSha })), 201);
  const rsR = await requestFor(rightSha.id);
  mark = (await s.control("github")).requests.length;
  const rs = await ok(decide(rsR, signed(devices.phone, rsR, "approve")));
  assert.equal(rs.state, "executed");
  assert.deepEqual((await s.control("github")).requests.slice(mark).filter((c) => c.method !== "GET").map((c) => c.path), ["/pulls"]);

  // The branch was created and then the PR call failed: the outcome is unknown, not failed.
  await s.control("github-fail", { key: "POST /pulls", status: 500 });
  try {
    const p = await ok(proposal(prInputs()), 201);
    const r = await requestFor(p.id);
    const res = await ok(decide(r, signed(devices.phone, r, "approve")));
    assert.equal(res.state, "outcome_unknown");
    assert.deepEqual(await s.d1(`SELECT state FROM proposals WHERE id = '${p.id}'`), [{ state: "outcome_unknown" }]);
  } finally {
    await s.control("github-fail", { key: "POST /pulls", status: 0 });
  }
});

test("a decision only for the proposal's current inputs: changed stored inputs refuse the signature's request", async () => {
  const p = await ok(proposal(prInputs()), 201);
  const r = await requestFor(p.id);
  await s.d1(`UPDATE proposals SET inputs_json = json_set(inputs_json, '$.base', 'release') WHERE id = '${p.id}'`);
  const mark = (await s.control("github")).requests.length;
  await refusedBy(decide(r, signed(devices.phone, r, "approve")), 409, "inputs_hash");
  assert.equal((await s.control("github")).requests.length, mark);
  assert.equal((await ok(req("admin", "GET", `/approvals/${r.id}`))).state, "pending");
});

// ---- inbox ----

test("POST /inbox stores the text verbatim with the token's source; kinds follow the source and every bad field is named", async () => {
  const text = "  Ship the hub.\nThen rest.  ";
  const mine = await ok(req(devices.phone.bearer, "POST", "/inbox", { kind: "thought", text, source: "agent:dot" }), 201);
  assert.equal(mine.source, `device:${devices.phone.id}`);
  assert.deepEqual(await s.d1(`SELECT text, source, claimed_source FROM inbox_items WHERE id = '${mine.id}'`), [{ text, source: `device:${devices.phone.id}`, claimed_source: "agent:dot" }]);
  assert.equal((await ok(req("mail_dot", "POST", "/inbox", { kind: "reply", text: "On it.", reply_to: mine.id, source: "sam" }), 201)).source, "dot");
  assert.equal((await ok(req("admin", "POST", "/inbox", { kind: "direction", text: "x" }), 201)).source, "admin");

  // An agent can't pass for Sam.
  for (const kind of ["thought", "direction", "task"]) {
    const r = await req("mail_t3", "POST", "/inbox", { kind, text: "do it" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /^kind /);
  }
  assert.equal((await req(devices.phone.bearer, "POST", "/inbox", { kind: "agent_push", text: "x" })).status, 400);
  const cases = [
    [{ kind: "note", text: "x" }, /^kind /],
    [{ kind: "thought", text: "" }, /^text /],
    [{ kind: "thought", text: "é".repeat(4097) }, /^text is 8194 bytes/],
    [{ kind: "thought", text: "x", refs: ["ftp://x"] }, /^refs\[0\] /],
    [{ kind: "thought", text: "x", audio_id: "v_0000000000000000" }, /^audio_id /],
    [{ kind: "thought", text: "x", reply_to: mine.id }, /^reply_to /],
    [{ kind: "thought", text: "x", when: 1 }, /^body\.when /],
  ];
  for (const [body, error] of cases) {
    const r = await req(devices.phone.bearer, "POST", "/inbox", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, error);
  }
  const leak = await req("mail_dot", "POST", "/inbox", { kind: "agent_push", text: `see ${"ab".repeat(32)}` });
  assert.equal(leak.status, 422);
  for (const token of ["runner", "ingest", "inbox", "bridge"]) assert.equal((await req(token, "POST", "/inbox", { kind: "thought", text: "x" })).status, 403, token);
});

test("the brief: empty text on a quiet day; else at most 3 asks with the project, 1 return on Sam's words, 1 question, counts, at most 90 words", async () => {
  // Quiet: nothing pending, nothing said.
  await s.d1("UPDATE approval_requests SET state = 'expired' WHERE state = 'pending'");
  await s.d1("DELETE FROM inbox_items");
  const quiet = await ok(req(devices.phone.bearer, "GET", "/brief"));
  assert.equal(quiet.text, "");
  assert.deepEqual(quiet.asks, []);
  assert.equal(quiet.question, undefined);
  // An agent's news alone doesn't break the quiet.
  await ok(req("mail_dot", "POST", "/inbox", { kind: "agent_push", text: "Found a post about Rust." }), 201);
  assert.equal((await ok(req("admin", "GET", "/brief"))).text, "");

  const filed = [];
  for (let i = 0; i < 4; i++) filed.push(await ok(proposal(prInputs(), "open_pr", `Decision number ${i} with a fairly long title that keeps going on and on`), 201));
  const said = await ok(req(devices.phone.bearer, "POST", "/inbox", { kind: "thought", text: "Should the dot summarize my mornings?" }), 201);
  const open = await ok(req(devices.phone.bearer, "POST", "/inbox", { kind: "thought", text: "Look into a cheaper GPU box for evals" }), 201);
  await ok(req("mail_dot", "POST", "/inbox", { kind: "reply", text: "Yes: a 6 am brief, three lines.", reply_to: said.id }), 201);

  const b = await ok(req("mail_dot", "GET", "/brief"));
  assert.equal(b.asks.length, 3);
  assert.ok(b.asks.every((a) => a.line.startsWith("Open PR in discovery: ")), JSON.stringify(b.asks));
  assert.equal(b.counts.pending_approvals, 4);
  assert.equal(b.counts.more_approvals, 1);
  assert.equal(b.returns.length, 1);
  assert.match(b.returns[0].line, /^dot answered "Should the dot summarize my mornings\?": Yes: a 6 am brief/);
  assert.equal(b.question.inbox_id, open.id, "the unanswered thought, not the answered one");
  assert.ok(b.text.split(/\s+/).filter(Boolean).length <= 90, b.text);
  assert.match(b.text, /^3 decisions: /);
  assert.match(b.text, /1 more waiting\./);
  assert.ok(!/found today/i.test(b.text));
  for (const f of filed) assert.ok(await requestFor(f.id));
  assert.equal((await req("mail_t3", "GET", "/brief")).status, 403);
  assert.equal((await req("runner", "GET", "/brief")).status, 403);
});

test("the dot's MCP surface adds get_brief and tell; no other agent sees them", async () => {
  const rpc = async (path, method, params, token = "none") => (await s.call("POST", path, { jsonrpc: "2.0", id: 1, method, params }, { raw: true, token })).json();
  const dotPath = `/mcp/dot/${s.vars.MAIL_DOT_TOKEN}`;
  const names = (await rpc(dotPath, "tools/list", {})).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_brief", "mailbox_ack", "mailbox_claim", "mailbox_complete", "mailbox_send", "tell"]);
  const t3 = (await rpc("/mcp", "tools/list", {}, "mail_t3")).result.tools.map((t) => t.name);
  assert.ok(!t3.includes("tell") && !t3.includes("get_brief"));
  const told = await rpc(dotPath, "tools/call", { name: "tell", arguments: { text: "The PR is up." } });
  const id = told.result.structuredContent.id;
  assert.deepEqual(await s.d1(`SELECT kind, source, text FROM inbox_items WHERE id = '${id}'`), [{ kind: "agent_push", source: "dot", text: "The PR is up." }]);
  const asT3 = await rpc("/mcp", "tools/call", { name: "tell", arguments: { text: "x" } }, "mail_t3");
  assert.ok(asT3.error || asT3.result?.isError, "t3 can't call tell");
  const b = await rpc(dotPath, "tools/call", { name: "get_brief", arguments: {} });
  assert.equal(typeof b.result.structuredContent.text, "string");
  assert.ok("counts" in b.result.structuredContent);
});

// ---- voice ----

// One connection per upload: a refusal answered before the body is read
// leaves local dev's connection unusable, which fetch's keep-alive pool would
// hit on the next call.
const voice = (token, bytes, headers = {}) =>
  new Promise((resolve, reject) => {
    const h = { authorization: `Bearer ${token.bearer}`, "content-type": "audio/mp4", "x-recorded-at": "2026-11-12T08:00:00-06:00", "content-length": String(bytes.length), ...headers };
    const r = request(`${s.base}/voice`, { method: "POST", agent: false, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    r.on("error", (e) => (r.headersSent && e.code === "ECONNRESET" ? null : reject(e)));
    r.end(bytes);
  });

test("a voice note is stored and answered at once, then transcribed with Gemini and filed as a thought with its audio_id", async () => {
  await s.control("gemini-set", { status: 200, transcript: "Remember to ship the hub branch." });
  const audio = randomBytes(64 * 1024);
  const res = await voice(devices.phone.bearer, audio);
  assert.equal(res.status, 201);
  const { audio_id } = await res.json();
  assert.match(audio_id, /^v_[0-9a-f]{16}$/);
  const done = await until(async () => {
    const v = await ok(req(devices.phone.bearer, "GET", `/voice/${audio_id}`));
    return v.state === "done" && v;
  }, "the transcription");
  assert.equal(done.transcript, "Remember to ship the hub branch.");
  assert.deepEqual(await s.d1(`SELECT kind, source, audio_id, text FROM inbox_items WHERE id = '${done.inbox_id}'`), [
    { kind: "thought", source: `device:${devices.phone.id}`, audio_id, text: "Remember to ship the hub branch." },
  ]);
  const g = await s.control("gemini");
  const upload = g.uploads.at(-1);
  assert.equal(upload.bytes, audio.length);
  assert.equal(upload.sha256, createHash("sha256").update(audio).digest("hex"), "Gemini got the exact bytes the phone sent, via R2");
  const start = g.requests.filter((x) => x.path === "/gemini/upload/v1beta/files").at(-1);
  assert.equal(start.headers["x-goog-api-key"], s.vars.GEMINI_API_KEY);
  assert.equal(start.headers["x-goog-upload-protocol"], "resumable");
  assert.equal(start.headers["x-goog-upload-header-content-length"], String(audio.length));
  const call = JSON.parse(g.requests.filter((x) => x.path === "/gemini/v1beta/interactions").at(-1).body);
  assert.deepEqual(call, { model: "models/gemini-3.5-transcribe", input: [{ type: "file", file_uri: `https://generativelanguage.googleapis.com/v1beta/files/f${upload.n}` }] });
  // Another device can't read it.
  assert.equal((await req(devices.ipad.bearer, "GET", `/voice/${audio_id}`)).status, 404);
});

test("voice refuses a wrong type, a missing x-recorded-at, an oversized body and a non-device token; a failing transcription is retried by the cron, then failed", async () => {
  assert.equal((await voice(devices.phone.bearer, randomBytes(10), { "content-type": "audio/wav" })).status, 415);
  assert.equal((await voice(devices.phone.bearer, randomBytes(10), { "x-recorded-at": "yesterday" })).status, 400);
  assert.equal((await voice({ bearer: s.vars.ADMIN_TOKEN }, randomBytes(10))).status, 403);
  assert.equal((await voice({ bearer: s.vars.MAIL_DOT_TOKEN }, randomBytes(10))).status, 403);
  assert.equal((await voice(devices.phone.bearer, Buffer.alloc(0))).status, 400);

  await s.control("gemini-set", { status: 503 });
  try {
    const { audio_id } = await (await voice(devices.phone.bearer, randomBytes(1024))).json();
    await until(async () => (await s.d1(`SELECT state, attempts FROM voice_notes WHERE id = '${audio_id}'`))[0].attempts === 1 && (await s.d1(`SELECT state FROM voice_notes WHERE id = '${audio_id}'`))[0].state === "queued", "the first attempt to fail");
    for (let n = 2; n <= 3; n++) {
      await s.d1(`UPDATE voice_notes SET updated_at = 0 WHERE id = '${audio_id}'`);
      assert.equal((await freshFetch(`${s.base}/__scheduled?cron=*/15+*+*+*+*`)).status, 200);
      assert.equal((await s.d1(`SELECT attempts FROM voice_notes WHERE id = '${audio_id}'`))[0].attempts, n);
    }
    const v = await ok(req(devices.phone.bearer, "GET", `/voice/${audio_id}`));
    assert.equal(v.state, "failed");
    assert.match(v.error, /503/);
    await s.d1(`UPDATE voice_notes SET updated_at = 0 WHERE id = '${audio_id}'`);
    await freshFetch(`${s.base}/__scheduled?cron=*/15+*+*+*+*`);
    assert.equal((await s.d1(`SELECT attempts FROM voice_notes WHERE id = '${audio_id}'`))[0].attempts, 3, "no fourth attempt");
  } finally {
    await s.control("gemini-set", { status: 200 });
  }
  // Refused from the declared length; local dev resets the connection after the 413.
  assert.equal((await voice(devices.phone.bearer, randomBytes(25 * 1024 * 1024 + 1))).status, 413);
});
