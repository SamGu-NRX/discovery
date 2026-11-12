// Starts the Worker under `wrangler dev` (local D1 and R2) with state kept in
// the given directory, and stays up until killed. acceptance/run.py drives
// kworker against it. Gemini is off: the harness would otherwise point it at
// the fixture stand-in, and acceptance must use real models. Usage: node acceptance/stack.mjs <state dir> [port]

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { startStack } from "../../worker/scripts/harness.mjs";

// Absolute, because wrangler runs in worker/ and would resolve a relative
// path from there.
const stateDir = process.argv[2] && resolve(process.argv[2]);
if (!stateDir) throw new Error("usage: node acceptance/stack.mjs <state dir> [port]");
const port = Number(process.argv[3] ?? 8871);
mkdirSync(stateDir, { recursive: true });
const s = await startStack({ port, fixturePort: port + 1, inspectorPort: port + 500, persistTo: stateDir, logFile: `${stateDir}/wrangler.log`, gemini: false });
console.log(JSON.stringify({ ready: true, base: s.base }));
const stop = async () => {
  await s.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
