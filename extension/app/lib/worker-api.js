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

// Resolves to the Worker's answer: the stored status and the account's
// pause_until (null when not paused).
export function postStatus(config, { account, session_id, status, detail }) {
  return call(config, "POST", "/ingest/x/status", { account, session_id, status, detail });
}

// A valid pause_until from a Worker answer, or null.
export function pauseFrom(answer) {
  const until = answer?.pause_until;
  return typeof until === "string" && !Number.isNaN(Date.parse(until)) ? until : null;
}

// POST /x/sessions/start. Resolves { ok: true } only on 200; otherwise
// { ok: false, reason, pauseUntil } with the Worker's pause_until if it sent
// one. Never throws: a network failure is a refusal too. Starting a session
// that is still open answers 200 again, so a request whose answer was lost
// is sent once more under the same session id. 409 means the id is closed or
// another account's; sessions always use a fresh id, so it is a refusal.
// `mode` is "active" for a scheduled or manual session and "fetch" for a
// fetch-mode run; a Worker from before fetch mode ignores it.
export async function reserveSession(config, { account, session_id, mode = "active" }) {
  let res;
  for (let attempt = 1; ; attempt += 1) {
    try {
      res = await fetch(new URL("/x/sessions/start", config.workerUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${config.ingestToken}`, "content-type": "application/json" },
        body: JSON.stringify(mode === "active" ? { account, session_id } : { account, session_id, mode }),
        signal: AbortSignal.timeout(30_000),
      });
      break;
    } catch (err) {
      if (attempt >= 2) {
        return { ok: false, reason: `The Worker could not be reached to reserve a session (${err.message}).`, pauseUntil: null };
      }
    }
  }
  if (res.status === 200) return { ok: true };
  const pauseUntil = pauseFrom(await res.json().catch(() => ({})));
  const reason =
    res.status === 423
      ? `The Worker is holding sessions${pauseUntil ? ` until ${new Date(pauseUntil).toLocaleString()}` : ""}.`
      : res.status === 404
        ? "The Worker does not take session reservations, so sessions stay off."
        : `The Worker refused the session (${res.status}).`;
  return { ok: false, reason, pauseUntil };
}

export function getDetailQueue(config, account) {
  return call(config, "GET", `/x/detail-queue?account=${encodeURIComponent(account)}`);
}
