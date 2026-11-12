// Voice notes (docs/APPROVALS.md, "Voice"). The phone uploads AAC audio; the
// Worker streams it to R2 and answers at once, then transcribes it with
// Gemini and files the transcript to the inbox as a thought.
//
// Gemini request shapes are from Google's docs as read on 2026-11-12
// (aistudio.google.com/docs/files and /docs/speech-to-text): a resumable
// Files API upload, then POST /v1beta/interactions with model
// gemini-3.5-transcribe and an input part {type: "file", file_uri}. That
// page's REST sample puts the text at steps[].content[].text in the
// model_output step and names output_text as the SDK accessor; both are read.
// Neither shape has been checked against the live API.

import type { Caller } from "./auth";
import type { Env } from "./check";
import { HttpError, randomHex } from "./http";
import { insertInbox } from "./hub";

export const VOICE_MAX_BYTES = 25 * 1024 * 1024;
const MODEL = "models/gemini-3.5-transcribe";
// Google's audio pages list audio/m4a and audio/aac, not audio/mp4, which is
// what an AAC .m4a file is. The upload is labelled audio/m4a.
const GEMINI_MIME = "audio/m4a";
const MAX_ATTEMPTS = 3;
// waitUntil ends 30 s after the response; a transcription it didn't finish
// is picked up by the cron, whose wall-time limit is 15 minutes.
const STUCK_MS = 10 * 60_000;
const CRON_PER_RUN = 2;
const POLLS = 10;
const POLL_MS = 3000;

function recordedAt(v: string | null): number {
  if (v === null) throw new HttpError(400, "x-recorded-at header is required: an ISO 8601 time such as 2026-11-12T09:30:00Z");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))) return Date.parse(v);
  throw new HttpError(400, "x-recorded-at must be an ISO 8601 time with seconds and a zone, such as 2026-11-12T09:30:00Z");
}

export async function uploadVoice(env: Env, ctx: ExecutionContext, caller: Caller, req: Request) {
  if (caller.scope !== "device") throw new HttpError(403, "only a device uploads voice notes");
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "audio/mp4") throw new HttpError(415, `content-type must be audio/mp4 (AAC), got ${JSON.stringify(type || null)}`);
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader === null || !/^\d+$/.test(lengthHeader)) throw new HttpError(411, "content-length is required");
  const length = Number(lengthHeader);
  if (length === 0) throw new HttpError(400, "the body is empty");
  if (length > VOICE_MAX_BYTES) throw new HttpError(413, `body is ${length} bytes; the limit is ${VOICE_MAX_BYTES}`);
  const at = recordedAt(req.headers.get("x-recorded-at"));
  const id = "v_" + randomHex(8);
  const key = `voice/${id}.m4a`;
  // Streamed: R2 needs the length, which Content-Length gives, and the audio
  // never sits in the Worker's memory or costs CPU to copy.
  try {
    await env.VOICE.put(key, req.body!, { httpMetadata: { contentType: "audio/mp4" }, customMetadata: { device_id: caller.deviceId! } });
  } catch (e) {
    throw new HttpError(400, `the audio could not be stored: ${e instanceof Error ? e.message.slice(0, 120) : "stream error"}`);
  }
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO voice_notes (id, device_id, content_type, bytes, recorded_at, r2_key, state, created_at, updated_at)
     VALUES (?1, ?2, 'audio/mp4', ?3, ?4, ?5, 'queued', ?6, ?6)`,
  )
    .bind(id, caller.deviceId, length, at, key, now)
    .run();
  ctx.waitUntil(transcribe(env, id));
  return { audio_id: id };
}

export async function voiceStatus(env: Env, caller: Caller, id: string) {
  const v = await env.DB.prepare("SELECT id, device_id, state, transcript, error, inbox_id FROM voice_notes WHERE id = ?").bind(id).first<{
    id: string;
    device_id: string;
    state: string;
    transcript: string | null;
    error: string | null;
    inbox_id: string | null;
  }>();
  if (!v || (caller.scope === "device" && v.device_id !== caller.deviceId)) throw new HttpError(404, `voice note ${id} not found`);
  // docs/APPROVALS.md, "Wire details": { state, transcript?, error? }.
  return {
    state: v.state,
    ...(v.state === "done" ? { transcript: v.transcript ?? "" } : {}),
    ...(v.state === "failed" ? { error: v.error ?? "transcription failed" } : {}),
  };
}

class GeminiError extends Error {}

async function gemini(env: Env, url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { "x-goog-api-key": env.GEMINI_API_KEY!, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new GeminiError(`Gemini ${new URL(url).pathname.split("/").slice(0, 4).join("/")} answered ${res.status} ${text}`);
  }
  return res;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function transcriptOf(x: Record<string, unknown>): string | null {
  if (typeof x.output_text === "string") return x.output_text;
  if (!Array.isArray(x.steps)) return null;
  const parts: string[] = [];
  for (const step of x.steps as { type?: string; content?: { type?: string; text?: string }[] }[]) {
    if (step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const c of step.content) if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.length ? parts.join("") : null;
}

async function runGemini(env: Env, note: { id: string; r2_key: string; bytes: number }): Promise<string> {
  const origin = env.GEMINI_API_ORIGIN ?? "https://generativelanguage.googleapis.com";
  const obj = await env.VOICE.get(note.r2_key);
  if (!obj) throw new GeminiError(`the audio ${note.r2_key} is missing from R2`);
  const start = await gemini(env, `${origin}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(obj.size),
      "x-goog-upload-header-content-type": GEMINI_MIME,
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: note.id } }),
  });
  await start.body?.cancel();
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new GeminiError("Gemini's upload start had no x-goog-upload-url header");
  const { readable, writable } = new FixedLengthStream(obj.size);
  const piping = obj.body.pipeTo(writable);
  const uploaded = await gemini(env, uploadUrl, {
    method: "POST",
    headers: { "content-length": String(obj.size), "x-goog-upload-offset": "0", "x-goog-upload-command": "upload, finalize" },
    body: readable,
  });
  await piping;
  let file = ((await uploaded.json()) as { file?: { uri?: string; name?: string; state?: string } }).file;
  if (!file?.uri || !file.name) throw new GeminiError("Gemini's upload answer has no file.uri and file.name");
  for (let i = 0; file.state === "PROCESSING" && i < POLLS; i++) {
    await sleep(POLL_MS);
    file = (await (await gemini(env, `${origin}/v1beta/${file.name}`, { method: "GET" })).json()) as typeof file;
  }
  if (file!.state && file!.state !== "ACTIVE") throw new GeminiError(`the uploaded file is ${file!.state}`);
  let answer = (await (
    await gemini(env, `${origin}/v1beta/interactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: [{ type: "file", file_uri: file!.uri }] }),
    })
  ).json()) as Record<string, unknown>;
  for (let i = 0; answer.status !== undefined && answer.status !== "completed" && i < POLLS; i++) {
    if (answer.status === "failed" || answer.status === "cancelled") break;
    await sleep(POLL_MS);
    answer = (await (await gemini(env, `${origin}/v1beta/interactions/${encodeURIComponent(String(answer.id))}`, { method: "GET" })).json()) as Record<string, unknown>;
  }
  if (answer.status !== undefined && answer.status !== "completed") throw new GeminiError(`the transcription is ${String(answer.status)}`);
  const text = transcriptOf(answer);
  if (text === null) throw new GeminiError("Gemini's answer has no transcript text (no output_text, no model_output text step)");
  // Uploaded files expire after 48 hours; this removes Sam's audio sooner.
  // A failure here changes nothing.
  await fetch(`${origin}/v1beta/${file!.name}`, { method: "DELETE", headers: { "x-goog-api-key": env.GEMINI_API_KEY! } }).then((r) => r.body?.cancel(), () => {});
  return text.trim();
}

export async function transcribe(env: Env, id: string): Promise<void> {
  const now = Date.now();
  if (!env.GEMINI_API_KEY) {
    await env.DB.prepare("UPDATE voice_notes SET error = 'GEMINI_API_KEY is not set' WHERE id = ? AND state = 'queued'").bind(id).run();
    return;
  }
  const note = await env.DB.prepare(
    `UPDATE voice_notes SET state = 'transcribing', attempts = attempts + 1, updated_at = ?2
     WHERE id = ?1 AND attempts < ?3 AND (state = 'queued' OR (state = 'transcribing' AND updated_at < ?4))
     RETURNING id, device_id, r2_key, bytes, attempts`,
  )
    .bind(id, now, MAX_ATTEMPTS, now - STUCK_MS)
    .first<{ id: string; device_id: string; r2_key: string; bytes: number; attempts: number }>();
  if (!note) return;
  try {
    const transcript = await runGemini(env, note);
    const filed = transcript ? await insertInbox(env, { kind: "thought", text: transcript, source: `device:${note.device_id}`, audioId: note.id }) : null;
    await env.DB.prepare("UPDATE voice_notes SET state = 'done', transcript = ?2, inbox_id = ?3, error = NULL, updated_at = ?4 WHERE id = ?1")
      .bind(id, transcript, filed?.id ?? null, Date.now())
      .run();
    console.log(`[voice] ${id} transcribed: ${transcript.length} characters`);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    const state = note.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
    await env.DB.prepare("UPDATE voice_notes SET state = ?2, error = ?3, updated_at = ?4 WHERE id = ?1").bind(id, state, msg, Date.now()).run();
    console.log(`[voice] ${id} attempt ${note.attempts} ${state}: ${msg}`);
  }
}

export async function voiceCron(env: Env, now: number): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT id FROM voice_notes WHERE attempts < ?3 AND ((state = 'queued' AND updated_at < ?1) OR (state = 'transcribing' AND updated_at < ?2))
     ORDER BY updated_at LIMIT ?4`,
  )
    .bind(now - 60_000, now - STUCK_MS, MAX_ATTEMPTS, CRON_PER_RUN)
    .all<{ id: string }>();
  for (const v of due.results) await transcribe(env, v.id);
  return due.results.length;
}
