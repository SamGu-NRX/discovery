// Content-addressed blobs: R2 object sha256/<hex> plus a blobs row, written
// only once R2 itself has checked the hash. The Worker never hashes the
// bytes (Workers Free allows 10 ms of CPU).

import type { Env } from "../check";
import { json } from "../http";
import { blobKey, hex64, KError, list, mimeType, toHex } from "./common";

const MAX_PUT_BYTES = 95 * 1024 * 1024;

export interface BlobRow {
  sha256: string;
  size: number;
  mime: string;
  r2_key: string;
  cold_ref: string | null;
  created_at: number;
}

const present = (row: BlobRow, created: boolean) => ({ sha256: row.sha256, size: row.size, mime: row.mime, r2_key: row.r2_key, created });

export const blobRow = (env: Env, sha: string) => env.DB.prepare("SELECT * FROM blobs WHERE sha256 = ?").bind(sha).first<BlobRow>();

async function insertRow(env: Env, sha: string, size: number, mime: string): Promise<BlobRow> {
  const inserted = await env.DB.prepare(
    `INSERT INTO blobs (sha256, size, mime, r2_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (sha256) DO NOTHING RETURNING *`,
  )
    .bind(sha, size, mime, blobKey(sha), Date.now())
    .first<BlobRow>();
  // A concurrent writer of the same bytes inserted first; its row is as good.
  return inserted ?? (await blobRow(env, sha))!;
}

// R2's error for a sha256 option that doesn't match the received bytes.
// Workers documents the option but not the error, so this matches both the
// production wording ("did not match", BadDigest) and miniflare's.
const isDigestMismatch = (e: unknown) => e instanceof Error && /sha-?256|checksum|digest|did not match/i.test(e.message);

// Stores bytes the caller already hashed. Used for small outputs the Worker
// produced itself (model output), never for request bodies.
export async function storeBytes(env: Env, sha: string, bytes: Uint8Array, mime: string): Promise<BlobRow> {
  const existing = await blobRow(env, sha);
  if (existing) return existing;
  await env.KNOWLEDGE.put(blobKey(sha), bytes, { sha256: sha, httpMetadata: { contentType: mime } });
  return insertRow(env, sha, bytes.byteLength, mime);
}

export async function putBlob(env: Env, req: Request, sha: string): Promise<Response> {
  hex64(sha, "the path's sha256");
  const mime = mimeType(req.headers.get("content-type") ?? undefined, "Content-Type");
  const declared = req.headers.get("content-length");
  // R2 refuses a stream of unknown length, and a declared length lets an
  // oversized body be refused before any of it is read.
  if (declared === null || !/^\d+$/.test(declared)) throw new KError(411, "length_required", "Content-Length must be set to the body's size in bytes");
  if (Number(declared) > MAX_PUT_BYTES) throw new KError(413, "too_large", `Content-Length must be at most ${MAX_PUT_BYTES} bytes (95 MiB)`);

  const existing = await blobRow(env, sha);
  if (existing) return json(present(existing, false), 200);

  let stored: R2Object;
  try {
    stored = await env.KNOWLEDGE.put(blobKey(sha), req.body ?? new Uint8Array(), { sha256: sha, httpMetadata: { contentType: mime } });
  } catch (e) {
    if (isDigestMismatch(e)) throw new KError(422, "hash_mismatch", `the body's SHA-256 is not ${sha}; nothing was stored`);
    throw e;
  }
  return json(present(await insertRow(env, sha, stored.size, mime), true), 201);
}

// After kworker's S3 upload with x-amz-checksum-sha256: R2 recorded and
// checked that checksum, so its metadata is the proof the bytes match.
export async function commitBlob(env: Env, b: Record<string, unknown>): Promise<Response> {
  const sha = hex64(b.sha256, "sha256");
  const mime = mimeType(b.mime, "mime");
  const existing = await blobRow(env, sha);
  if (existing) return json(present(existing, false), 200);
  const head = await env.KNOWLEDGE.head(blobKey(sha));
  if (!head) throw new KError(404, "object_missing", `sha256 names no object: R2 has nothing at ${blobKey(sha)}`);
  const recorded = head.checksums.sha256;
  if (!recorded) throw new KError(409, "checksum_missing", `sha256: R2 recorded no SHA-256 checksum for ${blobKey(sha)}; upload it with x-amz-checksum-sha256`);
  if (toHex(recorded) !== sha) throw new KError(422, "hash_mismatch", `sha256: R2 recorded checksum ${toHex(recorded)} for ${blobKey(sha)}`);
  return json(present(await insertRow(env, sha, head.size, mime), true), 201);
}

export async function hasBlobs(env: Env, b: Record<string, unknown>) {
  const shas = list(b.sha256s, "sha256s", 100).map((s, i) => hex64(s, `sha256s[${i}]`));
  const rows = await env.DB.prepare("SELECT sha256 FROM blobs WHERE sha256 IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(shas)).all<{ sha256: string }>();
  const present = new Set(rows.results.map((r) => r.sha256));
  return { present: shas.filter((s) => present.has(s)) };
}

// bytes=a-b, bytes=a- or bytes=-n, resolved against size. One range only.
export function parseRange(header: string, size: number): { offset: number; length: number } {
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) throw new KError(416, "range_not_satisfiable", "Range must be one bytes=a-b, bytes=a- or bytes=-n range");
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) throw new KError(416, "range_not_satisfiable", `Range ${header} is outside the blob's ${size} bytes`);
  return { offset: start, length: end - start + 1 };
}

export async function getBlob(env: Env, req: Request, sha: string): Promise<Response> {
  hex64(sha, "the path's sha256");
  const row = await blobRow(env, sha);
  if (!row) throw new KError(404, "blob_missing", `sha256 ${sha} names no blob`);
  const rangeHeader = req.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader, row.size) : null;
  const obj = await env.KNOWLEDGE.get(row.r2_key, range ? { range } : undefined);
  if (!obj) throw new KError(404, "object_missing", `the blob row for ${sha} has no R2 object`);
  const headers = new Headers({ "content-type": row.mime, "accept-ranges": "bytes", etag: `"${sha}"` });
  if (!range) return new Response(obj.body, { status: 200, headers });
  headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`);
  return new Response(obj.body, { status: 206, headers });
}

// The listed shas that name no blob, for refusing rows that point at them.
export async function missingBlobs(env: Env, shas: string[]): Promise<Set<string>> {
  if (!shas.length) return new Set();
  const rows = await env.DB.prepare("SELECT value FROM json_each(?1) WHERE value NOT IN (SELECT sha256 FROM blobs)").bind(JSON.stringify([...new Set(shas)])).all<{ value: string }>();
  return new Set(rows.results.map((r) => r.value));
}

export function requireBlobs(missing: Set<string>, fields: [string, string | null][]) {
  for (const [field, sha] of fields) if (sha && missing.has(sha)) throw new KError(422, "blob_missing", `${field} names no blob: ${sha} has not been uploaded`);
}
