// Device enrollment (docs/APPROVALS.md, "Enrollment"). An enrolled iPhone
// holds a Secure Enclave P-256 key; the Worker keeps its public key, its push
// token and the SHA-256 of a low-risk bearer token.

import { sha256Hex } from "./adapters";
import type { Env } from "./check";
import { fail, HttpError, oneOf, randomHex, readJson } from "./http";
import { importDeviceKey } from "./p256";
import { backfillApprovalRequests } from "./approvals";

const CODE_TTL_MS = 10 * 60_000;
// Crockford base32 without I, L, O and U, so a typed code can't be misread.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 12;
const APNS_ENVS = ["development", "production"] as const;

// Unknown fields are refused, so a typo can't silently drop a value.
export function onlyFields(b: Record<string, unknown>, allowed: readonly string[], where = "body") {
  for (const k of Object.keys(b)) if (!allowed.includes(k)) fail(`${where}.${k} is not a field this route takes (allowed: ${allowed.join(", ")})`);
}

// Spaces and dashes are for reading; case doesn't matter.
const normalizeCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, "");

export async function mintEnrollCode(env: Env) {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_CHARS));
  // 256 is a multiple of 32, so the modulo adds no bias. 60 bits.
  const code = [...bytes].map((b) => CODE_ALPHABET[b % 32]).join("");
  const now = Date.now();
  await env.DB.prepare("INSERT INTO device_enroll_codes (code_hash, created_at, expires_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256Hex(code), now, now + CODE_TTL_MS)
    .run();
  const shown = code.match(/.{4}/g)!.join("-");
  return { code: shown, expires_at: new Date(now + CODE_TTL_MS).toISOString() };
}

function apnsToken(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^[0-9a-fA-F]{64,200}$/.test(v)) fail(`${field} must be the device token as hex (64 to 200 hex digits)`);
  return v.toLowerCase();
}

export async function enroll(env: Env, req: Request) {
  const b = await readJson<Record<string, unknown>>(req, 8 * 1024);
  onlyFields(b, ["code", "name", "public_key_spki_b64", "apns_token", "apns_env"]);
  if (typeof b.code !== "string" || !b.code) fail("code must be the enrollment code as a string");
  const code = normalizeCode(b.code);
  if (typeof b.name !== "string" || b.name.trim().length === 0 || b.name.length > 64) fail("name must be a non-empty string of at most 64 characters");
  if (typeof b.public_key_spki_b64 !== "string") fail("public_key_spki_b64 must be a base64 string");
  if (!(await importDeviceKey(b.public_key_spki_b64))) {
    fail("public_key_spki_b64 must be the base64 DER SubjectPublicKeyInfo of an uncompressed P-256 public key (91 bytes)");
  }
  const token = apnsToken(b.apns_token, "apns_token");
  const apnsEnv = oneOf(b.apns_env, APNS_ENVS, "apns_env");

  const id = "d_" + randomHex(8);
  const deviceToken = randomHex(32);
  const now = Date.now();
  // One transaction: the code is spent and the device written together, or
  // neither. A spent, expired or unknown code changes nothing.
  const [used] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE device_enroll_codes SET used_at = ?2, device_id = ?3
       WHERE code_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING code_hash`,
    ).bind(await sha256Hex(code), now, id),
    env.DB.prepare(
      `INSERT INTO devices (id, name, public_key_spki_b64, apns_token, apns_env, device_token_hash, enrolled_at, apns_token_updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7
       WHERE EXISTS (SELECT 1 FROM device_enroll_codes WHERE device_id = ?1 AND used_at = ?7)`,
    ).bind(id, b.name, b.public_key_spki_b64, token, apnsEnv, await sha256Hex(deviceToken), now),
  ]);
  if (used.results.length === 0) throw new HttpError(403, "code is not a valid enrollment code: unknown, already used, or older than 10 minutes");
  console.log(`[devices] enrolled ${id} (${apnsEnv})`);
  // Proposals already waiting get a request now, because their bearer links
  // stop working once a device exists.
  await backfillApprovalRequests(env, now);
  return { device_id: id, device_token: deviceToken };
}

export async function updateApnsToken(env: Env, callerDevice: string | undefined, id: string, req: Request) {
  if (callerDevice !== id) throw new HttpError(403, `this device token belongs to another device than ${id}`);
  const b = await readJson<Record<string, unknown>>(req, 4096);
  onlyFields(b, ["apns_token", "apns_env"]);
  const token = apnsToken(b.apns_token, "apns_token");
  const apnsEnv = b.apns_env === undefined ? null : oneOf(b.apns_env, APNS_ENVS, "apns_env");
  const row = await env.DB.prepare(
    `UPDATE devices SET apns_token = ?2, apns_env = coalesce(?3, apns_env), apns_token_updated_at = ?4, apns_invalid_at = NULL, apns_invalid_reason = NULL
     WHERE id = ?1 AND revoked_at IS NULL RETURNING id, apns_env`,
  )
    .bind(id, token, apnsEnv, Date.now())
    .first<{ id: string; apns_env: string }>();
  if (!row) throw new HttpError(404, `device ${id} is not enrolled`);
  return { device_id: row.id, apns_env: row.apns_env };
}

export async function revoke(env: Env, id: string) {
  const row = await env.DB.prepare("UPDATE devices SET revoked_at = coalesce(revoked_at, ?2) WHERE id = ?1 RETURNING id, revoked_at")
    .bind(id, Date.now())
    .first<{ id: string; revoked_at: number }>();
  if (!row) throw new HttpError(404, `device ${id} not found`);
  console.log(`[devices] revoked ${id}`);
  return { device_id: row.id, revoked_at: new Date(row.revoked_at).toISOString() };
}

export async function listDevices(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT id, name, apns_env, enrolled_at, revoked_at, apns_token_updated_at, apns_invalid_at, apns_invalid_reason FROM devices ORDER BY enrolled_at`,
  ).all();
  return { devices: rows.results };
}
