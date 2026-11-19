// Registers the watchers in a JSON file against a running Worker. An
// existing watcher id is left as it is.
//
// Usage: node scripts/register-watchers.mjs <base-url> <admin-token-file> [watchers.json]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [base, tokenFile, file = fileURLToPath(new URL("./production-watchers.json", import.meta.url))] = process.argv.slice(2);
if (!base || !tokenFile) throw new Error("usage: register-watchers.mjs <base-url> <admin-token-file> [watchers.json]");
const token = readFileSync(tokenFile, "utf8").trim();

for (const w of JSON.parse(readFileSync(file, "utf8"))) {
  const res = await fetch(`${base}/admin/watchers`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(w),
  });
  console.log(`${w.id}: ${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 200)}`);
  if (res.status !== 201 && res.status !== 409) process.exitCode = 1;
}
