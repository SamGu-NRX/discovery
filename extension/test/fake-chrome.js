// The slice of the extension platform that lib/ modules touch outside a
// browser: chrome.storage (local and session) and the window and alarm calls
// recovery and scheduling make. Storage round-trips through structuredClone
// like the real one. Install before importing a module that reads `chrome`.

export function installFakeChrome() {
  const local = new Map();
  const session = new Map();
  const removedWindows = [];
  const area = (store) => ({
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(Object.fromEntries(store));
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const key of list) if (store.has(key)) out[key] = structuredClone(store.get(key));
      return out;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) store.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) store.delete(key);
    },
  });
  globalThis.chrome = {
    storage: { local: area(local), session: area(session) },
    windows: { remove: async (id) => void removedWindows.push(id) },
    alarms: { create: async () => {}, clear: async () => {}, get: async () => null },
    runtime: { getPlatformInfo: async () => ({}) },
  };
  return { local, session, removedWindows };
}

// A Worker stand-in on 127.0.0.1. `answer(record)` returns the HTTP status for
// each request; every request is recorded.
export async function startWorker(answer = () => 200) {
  const { createServer } = await import("node:http");
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const record = { method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null };
      requests.push(record);
      res.writeHead(answer(record), { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
