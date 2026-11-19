// Capabilities (which provider and model serves each step, in rank order)
// and the one Worker-side model adapter, Gemini.
//
// The Gemini adapter was written from Google's API docs (generateContent and
// the Files API resumable upload) and has been tested only against the
// local stand-in in fixtures/server.mjs, never the real API: no key was
// available where it was written.

import type { Env } from "../check";
import { canonicalJson, readText, utcDayStart } from "../http";
import { blobRow, storeBytes, type BlobRow } from "./blobs";
import { hex64, int, invalid, jsonField, KError, list, mimeType, obj, sha256Hex, text } from "./common";
import { insertDerivations } from "./records";

// Inline bytes are base64-encoded in the Worker, so their total per request
// stays within the 512 KiB KNOWLEDGE.md allows; the rest go through the
// Files API as a stream.
const INLINE_MAX = 512 * 1024;
// Each Files API input costs start, upload, up to POLL_MAX status reads and a
// delete; two of them plus generateContent stay under Workers Free's 50
// subrequests.
const MAX_FILE_INPUTS = 2;
const POLL_MAX = 20;
const POLL_MS = 2000;
const MAX_INPUTS = 8;
const OUTPUT_MAX = 512 * 1024;
const GEMINI_RESPONSE_MAX = 2 * 1024 * 1024;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,99}$/;

interface Capability {
  step: string;
  rank: number;
  provider: string;
  model: string;
  runs_on: "worker" | "kworker";
  quota_per_day: number | null;
  prompt_v: string;
  enabled: number;
  note: string | null;
}

// Whether the Worker holds what a worker-side provider needs. The AI
// binding is always present; Gemini needs its key.
function workerHas(env: Env, provider: string): boolean {
  if (provider === "workers-ai") return true;
  if (provider === "gemini") return !!env.GEMINI_API_KEY;
  return false;
}

const usedToday = (env: Env, provider: string, model: string) =>
  env.DB.prepare("SELECT count(*) AS n FROM derivations WHERE provider = ?1 AND model = ?2 AND created_at >= ?3")
    .bind(provider, model, utcDayStart(Date.now()))
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);

export async function listCapabilities(env: Env, url: URL) {
  const step = url.searchParams.get("step") || null;
  const rows = await env.DB.prepare(
    `SELECT c.*, (SELECT count(*) FROM derivations d WHERE d.provider = c.provider AND d.model = c.model AND d.created_at >= ?2) AS used_today
     FROM capabilities c WHERE ?1 IS NULL OR c.step = ?1 ORDER BY c.step, c.rank`,
  )
    .bind(step, utcDayStart(Date.now()))
    .all<Capability & { used_today: number }>();
  // available is about the Worker's own secrets; it cannot know kworker's.
  return { capabilities: rows.results.map((c) => ({ ...c, available: c.runs_on === "worker" ? workerHas(env, c.provider) : null })) };
}

// The derivation key for a model call (KNOWLEDGE.md, "Cache keys"): sha256
// of canonical JSON {inputs: [sha…], prompt_sha, response_schema_sha?}.
async function modelInputSha(inputs: string[], prompt: string, schema: unknown): Promise<string> {
  const key: Record<string, unknown> = { inputs, prompt_sha: await sha256Hex(prompt) };
  if (schema !== undefined && schema !== null) key.response_schema_sha = await sha256Hex(canonicalJson(schema));
  return sha256Hex(canonicalJson(key));
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

class Gemini {
  readonly base: string;
  constructor(
    private readonly env: Env,
    readonly key: string,
  ) {
    this.base = (env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  }

  async call(what: string, url: string, init: RequestInit): Promise<Response> {
    const res = await fetch(url, init);
    if (res.ok) return res;
    // Google's error body names the problem in error.status; its message can
    // quote the request, so only the status goes back.
    let status = "";
    try {
      status = (JSON.parse(await readText(res, 64 * 1024)) as { error?: { status?: string } }).error?.status ?? "";
    } catch {}
    const detail = `Gemini ${what} answered ${res.status}${status ? ` ${status}` : ""}`;
    if (res.status === 429) throw new KError(429, "quota_exhausted", `${detail}: the provider's quota is spent`);
    throw new KError(502, "model_error", detail);
  }

  async json<T>(what: string, url: string, init: RequestInit): Promise<T> {
    const res = await this.call(what, url, init);
    try {
      return JSON.parse(await readText(res, GEMINI_RESPONSE_MAX)) as T;
    } catch {
      throw new KError(502, "model_error", `Gemini ${what} did not answer with JSON`);
    }
  }

  // Resumable upload, streaming the R2 object body: start, then one
  // "upload, finalize" request with the bytes, then wait for ACTIVE.
  async upload(blob: BlobRow, mime: string): Promise<{ name: string; uri: string }> {
    const start = await this.call("upload start", `${this.base}/upload/v1beta/files`, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.key,
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(blob.size),
        "x-goog-upload-header-content-type": mime,
        "content-type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: blob.sha256.slice(0, 16) } }),
    });
    await start.body?.cancel();
    const uploadUrl = start.headers.get("x-goog-upload-url");
    // The bytes go only to the provider's own origin.
    if (!uploadUrl || new URL(uploadUrl).origin !== new URL(this.base).origin) throw new KError(502, "model_error", "Gemini upload start returned no upload URL on its own origin");

    const obj = await this.env.KNOWLEDGE.get(blob.r2_key);
    if (!obj) throw new KError(404, "object_missing", `the blob row for ${blob.sha256} has no R2 object`);
    const uploaded = await this.json<{ file?: GeminiFile }>("upload", uploadUrl, {
      method: "POST",
      headers: { "content-length": String(blob.size), "x-goog-upload-offset": "0", "x-goog-upload-command": "upload, finalize" },
      body: obj.body,
    });
    let file = checkedFile(uploaded.file);
    for (let i = 0; file.state !== "ACTIVE"; i++) {
      if (file.state === "FAILED") throw new KError(502, "model_error", `Gemini could not process the upload of ${blob.sha256}`);
      if (i === POLL_MAX) throw new KError(504, "model_timeout", `Gemini's upload of ${blob.sha256} was not ACTIVE after ${POLL_MAX} checks`);
      if (i > 0) await new Promise((r) => setTimeout(r, POLL_MS));
      const got = await this.json<GeminiFile & { file?: GeminiFile }>("file status", `${this.base}/v1beta/${file.name}`, { headers: { "x-goog-api-key": this.key } });
      file = checkedFile(got.file ?? got);
    }
    return { name: file.name, uri: file.uri };
  }

  async remove(name: string) {
    try {
      const res = await fetch(`${this.base}/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": this.key } });
      await res.body?.cancel();
    } catch {}
  }
}

interface GeminiFile {
  name: string;
  uri: string;
  state?: string;
}

// The name goes into a URL path, so it must be the files/<id> form.
function checkedFile(f: GeminiFile | undefined): GeminiFile {
  if (!f || typeof f.name !== "string" || !/^files\/[A-Za-z0-9_-]+$/.test(f.name) || typeof f.uri !== "string") {
    throw new KError(502, "model_error", "Gemini returned a file without a files/<id> name and a uri");
  }
  return f;
}

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export async function runModel(env: Env, b: Record<string, unknown>) {
  const step = text(b.step, "step", 64);
  const provider = text(b.provider, "provider", 100);
  if (provider !== "gemini") throw new KError(422, "no_adapter", `provider must be gemini: the Worker has no adapter for ${JSON.stringify(provider)}`);
  const model = text(b.model, "model", 100);
  if (!MODEL_ID.test(model)) invalid("model must be a Gemini model id such as gemini-3.6-flash");
  const promptV = text(b.prompt_v, "prompt_v", 100);
  const prompt = text(b.prompt, "prompt", 64 * 1024);
  const inputs = list(b.inputs ?? [], "inputs", MAX_INPUTS, 0).map((raw, i) => {
    const r = obj(raw, `inputs[${i}]`);
    return { sha256: hex64(r.sha256, `inputs[${i}].sha256`), mime: mimeType(r.mime, `inputs[${i}].mime`) };
  });
  const schema = b.response_schema ?? undefined;
  if (schema !== undefined) {
    obj(schema, "response_schema");
    jsonField(schema, "response_schema", 16 * 1024);
  }
  const maxTokens = b.max_output_tokens === undefined ? undefined : int(b.max_output_tokens, "max_output_tokens", 1, 65536);

  const cap = await env.DB.prepare("SELECT * FROM capabilities WHERE step = ?1 AND provider = ?2 AND model = ?3 AND runs_on = 'worker'")
    .bind(step, provider, model)
    .first<Capability>();
  if (!cap) throw new KError(422, "capability_unknown", `step, provider and model name no Worker capability: ${step} ${provider} ${model}`);

  const inputSha = await modelInputSha(
    inputs.map((i) => i.sha256),
    prompt,
    schema,
  );
  const hit = await env.DB.prepare(
    "SELECT output_sha, input_tokens, output_tokens FROM derivations WHERE input_sha = ?1 AND step = ?2 AND provider = ?3 AND model = ?4 AND prompt_v = ?5",
  )
    .bind(inputSha, step, provider, model, promptV)
    .first<{ output_sha: string; input_tokens: number | null; output_tokens: number | null }>();
  if (hit) {
    const out = await env.KNOWLEDGE.get(`sha256/${hit.output_sha}`);
    if (!out) throw new KError(404, "object_missing", `the cached output ${hit.output_sha} has no R2 object`);
    return { output_sha: hit.output_sha, output: await out.text(), cached: true, usage: { input_tokens: hit.input_tokens, output_tokens: hit.output_tokens } };
  }

  if (!env.GEMINI_API_KEY) throw new KError(503, "capability_unavailable", "provider gemini is unavailable: the Worker has no GEMINI_API_KEY");
  if (!cap.enabled) throw new KError(503, "capability_unavailable", `capability ${step} ${provider} ${model} is disabled`);
  const used = await usedToday(env, provider, model);
  if (cap.quota_per_day !== null && used >= cap.quota_per_day) {
    throw new KError(429, "quota_exhausted", `model ${model} has made ${used} of its ${cap.quota_per_day} calls today (UTC)`);
  }

  const blobs: BlobRow[] = [];
  for (const [i, input] of inputs.entries()) {
    const row = await blobRow(env, input.sha256);
    if (!row) throw new KError(422, "blob_missing", `inputs[${i}].sha256 names no blob: ${input.sha256} has not been uploaded`);
    blobs.push(row);
  }
  // Inline while the running total fits, in input order; the rest stream.
  let inlineTotal = 0;
  const viaFile = blobs.map((row) => {
    if (inlineTotal + row.size <= INLINE_MAX) {
      inlineTotal += row.size;
      return false;
    }
    return true;
  });
  if (viaFile.filter(Boolean).length > MAX_FILE_INPUTS) {
    throw new KError(422, "too_many_large_inputs", `inputs must leave at most ${MAX_FILE_INPUTS} blobs beyond the ${INLINE_MAX}-byte inline total`);
  }

  const gemini = new Gemini(env, env.GEMINI_API_KEY);
  const uploaded: string[] = [];
  const started = Date.now();
  try {
    const parts: unknown[] = [];
    for (const [i, row] of blobs.entries()) {
      const mime = inputs[i].mime;
      if (viaFile[i]) {
        const f = await gemini.upload(row, mime);
        uploaded.push(f.name);
        parts.push({ file_data: { mime_type: mime, file_uri: f.uri } });
      } else {
        const obj = await env.KNOWLEDGE.get(row.r2_key);
        if (!obj) throw new KError(404, "object_missing", `the blob row for ${row.sha256} has no R2 object`);
        parts.push({ inline_data: { mime_type: mime, data: base64(new Uint8Array(await obj.arrayBuffer())) } });
      }
    }
    parts.push({ text: prompt });
    const generationConfig: Record<string, unknown> = { responseMimeType: "application/json" };
    if (schema !== undefined) generationConfig.responseSchema = schema;
    if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
    const res = await gemini.json<GenerateResponse>("generateContent", `${gemini.base}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": gemini.key, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
    });

    const cand = res.candidates?.[0];
    if (!cand) throw new KError(502, "model_error", `Gemini returned no candidate${res.promptFeedback?.blockReason ? ` (blockReason ${res.promptFeedback.blockReason})` : ""}`);
    // A cut-off or filtered answer is not cached, or every later lookup
    // would get the broken output.
    if (cand.finishReason && cand.finishReason !== "STOP") throw new KError(502, "model_error", `Gemini stopped with finishReason ${cand.finishReason}; nothing was cached`);
    const output = (cand.content?.parts ?? []).map((p) => p.text ?? "").join("");
    const bytes = new TextEncoder().encode(output);
    if (bytes.byteLength > OUTPUT_MAX) throw new KError(502, "model_error", `Gemini's output is ${bytes.byteLength} bytes, over the ${OUTPUT_MAX} the Worker stores`);
    const outputSha = await sha256Hex(bytes);
    await storeBytes(env, outputSha, bytes, "application/json");
    const usage = { input_tokens: res.usageMetadata?.promptTokenCount ?? null, output_tokens: res.usageMetadata?.candidatesTokenCount ?? null };
    await insertDerivations(env, [
      { input_sha: inputSha, step, provider, model, prompt_v: promptV, output_sha: outputSha, ...usage, ms: Date.now() - started, created_at: Date.now() },
    ]);
    return { output_sha: outputSha, output, cached: false, usage };
  } finally {
    await Promise.all(uploaded.map((n) => gemini.remove(n)));
  }
}
