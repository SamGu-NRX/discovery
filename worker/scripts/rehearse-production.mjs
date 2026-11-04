// Runs the production watcher list against the real sources in local
// wrangler dev. Rule matches become watcher_event candidates; the fixture's
// webhook log should stay empty, because watchers no longer POST anywhere.
// It is the same check as step 5 of a deploy, minus Cloudflare.
//
// About two requests per source (the seed and one recheck), three for YouTube
// while its feed 404s.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, startStack } from "./harness.mjs";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, "evidence", `rehearsal-${stamp}`);
mkdirSync(outDir, { recursive: true });
const s = await startStack({ port: 8787, fixturePort: 8799, inspectorPort: 9229, logFile: join(outDir, "wrangler.log") });
const tokenFile = join(ROOT, ".wrangler", "rehearsal-token");
writeFileSync(tokenFile, s.vars.ADMIN_TOKEN, { mode: 0o600 });
const run = (script, ...args) => execFileSync("node", [join(ROOT, "scripts", script), s.base, tokenFile, ...args], { encoding: "utf8" });
const webhookLog = async () => (await s.control("webhooks")).map((p) => ({ status: p.status, ...p.body }));
const candidates = async () => (await s.call("GET", "/candidates?kind=watcher_event")).candidates.map((c) => `${c.ref} ${c.title}`);

try {
  const out = {};
  out.register = run("register-watchers.mjs");
  for (const id of ["greenhouse-anthropic", "gh-claude-code", "hn-anthropic", "page-anthropic-news", "yt-theo"]) await s.waitForFetches(id, 1, 60_000);
  out.candidates_after_seed = await candidates();
  out.webhooks_after_seed = await webhookLog();
  out.cron_status = (await fetch(`${s.base}/__scheduled?cron=${encodeURIComponent("*/15 * * * *")}`)).status;
  out.verify_recheck = run("verify-production.mjs", "--recheck");
  out.candidates_after_recheck = await candidates();
  out.webhooks_after_recheck = await webhookLog();
  writeFileSync(join(outDir, "results.json"), JSON.stringify(out, null, 2));
  console.log(out.register);
  console.log("candidates after seed:", JSON.stringify(out.candidates_after_seed, null, 1));
  console.log(out.verify_recheck);
  console.log(`candidates after recheck: ${out.candidates_after_recheck.length}; webhook POSTs: ${out.webhooks_after_recheck.length}`);
} finally {
  rmSync(tokenFile, { force: true });
  await s.stop();
}
