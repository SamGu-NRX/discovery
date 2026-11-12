// The cache tables kworker reads before every step and writes after it:
// fetches (per canonical URL), derivations (per input and model), verdicts
// (the gate's tombstones), and per-host start rungs. Batches go to D1 as one
// JSON parameter expanded by json_each, so 200 rows are one statement, not
// 200 queries against the per-invocation limit.

import type { Env } from "../check";
import { missingBlobs, requireBlobs } from "./blobs";
import { choice, hex64, int, invalid, list, obj, optHex64, optInt, optText, sha256Hex, text } from "./common";

const STEP = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_TIME = 8.64e15;

function step(v: unknown, field: string): string {
  if (typeof v !== "string" || !STEP.test(v)) invalid(`${field} must be lowercase letters, digits and _ (at most 64), such as image_read`);
  return v;
}

const col = (names: string[]) => names.map((n) => `json_extract(value, '$.${n}')`).join(", ");

// ---- fetches ----

const FETCH_COLS = ["url_hash", "canonical_url", "final_url", "etag", "last_modified", "content_sha", "mime", "http_status", "rung", "status", "immutable", "note", "fetched_at"];

export async function lookupFetches(env: Env, b: Record<string, unknown>) {
  const hashes = list(b.url_hashes, "url_hashes", 100).map((h, i) => hex64(h, `url_hashes[${i}]`));
  const rows = await env.DB.prepare("SELECT * FROM fetches WHERE url_hash IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(hashes)).all();
  return { fetches: rows.results };
}

export async function upsertFetches(env: Env, b: Record<string, unknown>) {
  const now = Date.now();
  const rows = await Promise.all(
    list(b.rows, "rows", 50).map(async (raw, i) => {
      const r = obj(raw, `rows[${i}]`);
      const f = `rows[${i}]`;
      const url_hash = hex64(r.url_hash, `${f}.url_hash`);
      const canonical_url = text(r.canonical_url, `${f}.canonical_url`, 4096);
      if ((await sha256Hex(canonical_url)) !== url_hash) invalid(`${f}.url_hash must be the SHA-256 of ${f}.canonical_url`);
      if (r.immutable !== undefined && typeof r.immutable !== "boolean" && r.immutable !== 0 && r.immutable !== 1) invalid(`${f}.immutable must be true, false, 0 or 1`);
      return {
        url_hash,
        canonical_url,
        final_url: optText(r.final_url, `${f}.final_url`, 4096),
        etag: optText(r.etag, `${f}.etag`, 1000),
        last_modified: optText(r.last_modified, `${f}.last_modified`, 200),
        content_sha: optHex64(r.content_sha, `${f}.content_sha`),
        mime: optText(r.mime, `${f}.mime`, 200),
        http_status: optInt(r.http_status, `${f}.http_status`, 100, 599),
        rung: int(r.rung, `${f}.rung`, 0, 7),
        status: choice(r.status, ["ok", "not_found", "blocked", "error"] as const, `${f}.status`),
        immutable: r.immutable === true || r.immutable === 1 ? 1 : 0,
        note: optText(r.note, `${f}.note`, 2000),
        fetched_at: optInt(r.fetched_at, `${f}.fetched_at`, 0, MAX_TIME) ?? now,
      };
    }),
  );
  requireBlobs(
    await missingBlobs(env, rows.flatMap((r) => (r.content_sha ? [r.content_sha] : []))),
    rows.map((r, i) => [`rows[${i}].content_sha`, r.content_sha]),
  );
  const update = FETCH_COLS.slice(1)
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  // WHERE true: SQLite needs it to tell an upsert's ON CONFLICT from a join.
  const res = await env.DB.prepare(
    `INSERT INTO fetches (${FETCH_COLS.join(", ")}) SELECT ${col(FETCH_COLS)} FROM json_each(?1) WHERE true
     ON CONFLICT (url_hash) DO UPDATE SET ${update}`,
  )
    .bind(JSON.stringify(rows))
    .run();
  return { upserted: res.meta.changes };
}

// ---- derivations ----

const DERIVATION_COLS = ["input_sha", "step", "provider", "model", "prompt_v", "output_sha", "input_tokens", "output_tokens", "ms", "created_at"];

export async function lookupDerivations(env: Env, b: Record<string, unknown>) {
  const keys = list(b.keys, "keys", 100).map((raw, i) => {
    const k = obj(raw, `keys[${i}]`);
    return { input_sha: hex64(k.input_sha, `keys[${i}].input_sha`), step: step(k.step, `keys[${i}].step`) };
  });
  // Each pair can hold several providers and prompt versions; 1000 rows
  // bounds the response if a key has accumulated many.
  const rows = await env.DB.prepare(
    `SELECT d.* FROM json_each(?1) k
     JOIN derivations d ON d.input_sha = json_extract(k.value, '$.input_sha') AND d.step = json_extract(k.value, '$.step')
     LIMIT 1000`,
  )
    .bind(JSON.stringify(keys))
    .all();
  return { derivations: rows.results };
}

interface Derivation {
  input_sha: string;
  step: string;
  provider: string;
  model: string;
  prompt_v: string;
  output_sha: string;
  input_tokens: number | null;
  output_tokens: number | null;
  ms: number | null;
  created_at: number;
}

// created_at is always the Worker's clock: used_today counts by it.
export async function insertDerivations(env: Env, rows: Derivation[]) {
  const res = await env.DB.prepare(
    `INSERT INTO derivations (${DERIVATION_COLS.join(", ")}) SELECT ${col(DERIVATION_COLS)} FROM json_each(?1) WHERE true
     ON CONFLICT DO NOTHING`,
  )
    .bind(JSON.stringify(rows))
    .run();
  return res.meta.changes;
}

export async function postDerivations(env: Env, b: Record<string, unknown>) {
  const now = Date.now();
  const rows: Derivation[] = list(b.rows, "rows", 50).map((raw, i) => {
    const r = obj(raw, `rows[${i}]`);
    const f = `rows[${i}]`;
    return {
      input_sha: hex64(r.input_sha, `${f}.input_sha`),
      step: step(r.step, `${f}.step`),
      provider: text(r.provider, `${f}.provider`, 100),
      model: text(r.model, `${f}.model`, 200),
      prompt_v: text(r.prompt_v, `${f}.prompt_v`, 100),
      output_sha: hex64(r.output_sha, `${f}.output_sha`),
      input_tokens: optInt(r.input_tokens, `${f}.input_tokens`, 0, 1e9),
      output_tokens: optInt(r.output_tokens, `${f}.output_tokens`, 0, 1e9),
      ms: optInt(r.ms, `${f}.ms`, 0, 1e9),
      created_at: now,
    };
  });
  requireBlobs(
    await missingBlobs(env, rows.map((r) => r.output_sha)),
    rows.map((r, i) => [`rows[${i}].output_sha`, r.output_sha]),
  );
  return { inserted: await insertDerivations(env, rows) };
}

// ---- verdicts ----

const ITEM_KINDS = ["reply", "quote", "upstream", "linking", "link"] as const;
const VERDICT_COLS = ["item_kind", "item_id", "save_id", "verdict", "reason", "stage", "score", "text_sha", "gate_v", "pack_sha", "pack_row", "created_at"];

export async function postVerdicts(env: Env, b: Record<string, unknown>) {
  const now = Date.now();
  const rows = list(b.rows, "rows", 200).map((raw, i) => {
    const r = obj(raw, `rows[${i}]`);
    const f = `rows[${i}]`;
    if (r.score !== undefined && r.score !== null && (typeof r.score !== "number" || !Number.isFinite(r.score))) invalid(`${f}.score must be a finite number or null`);
    return {
      item_kind: choice(r.item_kind, ITEM_KINDS, `${f}.item_kind`),
      item_id: text(r.item_id, `${f}.item_id`, 4096),
      save_id: text(r.save_id, `${f}.save_id`, 64),
      verdict: choice(r.verdict, ["keep", "drop"] as const, `${f}.verdict`),
      reason: optText(r.reason, `${f}.reason`, 2000),
      stage: choice(r.stage, ["rule", "embed", "model"] as const, `${f}.stage`),
      score: (r.score as number | null | undefined) ?? null,
      text_sha: hex64(r.text_sha, `${f}.text_sha`),
      gate_v: text(r.gate_v, `${f}.gate_v`, 100),
      pack_sha: optHex64(r.pack_sha, `${f}.pack_sha`),
      pack_row: optInt(r.pack_row, `${f}.pack_row`, 0, 1e12),
      created_at: now,
    };
  });
  const res = await env.DB.prepare(
    `INSERT INTO verdicts (${VERDICT_COLS.join(", ")}) SELECT ${col(VERDICT_COLS)} FROM json_each(?1) WHERE true
     ON CONFLICT DO NOTHING`,
  )
    .bind(JSON.stringify(rows))
    .run();
  return { inserted: res.meta.changes };
}

export async function lookupVerdicts(env: Env, b: Record<string, unknown>) {
  const gate = text(b.gate_v, "gate_v", 100);
  const items = list(b.items, "items", 200).map((raw, i) => {
    const it = obj(raw, `items[${i}]`);
    return { item_kind: choice(it.item_kind, ITEM_KINDS, `items[${i}].item_kind`), item_id: text(it.item_id, `items[${i}].item_id`, 4096) };
  });
  const rows = await env.DB.prepare(
    `SELECT v.* FROM json_each(?2) k
     JOIN verdicts v ON v.gate_v = ?1 AND v.item_kind = json_extract(k.value, '$.item_kind') AND v.item_id = json_extract(k.value, '$.item_id')`,
  )
    .bind(gate, JSON.stringify(items))
    .all();
  return { verdicts: rows.results };
}

// ---- domain policy ----

function host(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(v) || v.length > 253) {
    invalid(`${field} must be a lowercase host name such as github.com`);
  }
  return v;
}

export async function getDomainPolicy(env: Env, url: URL) {
  const h = host(url.searchParams.get("host") ?? undefined, "host");
  return { policy: await env.DB.prepare("SELECT * FROM domain_policy WHERE host = ?").bind(h).first() };
}

export async function putDomainPolicy(env: Env, b: Record<string, unknown>) {
  const h = host(b.host, "host");
  const rung = int(b.start_rung, "start_rung", 0, 7);
  const notes = optText(b.notes, "notes", 2000);
  const policy = await env.DB.prepare(
    `INSERT INTO domain_policy (host, start_rung, notes, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (host) DO UPDATE SET start_rung = excluded.start_rung, notes = excluded.notes, updated_at = excluded.updated_at
     RETURNING *`,
  )
    .bind(h, rung, notes, Date.now())
    .first();
  return { policy };
}
