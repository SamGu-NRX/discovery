// Proposals and their approval links. docs/CONTRACT.md, "POST /proposals" and
// "Approval".
//
// A proposal whose last step is reversible is recorded as done and never
// asks. One with an irreversible final step gets a random approval token;
// D1 keeps only its SHA-256. The link is single-use, expires with the
// proposal, and is bound to inputs_hash: the decision applies only to the
// exact final step and inputs the card showed.

import { sha256Hex } from "./adapters";
import type { Env } from "./check";
import { canonicalJson, fail, HttpError, intParam, oneOf, optStr, randomHex, readJson, str, timeParam, utcDay } from "./http";

export const APPROVAL_DAILY_CAP = 3;
const DEFAULT_EXPIRY_S = 7 * 86400;
const MAX_EXPIRY_S = 30 * 86400;

const FINAL_STEP_KINDS = ["submit", "send", "post", "pay", "rsvp", "delete", "accept_terms", "push", "open_pr"] as const;
const PREPARED_TYPES = ["file", "branch", "draft", "note", "task"] as const;
const DECISIONS = { approve: "approved", skip: "skipped", later: "later" } as const;
type Decision = keyof typeof DECISIONS;
const WHERE = /^(op|op_followup|reply:@[A-Za-z0-9_]{1,15}|link:\S+)$/;

interface ProposalRow {
  id: string;
  candidate_ids_json: string;
  kind: string;
  title: string;
  why: string;
  evidence_json: string;
  prepared_json: string;
  final_step_kind: string | null;
  final_step: string | null;
  inputs_json: string;
  inputs_hash: string;
  state: string;
  approval_token_hash: string | null;
  expires_at: number | null;
  notified_at: number | null;
  created_at: number;
  decided_at: number | null;
  result_json: string | null;
  notify_state: string | null;
  notify_day: string | null;
  notify_status: number | null;
  notify_error: string | null;
}

interface Prepared {
  type: string;
  ref: string;
  summary: string;
}

function array<T>(v: unknown, field: string, max: number, each: (x: Record<string, unknown>, at: string) => T): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) fail(`${field} must be an array of at most ${max} items`);
  return v.map((x, i) => {
    if (typeof x !== "object" || x === null) fail(`${field}[${i}] must be an object`);
    return each(x as Record<string, unknown>, `${field}[${i}]`);
  });
}

const inputsHash = (finalStepKind: string | null, finalStep: string | null, inputs: unknown) =>
  sha256Hex(canonicalJson({ final_step_kind: finalStepKind, final_step: finalStep, inputs }));

export function presentProposal(r: ProposalRow) {
  const { approval_token_hash, candidate_ids_json, evidence_json, prepared_json, inputs_json, result_json, ...rest } = r;
  return {
    ...rest,
    candidate_ids: JSON.parse(candidate_ids_json),
    evidence: JSON.parse(evidence_json),
    prepared: JSON.parse(prepared_json),
    inputs: JSON.parse(inputs_json),
    result: result_json ? JSON.parse(result_json) : null,
  };
}

export async function createProposal(env: Env, req: Request) {
  const b = await readJson<Record<string, unknown>>(req, 256 * 1024);
  if (!Array.isArray(b.candidate_ids) || b.candidate_ids.length > 50 || !b.candidate_ids.every((c) => typeof c === "string" && c.length > 0 && c.length <= 64)) {
    fail("candidate_ids must be an array of at most 50 candidate id strings");
  }
  const candidateIds = [...new Set(b.candidate_ids as string[])].sort();
  const kind = str(b.kind, "kind", 64);
  const title = str(b.title, "title", 200);
  const why = str(b.why, "why", 4000);
  const evidence = array(b.evidence, "evidence", 50, (e, at) => {
    const where = str(e.where, `${at}.where`, 300);
    if (!WHERE.test(where)) fail(`${at}.where must be op, op_followup, reply:@handle or link:<url>`);
    return { quote: str(e.quote, `${at}.quote`, 2000), where };
  });
  const prepared: Prepared[] = array(b.prepared, "prepared", 50, (p, at) => ({
    type: oneOf(p.type, PREPARED_TYPES, `${at}.type`),
    ref: str(p.ref, `${at}.ref`, 2000),
    summary: str(p.summary, `${at}.summary`, 2000),
  }));
  const finalStepKind = b.final_step_kind === null || b.final_step_kind === undefined ? null : oneOf(b.final_step_kind, FINAL_STEP_KINDS, "final_step_kind");
  const finalStep = optStr(b.final_step, "final_step", 2000);
  // A null final_step_kind alone decides that nothing irreversible remains;
  // a final_step sent with it is kept as a description.
  if (finalStepKind && !finalStep) fail("final_step must describe the step when final_step_kind is set");
  const inputs = b.inputs ?? null;
  let expiresInS = DEFAULT_EXPIRY_S;
  if (b.expires_in_s !== undefined) {
    if (!Number.isInteger(b.expires_in_s) || (b.expires_in_s as number) < 1 || (b.expires_in_s as number) > MAX_EXPIRY_S) fail(`expires_in_s must be an integer from 1 to ${MAX_EXPIRY_S}`);
    expiresInS = b.expires_in_s as number;
  }

  const hash = await inputsHash(finalStepKind, finalStep, inputs);
  // The same proposal sent twice (a runner retry) gets the same id, so a
  // retry can never mint a second link or send a second notification.
  const id = "p_" + (await sha256Hex(canonicalJson({ candidate_ids: candidateIds, kind, title, inputs_hash: hash }))).slice(0, 24);
  const now = Date.now();
  const columns = [id, JSON.stringify(candidateIds), kind, title, why, JSON.stringify(evidence), JSON.stringify(prepared), finalStepKind, finalStep, JSON.stringify(inputs), hash, now];

  if (!finalStepKind) {
    const row = await env.DB.prepare(
      `INSERT INTO proposals (id, candidate_ids_json, kind, title, why, evidence_json, prepared_json, final_step_kind, final_step,
         inputs_json, inputs_hash, created_at, state)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'done')
       ON CONFLICT (id) DO NOTHING RETURNING id, state`,
    )
      .bind(...columns)
      .first<{ id: string; state: string }>();
    return row ? { status: 201, body: { id, state: row.state } } : duplicate(env, id);
  }

  const token = randomHex(32);
  const day = utcDay(now);
  // One statement decides the notification state, so two proposals created
  // at once cannot both take the last of the day's 3 slots.
  const row = await env.DB.prepare(
    `INSERT INTO proposals (id, candidate_ids_json, kind, title, why, evidence_json, prepared_json, final_step_kind, final_step,
       inputs_json, inputs_hash, created_at, state, approval_token_hash, expires_at, notify_day, notify_state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'awaiting_approval', ?13, ?14, ?15,
       CASE
         WHEN (SELECT value FROM settings WHERE key = 'notifications_paused') = '1' THEN 'paused'
         WHEN ?16 = 0 THEN 'no_webhook'
         WHEN (SELECT count(*) FROM proposals WHERE notify_day = ?15 AND notify_state IN ('pending', 'sent', 'failed')) >= ?17 THEN 'capped'
         ELSE 'pending'
       END)
     ON CONFLICT (id) DO NOTHING RETURNING *`,
  )
    .bind(...columns, await sha256Hex(token), now + expiresInS * 1000, day, env.T3_APPROVALS_WEBHOOK_URL ? 1 : 0, APPROVAL_DAILY_CAP)
    .first<ProposalRow>();
  if (!row) return duplicate(env, id);

  const approveUrl = `${new URL(req.url).origin}/a/${token}`;
  const notifyState = row.notify_state === "pending" ? await notify(env, row, approveUrl) : row.notify_state;
  return {
    status: 201,
    body: { id, state: row.state, approve_url: approveUrl, expires_at: new Date(row.expires_at!).toISOString(), notify_state: notifyState },
  };
}

async function duplicate(env: Env, id: string) {
  const existing = await env.DB.prepare("SELECT id, state, notify_state FROM proposals WHERE id = ?").bind(id).first<{ id: string; state: string; notify_state: string | null }>();
  if (!existing) throw new HttpError(500, `proposal ${id} conflicted but is not stored`);
  return { status: 200, body: { id, state: existing.state, notify_state: existing.notify_state, duplicate: true } };
}

async function notify(env: Env, row: ProposalRow, approveUrl: string): Promise<string> {
  const url = env.T3_APPROVALS_WEBHOOK_URL!;
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_id: row.id, title: row.title, why: row.why, final_step: row.final_step, approve_url: approveUrl }),
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    await res.body?.cancel();
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    status = 0;
    // The webhook URL is a capability secret; keep it out of D1 and logs.
    error = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split(url).join("<webhook>").slice(0, 200);
  }
  const sent = status !== null && status >= 200 && status < 300;
  const state = sent ? "sent" : "failed";
  await env.DB.prepare(
    `UPDATE proposals SET notify_state = ?2, notify_status = ?3, notify_error = ?4, notified_at = CASE WHEN ?2 = 'sent' THEN ?5 ELSE NULL END
     WHERE id = ?1`,
  )
    .bind(row.id, state, status, error, Date.now())
    .run();
  console.log(`[approvals] ${row.id} notify status=${status} state=${state}${error ? ` error=${error}` : ""}`);
  return state;
}

export async function listProposals(env: Env, url: URL) {
  const state = url.searchParams.get("state");
  const since = timeParam(url, "since");
  const limit = intParam(url, "limit", 100, 200);
  const rows = await env.DB.prepare(
    `SELECT * FROM proposals
     WHERE (?1 IS NULL OR state = ?1) AND (?2 IS NULL OR created_at >= ?2 OR decided_at >= ?2)
     ORDER BY created_at DESC LIMIT ?3`,
  )
    .bind(state, since, limit)
    .all<ProposalRow>();
  return { proposals: rows.results.map(presentProposal) };
}

export async function expireProposals(env: Env, now: number): Promise<number> {
  const r = await env.DB.prepare("UPDATE proposals SET state = 'expired' WHERE state = 'awaiting_approval' AND expires_at <= ?").bind(now).run();
  return r.meta.changes;
}

// ---- the approval link ----

async function byToken(env: Env, token: string): Promise<ProposalRow | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB.prepare("SELECT * FROM proposals WHERE approval_token_hash = ?").bind(await sha256Hex(token)).first<ProposalRow>();
}

const expired = (p: ProposalRow, now: number) => p.state === "expired" || (p.state === "awaiting_approval" && p.expires_at !== null && p.expires_at <= now);

export async function approvalPage(env: Env, token: string): Promise<Response> {
  const p = await byToken(env, token);
  if (!p) return page(404, "Link not found", messageBody("This approval link is not valid.", "Check that the whole link was copied. Links are made once per proposal."));
  if (expired(p, Date.now())) return page(410, "Link expired", messageBody("This approval has expired.", `It expired on ${dateLabel(p.expires_at!)}. Nothing was sent or submitted.`, p.title));
  if (p.state !== "awaiting_approval") return page(200, "Already decided", messageBody(decidedHeadline(p.state), decidedDetail(p), p.title));
  return page(200, p.title, card(p));
}

export async function decide(env: Env, token: string, req: Request): Promise<Response> {
  const type = req.headers.get("content-type") ?? "";
  const fromForm = type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");
  const reply = (status: number, headline: string, detail: string, title?: string, data?: Record<string, unknown>) =>
    fromForm ? page(status, headline, messageBody(headline, detail, title)) : new Response(JSON.stringify(data ?? { error: `${headline} ${detail}` }), { status, headers: { "content-type": "application/json" } });

  let decisionRaw: unknown;
  let boundHash: unknown;
  if (fromForm) {
    const form = await req.formData();
    decisionRaw = form.get("decision");
    boundHash = form.get("inputs_hash");
  } else {
    const b = await readJson<Record<string, unknown>>(req);
    decisionRaw = b.decision;
    boundHash = b.inputs_hash;
  }
  if (!(typeof decisionRaw === "string" && decisionRaw in DECISIONS)) return reply(400, "Unknown decision.", "Choose approve, skip or later.");
  const decision = decisionRaw as Decision;

  const p = await byToken(env, token);
  if (!p) return reply(404, "Link not found.", "This approval link is not valid.");
  const now = Date.now();
  const refuse = (current: ProposalRow) =>
    expired(current, now)
      ? reply(410, "This approval has expired.", "Nothing was recorded.", current.title, { error: "expired", id: current.id })
      : reply(409, alreadyHeadline(current.state), decidedDetail(current), current.title, { error: "already decided", id: current.id, state: current.state });
  // Single use rests on the conditional UPDATE below, not on this read; the
  // read only picks the clearest error for a link that is already spent.
  if (p.state === "awaiting_approval" && !expired(p, now)) {
    // The card carries the inputs_hash it was rendered with; a JSON caller
    // may send it too. The stored inputs must still hash to the stored value.
    if (boundHash !== undefined && boundHash !== null && boundHash !== p.inputs_hash) {
      return reply(409, "This proposal changed.", "Reload the link to see the current version before deciding.", p.title, { error: "inputs_hash does not match", id: p.id });
    }
    if ((await inputsHash(p.final_step_kind, p.final_step, JSON.parse(p.inputs_json))) !== p.inputs_hash) {
      return reply(409, "This proposal's inputs no longer match what was proposed.", "Nothing was recorded.", p.title, { error: "stored inputs do not match inputs_hash", id: p.id });
    }
  }

  const state = DECISIONS[decision];
  const row = await env.DB.prepare(
    `UPDATE proposals SET state = ?2, decided_at = ?3, result_json = ?4
     WHERE id = ?1 AND state = 'awaiting_approval' AND expires_at > ?3 AND inputs_hash = ?5
     RETURNING *`,
  )
    .bind(p.id, state, now, JSON.stringify({ decision, inputs_hash: p.inputs_hash, via: fromForm ? "card" : "api" }), p.inputs_hash)
    .first<ProposalRow>();
  if (!row) return refuse((await byToken(env, token)) ?? p);
  console.log(`[approvals] ${p.id} decided ${state} via ${fromForm ? "card" : "api"}`);
  return reply(200, decidedHeadline(state), decidedDetail(row), row.title, { id: row.id, state: row.state, inputs_hash: row.inputs_hash });
}

function alreadyHeadline(state: string): string {
  return { approved: "Already approved.", skipped: "Already skipped.", later: "Already saved for later." }[state] ?? "Already decided.";
}

function decidedHeadline(state: string): string {
  return { approved: "Approved.", skipped: "Skipped.", later: "Saved for later.", executed: "Done.", expired: "This approval has expired." }[state] ?? `State: ${state}.`;
}

function decidedDetail(p: Pick<ProposalRow, "state" | "decided_at" | "final_step">): string {
  const when = p.decided_at ? ` on ${dateLabel(p.decided_at)}` : "";
  if (p.state === "approved") return `Recorded${when}. Nothing has run yet: the final step (${p.final_step}) waits until it is executed.`;
  if (p.state === "skipped") return `Recorded${when}. Nothing will run, and the scorer learns from the skip.`;
  if (p.state === "later") return `Recorded${when}. Nothing will run from this link.`;
  return `Recorded${when}.`;
}

// ---- HTML ----

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const dateLabel = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

// A ref becomes a link only if it parses as an http(s) URL. Anything else,
// including a malformed "https://bad host", shows as plain text, so one bad
// ref can't stop the card (and its buttons) from rendering.
function httpUrl(ref: string): URL | null {
  if (!/^https?:\/\//i.test(ref)) return null;
  try {
    const u = new URL(ref);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function preparedItem(item: Prepared): string {
  const url = httpUrl(item.ref);
  const summary = esc(item.summary);
  const main = url ? `<a href="${esc(url.href)}" rel="noreferrer noopener">${summary}</a>` : `<span>${summary}</span>`;
  return `<li><span class="tag">${esc(item.type)}</span><div>${main}<code>${esc(url ? url.host : item.ref)}</code></div></li>`;
}

function card(p: ProposalRow): string {
  const prepared: Prepared[] = JSON.parse(p.prepared_json);
  const kind = (p.final_step_kind ?? "").replace("_", " ");
  return `<main class="slip">
  <p class="eyebrow">Needs your approval · expires ${esc(dateLabel(p.expires_at!))}</p>
  <h1>${esc(p.title)}</h1>
  <p class="why">${esc(p.why)}</p>
  ${
    prepared.length
      ? `<section><h2>Ready</h2><ul class="prepared">${prepared.map(preparedItem).join("")}</ul></section>`
      : `<section><h2>Ready</h2><p class="muted">Nothing was prepared ahead of the final step.</p></section>`
  }
  <section class="final" aria-labelledby="final-h">
    <span class="stamp">${esc(kind)}</span>
    <h2 id="final-h">Final step</h2>
    <p>${esc(p.final_step ?? "")}</p>
    <p class="muted">Approving records your decision. The step itself runs only when it is executed.</p>
  </section>
  <form method="post" class="actions">
    <input type="hidden" name="inputs_hash" value="${esc(p.inputs_hash)}">
    <button class="approve" name="decision" value="approve">Approve</button>
    <div class="pair">
      <button name="decision" value="later">Later</button>
      <button name="decision" value="skip">Skip</button>
    </div>
  </form>
</main>`;
}

function messageBody(headline: string, detail: string, title?: string): string {
  return `<main class="slip message">
  ${title ? `<p class="eyebrow">${esc(title)}</p>` : ""}
  <h1>${esc(headline)}</h1>
  <p>${esc(detail)}</p>
</main>`;
}

const CSS = `
:root{--paper:#e9edf1;--sheet:#fff;--ink:#17212b;--muted:#5d6874;--rule:#d5dbe1;--stamp:#a4500f;--stamp-bg:#fbf1e7;--focus:#2f6fb2;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--paper:#0f1419;--sheet:#182029;--ink:#e6ebf0;--muted:#9aa5b1;--rule:#2b3640;--stamp:#f0a35e;--stamp-bg:#2a2017;--focus:#7fb2e8}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
.slip{overflow-wrap:anywhere;max-width:34rem;margin:0 auto;background:var(--sheet);border:1px solid var(--rule);border-radius:14px;padding:22px 20px 20px}
.eyebrow{margin:0 0 10px;font-size:13px;color:var(--muted);letter-spacing:.01em}
h1{margin:0 0 12px;font:600 1.6rem/1.2 Charter,"Iowan Old Style","Palatino Linotype",Georgia,serif;text-wrap:balance}
h2{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
p{margin:0 0 12px}
.why{white-space:pre-line}
.muted{color:var(--muted);font-size:14px}
section{border-top:1px solid var(--rule);padding-top:16px;margin-top:16px}
.prepared{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.prepared li{display:grid;grid-template-columns:3.75rem minmax(0,1fr);gap:10px;align-items:baseline}
.prepared a{color:inherit;text-underline-offset:3px}
.prepared code{display:block;font:12px/1.4 ui-monospace,"SF Mono",Menlo,monospace;color:var(--muted);overflow-wrap:anywhere;margin-top:2px}
.tag{justify-self:start;font:11px/1 ui-monospace,"SF Mono",Menlo,monospace;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--rule);border-radius:4px;padding:3px 5px;color:var(--muted)}
.final{position:relative;background:var(--stamp-bg);border:1px dashed var(--stamp);border-radius:10px;padding:16px;margin-top:18px}
.final p:last-child{margin-bottom:0}
.stamp{float:right;margin:-4px -4px 8px 12px;font:700 12px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;
  color:var(--stamp);border:2px solid var(--stamp);border-radius:4px;padding:6px 8px;transform:rotate(-4deg)}
.actions{margin-top:20px;display:grid;gap:10px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{font:inherit;font-weight:600;min-height:50px;border-radius:10px;border:1px solid var(--rule);background:var(--sheet);color:var(--ink);
  cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
button.approve{background:var(--ink);color:var(--sheet);border-color:var(--ink)}
@media (prefers-reduced-motion:no-preference){button{transition:transform 120ms ease-out}button:active:not(:focus-visible){transform:scale(.97)}}
button:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.message h1{font-size:1.4rem}
`;

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#e9edf1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1419" media="(prefers-color-scheme: dark)">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The token is in the URL: never cache the page or leak it as a referrer.
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
