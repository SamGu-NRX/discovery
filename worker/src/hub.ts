// The unified inbox and the secretary brief (docs/APPROVALS.md, "Inbox and
// brief"). The inbox holds what Sam says from his phone and what agents tell
// him; the brief is the one short message he reads.

import type { Caller } from "./auth";
import type { Env } from "./check";
import { onlyFields } from "./devices";
import { fail, HttpError, randomHex, readJson } from "./http";
import { MailRefusal } from "./mailbox";

const KINDS = ["thought", "direction", "task", "reply", "agent_push"] as const;
type Kind = (typeof KINDS)[number];
// Sam's own words come from his phone; agents answer or push. An agent's
// post can't pass for one of his directions, whatever its body says.
const DEVICE_KINDS: readonly Kind[] = ["thought", "direction", "task", "reply"];
const AGENT_KINDS: readonly Kind[] = ["reply", "agent_push"];
const TEXT_MAX_BYTES = 8 * 1024;
const MAX_REFS = 10;

// Same rule as the mailbox (src/mailbox.ts): an agent's text must not carry
// this Worker's capability paths or a token-shaped string, because the brief
// passes it to the dot.
const CAPABILITY_PATH = /\/(?:a|mcp|room|admin)\//i;
const TOKEN_SHAPED = /[0-9a-f]{64}/i;

// Who is speaking, from the token alone.
export function sourceOf(caller: Caller): string {
  if (caller.scope === "device") return `device:${caller.deviceId}`;
  if (caller.scope === "admin") return "admin";
  if (caller.scope.startsWith("agent:")) return caller.scope.slice("agent:".length);
  throw new HttpError(403, `the ${caller.scope} token has no inbox`);
}

export async function postInbox(env: Env, source: string, b: Record<string, unknown>) {
  onlyFields(b, ["kind", "text", "source", "refs", "audio_id", "reply_to"]);
  if (!KINDS.includes(b.kind as Kind)) fail(`kind must be one of ${KINDS.join("|")}`);
  const kind = b.kind as Kind;
  const fromDevice = source.startsWith("device:");
  const allowed = fromDevice ? DEVICE_KINDS : source === "admin" ? KINDS : AGENT_KINDS;
  if (!allowed.includes(kind)) fail(`kind ${kind} can't come from ${source}; it may post ${allowed.join("|")}`);
  if (typeof b.text !== "string" || b.text.trim() === "") fail("text must be a non-empty string");
  const n = new TextEncoder().encode(b.text).byteLength;
  if (n > TEXT_MAX_BYTES) fail(`text is ${n} bytes of UTF-8; the limit is ${TEXT_MAX_BYTES}`);
  if (!fromDevice && (CAPABILITY_PATH.test(b.text) || TOKEN_SHAPED.test(b.text))) {
    throw new MailRefusal(422, "capability_leak", "text contains a path under /a/, /mcp/, /room/ or /admin/, or a 64-hex string shaped like a token");
  }
  // Kept as data: the stored source is the token's.
  if (b.source !== undefined && (typeof b.source !== "string" || b.source.length > 64)) fail("source must be a string of at most 64 characters (it is recorded, but the token decides the source)");
  let refs: string[] = [];
  if (b.refs !== undefined) {
    if (!Array.isArray(b.refs) || b.refs.length > MAX_REFS) fail(`refs must be an array of at most ${MAX_REFS} URLs`);
    refs = b.refs.map((r, i) => {
      let u: URL | null = null;
      try {
        u = typeof r === "string" && r.length <= 2000 ? new URL(r) : null;
      } catch {}
      if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) fail(`refs[${i}] must be an http(s) URL of at most 2000 characters`);
      if (!fromDevice && CAPABILITY_PATH.test(u.pathname)) throw new MailRefusal(422, "capability_leak", `refs[${i}] is a path under /a/, /mcp/, /room/ or /admin/`);
      return r as string;
    });
  }
  let audioId: string | null = null;
  if (b.audio_id !== undefined) {
    if (!fromDevice) fail("audio_id is set only on a device's own voice notes");
    if (typeof b.audio_id !== "string" || !/^v_[0-9a-f]{16}$/.test(b.audio_id)) fail("audio_id must be an id POST /voice returned");
    const v = await env.DB.prepare("SELECT 1 FROM voice_notes WHERE id = ? AND device_id = ?").bind(b.audio_id, source.slice("device:".length)).first();
    if (!v) fail(`audio_id ${b.audio_id} is not a voice note from this device`);
    audioId = b.audio_id;
  }
  let replyTo: string | null = null;
  if (b.reply_to !== undefined) {
    if (kind !== "reply") fail("reply_to goes only with kind reply");
    if (typeof b.reply_to !== "string" || !/^i_[0-9a-f]{16}$/.test(b.reply_to)) fail("reply_to must be an inbox item id");
    if (!(await env.DB.prepare("SELECT 1 FROM inbox_items WHERE id = ?").bind(b.reply_to).first())) fail(`reply_to ${b.reply_to} is not an inbox item`);
    replyTo = b.reply_to;
  }
  return insertInbox(env, { kind, text: b.text, source, claimedSource: (b.source as string | undefined) ?? null, refs, audioId, replyTo });
}

export async function insertInbox(
  env: Env,
  i: { kind: Kind; text: string; source: string; claimedSource?: string | null; refs?: string[]; audioId?: string | null; replyTo?: string | null },
) {
  const id = "i_" + randomHex(8);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO inbox_items (id, kind, text, source, claimed_source, refs_json, audio_id, reply_to, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(id, i.kind, i.text, i.source, i.claimedSource ?? null, JSON.stringify(i.refs ?? []), i.audioId ?? null, i.replyTo ?? null, now)
    .run();
  console.log(`[inbox] ${id} ${i.kind} from ${i.source}`);
  return { id, kind: i.kind, source: i.source, created_at: new Date(now).toISOString() };
}

export async function inboxRoute(env: Env, caller: Caller, req: Request) {
  return postInbox(env, sourceOf(caller), await readJson<Record<string, unknown>>(req, 32 * 1024));
}

// ---- the brief ----
//
// Deterministic, from D1, no model call. Rules from the design consult: an
// item is a decision in one of Sam's projects, never a post; at most 3 asks,
// 1 return on something he said, at most 1 question, and a count of the
// rest. The three sources map one to one: asks are pending approval
// requests, the return is an agent's reply to something Sam posted, and the
// question is about his oldest unanswered thought.

const MAX_WORDS = 90;
const MAX_ASKS = 3;
const DAY = 86_400_000;
const RETURN_WINDOW_MS = 2 * DAY;
const QUESTION_WINDOW_MS = 7 * DAY;

const words = (s: string, n: number) => {
  const w = s.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ") + "…";
};
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export async function brief(env: Env) {
  const now = Date.now();
  const db = env.DB;
  const deviceSourced = "source LIKE 'device:%'";
  const [asks, counts, ret, question] = await db.batch<Record<string, unknown>>([
    db
      .prepare(`SELECT id, title, action_label, project FROM approval_requests WHERE state = 'pending' AND expires_at > ?1 ORDER BY expires_at, created_at LIMIT ?2`)
      .bind(now, MAX_ASKS),
    db
      .prepare(
        `SELECT (SELECT count(*) FROM approval_requests WHERE state = 'pending' AND expires_at > ?1) AS pending_approvals,
                (SELECT count(*) FROM inbox_items r JOIN inbox_items s ON s.id = r.reply_to
                   WHERE r.kind = 'reply' AND r.source NOT LIKE 'device:%' AND s.${deviceSourced} AND r.created_at >= ?2) AS replies,
                (SELECT count(*) FROM inbox_items t WHERE t.kind = 'thought' AND t.${deviceSourced} AND t.created_at >= ?3
                   AND NOT EXISTS (SELECT 1 FROM inbox_items r WHERE r.reply_to = t.id)) AS unanswered_thoughts,
                (SELECT count(*) FROM inbox_items WHERE kind = 'agent_push' AND created_at >= ?4) AS agent_pushes,
                (SELECT count(*) FROM approval_requests WHERE outcome = 'executed' AND finished_at >= ?4) AS executed`,
      )
      .bind(now, now - RETURN_WINDOW_MS, now - QUESTION_WINDOW_MS, now - DAY),
    db
      .prepare(
        `SELECT r.id, r.source, r.text, s.text AS said FROM inbox_items r JOIN inbox_items s ON s.id = r.reply_to
         WHERE r.kind = 'reply' AND r.source NOT LIKE 'device:%' AND s.${deviceSourced} AND r.created_at >= ?1
         ORDER BY r.created_at DESC LIMIT 1`,
      )
      .bind(now - RETURN_WINDOW_MS),
    db
      .prepare(
        `SELECT t.id, t.text FROM inbox_items t WHERE t.kind = 'thought' AND t.${deviceSourced} AND t.created_at >= ?1
           AND NOT EXISTS (SELECT 1 FROM inbox_items r WHERE r.reply_to = t.id)
         ORDER BY t.created_at LIMIT 1`,
      )
      .bind(now - QUESTION_WINDOW_MS),
  ]);
  const c = counts.results[0] as Record<string, number>;
  const askRows = asks.results as { id: string; title: string; action_label: string; project: string | null }[];
  const askList = askRows.map((a) => ({ request_id: a.id, line: words(`${a.action_label}${a.project ? ` in ${a.project}` : ""}: ${a.title}`, 14) }));
  const r = ret.results[0] as { id: string; source: string; text: string; said: string } | undefined;
  const returns = r ? [{ inbox_id: r.id, source: r.source, line: `${r.source} answered "${words(r.said, 8)}": ${words(r.text, 20)}` }] : [];
  const q = question.results[0] as { id: string; text: string } | undefined;
  const counted = {
    pending_approvals: c.pending_approvals,
    more_approvals: c.pending_approvals - askList.length,
    more_replies: c.replies - returns.length,
    unanswered_thoughts: c.unanswered_thoughts,
    agent_pushes_24h: c.agent_pushes,
    executed_24h: c.executed,
  };
  if (askList.length === 0 && returns.length === 0 && !q) return { text: "", asks: [], returns: [], counts: counted };

  const sentences: string[] = [];
  if (askList.length === 1) sentences.push(`One decision: ${askList[0].line}.`);
  else if (askList.length > 1) sentences.push(`${askList.length} decisions: ${askList.map((a) => a.line).join("; ")}.`);
  if (counted.more_approvals > 0) sentences.push(`${counted.more_approvals} more waiting.`);
  if (returns.length) sentences.push(`${returns[0].line}.`);
  const questionText = q ? `Still thinking about "${words(q.text, 10)}"?` : undefined;
  if (questionText) sentences.push(questionText);
  const rest = counted.more_replies + counted.agent_pushes_24h + counted.executed_24h;
  if (rest > 0) sentences.push(`${rest} other update${rest === 1 ? "" : "s"}.`);
  let text = sentences.join(" ");
  // The parts above stay under 90 words by construction; this keeps it so if
  // a cap changes.
  if (wordCount(text) > MAX_WORDS) text = words(text, MAX_WORDS);
  return { text, asks: askList, returns, ...(questionText ? { question: { inbox_id: q!.id, line: questionText } } : {}), counts: counted };
}
