import { fingerprint, parse, type Item, type Kind, type Parsed } from "./adapters";
import { notifyMatches } from "./notify";
import type { WatcherDO } from "./watcher";

export interface Env {
  DB: D1Database;
  WATCHER: DurableObjectNamespace<WatcherDO>;
  ADMIN_TOKEN: string;
  WEBSUB_SECRET: string;
  T3_WEBHOOK_URL?: string;
}

export interface WatcherRow {
  id: string;
  kind: Kind;
  url: string;
  etag: string | null;
  last_modified: string | null;
  fingerprint: string | null;
  next_check_at: number;
  interval_s: number;
  hot_interval_s: number;
  hot_window_s: number;
  hot_until: number | null;
  hot_rule: string | null;
  notify_rule: string | null;
  notify_all_new: number;
  fallback_url: string | null;
  fallback_kind: Kind | null;
  mode: "normal" | "hot";
  consecutive_failures: number;
  last_status: number | null;
  enabled: number;
  created_at: number;
}

export type Trigger = "alarm" | "manual" | "backstop" | "push";
export type Outcome = "seeded" | "not_modified" | "same_fingerprint" | "changed" | "error";

export interface CheckResult {
  watcher_id: string;
  trigger: Trigger;
  source: "primary" | "fallback";
  status: number;
  bytes: number;
  latency_ms: number;
  conditional: boolean;
  outcome: Outcome;
  items_seen: number;
  events_created: number;
  notified: boolean;
  subrequests: number;
  model_calls: number;
  mode: "normal" | "hot";
  next_interval_s: number;
  next_check_at: number;
  error: string | null;
}

// Hosts of model APIs a later triage stage might call. A check that reached
// any of them would show up as model_calls > 0 in fetch_log.
const MODEL_HOSTS = new Set([
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.x.ai",
  "openrouter.ai",
  "gateway.ai.cloudflare.com",
  "api.mistral.ai",
  "api.groq.com",
  "api.together.xyz",
]);

const USER_AGENT = "discovery-watcher/0.2 (personal feed watcher; polls each source at most every 30 min)";
const MAX_BACKOFF_S = 6 * 3600;

// The only fetch a check uses for its source, so the counts in fetch_log
// cover every source request. The T3 webhook POST is counted in notifications.
class Outbound {
  subrequests = 0;
  modelCalls = 0;

  fetch(url: string, init: RequestInit): Promise<Response> {
    this.subrequests++;
    if (MODEL_HOSTS.has(new URL(url).hostname)) this.modelCalls++;
    return fetch(url, init);
  }
}

export function matches(rule: string | null, text: string): boolean {
  return rule !== null && new RegExp(rule, "i").test(text);
}

type RuleWatcher = Pick<WatcherRow, "id" | "url" | "hot_rule" | "notify_rule" | "notify_all_new">;

// A hot_rule match shortens the interval and notifies; a notify_rule match
// only notifies. notify_all_new makes every new item notify, but seeded
// items only notify through a rule match.
function classify(w: RuleWatcher, text: string, isNew: boolean) {
  const hot = matches(w.hot_rule, text);
  return { hot, notify: hot || matches(w.notify_rule, text) || (isNew && w.notify_all_new === 1) };
}

function describeRule(w: RuleWatcher): string {
  const rules = [w.hot_rule, w.notify_rule].filter(Boolean).map((r) => `/${r}/i`);
  if (w.notify_all_new === 1) rules.push("notify on every new item");
  return rules.join(" or ");
}

// Inserts events for items this watcher has not seen, then marks every item
// seen, in one transaction. The events_enqueue trigger adds one triage job per
// inserted event. Rule-matched events among those inserted become one
// notification. An item already in seen_items, or a dedupe_key already in
// events, inserts nothing and so notifies nothing.
export async function recordItems(
  env: Env,
  w: RuleWatcher,
  items: Item[],
  now: number,
): Promise<{ created: number; hot: boolean; notified: boolean }> {
  const db = env.DB;
  const payload = JSON.stringify(items.map((i) => ({ ...i, ...classify(w, i.title, true) })));
  const [inserted] = await db.batch<{ dedupe_key: string; payload: string }>([
    db
      .prepare(
        `INSERT OR IGNORE INTO events (watcher_id, ts, kind, dedupe_key, payload)
         SELECT ?1, ?2, 'item.new', ?1 || ':' || json_extract(value, '$.id'), value
         FROM json_each(?3)
         WHERE json_extract(value, '$.id') NOT IN (SELECT item_id FROM seen_items WHERE watcher_id = ?1)
         RETURNING dedupe_key, payload`,
      )
      .bind(w.id, now, payload),
    seedStatement(db, w.id, items, now),
  ]);
  const rows = inserted.results.map((r) => ({ key: r.dedupe_key, ...(JSON.parse(r.payload) as Item & { hot: boolean; notify: boolean }) }));
  const matched = rows.filter((r) => r.notify);
  const n = await notifyMatches(env, w, "item.new", matched.map((m) => m.key), matched, `new item: ${describeRule(w)}`, now);
  return { created: rows.length, hot: rows.some((r) => r.hot), notified: n !== null };
}

function seedStatement(db: D1Database, watcherId: string, items: Item[], now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO seen_items (watcher_id, item_id, first_seen)
       SELECT ?1, value, ?2 FROM json_each(?3)`,
    )
    .bind(watcherId, now, JSON.stringify(items.map((i) => i.id)));
}

// The first successful fetch records current state and emits no item events.
// Rules still run over it: openings that already exist when a watcher starts
// are the ones most worth knowing about. They produce one seed.match event,
// whose fixed dedupe_key means it can happen once per watcher, ever. It never
// sets hot, because nothing changed.
async function seed(env: Env, w: WatcherRow, parsed: Parsed, now: number): Promise<{ created: number; notified: boolean }> {
  let matched: { title: string; url: string | null; id?: string }[];
  let total: number;
  if (parsed.shape === "items") {
    await seedStatement(env.DB, w.id, parsed.items, now).run();
    matched = parsed.items.filter((i) => classify(w, i.title, false).notify);
    total = parsed.items.length;
  } else {
    matched = classify(w, parsed.text, false).notify ? [{ title: `Page matches: ${w.url}`, url: w.url }] : [];
    total = 1;
  }
  if (matched.length === 0) return { created: 0, notified: false };

  const key = `${w.id}:seed.match`;
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO events (watcher_id, ts, kind, dedupe_key, payload)
     VALUES (?1, ?2, 'seed.match', ?3, ?4) RETURNING id`,
  )
    .bind(w.id, now, key, JSON.stringify({ count: matched.length, of: total, rule: describeRule(w), items: matched.slice(0, 25) }))
    .all();
  if (inserted.results.length === 0) return { created: 0, notified: false };
  const n = await notifyMatches(env, w, "seed.match", [key], matched, `already open at first check: ${matched.length} of ${total} match ${describeRule(w)}`, now);
  return { created: 1, notified: n !== null };
}

export function schedule(w: WatcherRow, now: number, hotTriggered: boolean, failed: boolean) {
  const hotUntil = hotTriggered ? now + w.hot_window_s * 1000 : w.hot_until;
  const mode: "normal" | "hot" = hotUntil !== null && hotUntil > now ? "hot" : "normal";
  const failures = failed ? w.consecutive_failures + 1 : 0;
  let interval = mode === "hot" ? w.hot_interval_s : w.interval_s;
  if (failures > 0) interval = Math.min(interval * 2 ** failures, MAX_BACKOFF_S);
  return { hotUntil: mode === "hot" ? hotUntil : null, mode, interval, failures, nextCheckAt: now + interval * 1000 };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runCheck(env: Env, watcherId: string, trigger: Trigger): Promise<CheckResult> {
  const w = await env.DB.prepare("SELECT * FROM watchers WHERE id = ?").bind(watcherId).first<WatcherRow>();
  if (!w) throw new Error(`watcher ${watcherId} not found`);

  const out = new Outbound();
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (w.etag) headers["if-none-match"] = w.etag;
  if (w.last_modified) headers["if-modified-since"] = w.last_modified;
  const conditional = Boolean(w.etag || w.last_modified);

  const started = Date.now();
  let source: "primary" | "fallback" = "primary";
  let kind = w.kind;
  let status = 0;
  let bytes = 0;
  let outcome: Outcome = "error";
  let itemsSeen = 0;
  let eventsCreated = 0;
  let notified = false;
  let hotTriggered = false;
  let error: string | null = null;
  let etag = w.etag;
  let lastModified = w.last_modified;
  let fp = w.fingerprint;
  let latency = 0;

  let res: Response | null = null;
  try {
    res = await out.fetch(w.url, { headers, redirect: "follow" });
  } catch (e) {
    error = errorText(e);
  }
  if (w.fallback_url && (res === null || (!res.ok && res.status !== 304))) {
    const primary = res ? `HTTP ${res.status}` : error;
    await res?.body?.cancel();
    source = "fallback";
    kind = w.fallback_kind ?? w.kind;
    error = `primary ${primary}; used fallback`;
    try {
      res = await out.fetch(w.fallback_url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
    } catch (e) {
      res = null;
      error = `primary ${primary}; fallback ${errorText(e)}`;
    }
  }

  try {
    if (res === null) {
      latency = Date.now() - started;
    } else if (res.status === 304) {
      status = 304;
      await res.body?.cancel();
      latency = Date.now() - started;
      outcome = "not_modified";
    } else if (res.ok) {
      status = res.status;
      const body = await res.text();
      latency = Date.now() - started;
      bytes = new TextEncoder().encode(body).byteLength;
      if (source === "primary") {
        etag = res.headers.get("etag") ?? etag;
        lastModified = res.headers.get("last-modified") ?? lastModified;
      }
      const parsed = parse(kind, body);
      const newFp = await fingerprint(parsed);
      itemsSeen = parsed.shape === "items" ? parsed.items.length : 0;
      const now = Date.now();
      if (newFp === w.fingerprint) {
        outcome = "same_fingerprint";
      } else if (w.fingerprint === null) {
        const r = await seed(env, w, parsed, now);
        eventsCreated = r.created;
        notified = r.notified;
        outcome = "seeded";
      } else if (parsed.shape === "items") {
        const r = await recordItems(env, w, parsed.items, now);
        eventsCreated = r.created;
        hotTriggered = r.hot;
        notified = r.notified;
        outcome = "changed";
      } else {
        const c = classify(w, parsed.text, true);
        hotTriggered = c.hot;
        const key = `${w.id}:page:${w.fingerprint}:${newFp}`;
        const inserted = await env.DB.prepare(
          `INSERT OR IGNORE INTO events (watcher_id, ts, kind, dedupe_key, payload)
           VALUES (?1, ?2, 'page.changed', ?3, ?4) RETURNING id`,
        )
          .bind(w.id, now, key, JSON.stringify({ url: w.url, from: w.fingerprint, to: newFp, ...c, excerpt: parsed.text.slice(0, 280) }))
          .all();
        eventsCreated = inserted.results.length;
        if (eventsCreated > 0 && c.notify) {
          notified = (await notifyMatches(env, w, "page.changed", [key], [{ title: `Page changed: ${w.url}`, url: w.url }], `page text matches ${describeRule(w)}`, now)) !== null;
        }
        outcome = "changed";
      }
      fp = newFp;
    } else {
      status = res.status;
      await res.body?.cancel();
      latency = Date.now() - started;
      error = source === "fallback" ? `${error}; fallback HTTP ${res.status}` : `HTTP ${res.status}`;
    }
  } catch (e) {
    latency = Date.now() - started;
    error = errorText(e);
    outcome = "error";
  }

  const now = Date.now();
  const s = schedule(w, now, hotTriggered, outcome === "error");
  if (s.mode !== w.mode) {
    const prev = w.mode === "hot" ? w.hot_interval_s : w.interval_s;
    console.log(
      `[${w.id}] interval switch ${w.mode}(${prev}s) -> ${s.mode}(${s.interval}s)` +
        (s.mode === "hot" ? ` hot_until=${new Date(s.hotUntil!).toISOString()}` : " hot window expired"),
    );
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE watchers SET etag = ?2, last_modified = ?3, fingerprint = ?4, next_check_at = ?5,
         hot_until = ?6, mode = ?7, consecutive_failures = ?8, last_status = ?9 WHERE id = ?1`,
    ).bind(w.id, etag, lastModified, fp, s.nextCheckAt, s.hotUntil, s.mode, s.failures, status),
    env.DB.prepare(
      `INSERT INTO fetch_log (watcher_id, ts, via, source, status, bytes, latency_ms, conditional, outcome, changed,
         items_seen, events_created, subrequests, model_calls, next_interval_s, mode, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
    ).bind(
      w.id,
      now,
      trigger,
      source,
      status,
      bytes,
      latency,
      conditional ? 1 : 0,
      outcome,
      outcome === "changed" ? 1 : 0,
      itemsSeen,
      eventsCreated,
      out.subrequests,
      out.modelCalls,
      s.interval,
      s.mode,
      error,
    ),
  ]);

  const result: CheckResult = {
    watcher_id: w.id,
    trigger,
    source,
    status,
    bytes,
    latency_ms: latency,
    conditional,
    outcome,
    items_seen: itemsSeen,
    events_created: eventsCreated,
    notified,
    subrequests: out.subrequests,
    model_calls: out.modelCalls,
    mode: s.mode,
    next_interval_s: s.interval,
    next_check_at: s.nextCheckAt,
    error,
  };
  console.log(
    `[${w.id}] check trigger=${trigger} source=${source} status=${status} bytes=${bytes} latency=${latency}ms conditional=${conditional} ` +
      `outcome=${outcome} items=${itemsSeen} events=${eventsCreated} notified=${notified} model_calls=${out.modelCalls} ` +
      `next=+${s.interval}s mode=${s.mode}${error ? ` error=${error}` : ""}`,
  );
  return result;
}
