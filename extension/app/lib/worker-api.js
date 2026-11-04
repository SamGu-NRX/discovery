// The three Worker routes the INGEST token may call (docs/CONTRACT.md).

export class WorkerError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "WorkerError";
    this.status = status;
  }
}

async function call(config, method, path, body) {
  if (!config.workerUrl || !config.ingestToken) throw new WorkerError(0, "Worker URL or ingest token is not set");
  let res;
  try {
    res = await fetch(new URL(path, config.workerUrl), {
      method,
      headers: {
        authorization: `Bearer ${config.ingestToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // Flushes hold the storage lock while a request is in flight.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new WorkerError(0, `Worker unreachable: ${err.message}`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new WorkerError(res.status, `Worker answered ${res.status} to ${method} ${path}${text ? `: ${text}` : ""}`);
  }
  return res.json().catch(() => ({}));
}

export function postIngest(config, body) {
  return call(config, "POST", "/ingest/x", body);
}

export function postStatus(config, { account, session_id, status, detail }) {
  return call(config, "POST", "/ingest/x/status", { account, session_id, status, detail });
}

// POST /x/sessions/start. Resolves { ok: true } only on 200; otherwise
// { ok: false, reason, pauseUntil } with the Worker's pause_until if it sent
// one. Never throws: a network failure is a refusal too.
export async function reserveSession(config, { account, session_id }) {
  let res;
  try {
    res = await fetch(new URL("/x/sessions/start", config.workerUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${config.ingestToken}`, "content-type": "application/json" },
      body: JSON.stringify({ account, session_id }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, reason: `The Worker could not be reached to reserve a session (${err.message}).`, pauseUntil: null };
  }
  if (res.status === 200) return { ok: true };
  const body = await res.json().catch(() => ({}));
  const pauseUntil = typeof body?.pause_until === "string" && !Number.isNaN(Date.parse(body.pause_until)) ? body.pause_until : null;
  const reason =
    res.status === 423
      ? `The Worker is holding sessions${pauseUntil ? ` until ${new Date(pauseUntil).toLocaleString()}` : ""}.`
      : res.status === 404
        ? "The Worker does not take session reservations yet, so sessions stay off."
        : `The Worker refused the session (${res.status}).`;
  return { ok: false, reason, pauseUntil };
}

export function getDetailQueue(config, account) {
  return call(config, "GET", `/x/detail-queue?account=${encodeURIComponent(account)}`);
}
