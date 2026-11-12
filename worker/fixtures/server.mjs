// Local stand-ins for the three source shapes, with state a test or the
// evidence run mutates between checks through /control/*.
//
//   /feed.xml   Atom, honors If-None-Match and If-Modified-Since (like GitHub)
//   /jobs.json  Greenhouse-shaped, no validators, so the watcher falls back to
//               the item-id fingerprint
//   /page.html  HTML with a per-request script nonce and no validators, so
//               the watcher falls back to the normalized-text fingerprint
//   /gone.xml   always 404, like the YouTube channel feed since 2026-11-04
//   /t3-webhook stand-in for the T3 webhook; records each POST body and
//               answers with state.webhookStatus
//   /hook/<name> stand-in for a mailbox wake target; records each POST's
//               headers and raw body and answers with state.hookStatus[name]
//               (default 200). An MCP Events verification request gets its
//               challenge echoed, unless state.hookMode[name] is "wrong"
//               (another challenge) or "flood" (8 KB that never ends)
//   /github/*   a small GitHub REST API for the PR executor: repos, refs,
//               commits, blobs, trees and pulls, recorded in state.github
//   /apns/<host>/3/device/<token>  stand-in for APNs; records each push and
//               answers state.apns[token] ?? {status: 200}
//   /gemini/*   the Files API resumable upload and POST /v1beta/interactions,
//               answering state.gemini.transcript (or state.gemini.status)
//   /upload/v1beta/files, /upload-session/<id>, /v1beta/files/<id>,
//   /v1beta/models/<model>:generateContent
//               stand-in for the Gemini API (generateContent and the Files
//               API resumable upload), written from Google's docs. Records
//               every call in state.kgemini.calls with the bytes it received
//               hashed; /control/gemini-calls reads them
//   /v1/embeddings, /v1/chat/completions  OpenAI-compatible stand-ins for the
//               lens model adapter (src/lens.ts). An embedding counts topic
//               words, so tests can say which posts sit near a centroid; the
//               chat answer depends on state.labelReply.
//
// Usage: node fixtures/server.mjs [port]   (default 8799)

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const fakeSha = (seed) => createHash("sha1").update(String(seed)).digest("hex");

export function createFixture() {
  const state = {
    version: 1,
    modifiedAt: new Date("2026-11-01T00:00:00Z"),
    entries: [
      { id: "fx:entry:1", title: "Seed entry one" },
      { id: "fx:entry:2", title: "Seed entry two" },
    ],
    jobs: [
      { id: 1001, title: "Software Engineer, Infrastructure" },
      { id: 1002, title: "Research Engineer, Interpretability" },
    ],
    pageText: "Careers. We are hiring across research and engineering.",
    hits: [],
    webhooks: [],
    webhookStatus: 200,
    hooks: [],
    hookStatus: {},
    hookMode: {},
    github: {
      repos: { "SamGu-NRX/discovery": { default_branch: "main", refs: { main: fakeSha("main"), "agent/pushed": fakeSha("pushed") }, pulls: 0 } },
      requests: [],
      // "<METHOD> <path prefix>" -> status, to make one kind of call fail.
      fail: {},
      race: {},
      seq: 0,
    },
    apns: {},
    pushes: [],
    // answer: what an interactions call returns as its JSON output text; the
    // transcript is added for a call that carries audio.
    gemini: { transcript: "Remember to ship the hub branch.", answer: null, status: 200, requests: [], uploads: [], seq: 0 },
    // The knowledge store's Gemini stand-in (generateContent and Files).
    kgemini: { calls: [], nextFile: 1 },
    // echo: label by topic words; garbage: answer with text that is not JSON.
    labelReply: "echo",
    chats: [],
  };
  // Axes of the stand-in embedding; every text also gets a small constant.
  const AXES = ["agent", "claude", "codex", "mcp", "harness", "memory", "recipe", "football"];
  const embedding = (text) => {
    const lower = text.toLowerCase();
    return AXES.map((w) => lower.split(w).length - 1 + 0.01);
  };

  const atom = () =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">\n<title>fixture</title>\n` +
    state.entries
      .map((e) => `<entry><id>${e.id}</id><title>${e.title}</title><link rel="alternate" href="http://fixture.local/${e.id}"/></entry>`)
      .join("\n") +
    "\n</feed>\n";

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.local");
    const send = (status, body, headers = {}) => {
      res.writeHead(status, headers);
      res.end(body);
    };

    if (url.pathname.startsWith("/control/")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const b = raw ? JSON.parse(raw) : {};
        switch (url.pathname) {
          case "/control/add-entry":
            state.entries.unshift(b);
            state.version++;
            state.modifiedAt = new Date();
            return send(200, JSON.stringify({ version: state.version }));
          case "/control/add-job":
            state.jobs.push(b);
            return send(200, "{}");
          case "/control/page":
            state.pageText = b.text;
            return send(200, "{}");
          case "/control/hits":
            return send(200, JSON.stringify(state.hits));
          case "/control/webhooks":
            return send(200, JSON.stringify(state.webhooks));
          case "/control/webhook-status":
            state.webhookStatus = b.status;
            return send(200, "{}");
          case "/control/hooks":
            return send(200, JSON.stringify(state.hooks));
          case "/control/hook-status":
            state.hookStatus[b.name] = b.status;
            return send(200, "{}");
          case "/control/hook-mode":
            state.hookMode[b.name] = b.mode;
            return send(200, "{}");
          case "/control/github":
            return send(200, JSON.stringify(state.github));
          case "/control/github-race":
            state.github.race[b.branch] = b.sha;
            return send(200, "{}");
          case "/control/github-fail":
            state.github.fail[b.key] = b.status;
            return send(200, "{}");
          case "/control/pushes":
            return send(200, JSON.stringify(state.pushes));
          case "/control/apns":
            state.apns[b.token] = b.reply;
            return send(200, "{}");
          case "/control/gemini":
            return send(200, JSON.stringify(state.gemini));
          case "/control/gemini-set":
            Object.assign(state.gemini, b);
            return send(200, "{}");
          case "/control/gemini-calls":
            return send(200, JSON.stringify(state.kgemini.calls));
          case "/control/label-reply":
            state.labelReply = b.mode;
            return send(200, "{}");
          case "/control/chats":
            return send(200, JSON.stringify(state.chats));
          case "/control/atom":
            return send(200, atom(), { "content-type": "application/atom+xml" });
          default:
            return send(404, "unknown control");
        }
      });
      return;
    }

    if ((url.pathname === "/v1/embeddings" || url.pathname === "/v1/chat/completions") && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const b = JSON.parse(raw);
        if (url.pathname === "/v1/embeddings") {
          return send(200, JSON.stringify({ data: b.input.map((t, index) => ({ index, embedding: embedding(t) })) }), { "content-type": "application/json" });
        }
        state.chats.push(b);
        const { posts } = JSON.parse(b.messages[1].content);
        const action = (t) => (/mcp/i.test(t) ? "open" : /agent/i.test(t) ? "glance" : "skip");
        const content = state.labelReply === "garbage" ? "I think these are good posts." : JSON.stringify({ labels: posts.map((p) => ({ id: p.id, action: action(p.text) })) });
        send(200, JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { "content-type": "application/json" });
      });
      return;
    }

    if (url.pathname === "/t3-webhook" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        state.webhooks.push({ ts: Date.now(), status: state.webhookStatus, body: JSON.parse(raw) });
        send(state.webhookStatus, "{}");
      });
      return;
    }

    if (url.pathname.startsWith("/hook/") && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const name = url.pathname.slice("/hook/".length);
        const status = state.hookStatus[name] ?? 200;
        state.hooks.push({ ts: Date.now(), name, status, headers: req.headers, raw });
        let body;
        try {
          body = JSON.parse(raw);
        } catch {}
        if (body?.type !== "verification") return send(status, "{}");
        const mode = state.hookMode[name];
        if (mode === "flood") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write(" ".repeat(8192));
          return; // never ends
        }
        const reply = () => send(status, JSON.stringify({ challenge: mode === "wrong" ? "not-the-challenge" : body.challenge }), { "content-type": "application/json" });
        // "slow" holds the correct echo for 1.5 s so a test can act mid-handshake.
        if (mode === "slow") return void setTimeout(reply, 1500);
        reply();
      });
      return;
    }

    if (url.pathname.startsWith("/github/")) return github(req, url, send);
    if (url.pathname.startsWith("/apns/")) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const [, , host, , , token] = url.pathname.split("/");
        state.pushes.push({ ts: Date.now(), host, token, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
        const reply = state.apns[token] ?? { status: 200 };
        send(reply.status, reply.status === 200 ? "" : JSON.stringify({ reason: reply.reason }), { "apns-id": `apns-${state.pushes.length}` });
      });
      return;
    }
    if (url.pathname.startsWith("/gemini/")) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const g = state.gemini;
        const raw = Buffer.concat(chunks);
        const session = url.pathname.startsWith("/gemini/upload-session/");
        g.requests.push({ ts: Date.now(), method: req.method, path: url.pathname, headers: req.headers, body: session ? `<${raw.length} bytes>` : raw.toString() });
        if (g.status !== 200) return send(g.status, JSON.stringify({ error: { message: "fixture failure" } }));
        if (url.pathname === "/gemini/upload/v1beta/files") {
          return send(200, "", { "x-goog-upload-url": `http://${req.headers.host}/gemini/upload-session/${++g.seq}` });
        }
        if (session) {
          const n = url.pathname.split("/").pop();
          g.uploads.push({ n, bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), headers: req.headers });
          const file = { name: `files/f${n}`, uri: `https://generativelanguage.googleapis.com/v1beta/files/f${n}`, mimeType: req.headers["x-goog-upload-header-content-type"], state: "ACTIVE" };
          return send(200, JSON.stringify({ file }), { "content-type": "application/json" });
        }
        if (url.pathname === "/gemini/v1beta/interactions" && req.method === "POST") {
          const asked = JSON.parse(raw.toString());
          const audio = asked.input?.some((p) => p.type === "audio");
          const out = { kind: "thought", title: "A note", project: null, target: null, work_type: "note", confidence: 0.6, ...(g.answer ?? {}), ...(audio ? { transcript: g.transcript } : {}) };
          const answer = { id: `int-${g.seq}`, status: "completed", steps: [{ type: "user_input" }, { type: "model_output", content: [{ type: "text", text: JSON.stringify(out) }] }] };
          return send(200, JSON.stringify(answer), { "content-type": "application/json" });
        }
        if (req.method === "DELETE") return send(200, "{}");
        send(404, "{}");
      });
      return;
    }
    if (url.pathname.startsWith("/upload/") || url.pathname.startsWith("/upload-session/") || url.pathname.startsWith("/v1beta/")) return gemini(req, res, url, send);

    state.hits.push({
      path: url.pathname,
      if_none_match: req.headers["if-none-match"] ?? null,
      if_modified_since: req.headers["if-modified-since"] ?? null,
      ts: Date.now(),
    });

    if (url.pathname === "/feed.xml") {
      const etag = `W/"v${state.version}"`;
      const lastModified = state.modifiedAt.toUTCString();
      const inm = req.headers["if-none-match"];
      const ims = req.headers["if-modified-since"];
      const fresh = inm ? inm === etag : ims ? new Date(ims) >= new Date(lastModified) : false;
      if (fresh) return send(304, undefined, { etag, "last-modified": lastModified });
      return send(200, atom(), { "content-type": "application/atom+xml", etag, "last-modified": lastModified });
    }
    if (url.pathname === "/gone.xml") return send(404, "not found");
    if (url.pathname === "/jobs.json") {
      // Greenhouse bodies change on every response (meta, timestamps) even when
      // the job set does not; the watcher must not treat that as a change.
      const body = { jobs: state.jobs.map((j) => ({ ...j, absolute_url: `http://fixture.local/jobs/${j.id}` })), meta: { total: state.jobs.length, served_at: Date.now() } };
      return send(200, JSON.stringify(body), { "content-type": "application/json" });
    }
    if (url.pathname === "/page.html") {
      const nonce = Math.random().toString(36).slice(2);
      const html = `<!doctype html><html><head><script nonce="${nonce}">window.__BUILD="${nonce}"</script><style>.c-${nonce}{}</style></head>` +
        `<body><main><h1>Careers</h1><p>${state.pageText}</p></main></body></html>`;
      return send(200, html, { "content-type": "text/html" });
    }
    send(404, "not found");
  });

  // GitHub's REST shapes for the calls src/executor.ts makes. Anything else
  // (a PATCH to a ref, say) is recorded and answered 404.
  function github(req, url, send) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const g = state.github;
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const m = url.pathname.match(/^\/github\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
      const path = decodeURIComponent(m?.[2] ?? "");
      g.requests.push({ ts: Date.now(), method: req.method, repo: m?.[1], path, auth: req.headers.authorization, body });
      const out = (status, data) => send(status, JSON.stringify(data), { "content-type": "application/json" });
      const injected = Object.entries(g.fail).find(([k, v]) => v && `${req.method} ${path}`.startsWith(k));
      if (injected) return out(injected[1], { message: "injected failure" });
      const repo = m && g.repos[m[1]];
      if (!repo) return out(404, { message: "Not Found" });
      if (req.method === "GET" && path === "") return out(200, { full_name: m[1], default_branch: repo.default_branch });
      let r;
      if (req.method === "GET" && (r = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
        const sha = repo.refs[r[1]];
        return sha ? out(200, { ref: `refs/heads/${r[1]}`, object: { sha, type: "commit" } }) : out(404, { message: "Not Found" });
      }
      if (req.method === "GET" && (r = path.match(/^\/git\/commits\/([0-9a-f]{40})$/))) return out(200, { sha: r[1], tree: { sha: fakeSha(`tree-of-${r[1]}`) } });
      if (req.method === "POST" && ["/git/blobs", "/git/trees", "/git/commits"].includes(path)) return out(201, { sha: fakeSha(`${path}-${++g.seq}`) });
      if (req.method === "POST" && path === "/git/refs") {
        const name = body.ref.replace(/^refs\/heads\//, "");
        if (repo.refs[name]) return out(422, { message: "Reference already exists" });
        repo.refs[name] = body.sha;
        return out(201, { ref: body.ref, object: { sha: body.sha, type: "commit" } });
      }
      if (req.method === "POST" && path === "/pulls") {
        if (!repo.refs[body.head]) return out(422, { message: "Validation Failed: head does not exist" });
        // g.race[branch]: someone pushes to the branch just before the PR opens.
        if (g.race[body.head]) repo.refs[body.head] = g.race[body.head];
        const n = ++repo.pulls;
        return out(201, { number: n, draft: body.draft, html_url: `https://github.com/${m[1]}/pull/${n}`, head: { ref: body.head, sha: repo.refs[body.head] } });
      }
      if (req.method === "PATCH" && /^\/pulls\/\d+$/.test(path)) return out(200, { state: body.state });
      out(404, { message: "Not Found" });
    });
  }

  function gemini(req, res, url, send) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const h = req.headers;
      const call = { method: req.method, path: url.pathname, key: h["x-goog-api-key"] ?? null };
      state.kgemini.calls.push(call);
      const origin = `http://${h.host}`;
      const reply = (status, body, headers = {}) => send(status, JSON.stringify(body), { "content-type": "application/json", ...headers });
      if (req.method === "POST" && url.pathname === "/upload/v1beta/files") {
        const id = `fx${state.kgemini.nextFile++}`;
        Object.assign(call, {
          op: "start",
          protocol: h["x-goog-upload-protocol"],
          command: h["x-goog-upload-command"],
          declared_length: h["x-goog-upload-header-content-length"],
          declared_type: h["x-goog-upload-header-content-type"],
          body: JSON.parse(raw.toString() || "null"),
        });
        return reply(200, {}, { "x-goog-upload-url": `${origin}/upload-session/${id}` });
      }
      const session = url.pathname.match(/^\/upload-session\/(\w+)$/);
      if (req.method === "POST" && session) {
        Object.assign(call, {
          op: "upload",
          command: h["x-goog-upload-command"],
          offset: h["x-goog-upload-offset"],
          content_length: h["content-length"] ?? null,
          chunked: h["transfer-encoding"] === "chunked",
          bytes: raw.length,
          sha256: createHash("sha256").update(raw).digest("hex"),
        });
        return reply(200, { file: { name: `files/${session[1]}`, uri: `${origin}/v1beta/files/${session[1]}`, state: "PROCESSING" } });
      }
      const file = url.pathname.match(/^\/v1beta\/files\/(\w+)$/);
      if (file && req.method === "GET") {
        call.op = "status";
        return reply(200, { name: `files/${file[1]}`, uri: `${origin}/v1beta/files/${file[1]}`, state: "ACTIVE" });
      }
      if (file && req.method === "DELETE") {
        call.op = "delete";
        return reply(200, {});
      }
      const gen = url.pathname.match(/^\/v1beta\/models\/([^/:]+):generateContent$/);
      if (req.method === "POST" && gen) {
        const body = JSON.parse(raw.toString());
        const parts = body.contents[0].parts.map((p) =>
          p.inline_data
            ? { inline: p.inline_data.mime_type, sha256: createHash("sha256").update(Buffer.from(p.inline_data.data, "base64")).digest("hex") }
            : p.file_data
              ? { file: p.file_data.file_uri, mime: p.file_data.mime_type }
              : { text: p.text },
        );
        Object.assign(call, { op: "generate", model: gen[1], parts, generationConfig: body.generationConfig });
        // Two text parts, so the adapter has to concatenate them.
        return reply(200, {
          candidates: [{ content: { role: "model", parts: [{ text: '{"read":' }, { text: `"fixture","parts":${parts.length}}` }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
        });
      }
      reply(404, { error: { status: "NOT_FOUND" } });
    });
  }

  return { server, state };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8799);
  createFixture().server.listen(port, "127.0.0.1", () => console.log(`fixture listening on http://127.0.0.1:${port}`));
}
