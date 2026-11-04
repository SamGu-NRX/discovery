// YouTube push through the public WebSub hub. The callback verifies the hub's
// challenge only for a subscription this Worker asked for, and accepts a
// delivery only when its X-Hub-Signature HMAC matches hub.secret.

import { parseAtom } from "./adapters";
import { recordItems, type Env, type WatcherRow } from "./check";

export const HUB = "https://pubsubhubbub.appspot.com/";
const LEASE_S = 86400;

export function youtubeTopic(feedUrl: string): string {
  const channel = new URL(feedUrl).searchParams.get("channel_id");
  if (!channel) throw new Error(`not a YouTube channel feed: ${feedUrl}`);
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channel}`;
}

export async function requestSubscription(
  env: Env,
  watcherId: string,
  callback: string,
  mode: "subscribe" | "unsubscribe",
): Promise<{ hub_status: number; hub_body: string; topic: string }> {
  const w = await env.DB.prepare("SELECT * FROM watchers WHERE id = ?").bind(watcherId).first<WatcherRow>();
  if (!w) throw new Error(`watcher ${watcherId} not found`);
  const topic = youtubeTopic(w.url);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO websub_subscriptions (watcher_id, topic, hub, callback, state, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (watcher_id) DO UPDATE SET topic = ?2, hub = ?3, callback = ?4, state = ?5, updated_at = ?6`,
  )
    .bind(watcherId, topic, HUB, callback, `pending_${mode}`, now)
    .run();

  const form = new URLSearchParams({
    "hub.callback": callback,
    "hub.topic": topic,
    "hub.mode": mode,
    "hub.verify": "async",
  });
  if (mode === "subscribe") {
    form.set("hub.secret", env.WEBSUB_SECRET);
    form.set("hub.lease_seconds", String(LEASE_S));
  }
  const res = await fetch(HUB, { method: "POST", body: form });
  return { hub_status: res.status, hub_body: (await res.text()).slice(0, 500), topic };
}

export async function handleVerification(env: Env, watcherId: string, url: URL): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const topic = url.searchParams.get("hub.topic");
  const challenge = url.searchParams.get("hub.challenge");
  const sub = await env.DB.prepare("SELECT * FROM websub_subscriptions WHERE watcher_id = ?")
    .bind(watcherId)
    .first<{ topic: string; state: string }>();
  if (!sub || !challenge || sub.topic !== topic || sub.state !== `pending_${mode}`) {
    console.log(`[websub] ${watcherId} refused verification mode=${mode} state=${sub?.state ?? "none"}`);
    return new Response("unknown subscription", { status: 404 });
  }
  const lease = Number(url.searchParams.get("hub.lease_seconds") ?? 0);
  const state = mode === "subscribe" ? "subscribed" : "unsubscribed";
  await env.DB.prepare("UPDATE websub_subscriptions SET state = ?2, lease_until = ?3, updated_at = ?4 WHERE watcher_id = ?1")
    .bind(watcherId, state, lease ? Date.now() + lease * 1000 : null, Date.now())
    .run();
  console.log(`[websub] ${watcherId} verified mode=${mode} lease_seconds=${lease}`);
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

async function signatureMatches(secret: string, body: ArrayBuffer, header: string | null): Promise<boolean> {
  const m = header?.match(/^sha1=([0-9a-f]{40})$/i);
  if (!m) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const given = new Uint8Array(m[1].match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.timingSafeEqual(expected, given);
}

// WebSub requires a 2xx even for a bad signature; the content is dropped.
export async function handleDelivery(env: Env, watcherId: string, req: Request): Promise<Response> {
  const w = await env.DB.prepare("SELECT * FROM watchers WHERE id = ?").bind(watcherId).first<WatcherRow>();
  if (!w) return new Response("unknown watcher", { status: 404 });
  const body = await req.arrayBuffer();
  const now = Date.now();
  const valid = await signatureMatches(env.WEBSUB_SECRET, body, req.headers.get("x-hub-signature"));
  let created = 0;
  let items = 0;
  if (valid) {
    const entries = parseAtom(new TextDecoder().decode(body));
    items = entries.length;
    created = (await recordItems(env, w, entries, now)).created;
  }
  await env.DB.prepare(
    `INSERT INTO fetch_log (watcher_id, ts, via, status, bytes, outcome, changed, items_seen, events_created)
     VALUES (?1, ?2, 'push', NULL, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(w.id, now, body.byteLength, valid ? "delivered" : "bad_signature", created > 0 ? 1 : 0, items, created)
    .run();
  console.log(`[websub] ${w.id} delivery signature=${valid ? "valid" : "INVALID"} bytes=${body.byteLength} entries=${items} events=${created}`);
  return new Response(null, { status: 202 });
}
