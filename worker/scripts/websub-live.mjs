// Live WebSub check against the public Google hub for Theo's channel.
//
// Exposure: a cloudflared quick tunnel points at a gate on 127.0.0.1:8798
// that forwards only GET/POST /websub/yt-theo to wrangler dev and answers 404
// to everything else, so the admin and jobs routes are never reachable from
// the internet. The script subscribes, waits for the hub's verification
// callback, reads the hub's subscription-details page, optionally waits for a
// delivery, then unsubscribes and stops the tunnel in a finally block.
//
// Usage: node scripts/websub-live.mjs [wait_for_delivery_s]   (default 0)

import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, startStack } from "./harness.mjs";
// Must match HUB in src/websub.ts.
const HUB = "https://pubsubhubbub.appspot.com/";

const WATCHER = "yt-theo";
const TOPIC_FEED = "https://www.youtube.com/feeds/videos.xml?channel_id=UCbRP3c757lWg9M-U7TyEkXA";
const waitDeliveryS = Number(process.argv[2] ?? 0);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, "evidence", `websub-${stamp}`);
mkdirSync(outDir, { recursive: true });
const record = { steps: [] };
const step = (name, data = {}) => {
  const row = { ts: new Date().toISOString(), name, ...data };
  record.steps.push(row);
  console.log(`[websub-live] ${row.ts} ${name} ${JSON.stringify(data)}`);
  writeFileSync(join(outDir, "results.json"), JSON.stringify(record, null, 2));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await startStack({ port: 8787, fixturePort: 8799, inspectorPort: 9229, logFile: join(outDir, "wrangler.log"), persistTo: join(ROOT, ".wrangler", "websub-state", stamp) });
await s.call("POST", "/admin/watchers", { id: WATCHER, kind: "atom", url: TOPIC_FEED, interval_s: 900, first_check_in_s: 86400 });

const gateLog = [];
const gate = createServer((req, res) => {
  const path = new URL(req.url, "http://gate").pathname;
  const allowed = path === `/websub/${WATCHER}` && (req.method === "GET" || req.method === "POST");
  gateLog.push({ ts: new Date().toISOString(), method: req.method, path, forwarded: allowed });
  if (!allowed) {
    res.writeHead(404).end("not found");
    return;
  }
  const headers = { ...req.headers, host: "127.0.0.1:8787" };
  const up = request({ host: "127.0.0.1", port: 8787, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", () => res.writeHead(502).end());
  req.pipe(up);
});
await new Promise((r) => gate.listen(8798, "127.0.0.1", r));

const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8798"], { stdio: ["ignore", "pipe", "pipe"] });
let publicUrl = null;
const tunnelLines = [];
const onTunnel = (c) => {
  for (const line of c.toString().split("\n").filter(Boolean)) {
    tunnelLines.push(line);
    publicUrl ??= line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
  }
};
tunnel.stdout.on("data", onTunnel);
tunnel.stderr.on("data", onTunnel);

let subscribed = false;
try {
  for (let i = 0; i < 60 && !publicUrl; i++) await sleep(500);
  if (!publicUrl) throw new Error("cloudflared printed no trycloudflare URL in 30s");
  step("tunnel_started", { public_url: publicUrl });

  // Quick-tunnel DNS can take a few seconds to resolve.
  let probe = null;
  for (let i = 0; i < 30; i++) {
    try {
      probe = await fetch(`${publicUrl}/admin/stats`);
      break;
    } catch {
      await sleep(2000);
    }
  }
  step("exposure_probe_admin_route", { status: probe?.status ?? "unreachable" });

  const callback = `${publicUrl}/websub/${WATCHER}`;
  const sub = await s.call("POST", `/admin/watchers/${WATCHER}/websub`, { callback, mode: "subscribe" });
  step("subscribe_requested", { hub: HUB, hub_status: sub.hub_status, hub_body: sub.hub_body, topic: sub.topic });
  subscribed = sub.hub_status === 202 || sub.hub_status === 204;

  let state = null;
  for (let i = 0; i < 60; i++) {
    state = (await s.call("GET", "/admin/websub")).find((r) => r.watcher_id === WATCHER)?.state;
    if (state === "subscribed") break;
    await sleep(1000);
  }
  step("subscription_state_after_verify", { state });

  const details = await fetch(`${HUB}subscription-details?` + new URLSearchParams({ "hub.callback": callback, "hub.topic": sub.topic }));
  const text = (await details.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  step("hub_subscription_details", { status: details.status, text: text.slice(0, 1200) });

  if (waitDeliveryS > 0) {
    step("waiting_for_delivery", { seconds: waitDeliveryS });
    const end = Date.now() + waitDeliveryS * 1000;
    while (Date.now() < end) {
      const d = await s.call("GET", `/admin/watchers/${WATCHER}`);
      if (d.fetch_log.some((f) => f.via === "push")) {
        step("delivery_received", { fetch_log: d.fetch_log.filter((f) => f.via === "push"), events: d.events });
        break;
      }
      await sleep(5000);
    }
  }
} catch (e) {
  step("error", { message: e.message });
} finally {
  if (subscribed && publicUrl) {
    const callback = `${publicUrl}/websub/${WATCHER}`;
    const unsub = await s.call("POST", `/admin/watchers/${WATCHER}/websub`, { callback, mode: "unsubscribe" });
    step("unsubscribe_requested", { hub_status: unsub.hub_status, hub_body: unsub.hub_body });
    let state = null;
    for (let i = 0; i < 60; i++) {
      state = (await s.call("GET", "/admin/websub")).find((r) => r.watcher_id === WATCHER)?.state;
      if (state === "unsubscribed") break;
      await sleep(1000);
    }
    step("subscription_state_after_unsubscribe", { state });
  }
  tunnel.kill("SIGTERM");
  await new Promise((r) => (tunnel.exitCode !== null ? r() : tunnel.once("exit", r)));
  step("tunnel_stopped", { exit_code: tunnel.exitCode, signal: tunnel.signalCode });
  await new Promise((r) => gate.close(r));
  record.gate_log = gateLog;
  record.tunnel_log_tail = tunnelLines.slice(-15);
  writeFileSync(join(outDir, "results.json"), JSON.stringify(record, null, 2));
  await s.stop();
}
