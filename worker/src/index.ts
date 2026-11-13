import type { Kind } from "./adapters";
import { callerScope, type Caller, type Scope } from "./auth";
import { backfillApprovalRequests, decideApproval, expireApprovalRequests, getApproval, listApprovals } from "./approvals";
import { chatCompletions, listModels } from "./bridge";
import { enroll, listDevices, mintEnrollCode, revoke, updateApnsToken, updateLiveActivityToken } from "./devices";
import { repoAllowlist, setRepoAllowlist } from "./executor";
import { brief, inboxRoute } from "./hub";
import { correctRouting, dispatch, publishTable, setTable } from "./routing";
import { uploadVoice, voiceCron, voiceStatus } from "./voice";
import { claimCandidates, completeCandidate, createCandidate, listCandidates } from "./candidates";
import type { Env, WatcherRow } from "./check";
import { HttpError, json, randomHex, readJson, timeParam, utcDay } from "./http";
import { APPROVAL_DAILY_CAP, approvalPage, createProposal, decide, expireProposals, listProposals, presentProposal, rotateToken } from "./proposals";
import { inbox, inboxExport, sightingsExport } from "./inbox";
import { knowledgeErrorBody } from "./knowledge/common";
import { KNOWLEDGE_ROUTES } from "./knowledge/routes";
import { agentOf, listTasks, MailRefusal, mailboxCron, mailboxStatus, mcp, mcpByPath, restAck, restClaim, restComplete, restSend, room, setPaused } from "./mailbox";
import { doneRepolls, dueRepolls, labelPosts, listLenses, recordBaseline, recordReads, refreshBackground, refreshDueBackgrounds, scorecard, signals, upsertLens } from "./lens";
import { CRON_LIMITS, lensEnv, ROUTE_LIMITS } from "./lens-budget";
import { handleDelivery, handleVerification, requestSubscription } from "./websub";
import { addPositives, detailQueue, embed, ingest, ingestStatus, listPositives, listPosts, postContext, saveScores, startSession } from "./x";

export { WatcherDO } from "./watcher";
export { BridgeWaitDO } from "./bridge";

// A watcher whose next check is this far past due has lost its alarm; a live
// alarm fires at next_check_at and the check moves next_check_at forward.
const BACKSTOP_GRACE_MS = 60_000;

const KINDS: Kind[] = ["atom", "greenhouse", "hn", "page", "youtube_page"];

function stub(env: Env, watcherId: string) {
  return env.WATCHER.get(env.WATCHER.idFromName(watcherId));
}

const body = <T>(req: Request) => readJson<T>(req);

interface NewWatcher {
  id: string;
  kind: Kind;
  url: string;
  interval_s: number;
  hot_interval_s?: number;
  hot_window_s?: number;
  hot_rule?: string;
  notify_rule?: string;
  notify_all_new?: boolean;
  fallback_url?: string;
  fallback_kind?: Kind;
  first_check_in_s?: number;
}

async function createWatcher(env: Env, w: NewWatcher) {
  if (!w.id || !KINDS.includes(w.kind) || !w.url || !(w.interval_s > 0)) {
    throw new HttpError(400, `watcher needs id, kind (${KINDS.join("|")}), url and interval_s > 0`);
  }
  if (w.fallback_url && !(w.fallback_kind && KINDS.includes(w.fallback_kind))) throw new HttpError(400, "fallback_url needs a fallback_kind");
  for (const rule of [w.hot_rule, w.notify_rule]) {
    if (!rule) continue;
    try {
      new RegExp(rule, "i");
    } catch {
      throw new HttpError(400, `not a valid regex: ${rule}`);
    }
  }
  const now = Date.now();
  const first = now + (w.first_check_in_s ?? 0) * 1000;
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO watchers (id, kind, url, next_check_at, interval_s, hot_interval_s, hot_window_s, hot_rule,
       notify_rule, notify_all_new, fallback_url, fallback_kind, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) RETURNING id`,
  )
    .bind(
      w.id,
      w.kind,
      w.url,
      first,
      w.interval_s,
      w.hot_interval_s ?? w.interval_s,
      w.hot_window_s ?? 0,
      w.hot_rule ?? null,
      w.notify_rule ?? null,
      w.notify_all_new ? 1 : 0,
      w.fallback_url ?? null,
      w.fallback_kind ?? null,
      now,
    )
    .all();
  if (inserted.results.length === 0) throw new HttpError(409, `watcher ${w.id} already exists`);
  await stub(env, w.id).start(w.id, first);
  return { id: w.id, first_check_at: first };
}

async function claimJob(env: Env, b: { types: string[]; owner: string; ttl_s: number }) {
  if (!Array.isArray(b.types) || !b.owner || !(b.ttl_s > 0)) throw new HttpError(400, "claim needs types[], owner, ttl_s > 0");
  const now = Date.now();
  // One statement, so two claimants cannot both take the same row.
  return env.DB.prepare(
    `UPDATE jobs SET state = 'claimed', owner = ?2, lease_until = ?3, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE type IN (SELECT value FROM json_each(?1))
         AND (state = 'queued' OR (state = 'claimed' AND lease_until < ?4))
       ORDER BY id LIMIT 1)
     RETURNING *`,
  )
    .bind(JSON.stringify(b.types), b.owner, now + b.ttl_s * 1000, now)
    .first();
}

// Only the current lease holder can complete. A worker whose lease expired
// and was reclaimed gets 409 instead of overwriting the new owner's work.
async function completeJob(env: Env, id: number, b: { owner: string; output?: unknown }) {
  const row = await env.DB.prepare(
    `UPDATE jobs SET state = 'done', output = ?3, lease_until = NULL
     WHERE id = ?1 AND owner = ?2 AND state = 'claimed' RETURNING *`,
  )
    .bind(id, b.owner, JSON.stringify(b.output ?? null))
    .first();
  if (!row) throw new HttpError(409, `job ${id} is not claimed by ${b.owner}`);
  return row;
}

async function watcherDetail(env: Env, id: string) {
  const w = await env.DB.prepare("SELECT * FROM watchers WHERE id = ?").bind(id).first<WatcherRow>();
  if (!w) throw new HttpError(404, `watcher ${id} not found`);
  const [events, log, jobs] = await Promise.all([
    env.DB.prepare("SELECT * FROM events WHERE watcher_id = ? ORDER BY id").bind(id).all(),
    env.DB.prepare("SELECT * FROM fetch_log WHERE watcher_id = ? ORDER BY id").bind(id).all(),
    env.DB.prepare(
      `SELECT jobs.* FROM jobs JOIN events ON json_extract(jobs.input, '$.event_id') = events.id
       WHERE events.watcher_id = ? ORDER BY jobs.id`,
    )
      .bind(id)
      .all(),
  ]);
  const seen = await env.DB.prepare("SELECT count(*) AS n FROM seen_items WHERE watcher_id = ?").bind(id).first<{ n: number }>();
  return { watcher: w, alarm_at: await stub(env, id).alarmAt(), seen_items: seen?.n ?? 0, events: events.results, jobs: jobs.results, fetch_log: log.results };
}

type Handler = (req: Request, env: Env, url: URL, params: string[], ctx: ExecutionContext, caller: Caller) => Promise<Response>;

interface Route {
  method: "GET" | "POST" | "PUT";
  path: RegExp;
  // Tokens that may call this route besides ADMIN_TOKEN, which may call all.
  scopes: Scope[];
  // Only `scopes` may call it; ADMIN_TOKEN gets 403 too.
  exclusive?: true;
  handler: Handler;
}

const ok = (p: Promise<unknown>, status = 200) => p.then((data) => json(data, status));

const MAIL_AGENTS: Scope[] = ["agent:dot", "agent:t3", "agent:grok"];
// The low-risk calls an enrolled phone makes with its device token. Deciding
// an approval takes a signature instead (POST /approvals/:id/decide, below).
const DEVICE: Scope[] = ["device"];

// docs/CONTRACT.md, "Tokens". A token not listed for a route gets 403.
const ROUTES: Route[] = [
  { method: "POST", path: /^\/ingest\/x$/, scopes: ["ingest"], handler: (req, env) => ok(ingest(env, req)) },
  { method: "POST", path: /^\/ingest\/x\/status$/, scopes: ["ingest"], handler: (req, env) => ok(ingestStatus(env, req)) },
  { method: "GET", path: /^\/x\/detail-queue$/, scopes: ["ingest"], handler: (_r, env, url) => ok(detailQueue(env, url)) },
  { method: "POST", path: /^\/x\/sessions\/start$/, scopes: ["ingest"], handler: (req, env) => startSession(env, req) },
  { method: "GET", path: /^\/x\/posts$/, scopes: ["runner"], handler: (_r, env, url) => ok(listPosts(env, url)) },
  { method: "POST", path: /^\/x\/posts\/scores$/, scopes: ["runner"], handler: (req, env) => ok(saveScores(env, req)) },
  { method: "GET", path: /^\/x\/posts\/([^/]+)\/context$/, scopes: ["runner"], handler: (_r, env, _u, [id]) => ok(postContext(env, id)) },
  { method: "POST", path: /^\/embed$/, scopes: ["runner", "kworker"], handler: (req, env, _u, _p, ctx) => embed(env, req, ctx) },
  { method: "POST", path: /^\/positives$/, scopes: ["runner"], handler: (req, env) => ok(addPositives(env, req)) },
  { method: "GET", path: /^\/positives$/, scopes: ["runner", "kworker"], handler: (_r, env, url) => ok(listPositives(env, url)) },
  {
    method: "POST",
    path: /^\/candidates$/,
    scopes: ["runner"],
    handler: async (req, env) => {
      const r = await createCandidate(env, await body(req));
      return json(r.body, r.status);
    },
  },
  { method: "GET", path: /^\/candidates$/, scopes: ["runner"], handler: (_r, env, url) => ok(listCandidates(env, url)) },
  {
    method: "POST",
    path: /^\/proposals$/,
    scopes: ["runner"],
    handler: async (req, env) => {
      const r = await createProposal(env, req);
      return json(r.body, r.status);
    },
  },
  { method: "GET", path: /^\/proposals$/, scopes: ["runner"], handler: (_r, env, url) => ok(listProposals(env, url)) },
  { method: "POST", path: /^\/proposals\/([^/]+)\/rotate-token$/, scopes: ["runner"], handler: (req, env, _u, [id]) => ok(rotateToken(env, id, req)) },
  { method: "GET", path: /^\/admin\/log$/, scopes: [], handler: (_r, env, url) => ok(activityLog(env, url)) },
  // GrokBot's route alone, so nothing the director sends can be counted as one of its runs.
  { method: "POST", path: /^\/inbox\/x$/, scopes: ["inbox"], exclusive: true, handler: (req, env) => inbox(env, req) },
  { method: "GET", path: /^\/admin\/inbox\/x$/, scopes: [], handler: (_r, env, url) => ok(inboxExport(env, url)) },
  { method: "GET", path: /^\/admin\/x\/sightings$/, scopes: [], handler: (_r, env, url) => ok(sightingsExport(env, url)) },
  // Lenses (docs/LENS.md): the reader labels, reads, re-polls and baselines
  // with the ingest token; creating a lens is admin only.
  { method: "POST", path: /^\/lenses$/, scopes: [], handler: (req, env) => ok(upsertLens(lensEnv(env, ROUTE_LIMITS), req)) },
  { method: "GET", path: /^\/lenses$/, scopes: ["ingest", "runner"], handler: (_r, env, url) => ok(listLenses(lensEnv(env, ROUTE_LIMITS), url)) },
  { method: "POST", path: /^\/lenses\/backgrounds\/refresh$/, scopes: ["runner"], handler: (req, env) => ok(refreshBackground(lensEnv(env, ROUTE_LIMITS), req)) },
  { method: "GET", path: /^\/lenses\/signals$/, scopes: ["runner"], handler: (_r, env, url) => ok(signals(lensEnv(env, ROUTE_LIMITS), url)) },
  { method: "GET", path: /^\/lenses\/repolls\/due$/, scopes: ["ingest"], handler: (_r, env, url) => ok(dueRepolls(lensEnv(env, ROUTE_LIMITS), url)) },
  { method: "POST", path: /^\/lenses\/repolls\/done$/, scopes: ["ingest"], handler: (req, env) => ok(doneRepolls(lensEnv(env, ROUTE_LIMITS), req)) },
  { method: "POST", path: /^\/lenses\/([a-z0-9-]+)\/label$/, scopes: ["ingest"], handler: (req, env, _u, [id]) => ok(labelPosts(lensEnv(env, ROUTE_LIMITS), id, req)) },
  { method: "POST", path: /^\/lenses\/([a-z0-9-]+)\/reads$/, scopes: ["ingest"], handler: (req, env, _u, [id]) => ok(recordReads(lensEnv(env, ROUTE_LIMITS), id, req)) },
  { method: "POST", path: /^\/lenses\/([a-z0-9-]+)\/baseline$/, scopes: ["ingest"], handler: (req, env, _u, [id]) => ok(recordBaseline(lensEnv(env, ROUTE_LIMITS), id, req)) },
  { method: "GET", path: /^\/lenses\/([a-z0-9-]+)\/scorecard$/, scopes: ["runner"], handler: (_r, env, url, [id]) => ok(scorecard(lensEnv(env, ROUTE_LIMITS), id, url)) },
  { method: "POST", path: /^\/candidates\/claim$/, scopes: ["runner"], handler: async (req, env) => ok(claimCandidates(env, await body(req))) },
  { method: "POST", path: /^\/candidates\/([^/]+)\/complete$/, scopes: ["runner"], handler: async (req, env, _u, [id]) => ok(completeCandidate(env, id, await body(req))) },
  // Mailbox (src/mailbox.ts). The admin token speaks as agent "sam".
  { method: "POST", path: /^\/mcp$/, scopes: MAIL_AGENTS, handler: (req, env, _u, _p, ctx, caller) => mcp(env, ctx, agentOf(caller.scope), req) },
  { method: "POST", path: /^\/mail\/tasks$/, scopes: MAIL_AGENTS, handler: (req, env, _u, _p, ctx, caller) => restSend(env, ctx, caller.scope, req) },
  { method: "GET", path: /^\/mail\/tasks$/, scopes: [], handler: (_r, env, url) => ok(listTasks(env, url)) },
  { method: "POST", path: /^\/mail\/claim$/, scopes: MAIL_AGENTS, handler: (req, env, _u, _p, ctx, caller) => restClaim(env, ctx, caller.scope, req) },
  { method: "POST", path: /^\/mail\/ack$/, scopes: MAIL_AGENTS, handler: (req, env, _u, _p, _c, caller) => restAck(env, caller.scope, req) },
  { method: "POST", path: /^\/mail\/tasks\/([^/]+)\/complete$/, scopes: MAIL_AGENTS, handler: (req, env, _u, [id], ctx, caller) => restComplete(env, ctx, caller.scope, id, req) },
  { method: "GET", path: /^\/admin\/mailbox$/, scopes: [], handler: (_r, env) => ok(mailboxStatus(env)) },
  { method: "POST", path: /^\/admin\/mailbox\/pause$/, scopes: [], handler: (req, env) => ok(setPaused(env, req)) },
  // Devices, approvals, inbox, brief and voice (docs/APPROVALS.md).
  { method: "POST", path: /^\/devices\/enroll-codes$/, scopes: [], handler: (_r, env) => ok(mintEnrollCode(env), 201) },
  { method: "GET", path: /^\/devices$/, scopes: [], handler: (_r, env) => ok(listDevices(env)) },
  { method: "POST", path: /^\/devices\/([^/]+)\/apns-token$/, scopes: DEVICE, handler: (req, env, _u, [id], _c, caller) => ok(updateApnsToken(env, caller.deviceId, id, req)) },
  { method: "POST", path: /^\/devices\/([^/]+)\/live-activity-token$/, scopes: DEVICE, handler: (req, env, _u, [id], _c, caller) => ok(updateLiveActivityToken(env, caller.deviceId, id, req)) },
  // A device token may revoke only its own device (checked in revoke).
  { method: "POST", path: /^\/devices\/([^/]+)\/revoke$/, scopes: DEVICE, handler: (_r, env, _u, [id], _c, caller) => ok(revoke(env, caller, id)) },
  { method: "GET", path: /^\/approvals$/, scopes: DEVICE, handler: (_r, env, url) => ok(listApprovals(env, url)) },
  { method: "GET", path: /^\/approvals\/([^/]+)$/, scopes: DEVICE, handler: (_r, env, _u, [id]) => ok(getApproval(env, id)) },
  { method: "POST", path: /^\/inbox$/, scopes: [...DEVICE, ...MAIL_AGENTS], handler: (req, env, _u, _p, _c, caller) => ok(inboxRoute(env, caller, req), 201) },
  { method: "GET", path: /^\/brief$/, scopes: [...DEVICE, "agent:dot"], handler: (_r, env) => ok(brief(env)) },
  { method: "POST", path: /^\/voice$/, scopes: DEVICE, handler: (req, env, _u, _p, ctx, caller) => ok(uploadVoice(env, ctx, caller, req), 201) },
  { method: "GET", path: /^\/voice\/([^/]+)$/, scopes: DEVICE, handler: (_r, env, _u, [id], _c, caller) => ok(voiceStatus(env, caller, id)) },
  { method: "GET", path: /^\/routing\/models$/, scopes: DEVICE, handler: (_r, env) => ok(publishTable(env)) },
  { method: "POST", path: /^\/inbox\/([^/]+)\/route$/, scopes: DEVICE, handler: (req, env, _u, [id]) => ok(correctRouting(env, id, req)) },
  { method: "POST", path: /^\/inbox\/([^/]+)\/dispatch$/, scopes: DEVICE, handler: (_r, env, _u, [id], ctx) => ok(dispatch(env, ctx, id)) },
  { method: "POST", path: /^\/admin\/routing$/, scopes: [], handler: (req, env) => ok(setTable(env, req)) },
  { method: "GET", path: /^\/admin\/pr-allowlist$/, scopes: [], handler: async (_r, env) => json({ repos: await repoAllowlist(env) }) },
  { method: "POST", path: /^\/admin\/pr-allowlist$/, scopes: [], handler: async (req, env) => ok(setRepoAllowlist(env, await body(req))) },
  // Agents as models (src/bridge.ts), for CLIProxyAPI.
  { method: "GET", path: /^\/v1\/models$/, scopes: ["bridge"], handler: async () => json(listModels()) },
  { method: "POST", path: /^\/v1\/chat\/completions$/, scopes: ["bridge"], handler: (req, env, _u, _p, ctx) => chatCompletions(env, ctx, req) },
  // Knowledge store (src/knowledge/routes.ts). Its handlers take the bare
  // scope; none reads it.
  ...KNOWLEDGE_ROUTES.map((r) => ({ ...r, handler: ((req, env, url, params, ctx, caller) => r.handler(req, env, url, params, ctx, caller.scope)) as Handler })),
];

function match(req: Request, url: URL): { route: Route; params: string[] } | "wrong_method" | null {
  let pathMatched = false;
  for (const route of ROUTES) {
    const m = url.pathname.match(route.path);
    if (!m) continue;
    pathMatched = true;
    if (route.method === req.method) return { route, params: m.slice(1).map(decodeURIComponent) };
  }
  return pathMatched ? "wrong_method" : null;
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);

  // Public, and reveals nothing beyond liveness and the last cron run.
  if (url.pathname === "/health" && req.method === "GET") {
    const [cron, paused] = await Promise.all([
      env.DB.prepare("SELECT * FROM cron_runs ORDER BY id DESC LIMIT 1").first<{ ts: number; cron: string; overdue_checked: number; notifications_retried: number }>(),
      env.DB.prepare("SELECT value FROM settings WHERE key = 'notifications_paused'").first<{ value: string }>(),
    ]);
    return json({
      ok: true,
      last_cron_at: cron ? new Date(cron.ts).toISOString() : null,
      last_cron: cron,
      notifications_paused: paused?.value === "1",
    });
  }

  // Public: the approval link is its own credential.
  if (parts[0] === "a" && parts.length === 2) {
    if (req.method === "GET") return approvalPage(env, parts[1]);
    if (req.method === "POST") return decide(env, parts[1], req);
    throw new HttpError(405, `${req.method} is not allowed on /a/:token`);
  }

  // Public: WebSub verification and delivery, authenticated by the hub's HMAC.
  if (parts[0] === "websub" && parts.length === 2) {
    if (req.method === "GET") return handleVerification(env, parts[1], url);
    if (req.method === "POST") return handleDelivery(env, parts[1], req);
  }

  // Public: the mailbox URL and the room link carry their own secrets.
  if (parts[0] === "mcp" && parts.length === 3) {
    if (req.method !== "POST") throw new HttpError(405, "the MCP endpoint takes POST");
    return mcpByPath(env, ctx, parts[1], parts[2], req);
  }
  if (parts[0] === "room" && parts.length === 2 && req.method === "GET") return room(env, parts[1]);
  // Public: the enrollment code is the credential.
  if (url.pathname === "/devices/enroll" && req.method === "POST") return json(await enroll(env, req), 201);
  // Public: the device's signature is the credential, checked before anything is recorded.
  if (parts[0] === "approvals" && parts.length === 3 && parts[2] === "decide" && req.method === "POST") return decideApproval(env, decodeURIComponent(parts[1]), req);
  // No OAuth here. A 404 tells an MCP client probing for OAuth metadata that
  // there is none, where a 401 would suggest it needs a token.
  if (parts[0] === ".well-known") return json({ error: "not found" }, 404);

  const caller = await callerScope(req, env);
  const scope = caller.scope;
  const found = match(req, url);
  if (found === "wrong_method") throw new HttpError(405, `${req.method} is not allowed on ${url.pathname}`);
  if (found) {
    const allowed = found.route.scopes.includes(scope) || (scope === "admin" && !found.route.exclusive);
    if (!allowed) throw new HttpError(403, `the ${scope} token cannot call ${req.method} ${url.pathname}`);
    return found.route.handler(req, env, url, found.params, ctx, caller);
  }
  // Everything below is the watcher administration API: ADMIN_TOKEN only.
  if (scope !== "admin") throw new HttpError(403, `the ${scope} token cannot call ${req.method} ${url.pathname}`);

  if (parts[0] === "admin" && parts[1] === "watchers") {
    const id = parts[2];
    if (!id && req.method === "POST") return json(await createWatcher(env, await body<NewWatcher>(req)), 201);
    if (!id && req.method === "GET") return json((await env.DB.prepare("SELECT * FROM watchers ORDER BY id").all()).results);
    if (id && parts.length === 3 && req.method === "GET") return json(await watcherDetail(env, id));
    if (id && parts[3] === "check" && req.method === "POST") return json(await stub(env, id).checkNow("manual"));
    if (id && parts[3] === "drop-alarm" && req.method === "POST") {
      await stub(env, id).dropAlarm();
      return json({ id, alarm_at: await stub(env, id).alarmAt() });
    }
    if (id && parts[3] === "websub" && req.method === "POST") {
      const b = await body<{ callback: string; mode: "subscribe" | "unsubscribe" }>(req);
      return json(await requestSubscription(env, id, b.callback, b.mode));
    }
  }
  if (parts[0] === "admin" && parts[1] === "events" && req.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
    const watcher = url.searchParams.get("watcher_id");
    const q = watcher
      ? env.DB.prepare("SELECT * FROM events WHERE watcher_id = ? ORDER BY id DESC LIMIT ?").bind(watcher, limit)
      : env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").bind(limit);
    return json((await q.all()).results);
  }
  if (parts[0] === "admin" && parts[1] === "notifications" && !parts[2] && req.method === "GET") {
    const day = utcDay(Date.now());
    const [used, recent, paused, legacy] = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare("SELECT count(*) AS n FROM proposals WHERE notify_day = ? AND notify_state IN ('pending', 'sent', 'failed')").bind(day),
      env.DB.prepare(
        `SELECT id, title, state, notify_state, notify_day, notify_status, notify_error, notified_at, created_at FROM proposals
         WHERE notify_state IS NOT NULL ORDER BY created_at DESC LIMIT 50`,
      ),
      env.DB.prepare("SELECT value FROM settings WHERE key = 'notifications_paused'"),
      // Watcher matches stopped notifying in v2; these rows are from before.
      env.DB.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT 100"),
    ]);
    return json({
      day,
      approvals_used_today: used.results[0].n,
      daily_cap: APPROVAL_DAILY_CAP,
      paused: paused.results[0]?.value === "1",
      approvals: recent.results,
      legacy_watcher_notifications: legacy.results,
    });
  }
  if (parts[0] === "admin" && parts[1] === "notifications" && parts[2] === "pause" && req.method === "POST") {
    const b = await body<{ paused: boolean }>(req);
    if (typeof b.paused !== "boolean") throw new HttpError(400, "body needs paused: true|false");
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('notifications_paused', ?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = ?2`,
    )
      .bind(b.paused ? "1" : "0", Date.now())
      .run();
    return json({ notifications_paused: b.paused });
  }
  if (parts[0] === "admin" && parts[1] === "websub" && req.method === "GET") {
    return json((await env.DB.prepare("SELECT * FROM websub_subscriptions").all()).results);
  }
  if (parts[0] === "admin" && parts[1] === "stats" && req.method === "GET") {
    const totals = await env.DB.prepare(
      `SELECT watcher_id, count(*) AS fetches, sum(model_calls) AS model_calls, sum(subrequests) AS subrequests,
              sum(events_created) AS events, sum(bytes) AS bytes
       FROM fetch_log GROUP BY watcher_id ORDER BY watcher_id`,
    ).all();
    const all = await env.DB.prepare(
      `SELECT count(*) AS fetches, coalesce(sum(model_calls), 0) AS model_calls, coalesce(sum(subrequests), 0) AS subrequests,
              (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM jobs) AS jobs
       FROM fetch_log`,
    ).first();
    return json({ all, per_watcher: totals.results });
  }

  if (parts[0] === "jobs") {
    if (parts.length === 1 && req.method === "POST") {
      const b = await body<{ type: string; input?: unknown }>(req);
      if (!b.type) throw new HttpError(400, "job needs type");
      return json(
        await env.DB.prepare("INSERT INTO jobs (type, input, created_at) VALUES (?1, ?2, ?3) RETURNING *")
          .bind(b.type, JSON.stringify(b.input ?? null), Date.now())
          .first(),
        201,
      );
    }
    if (parts[1] === "claim" && req.method === "POST") {
      const job = await claimJob(env, await body(req));
      return job ? json(job) : new Response(null, { status: 204 });
    }
    if (parts.length === 3 && parts[2] === "complete" && req.method === "POST") {
      return json(await completeJob(env, Number(parts[1]), await body(req)));
    }
    if (parts.length === 2 && req.method === "GET") {
      const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(Number(parts[1])).first();
      return job ? json(job) : json({ error: "not found" }, 404);
    }
  }

  return json({ error: "not found" }, 404);
}

// What happened since a time, for the director's morning report. Each list is
// capped at 200 rows; the counts are exact.
async function activityLog(env: Env, url: URL) {
  const now = Date.now();
  const since = timeParam(url, "since") ?? now - 24 * 3600 * 1000;
  const db = env.DB;
  const [counts, sessions, candidates, proposals, events, cron] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT (SELECT count(*) FROM x_posts WHERE first_seen_at >= ?1) AS new_posts,
                (SELECT count(*) FROM x_sightings WHERE seen_at >= ?1) AS sightings,
                (SELECT count(*) FROM candidates WHERE created_at >= ?1) AS candidates_created,
                (SELECT count(*) FROM proposals WHERE created_at >= ?1) AS proposals_created,
                (SELECT count(*) FROM events WHERE ts >= ?1) AS watcher_events,
                (SELECT count(*) FROM fetch_log WHERE ts >= ?1) AS watcher_checks,
                (SELECT count(*) FROM fetch_log WHERE ts >= ?1 AND outcome = 'error') AS watcher_errors,
                (SELECT count(*) FROM cron_runs WHERE ts >= ?1) AS cron_runs`,
      )
      .bind(since),
    db.prepare("SELECT * FROM x_sessions WHERE started_at >= ?1 OR ended_at >= ?1 ORDER BY started_at DESC LIMIT 200").bind(since),
    db.prepare("SELECT id, kind, ref, title, url, score, state, owner, attempts, origin, note, created_at, updated_at FROM candidates WHERE updated_at >= ?1 ORDER BY updated_at DESC LIMIT 200").bind(since),
    db.prepare("SELECT * FROM proposals WHERE created_at >= ?1 OR decided_at >= ?1 ORDER BY created_at DESC LIMIT 200").bind(since),
    db.prepare("SELECT id, watcher_id, ts, kind, dedupe_key FROM events WHERE ts >= ?1 ORDER BY id DESC LIMIT 200").bind(since),
    db.prepare("SELECT * FROM cron_runs ORDER BY id DESC LIMIT 1"),
  ]);
  return {
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    counts: counts.results[0],
    last_cron: cron.results[0] ?? null,
    x_sessions: sessions.results,
    candidates: candidates.results,
    proposals: (proposals.results as unknown as Parameters<typeof presentProposal>[0][]).map(presentProposal),
    watcher_events: events.results,
  };
}

// Path segments that are credentials: /a/<token>, /room/<token>, /mcp/<agent>/<token>.
function redactPath(path: string): string {
  return path.replace(/^\/(a|room)\/[^/]+/, "/$1/<redacted>").replace(/^\/mcp\/([^/]+)\/[^/]+/, "/mcp/$1/<redacted>");
}

// Routes the iPhone app calls. Their refusals are { error: <code>, message }
// (docs/APPROVALS.md, "Wire details" 4), because the app reads every non-2xx
// body that way (Nod, NodKit/Network/WorkerClient.swift). GrokBot's
// /inbox/x keeps its own format.
const APP_PATH = /^\/(?:devices|approvals|brief|voice|routing)(?:\/|$)|^\/inbox(?:$|\/(?!x$)[^/]+\/(?:route|dispatch)$)/;
const CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  410: "gone",
  411: "length_required",
  413: "body_too_large",
  415: "unsupported_media_type",
  422: "unprocessable",
  423: "paused",
  429: "rate_limited",
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      const path = new URL(req.url).pathname;
      const app = APP_PATH.test(path);
      if (e instanceof HttpError && app) return json({ error: e instanceof MailRefusal ? e.rule : (CODES[e.status] ?? "error"), message: e.message }, e.status);
      // /k/ routes answer { error: <code>, message } (docs/KNOWLEDGE.md).
      if (e instanceof HttpError) return json(path.startsWith("/k/") ? knowledgeErrorBody(e) : { error: e.message }, e.status);
      // An unexpected error's message can hold a URL or query text, so the
      // caller gets only an id to quote, and the log gets the path with any
      // token segment redacted.
      const requestId = randomHex(8);
      console.error(`[error] ${requestId} ${req.method} ${redactPath(new URL(req.url).pathname)}`, e);
      if (app) return json({ error: "internal_error", message: `The Worker failed; quote ${requestId} when reporting it.`, request_id: requestId }, 500);
      return json({ error: "internal error", request_id: requestId }, 500);
    }
  },

  // The one cron (Workers Free allows five per account). Watchers schedule
  // themselves; this catches lost alarms and records the run for /health.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    // One budget for the whole run (src/lens-budget.ts): the lens refresh is
    // charged together with the cron's own D1 calls.
    const lx = lensEnv(env, CRON_LIMITS);
    const { results } = await lx.db.prepare(
      "SELECT id, next_check_at FROM watchers WHERE enabled = 1 AND next_check_at < ? ORDER BY id",
    )
      .bind(now - BACKSTOP_GRACE_MS)
      .all<{ id: string; next_check_at: number }>();
    console.log(`[backstop] cron="${controller.cron}" overdue_watchers=${results.length}`);
    for (const w of results) {
      console.log(`[backstop] ${w.id} overdue by ${Math.round((now - w.next_check_at) / 1000)}s; alarm presumed lost, checking now`);
      const r = await stub(env, w.id).checkNow("backstop");
      console.log(`[backstop] ${w.id} re-armed, next check in ${r.next_interval_s}s`);
    }
    // expireProposals (src/proposals.ts) is one UPDATE on the raw binding.
    lx.budget.d1("expire proposals");
    const expired = await expireProposals(env, now);
    const requestsExpired = await expireApprovalRequests(env, now);
    const backfilled = await backfillApprovalRequests(env, now);
    const mail = await mailboxCron(env, now);
    const voice = await voiceCron(env, now);
    // Lens backgrounds (src/lens.ts): one due account per run. A failure is
    // the account's own, recorded in lens_background_attempts; this catch is
    // for the lookup around it, so the run is still recorded below.
    try {
      // The cron_runs row below is the one D1 call after it.
      const bg = await refreshDueBackgrounds(lx, now, 1);
      if (bg?.done) console.log(`[cron] lens background retaken: ${bg.account} v${bg.done.version}`);
      if (bg?.error) console.log(`[cron] lens background of ${bg.account} failed: ${bg.error}`);
    } catch (err) {
      console.log(`[cron] lens backgrounds: ${(err as Error).message}`);
    }
    await lx.db.prepareReserved("INSERT INTO cron_runs (ts, cron, overdue_checked, notifications_retried) VALUES (?1, ?2, ?3, 0)")
      .bind(now, controller.cron, results.length)
      .run();
    console.log(`[cron] done overdue_checked=${results.length} proposals_expired=${expired} mail_tasks_expired=${mail.expired} mail_tasks_requeued=${mail.requeued} wakes_retried=${mail.retried} requests_expired=${requestsExpired} requests_backfilled=${backfilled} voice_retried=${voice}`);
  },
} satisfies ExportedHandler<Env>;
