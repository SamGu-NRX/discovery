// APNs with token-based auth: an ES256 JWT signed with the .p8 key, sent as
// a bearer to Apple's HTTP/2 API. A deployed Worker's fetch reaches APNs over
// HTTP/2; local workerd can't (cloudflare/workerd#4841), so the tests use the
// fixture through APNS_ORIGIN.

import type { Env } from "./check";
import { es256Jwt, importP8 } from "./p256";

const HOSTS = { development: "api.sandbox.push.apple.com", production: "api.push.apple.com" } as const;

// Apple asks that a provider token be refreshed no more than once every 20
// minutes and no less than once every 60; 429 TooManyProviderTokenUpdates
// otherwise. One token per isolate, reused for 50 minutes. Isolates don't
// share it, and no run shows how often Cloudflare starts a new one.
const JWT_REUSE_MS = 50 * 60_000;
let cached: { jwt: string; at: number; keyId: string } | null = null;

export function apnsConfigured(env: Env): boolean {
  return Boolean(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC);
}

async function providerToken(env: Env): Promise<string> {
  const now = Date.now();
  if (cached && cached.keyId === env.APNS_KEY_ID && now - cached.at < JWT_REUSE_MS) return cached.jwt;
  const key = await importP8(env.APNS_KEY_P8!);
  const jwt = await es256Jwt(key, { alg: "ES256", kid: env.APNS_KEY_ID }, { iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) });
  cached = { jwt, at: now, keyId: env.APNS_KEY_ID! };
  return jwt;
}

export interface PushResult {
  status: number;
  apnsId: string | null;
  reason: string | null;
  // APNs says this device token will never work again.
  deadToken: boolean;
}

export async function push(
  env: Env,
  device: { apns_token: string; apns_env: "development" | "production" },
  payload: unknown,
  opts: { expiresAtMs: number; collapseId: string },
): Promise<PushResult> {
  const host = HOSTS[device.apns_env];
  const url = env.APNS_ORIGIN ? `${env.APNS_ORIGIN}/${host}/3/device/${device.apns_token}` : `https://${host}/3/device/${device.apns_token}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `bearer ${await providerToken(env)}`,
        "apns-topic": env.APNS_TOPIC!,
        "apns-push-type": "alert",
        // 10: deliver now. Time-sensitive alerts need it.
        "apns-priority": "10",
        // Apple drops the notification after this (Unix seconds) if the
        // phone was unreachable until then.
        "apns-expiration": String(Math.floor(opts.expiresAtMs / 1000)),
        "apns-collapse-id": opts.collapseId,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { status: 0, apnsId: null, reason: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e), deadToken: false };
  }
  let reason: string | null = null;
  if (res.status !== 200) {
    try {
      reason = ((await res.json()) as { reason?: string }).reason ?? null;
    } catch {
      reason = null;
    }
  } else {
    await res.body?.cancel();
  }
  // A provider token Apple refused is not reused.
  if (res.status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) cached = null;
  return {
    status: res.status,
    apnsId: res.headers.get("apns-id"),
    reason,
    deadToken: res.status === 410 || (res.status === 400 && reason === "BadDeviceToken"),
  };
}
