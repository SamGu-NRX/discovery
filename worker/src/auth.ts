// Identifies which bearer token a request carries. Which routes each token
// may call is declared next to the routes themselves (src/index.ts), so a new
// route cannot be reachable by a token nobody granted it to.

import type { Env } from "./check";
import { HttpError } from "./http";

export type Scope = "admin" | "ingest" | "runner" | "inbox";

const encoder = new TextEncoder();

// Compares SHA-256 digests in constant time, so neither the content nor the
// length of a configured token leaks through response timing.
async function sameSecret(given: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function callerScope(req: Request, env: Env): Promise<Scope> {
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer (\S+)$/);
  if (!m) throw new HttpError(401, "missing bearer token");
  const scopes: [Scope, string | undefined][] = [
    ["admin", env.ADMIN_TOKEN],
    ["ingest", env.INGEST_TOKEN],
    ["runner", env.RUNNER_TOKEN],
    ["inbox", env.INBOX_TOKEN],
  ];
  for (const [scope, secret] of scopes) {
    if (secret && (await sameSecret(m[1], secret))) return scope;
  }
  throw new HttpError(401, "bad bearer token");
}
