import type { Kind } from "./adapters";
import { callerScope, type Scope } from "./auth";
import { claimCandidates, completeCandidate, createCandidate, listCandidates } from "./candidates";
import type { Env, WatcherRow } from "./check";
import { HttpError, json, readJson } from "./http";
import { handleDelivery, handleVerification, requestSubscription } from "./websub";
import { addPositives, detailQueue, embed, ingest, ingestStatus, listPositives, listPosts, postContext, saveScores } from "./x";

export { WatcherDO } from "./watcher";

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

type Handler = (req: Request, env: Env, url: URL, params: string[]) => Promise<Response>;

interface Route {
  method: "GET" | "POST";
  path: RegExp;
  // Tokens that may call this route besides ADMIN_TOKEN, which may call all.
  scopes: Scope[];
  handler: Handler;
}

const ok = (p: Promise<unknown>, status = 200) => p.then((data) => json(data, status));

// docs/CONTRACT.md, "Tokens". A token not listed for a route gets 403.
const ROUTES: Route[] = [
  { method: "POST", path: /^\/ingest\/x$/, scopes: ["ingest"], handler: (req, env) => ok(ingest(env, req)) },
  { method: "POST", path: /^\/ingest\/x\/status$/, scopes: ["ingest"], handler: (req, env) => ok(ingestStatus(env, req)) },
  { method: "GET", path: /^\/x\/detail-queue$/, scopes: ["ingest"], handler: (_r, env, url) => ok(detailQueue(env, url)) },
  { method: "GET", path: /^\/x\/posts$/, scopes: ["runner"], handler: (_r, env, url) => ok(listPosts(env, url)) },
  { method: "POST", path: /^\/x\/posts\/scores$/, scopes: ["runner"], handler: (req, env) => ok(saveScores(env, req)) },
  { method: "GET", path: /^\/x\/posts\/([^/]+)\/context$/, scopes: ["runner"], handler: (_r, env, _u, [id]) => ok(postContext(env, id)) },
  { method: "POST", path: /^\/embed$/, scopes: ["runner"], handler: (req, env) => ok(embed(env, req)) },
  { method: "POST", path: /^\/positives$/, scopes: ["runner"], handler: (req, env) => ok(addPositives(env, req)) },
  { method: "GET", path: /^\/positives$/, scopes: ["runner"], handler: (_r, env, url) => ok(listPositives(env, url)) },
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
  { method: "POST", path: /^\/candidates\/claim$/, scopes: ["runner"], handler: async (req, env) => ok(claimCandidates(env, await body(req))) },
  { method: "POST", path: /^\/candidates\/([^/]+)\/complete$/, scopes: ["runner"], handler: async (req, env, _u, [id]) => ok(completeCandidate(env, id, await body(req))) },
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

async function route(req: Request, env: Env): Promise<Response> {
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

  // Public: WebSub verification and delivery, authenticated by the hub's HMAC.
  if (parts[0] === "websub" && parts.length === 2) {
    if (req.method === "GET") return handleVerification(env, parts[1], url);
    if (req.method === "POST") return handleDelivery(env, parts[1], req);
  }

  const scope = await callerScope(req, env);
  const found = match(req, url);
  if (found === "wrong_method") throw new HttpError(405, `${req.method} is not allowed on ${url.pathname}`);
  if (found) {
    if (scope !== "admin" && !found.route.scopes.includes(scope)) throw new HttpError(403, `the ${scope} token cannot call ${req.method} ${url.pathname}`);
    return found.route.handler(req, env, url, found.params);
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
    // Watcher notifications stopped in v2; these are the rows from before.
    return json({ legacy_watcher_notifications: (await env.DB.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT 100").all()).results });
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },

  // The one cron (Workers Free allows five per account). Watchers schedule
  // themselves; this catches lost alarms and records the run for /health.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    const { results } = await env.DB.prepare(
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
    await env.DB.prepare("INSERT INTO cron_runs (ts, cron, overdue_checked, notifications_retried) VALUES (?1, ?2, ?3, 0)")
      .bind(now, controller.cron, results.length)
      .run();
    console.log(`[cron] done overdue_checked=${results.length}`);
  },
} satisfies ExportedHandler<Env>;
