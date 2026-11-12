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
//
// Usage: node fixtures/server.mjs [port]   (default 8799)

import { createServer } from "node:http";

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
        send(status, JSON.stringify({ challenge: mode === "wrong" ? "not-the-challenge" : body.challenge }), { "content-type": "application/json" });
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

  return { server, state };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8799);
  createFixture().server.listen(port, "127.0.0.1", () => console.log(`fixture listening on http://127.0.0.1:${port}`));
}
