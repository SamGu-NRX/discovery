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

export function getDetailQueue(config, account) {
  return call(config, "GET", `/x/detail-queue?account=${encodeURIComponent(account)}`);
}
