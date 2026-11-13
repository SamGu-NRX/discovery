// Registered bundles. A version is added only when bundle.json's sha
// changes; its two blobs are copied to bundles/<post_id>/v<n>.{md,json} for
// browsing, and bundle_search holds the latest version's text.

import type { Env } from "../check";
import { json } from "../http";
import { requireBlobs, missingBlobs } from "./blobs";
import { blobKey, choice, hex64, invalid, jsonField, KError, list, obj, parsed, text } from "./common";

const SEARCH_MAX_BYTES = 64 * 1024;
// GET /k/digest returns cards as stored and stays under ~30 KB, so each card
// is small (docs/KNOWLEDGE.md, "Daily loop").
const CARD_MAX_BYTES = 4 * 1024;
// The post id doubles as bundle_search's rowid, so it must fit in int64.
const POST_ID = /^[1-9][0-9]{0,18}$/;
const INT64_MAX = 9223372036854775807n;

export interface BundleRow {
  post_id: string;
  version: number;
  r2_key: string;
  json_key: string;
  md_sha: string;
  json_sha: string;
  completeness: string;
  missing_json: string;
  saved_by: string;
  created_at: number;
  card_json: string | null;
}

export function postId(v: unknown, field: string): string {
  if (typeof v !== "string" || !POST_ID.test(v) || BigInt(v) > INT64_MAX) invalid(`${field} must be a numeric X post id as a string`);
  return v;
}

const presentBundle = (row: BundleRow) => {
  const { missing_json, saved_by, card_json, ...rest } = row;
  return { ...rest, missing: parsed(missing_json), saved_by: parsed(saved_by), card: parsed(card_json) };
};

export const latestBundle = (env: Env, id: string) =>
  env.DB.prepare("SELECT * FROM bundles WHERE post_id = ? ORDER BY version DESC LIMIT 1").bind(id).first<BundleRow>();

const keysFor = (id: string, version: number) => ({ r2_key: `bundles/${id}/v${version}.md`, json_key: `bundles/${id}/v${version}.json` });

async function copyBlob(env: Env, sha: string, to: string, mime: string) {
  const src = await env.KNOWLEDGE.get(blobKey(sha));
  if (!src) throw new KError(404, "object_missing", `the blob row for ${sha} has no R2 object`);
  await env.KNOWLEDGE.put(to, src.body, { httpMetadata: { contentType: mime } });
}

const copyBoth = (env: Env, row: { md_sha: string; json_sha: string; r2_key: string; json_key: string }) =>
  Promise.all([copyBlob(env, row.md_sha, row.r2_key, "text/markdown; charset=utf-8"), copyBlob(env, row.json_sha, row.json_key, "application/json")]);

export async function registerBundle(env: Env, b: Record<string, unknown>): Promise<Response> {
  const id = postId(b.post_id, "post_id");
  const md = hex64(b.md_sha, "md_sha");
  const js = hex64(b.json_sha, "json_sha");
  const completeness = choice(b.completeness, ["complete", "partial"] as const, "completeness");
  const missing = list(b.missing ?? [], "missing", 500, 0).map((m, i) => obj(m, `missing[${i}]`));
  const savedBy = list(b.saved_by ?? [], "saved_by", 20, 0).map((s, i) => text(s, `saved_by[${i}]`, 100));
  const author = typeof b.author === "string" ? b.author.slice(0, 500) : invalid("author must be a string");
  if (typeof b.search_text !== "string") invalid("search_text must be a string");
  const searchText = b.search_text;
  const card = b.card === undefined || b.card === null ? null : jsonField(obj(b.card, "card"), "card", CARD_MAX_BYTES);
  if (new TextEncoder().encode(searchText).byteLength > SEARCH_MAX_BYTES) invalid(`search_text must be at most ${SEARCH_MAX_BYTES} bytes`);
  requireBlobs(await missingBlobs(env, [md, js]), [
    ["md_sha", md],
    ["json_sha", js],
  ]);

  const latest = await latestBundle(env, id);
  if (latest && latest.json_sha === js) return json({ created: false, post_id: id, version: latest.version, r2_key: latest.r2_key, json_key: latest.json_key });

  // Copy first, insert after: a retry after a failed copy recomputes the
  // same version and rewrites the same keys, so a half-done registration
  // never leaves a row pointing at missing copies.
  const version = (latest?.version ?? 0) + 1;
  const keys = keysFor(id, version);
  await copyBoth(env, { md_sha: md, json_sha: js, ...keys });

  const db = env.DB;
  const now = Date.now();
  // The search row changes only if this request's version row went in.
  // rowid is the post id, so the replace is a rowid lookup.
  const ours = "EXISTS (SELECT 1 FROM bundles WHERE post_id = ?1 AND version = ?2 AND json_sha = ?3 AND created_at = ?4)";
  const [inserted] = await db.batch<BundleRow>([
    db
      .prepare(
        `INSERT INTO bundles (post_id, version, r2_key, json_key, md_sha, json_sha, completeness, missing_json, saved_by, created_at, card_json)
         VALUES (?1, ?2, ?5, ?6, ?7, ?3, ?8, ?9, ?10, ?4, ?11) ON CONFLICT (post_id, version) DO NOTHING RETURNING *`,
      )
      .bind(id, version, js, now, keys.r2_key, keys.json_key, md, completeness, JSON.stringify(missing), JSON.stringify(savedBy), card),
    db.prepare(`DELETE FROM bundle_search WHERE rowid = CAST(?1 AS INTEGER) AND ${ours}`).bind(id, version, js, now),
    db.prepare(`INSERT INTO bundle_search (rowid, post_id, author, body) SELECT CAST(?1 AS INTEGER), ?1, ?5, ?6 WHERE ${ours}`).bind(id, version, js, now, author, searchText),
  ]);
  if (inserted.results.length) return json({ created: true, post_id: id, version, r2_key: keys.r2_key, json_key: keys.json_key }, 201);

  // Another registration for this post took the version while we copied, and
  // our copies may have overwritten its files. Put its blobs back.
  const winner = await env.DB.prepare("SELECT * FROM bundles WHERE post_id = ? AND version = ?").bind(id, version).first<BundleRow>();
  if (winner) await copyBoth(env, winner);
  throw new KError(409, "version_conflict", `post_id ${id}: another registration took version ${version}; send the bundle again`);
}

export async function getBundle(env: Env, id: string) {
  postId(id, "the path's post_id");
  const row = await latestBundle(env, id);
  if (!row) throw new KError(404, "bundle_missing", `post_id ${id} has no bundle`);
  return presentBundle(row);
}
