// POST /inbox/x and the two admin exports (docs/CONTRACT.md, "POST /inbox/x")
// against a real `wrangler dev` with local D1.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startStack } from "../scripts/harness.mjs";

let s;
before(async () => {
  s = await startStack({ port: 8881, fixturePort: 8882, inspectorPort: 9381 });
});
after(async () => {
  await s?.stop();
});

const item = (id, extra = {}, post = {}) => ({
  surface: "home",
  position: 0,
  ...extra,
  post: {
    id,
    url: `https://x.com/alice/status/${id}`,
    author_handle: "alice",
    author_name: "Alice",
    created_at: "2026-11-12T12:00:00Z",
    text: `post ${id}`,
    quoted_id: null,
    metrics: { likes: 3, reposts: 1, replies: 0, quotes: 0, bookmarks: 2, views: 100 },
    ...post,
  },
});
const part = (run_id, n, items, extra = {}) => ({ run_id, account: "sdotgu", part: n, parts: 2, collected_at: "2026-11-12T13:10:00Z", items, ...extra });
const send = (body, token = "inbox") => s.call("POST", "/inbox/x", body, { raw: true, token });
const exportInbox = () => s.call("GET", "/admin/inbox/x?since=0&until=" + (Date.now() + 60_000));

test("the inbox token reaches only POST /inbox/x, and no other token reaches it, the admin token included", async () => {
  const status = async (method, path, token) => (await s.call(method, path, method === "POST" ? {} : undefined, { raw: true, token })).status;
  for (const [method, path] of [["POST", "/ingest/x"], ["POST", "/x/sessions/start"], ["GET", "/x/posts"], ["POST", "/candidates/claim"], ["GET", "/admin/log"], ["GET", "/admin/inbox/x?since=0&until=1"], ["GET", "/admin/x/sightings?since=0&until=1"], ["GET", "/admin/watchers"]]) {
    assert.equal(await status(method, path, "inbox"), 403, `inbox token on ${method} ${path}`);
  }
  // Only GrokBot writes here, so a stray admin-token write can't pass for one of its runs.
  for (const token of ["ingest", "runner", "admin"]) assert.equal(await status("POST", "/inbox/x", token), 403, `${token} token on POST /inbox/x`);
  assert.equal(await status("POST", "/inbox/x", "none"), 401);
  assert.equal((await send(part("scope-run", 1, [item("101")]))).status, 200);
});

test("a malformed part gets a 400 naming the exact field, stores no items, and is recorded as a reject", async () => {
  const t0 = Date.now();
  const ok = part("bad-run", 1, [item("201"), item("202", { position: 1 })]);
  const cases = [
    [{ ...ok, items: [item("201"), item(2.0263e18)] }, /^items\[1\]\.post\.id must be a string of digits in quotes, got the number/],
    [{ ...ok, items: [item("201", { surface: "thread", relation: "self" })] }, /^items\[0\]\.thread_root_id is required when surface is thread/],
    [{ ...ok, items: [item("201", { surface: "thread", thread_root_id: "200" })] }, /^items\[0\]\.relation is required when surface is thread: one of reply, quote, link, self/],
    [{ ...ok, items: [item("201", { surface: "thread", thread_root_id: "200", relation: "retweet" })] }, /^items\[0\]\.relation must be one of reply, quote, link, self, got "retweet"/],
    [{ ...ok, items: [item("201", { relation: "reply" })] }, /^items\[0\]\.relation is only allowed when surface is thread/],
    [{ ...ok, items: [item("201", { surface: "bookmarks", thread_root_id: "200" })] }, /^items\[0\]\.thread_root_id is only allowed when surface is thread/],
    [{ ...ok, items: [item("201", {}, { url: "https://x.com/alice/status/999" })] }, /^items\[0\]\.post\.url points at status 999 but items\[0\]\.post\.id is 201/],
    [{ ...ok, items: [item("201", {}, { metrics: { likes: "1.2K" } })] }, /^items\[0\]\.post\.metrics\.likes must be a whole number/],
    [{ ...ok, items: [item("201", {}, { author: "alice" })] }, /^items\[0\]\.post\.author is not a known field/],
    [{ ...ok, items: [item("201", {}, { author_handle: "@alice" })] }, /^items\[0\]\.post\.author_handle must be the handle without the leading @/],
    [{ ...ok, items: [item("201", {}, { created_at: "Nov 12, 2026" })] }, /^items\[0\]\.post\.created_at must be an ISO 8601 time/],
    [{ ...ok, items: [item("201"), item("201", { position: 1 })] }, /^items\[1\] repeats post 201 on surface home, already sent as items\[0\]/],
    [{ ...ok, part: 3 }, /^part is 3 but parts is 2/],
    [{ ...ok, run_id: undefined }, /^run_id is missing/],
  ];
  for (const [body, expected] of cases) {
    const res = await send(body);
    assert.equal(res.status, 400, `expected 400 for ${expected}`);
    const { error } = await res.json();
    assert.match(error, expected);
    assert.match(error, /Nothing from this part was stored/);
  }
  // 10,000 levels of nesting where a number belongs, sent as text (the client's own JSON.stringify would
  // overflow): the error describes it without walking into it, so it is a 400 with a reject, not a crash.
  const deep = JSON.stringify({ ...ok, items: [item("201", {}, { metrics: { likes: "DEEP" } })] }).replace('"DEEP"', "[".repeat(10_000) + "]".repeat(10_000));
  const deepRes = await fetch(`${s.base}/inbox/x`, { method: "POST", body: deep, headers: { authorization: `Bearer ${s.vars.INBOX_TOKEN}` } });
  assert.equal(deepRes.status, 400);
  assert.match((await deepRes.json()).error, /^items\[0\]\.post\.metrics\.likes must be a whole number .*got an array of 1/);
  const notJson = await fetch(`${s.base}/inbox/x`, { method: "POST", body: '{"run_id": "bad-run",', headers: { authorization: `Bearer ${s.vars.INBOX_TOKEN}` } });
  assert.equal(notJson.status, 400);
  assert.match((await notJson.json()).error, /^body is not valid JSON/);

  const { items, rejects } = await exportInbox();
  assert.deepEqual(items.filter((i) => i.run_id === "bad-run"), [], "a refused part stores no items");
  const mine = rejects.filter((r) => r.status === 400 && r.received_at >= t0);
  assert.equal(mine.length, cases.length + 2, "every refused body is recorded");
  assert.ok(mine.some((r) => r.error.startsWith("items[1].post.id") && r.run_id === "bad-run" && r.part === 1 && r.body.includes("2026300000000000000")));

  // The corrected part is accepted and its items read back as sent.
  assert.equal((await send(ok)).status, 200);
  const stored = (await exportInbox()).items.filter((i) => i.run_id === "bad-run");
  assert.deepEqual(stored.map((i) => [i.post_id, i.position, i.surface, i.author_handle]), [["201", 0, "home", "alice"], ["202", 1, "home", "alice"]]);
  assert.deepEqual(JSON.parse(stored[0].metrics_json), { likes: 3, reposts: 1, replies: 0, quotes: 0, bookmarks: 2, views: 100 });
});

test("a repeated (run_id, part) returns 200 and writes nothing; a repeat with a different body is recorded; inbox posts never reach x_posts or candidates", async () => {
  const p1 = part("idem-run", 1, [
    item("301", { surface: "bookmarks" }),
    item("302", { surface: "thread", thread_root_id: "301", relation: "self" }, { metrics: undefined }),
    item("305", { surface: "thread", thread_root_id: "301", relation: "quote" }),
  ]);
  const first = await (await send(p1)).json();
  assert.deepEqual(first, { run_id: "idem-run", part: 1, parts: 2, items_stored: 3, duplicate: false });
  const again = await (await send(p1)).json();
  assert.deepEqual(again, { run_id: "idem-run", part: 1, parts: 2, items_stored: 0, duplicate: true, same_body: true });
  const changed = await (await send({ ...p1, items: [item("303")] })).json();
  assert.equal(changed.duplicate, true);
  assert.equal(changed.same_body, false);
  assert.equal((await (await send(part("idem-run", 2, [item("304")]))).json()).items_stored, 1, "another part of the same run is written");

  const { parts, items, rejects } = await exportInbox();
  assert.deepEqual(items.filter((i) => i.run_id === "idem-run").map((i) => i.post_id).sort(), ["301", "302", "304", "305"]);
  const thread = items.find((i) => i.post_id === "302");
  assert.equal(thread.thread_root_id, "301");
  assert.equal(thread.relation, "self");
  assert.equal(thread.metrics_json, null);
  assert.equal(items.find((i) => i.post_id === "305").relation, "quote");
  assert.equal(items.find((i) => i.post_id === "301").relation, null);
  const stored = parts.find((x) => x.run_id === "idem-run" && x.part === 1);
  assert.deepEqual(JSON.parse(stored.body), JSON.parse(JSON.stringify(p1)), "the raw body is the first one sent");
  const dup = rejects.filter((r) => r.run_id === "idem-run");
  assert.equal(dup.length, 1);
  assert.equal(dup[0].status, 200);
  assert.match(dup[0].error, /already stored .* with a different body/);

  const posts = (await s.call("GET", "/x/posts?limit=200", undefined, { token: "runner" })).posts.map((p) => p.id);
  assert.ok(!posts.some((id) => ["301", "302", "304"].includes(id)), "inbox items are not ingested posts");
  const refs = (await s.call("GET", "/candidates?kind=x_post", undefined, { token: "runner" })).candidates.map((c) => c.ref);
  assert.ok(!refs.includes("301"), "an inbox bookmark makes no candidate");
});

test("the inbox cap is 256 KB, counted while reading; an oversized body gets 413 and its first 64 KB are recorded", async () => {
  const chunked = (text) =>
    fetch(`${s.base}/inbox/x`, {
      method: "POST",
      duplex: "half",
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
      headers: { authorization: `Bearer ${s.vars.INBOX_TOKEN}`, "content-type": "application/json" },
    });
  // A post's text is at most 50,000 characters, so the size comes from several posts.
  const wrap = (run, n) => JSON.stringify(part(run, 1, Array.from({ length: n }, (_, i) => item(String(400 + i), { position: i }, { text: "a".repeat(42_000) }))));
  const big = wrap("cap-big", 7);
  assert.ok(new TextEncoder().encode(big).length > 256 * 1024);
  const res = await chunked(big);
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /Split the items into more parts/);
  const near = wrap("cap-ok", 6);
  assert.ok(new TextEncoder().encode(near).length > 240 * 1024);
  assert.equal((await chunked(near)).status, 200);

  const { items, rejects } = await exportInbox();
  assert.ok(!items.some((i) => i.run_id === "cap-big"));
  const r = rejects.find((x) => x.status === 413 && x.body.includes("cap-big"));
  assert.ok(r, "the oversized body is recorded");
  assert.equal(r.body_truncated, 1);
  assert.equal(new TextEncoder().encode(r.body).length, 64 * 1024);
  assert.ok(r.body_bytes > 256 * 1024);
});

test("a recorded reject body is cut at a UTF-8 character boundary and stays within 64 KB", async () => {
  // 3-byte characters after a 2-byte prefix: 65,534 is not a multiple of 3, so a cut at exactly 65,536 bytes
  // lands inside a character.
  const body = "xy" + "€".repeat(30_000);
  const res = await fetch(`${s.base}/inbox/x`, { method: "POST", body, headers: { authorization: `Bearer ${s.vars.INBOX_TOKEN}` } });
  assert.equal(res.status, 400);
  const r = (await exportInbox()).rejects.find((x) => x.body.startsWith("xy€"));
  assert.ok(r);
  const bytes = new TextEncoder().encode(r.body).length;
  assert.ok(bytes <= 64 * 1024 && bytes > 64 * 1024 - 3, `stored ${bytes} bytes`);
  assert.ok(!r.body.includes("\uFFFD"), "no replacement character from a split character");
  assert.equal(r.body_truncated, 1);
  assert.equal(r.body_bytes, 2 + 3 * 30_000);
});

test("an oversized body is recorded without a split character even when reading stopped at exactly 64 KB", async () => {
  // A declared Content-Length over the cap stops the read at 64 KB. "x" then 4-byte characters puts the
  // 64 KB mark three bytes into a character.
  const body = "x" + "😀".repeat(70_000);
  const res = await fetch(`${s.base}/inbox/x`, { method: "POST", body, headers: { authorization: `Bearer ${s.vars.INBOX_TOKEN}` } });
  assert.equal(res.status, 413);
  const r = (await exportInbox()).rejects.find((x) => x.status === 413 && x.body.startsWith("x😀"));
  assert.ok(r);
  const bytes = new TextEncoder().encode(r.body).length;
  assert.equal(bytes, 1 + 4 * Math.floor((64 * 1024 - 1) / 4), `stored ${bytes} bytes`);
  assert.ok(!r.body.includes("\uFFFD"), "no replacement character from a split character");
  assert.ok(r.body.endsWith("😀"));
});

test("the sightings export joins each sighting to its post with that sighting's metrics, windows by seen_at, pages without gaps, and leaves out account test", async () => {
  const p = (id, likes) => ({ id, author_handle: "bob", author_name: "Bob", created_at: "2026-11-12T08:00:00Z", text: `x ${id}`, metrics: { likes }, position: 0 });
  const ingest = (account, session_id, mode, batch_id, surface, posts) =>
    s.call("POST", "/ingest/x", { account, session_id, mode, captured_at: new Date().toISOString(), batches: [{ batch_id, op: surface === "bookmarks" ? "Bookmarks" : "HomeTimeline", surface, posts }] }, { token: "ingest" });
  const t0 = Date.now() - 1;
  await ingest("sdotgu", "sess-a", "passive", "exp:1", "home_for_you", [p("e-1", 5)]);
  await ingest("sdotgu", "sess-b", "active", "exp:2", "home_following", [p("e-1", 40), p("e-2", 1)]);
  await ingest("test", "sess-t", "passive", "exp:3", "home_for_you", [p("e-3", 1)]);
  const t1 = Date.now() + 1;

  const all = await s.call("GET", `/admin/x/sightings?since=${t0}&until=${t1}`);
  const rows = all.sightings.filter((x) => x.post_id.startsWith("e-"));
  assert.deepEqual(
    rows.map((x) => [x.post_id, x.surface, x.session_id, x.mode, JSON.parse(x.metrics_json).likes]),
    [["e-1", "home_for_you", "sess-a", "passive", 5], ["e-1", "home_following", "sess-b", "active", 40], ["e-2", "home_following", "sess-b", "active", 1]],
    "metrics are per sighting, so the first sighting keeps its own like count",
  );
  assert.ok(rows.every((x) => x.author_handle === "bob" && x.account === "sdotgu" && x.seen_at >= t0));
  assert.ok(all.sessions.some((x) => x.session_id === "sess-b"));
  assert.ok(!all.sessions.some((x) => x.account === "test"));

  const before = await s.call("GET", `/admin/x/sightings?since=0&until=${t0}`);
  assert.ok(!before.sightings.some((x) => x.post_id.startsWith("e-")), "until is exclusive of later sightings");

  // More than one page (1000 rows): the pages must add up to every row once.
  const t2 = Date.now() - 1;
  for (const n of [0, 1]) {
    await ingest("sdotgu", "sess-page", "passive", `exp:page:${n}`, "home_for_you", Array.from({ length: 550 }, (_, i) => ({ ...p(`pg-${n}-${i}`, i), position: i })));
  }
  const t3 = Date.now() + 1;
  let after = 0;
  const paged = [];
  for (;;) {
    const page = await s.call("GET", `/admin/x/sightings?since=${t2}&until=${t3}&after_id=${after}`);
    assert.equal("threads" in page, after === 0, "threads and sessions come only on the first page");
    paged.push(...page.sightings.map((x) => x.post_id));
    if (page.next_after_id === null) break;
    after = page.next_after_id;
  }
  assert.equal(paged.length, 1100);
  assert.equal(new Set(paged).size, 1100);

  for (const q of ["since=0", "until=1", "since=5&until=5"]) {
    assert.equal((await s.call("GET", `/admin/x/sightings?${q}`, undefined, { raw: true })).status, 400, q);
  }
});
