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
      seq: 0,
    },
    apns: {},
    pushes: [],
    gemini: { transcript: "Remember to ship the hub branch.", status: 200, requests: [], uploads: [], seq: 0 },
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
          case "/control/atom":
            return send(200, atom(), { "content-type": "application/atom+xml" });
          default:
            return send(404, "unknown control");
        }
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
          const answer = { id: `int-${g.seq}`, status: "completed", steps: [{ type: "user_input" }, { type: "model_output", content: [{ type: "text", text: g.transcript }] }] };
          return send(200, JSON.stringify(answer), { "content-type": "application/json" });
        }
        if (req.method === "DELETE") return send(200, "{}");
        send(404, "{}");
      });
      return;
    }

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
        const n = ++repo.pulls;
        return out(201, { number: n, draft: body.draft, html_url: `https://github.com/${m[1]}/pull/${n}` });
      }
      out(404, { message: "Not Found" });
    });
  }

  return { server, state };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8799);
  createFixture().server.listen(port, "127.0.0.1", () => console.log(`fixture listening on http://127.0.0.1:${port}`));
}
