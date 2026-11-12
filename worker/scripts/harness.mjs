// Starts the fixture server and a real `wrangler dev` (workerd, local D1,
// local Durable Objects) on a fresh state directory. Used by the tests and by
// the evidence run so both exercise the same Worker the README tells you to run.

import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createFixture } from "../fixtures/server.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Run wrangler's JS entry with this node, so the harness works where
// node_modules/.bin/wrangler is a shell script node can't spawn (Windows).
const WRANGLER_JS = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const wrangler = (args) => [process.execPath, [WRANGLER_JS, ...args]];
const ENV = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };

const LOCAL_SECRETS = [
  "ADMIN_TOKEN", "WEBSUB_SECRET", "INGEST_TOKEN", "RUNNER_TOKEN", "INBOX_TOKEN",
  "MAIL_DOT_TOKEN", "MAIL_T3_TOKEN", "MAIL_GROK_TOKEN", "MAIL_ROOM_TOKEN", "MAIL_T3_WAKE_SECRET", "MAIL_GROK_WAKE_KEY",
  "BRIDGE_TOKEN", "GITHUB_PR_TOKEN", "GEMINI_API_KEY",
];

// Runs `wrangler d1 <args>`. When several suites run at once on Windows,
// wrangler's local runtime sometimes fails to start ("bad port", or
// "Directory named cache:storage not found" in its temp directory; seen on the
// Zephyrus, 2026-11-12). Nothing ran then, so it is tried again.
function wranglerD1(args) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(...wrangler(["d1", ...args]), { cwd: ROOT, env: ENV, stdio: "pipe" });
    } catch (e) {
      const out = `${e.stdout ?? ""} ${e.stderr ?? ""}`;
      if (attempt < 3 && /bad port|failed to start/.test(out)) continue;
      throw new Error(`wrangler d1 ${args.slice(0, 2).join(" ")} failed: ${out.slice(0, 1000)}`);
    }
  }
}

// fetch, but on a new connection each time. wrangler dev closes idle
// keep-alive sockets after 5 s, and fetch's pool sometimes reuses one just as
// it closes ("fetch failed"); on Windows, where each d1() call takes about 2 s,
// that happens often enough to fail a run.
export function freshFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined && body !== null) h["content-length"] = String(Buffer.byteLength(body));
    const r = request(url, { method, headers: h, agent: false, signal }, (res) => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) out.set(k, Array.isArray(v) ? v.join(", ") : v);
      const empty = res.statusCode === 204 || res.statusCode === 304;
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: out }));
    });
    r.on("error", reject);
    r.end(body ?? undefined);
  });
}

// Creates .dev.vars, or adds any secret it lacks, with random local values.
export function devVars() {
  const path = join(ROOT, ".dev.vars");
  const read = () =>
    existsSync(path)
      ? Object.fromEntries(
          readFileSync(path, "utf8")
            .split("\n")
            .filter((l) => l.includes("="))
            .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
        )
      : {};
  const vars = read();
  const missing = LOCAL_SECRETS.filter((k) => !vars[k]);
  if (missing.length) {
    const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
    for (const k of missing) lines.push(`${k}=${randomBytes(24).toString("hex")}`);
    writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  }
  return read();
}

// webhook: false starts the Worker with T3_APPROVALS_WEBHOOK_URL unset.
// vars: more --var values, such as the APNs key a test generated.
export async function startStack({ port, fixturePort, inspectorPort, logFile, persistTo, webhook = true, vars: extraVars = {} }) {
  const vars = devVars();
  // Without persistTo (the tests), state goes in a throwaway directory under
  // .wrangler/ that stop() removes.
  const scratchRoot = join(ROOT, ".wrangler", "test-state");
  mkdirSync(scratchRoot, { recursive: true });
  const stateDir = persistTo ?? mkdtempSync(join(scratchRoot, "run-"));

  const { server, state } = createFixture();
  // Longer than fetch's keep-alive, so the fixture never closes a socket the
  // test is about to reuse (an intermittent "fetch failed" otherwise).
  server.keepAliveTimeout = 65_000;
  await new Promise((r) => server.listen(fixturePort, "127.0.0.1", r));

  wranglerD1(["migrations", "apply", "DB", "--local", "--persist-to", stateDir]);

  const proc = spawn(
    process.execPath,
    [WRANGLER_JS, "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspectorPort), "--persist-to", stateDir, "--test-scheduled", "--show-interactive-dev-session=false",
      ...(webhook === false ? [] : ["--var", `T3_APPROVALS_WEBHOOK_URL:http://127.0.0.1:${fixturePort}/t3-webhook`]),
      // Mailbox wakes for t3 and grok land on the fixture's /hook/<name>.
      "--var", `MAIL_T3_WAKE_URL:http://127.0.0.1:${fixturePort}/hook/t3`,
      "--var", `MAIL_GROK_WAKE_URL:http://127.0.0.1:${fixturePort}/hook/grok`,
      // MCP Events callbacks may go to the fixture (a loopback http origin,
      // which only local dev can reach).
      "--var", `MAIL_CALLBACK_ORIGINS:http://127.0.0.1:${fixturePort}`,
      // APNs, GitHub and Gemini calls land on the fixture's stand-ins.
      "--var", `APNS_ORIGIN:http://127.0.0.1:${fixturePort}/apns`,
      "--var", `GITHUB_API_ORIGIN:http://127.0.0.1:${fixturePort}/github`,
      "--var", `GEMINI_API_ORIGIN:http://127.0.0.1:${fixturePort}/gemini`,
      ...Object.entries(extraVars).flatMap(([k, v]) => ["--var", `${k}:${v}`])],
    { cwd: ROOT, env: ENV, stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines = [];
  const log = logFile ? createWriteStream(logFile, { flags: "a" }) : null;
  const onData = (chunk) => {
    const text = chunk.toString();
    log?.write(text);
    lines.push(...text.split("\n").filter(Boolean));
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);

  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${vars.ADMIN_TOKEN}`, "content-type": "application/json" };

  // token: "admin" (default), "ingest", "runner", "inbox", "mail_dot",
  // "mail_t3", "mail_grok", "bridge", "none", or { bearer } for a token the
  // test holds (a device token).
  async function call(method, path, body, { raw = false, token = "admin" } = {}) {
    const headers = { "content-type": "application/json" };
    if (typeof token === "object") headers.authorization = `Bearer ${token.bearer}`;
    else if (token !== "none") headers.authorization = `Bearer ${vars[`${token.toUpperCase()}_TOKEN`]}`;
    const res = await freshFetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return res;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return data;
  }

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`wrangler dev exited early:\n${lines.join("\n")}`);
    try {
      const res = await fetch(base + "/admin/stats", { headers: auth });
      if (res.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`wrangler dev not ready after 60s:\n${lines.join("\n")}`);
    await new Promise((r) => setTimeout(r, 300));
  }

  async function control(path, body) {
    const res = await fetch(`http://127.0.0.1:${fixturePort}/control/${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
    return res.headers.get("content-type")?.includes("atom") ? res.text() : res.json();
  }

  // Waits until the watcher has at least `n` fetch_log rows, i.e. its alarm fired.
  async function waitForFetches(id, n, timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const d = await call("GET", `/admin/watchers/${id}`);
      if (d.fetch_log.length >= n) return d;
      if (Date.now() > end) throw new Error(`${id}: ${d.fetch_log.length} fetches after ${timeoutMs}ms, wanted ${n}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Runs SQL against the same local D1 the Worker uses, for setting up states
  // that would otherwise need waiting (an overdue watcher).
  function d1(sql) {
    return JSON.parse(wranglerD1(["execute", "DB", "--local", "--persist-to", stateDir, "--json", "--command", sql]).toString())[0].results;
  }

  async function stop() {
    const exited = new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r)));
    // On Windows a signal reaches only node, and the workerd it started would
    // keep the port; taskkill /T ends the tree this harness started.
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill("SIGTERM");
    await exited;
    // A fixture response that never ends (hook-mode "flood") must not hold this up.
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    log?.end();
    if (!persistTo) rmSync(stateDir, { recursive: true, force: true });
  }

  return { base, call, control, waitForFetches, d1, stop, lines, fixtureState: state, fixtureBase: `http://127.0.0.1:${fixturePort}`, vars, stateDir };
}
