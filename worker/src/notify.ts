// Turns the rule-matched events of one check into at most one POST to the T3
// webhook. Each POST starts a T3 thread that asks Sam one question, so this
// is the only path that can interrupt him: unmatched events never reach it,
// a daily cap bounds it, and a settings flag pauses it.

import { sha256Hex } from "./adapters";
import type { Env } from "./check";

export const DAILY_CAP = 5;
const MAX_ATTEMPTS = 3;
const PENDING_STALE_MS = 120_000;

export type NotifyKind = "seed.match" | "item.new" | "page.changed";

export interface Matched {
  title: string;
  url: string | null;
}

interface NotificationRow {
  id: number;
  event_id: string;
  watcher_id: string;
  kind: NotifyKind;
  title: string;
  url: string;
  reason: string;
  detected_at: string;
  state: string;
  attempts: number;
  last_status: number | null;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function summarize(kind: NotifyKind, items: Matched[]): string {
  const label = (m: Matched) => m.title || m.url || "untitled";
  if (items.length === 1) return clip(kind === "seed.match" ? `Open now: ${label(items[0])}` : `New: ${label(items[0])}`, 140);
  const head = items.slice(0, 2).map(label).join("; ");
  const what = kind === "seed.match" ? "matching items already open" : "new matching items";
  return clip(`${items.length} ${what}: ${head}`, 140);
}

// `keys` are the dedupe keys of the events this notification covers. Hashing
// them gives an event_id that is the same on every retry and after a
// database rebuild, so the T3 task can deduplicate on it.
export async function notifyMatches(
  env: Env,
  watcher: { id: string; url: string },
  kind: NotifyKind,
  keys: string[],
  items: Matched[],
  reason: string,
  now: number,
): Promise<NotificationRow | null> {
  if (items.length === 0) return null;
  const eventId = `${watcher.id}:${(await sha256Hex([...keys].sort().join("\n"))).slice(0, 16)}`;
  const day = new Date(now).toISOString().slice(0, 10);
  // One statement, so two watchers notifying at once cannot both take the
  // last slot under the cap.
  const row = await env.DB.prepare(
    `INSERT INTO notifications (event_id, watcher_id, kind, title, url, reason, detected_at, day, state, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
       CASE
         WHEN (SELECT value FROM settings WHERE key = 'notifications_paused') = '1' THEN 'paused'
         WHEN (SELECT count(*) FROM notifications WHERE day = ?8 AND state IN ('pending', 'sent', 'failed')) >= ?9 THEN 'capped'
         ELSE 'pending'
       END, ?10)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING *`,
  )
    .bind(eventId, watcher.id, kind, summarize(kind, items), items[0].url ?? watcher.url, clip(reason, 200), new Date(now).toISOString(), day, DAILY_CAP, now)
    .first<NotificationRow>();
  if (!row) return null;
  if (row.state !== "pending") {
    console.log(`[notify] ${row.watcher_id} event_id=${row.event_id} state=${row.state} (not sent)`);
    return row;
  }
  return send(env, row);
}

async function send(env: Env, row: NotificationRow): Promise<NotificationRow> {
  const body = JSON.stringify({
    event_id: row.event_id,
    kind: row.kind,
    watcher_id: row.watcher_id,
    title: row.title,
    url: row.url,
    detected_at: row.detected_at,
    reason: row.reason,
  });
  let status: number | null = null;
  let error: string | null = null;
  if (!env.T3_WEBHOOK_URL) {
    error = "T3_WEBHOOK_URL is not set";
  } else {
    try {
      const res = await fetch(env.T3_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      await res.body?.cancel();
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      status = 0;
      // The webhook URL is a capability secret; keep it out of D1 and logs.
      error = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split(env.T3_WEBHOOK_URL).join("<webhook>").slice(0, 200);
    }
  }
  const state = status !== null && status >= 200 && status < 300 ? "sent" : "failed";
  const updated = await env.DB.prepare(
    `UPDATE notifications SET state = ?2, attempts = attempts + 1, last_status = ?3, last_error = ?4,
       sent_at = CASE WHEN ?2 = 'sent' THEN ?5 ELSE sent_at END
     WHERE id = ?1 RETURNING *`,
  )
    .bind(row.id, state, status, error, Date.now())
    .first<NotificationRow>();
  console.log(`[notify] ${row.watcher_id} event_id=${row.event_id} kind=${row.kind} status=${status} state=${state}${error ? ` error=${error}` : ""}`);
  return updated!;
}

// Called by the cron: failed POSTs get up to MAX_ATTEMPTS in total, and a
// 'pending' row older than two minutes means the check died mid-send. The T3
// task deduplicates on event_id, so a resend after an unrecorded success is
// harmless.
export async function retryNotifications(env: Env, now: number): Promise<number> {
  const paused = await env.DB.prepare("SELECT value FROM settings WHERE key = 'notifications_paused'").first<{ value: string }>();
  if (paused?.value === "1") return 0;
  const { results } = await env.DB.prepare(
    `SELECT * FROM notifications
     WHERE (state = 'failed' AND attempts < ?1) OR (state = 'pending' AND created_at < ?2)
     ORDER BY id LIMIT 10`,
  )
    .bind(MAX_ATTEMPTS, now - PENDING_STALE_MS)
    .all<NotificationRow>();
  for (const row of results) await send(env, row);
  return results.length;
}
