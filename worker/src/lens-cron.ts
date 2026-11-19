// The lens background refresh (refreshDueBackgrounds in src/lens.ts), run as
// a Durable Object request. A Durable Object request is an invocation of its
// own, with its own 50 D1 calls. The */15 cron's hub work (approvals, the
// mailbox's unbounded wake dispatch, voice) uses raw D1 in the cron's own
// invocation, and the two together could pass 50. A second cron trigger
// would also give the refresh an invocation of its own, but the Cloudflare
// account is at 5 of the 5 triggers Workers Free allows. The */15 cron
// calls this once per run, keyed by name "lens", after the hub work.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./check";
import { refreshDueBackgrounds } from "./lens";
import { CRON_LIMITS, lensEnv } from "./lens-budget";

export class LensCronDO extends DurableObject<Env> {
  // POST { now }: the cron run's time. Answers what refreshDueBackgrounds
  // returns: the account tried, its new background or its error, and the
  // D1 calls this invocation made; null when no account was due.
  async fetch(req: Request): Promise<Response> {
    const { now } = (await req.json()) as { now: number };
    if (!Number.isFinite(now)) return Response.json({ error: "now must be a number" }, { status: 400 });
    // No D1 call follows the attempt row in this invocation.
    return Response.json(await refreshDueBackgrounds(lensEnv(this.env, CRON_LIMITS), now, 0));
  }
}
