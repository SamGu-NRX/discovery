// Starts the fixture server and a real `wrangler dev` (workerd, local D1,
// local Durable Objects) on a fresh state directory. Used by the tests and by
// the evidence run so both exercise the same Worker the README tells you to run.

import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "../fixtures/server.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");
const ENV = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };

const LOCAL_SECRETS = ["ADMIN_TOKEN", "WEBSUB_SECRET", "INGEST_TOKEN", "RUNNER_TOKEN", "INBOX_TOKEN"];

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
export async function startStack({ port, fixturePort, inspectorPort, logFile, persistTo, webhook = true }) {
  const vars = devVars();
  // Without persistTo (the tests), state goes in a throwaway directory under
  // .wrangler/ that stop() removes.
  const scratchRoot = join(ROOT, ".wrangler", "test-state");
  mkdirSync(scratchRoot, { recursive: true });
  const stateDir = persistTo ?? mkdtempSync(join(scratchRoot, "run-"));

  const { server, state } = createFixture();
  await new Promise((r) => server.listen(fixturePort, "127.0.0.1", r));

  execFileSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir], { cwd: ROOT, env: ENV, stdio: "pipe" });

  const proc = spawn(
    WRANGLER,
    ["dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspectorPort), "--persist-to", stateDir, "--test-scheduled", "--show-interactive-dev-session=false",
      ...(webhook === false ? [] : ["--var", `T3_APPROVALS_WEBHOOK_URL:http://127.0.0.1:${fixturePort}/t3-webhook`])],
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

  // token: "admin" (default), "ingest", "runner", "inbox", or "none".
  async function call(method, path, body, { raw = false, token = "admin" } = {}) {
    const headers = { "content-type": "application/json" };
    if (token !== "none") headers.authorization = `Bearer ${vars[`${token.toUpperCase()}_TOKEN`]}`;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
    const out = execFileSync(WRANGLER, ["d1", "execute", "DB", "--local", "--persist-to", stateDir, "--json", "--command", sql], { cwd: ROOT, env: ENV, stdio: "pipe" });
    return JSON.parse(out.toString())[0].results;
  }

  async function stop() {
    proc.kill("SIGTERM");
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r)));
    await new Promise((r) => server.close(r));
    log?.end();
    if (!persistTo) rmSync(stateDir, { recursive: true, force: true });
  }

  return { base, call, control, waitForFetches, d1, stop, lines, fixtureState: state, fixtureBase: `http://127.0.0.1:${fixturePort}`, vars, stateDir };
}
