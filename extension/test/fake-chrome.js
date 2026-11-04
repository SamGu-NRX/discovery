// The slice of the extension platform that lib/ modules touch outside a
// browser: chrome.storage (local and session) and the window and alarm calls
// recovery and scheduling make. Storage round-trips through structuredClone
// like the real one, and local storage enforces Chrome's 10 MiB QUOTA_BYTES
// the way Chrome counts it (each key plus the JSON of its value), refusing a
// write that would exceed it. Install before importing a module that reads
// `chrome`.

export const LOCAL_QUOTA_BYTES = 10 * 1024 * 1024;

export function installFakeChrome() {
  const local = new Map();
  const session = new Map();
  const removedWindows = [];
  const usage = (store) => [...store].reduce((sum, [key, value]) => sum + key.length + JSON.stringify(value).length, 0);
  const area = (store, quota = Infinity) => ({
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(Object.fromEntries(store));
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const key of list) if (store.has(key)) out[key] = structuredClone(store.get(key));
      return out;
    },
    async set(values) {
      const next = new Map(store);
      for (const [key, value] of Object.entries(values)) next.set(key, structuredClone(value));
      if (usage(next) > quota) throw new Error("QUOTA_BYTES quota exceeded");
      for (const [key, value] of Object.entries(values)) store.set(key, next.get(key));
    },
    async getBytesInUse() {
      return usage(store);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) store.delete(key);
    },
  });
  globalThis.chrome = {
    storage: { local: area(local, LOCAL_QUOTA_BYTES), session: area(session) },
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
