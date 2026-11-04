export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Reads the body as text, counting bytes as they arrive and stopping at the
// first byte over maxBytes. A declared Content-Length over the limit is
// refused before reading; a chunked body without one is refused mid-stream,
// so an oversized body is never buffered or parsed.
export async function readText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new HttpError(413, `body is ${declared} bytes; the limit is ${maxBytes}`);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, `body is over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// Reads a JSON object body under maxBytes (see readText), so a large request
// cannot spend the 10 ms CPU budget on JSON.parse.
export async function readJson<T>(req: Request, maxBytes = 64 * 1024): Promise<T> {
  const text = await readText(req, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "body must be a JSON object");
  return parsed as T;
}

export function fail(message: string): never {
  throw new HttpError(400, message);
}

export const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function str(v: unknown, field: string, max = 10_000): string {
  if (!isStr(v)) fail(`${field} must be a non-empty string`);
  if (v.length > max) fail(`${field} is longer than ${max} characters`);
  return v;
}

export function optStr(v: unknown, field: string, max = 10_000): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") fail(`${field} must be a string or null`);
  if (v.length > max) fail(`${field} is longer than ${max} characters`);
  return v;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(v as T)) fail(`${field} must be one of ${allowed.join("|")}, got ${JSON.stringify(v)}`);
  return v as T;
}

export function intParam(url: URL, name: string, dflt: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer`);
  return Math.min(n, max);
}

// Accepts an ISO time or epoch milliseconds; returns epoch milliseconds.
export function timeParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n)) fail(`${name} must be an ISO time or epoch milliseconds`);
  return n;
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const utcDayStart = (ms: number) => Date.parse(utcDay(ms) + "T00:00:00Z");

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// JSON with object keys sorted at every depth, so equal values hash equally
// whatever order the client wrote the keys in.
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
