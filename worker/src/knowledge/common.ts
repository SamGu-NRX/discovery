// Errors and field checks shared by the /k/ routes. Every 4xx on /k/ is
// { error: <machine code>, message } (docs/KNOWLEDGE.md, "Routes"); a plain
// HttpError from the shared helpers gets the code for its status.

import { HttpError } from "../http";

export class KError extends HttpError {
  constructor(
    status: number,
    readonly code: string,
    message: string,
  ) {
    super(status, message);
  }
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  411: "length_required",
  413: "too_large",
  416: "range_not_satisfiable",
  422: "unprocessable",
  429: "rate_limited",
};

export const knowledgeErrorBody = (e: HttpError) => ({
  error: e instanceof KError ? e.code : (CODE_BY_STATUS[e.status] ?? "error"),
  message: e.message,
});

export function invalid(message: string): never {
  throw new KError(400, "invalid_request", message);
}

export const HEX64 = /^[0-9a-f]{64}$/;

export function hex64(v: unknown, field: string): string {
  if (typeof v !== "string" || !HEX64.test(v)) invalid(`${field} must be 64 lowercase hex characters`);
  return v;
}

export function optHex64(v: unknown, field: string): string | null {
  return v === undefined || v === null ? null : hex64(v, field);
}

export function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || v === "") invalid(`${field} must be a non-empty string`);
  if (v.length > max) invalid(`${field} must be at most ${max} characters`);
  return v;
}

export function optText(v: unknown, field: string, max: number): string | null {
  return v === undefined || v === null ? null : text(v, field, max);
}

export function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) invalid(`${field} must be an integer from ${min} to ${max}`);
  return v;
}

export function optInt(v: unknown, field: string, min: number, max: number): number | null {
  return v === undefined || v === null ? null : int(v, field, min, max);
}

export function list(v: unknown, field: string, max: number, min = 1): unknown[] {
  if (!Array.isArray(v)) invalid(`${field} must be an array`);
  if (v.length < min || v.length > max) invalid(`${field} must hold ${min} to ${max} items, got ${v.length}`);
  return v;
}

export function obj(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) invalid(`${field} must be an object`);
  return v as Record<string, unknown>;
}

export function choice<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(v as T)) invalid(`${field} must be one of ${allowed.join("|")}`);
  return v as T;
}

// A type/subtype with optional parameters, as stored and served back.
export function mimeType(v: unknown, field: string): string {
  const m = text(v, field, 200);
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;.*)?$/i.test(m)) invalid(`${field} must be a MIME type such as image/jpeg`);
  return m;
}

// Serialized size of a JSON value, refused over max bytes.
export function jsonField(v: unknown, field: string, max: number): string {
  const s = JSON.stringify(v ?? null);
  if (new TextEncoder().encode(s).byteLength > max) invalid(`${field} must serialize to at most ${max} bytes`);
  return s;
}

export const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (data: string | ArrayBuffer | Uint8Array) =>
  toHex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data));

export const blobKey = (sha: string) => `sha256/${sha}`;

// Rows that hold JSON text are returned parsed.
export const parsed = (s: string | null) => (s === null ? null : JSON.parse(s));
