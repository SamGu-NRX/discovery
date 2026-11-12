// Identifies which bearer token a request carries. Which routes each token
// may call is declared next to the routes themselves (src/index.ts), so a new
// route cannot be reachable by a token nobody granted it to.

import { sha256Hex } from "./adapters";
import type { Env } from "./check";
import { HttpError } from "./http";

export type Scope = "admin" | "ingest" | "runner" | "inbox" | "bridge" | "device" | "agent:dot" | "agent:t3" | "agent:grok";

// A device token names one enrolled device; every other scope is one secret.
export interface Caller {
  scope: Scope;
  deviceId?: string;
}

const encoder = new TextEncoder();

// Compares SHA-256 digests in constant time, so neither the content nor the
// length of a configured token leaks through response timing.
export async function sameSecret(given: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function callerScope(req: Request, env: Env): Promise<Caller> {
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer (\S+)$/);
  if (!m) throw new HttpError(401, "missing bearer token");
  const scopes: [Scope, string | undefined][] = [
    ["admin", env.ADMIN_TOKEN],
    ["ingest", env.INGEST_TOKEN],
    ["runner", env.RUNNER_TOKEN],
    ["inbox", env.INBOX_TOKEN],
    ["bridge", env.BRIDGE_TOKEN],
    ["agent:dot", env.MAIL_DOT_TOKEN],
    ["agent:t3", env.MAIL_T3_TOKEN],
    ["agent:grok", env.MAIL_GROK_TOKEN],
  ];
  for (const [scope, secret] of scopes) {
    if (secret && (await sameSecret(m[1], secret))) return { scope };
  }
  // Device tokens live in D1 as SHA-256 hashes, looked up by hash, so the
  // lookup reveals nothing about a token that is not enrolled. Only the
  // shape devices are issued is looked up.
  if (/^[0-9a-f]{64}$/.test(m[1])) {
    const d = await env.DB.prepare("SELECT id FROM devices WHERE device_token_hash = ? AND revoked_at IS NULL")
      .bind(await sha256Hex(m[1]))
      .first<{ id: string }>();
    if (d) return { scope: "device", deviceId: d.id };
  }
  throw new HttpError(401, "bad bearer token");
}
