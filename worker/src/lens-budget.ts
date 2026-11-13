// Per-invocation limits for lens work (src/lens.ts). Workers Free allows, per
// invocation, 50 external subrequests (fetch), 1,000 internal ones (Workers
// AI and R2 bindings), and 50 D1 calls, where a whole batch() counts as one.
// A lens request that would go past its share fails with 503 at the call
// that would cross it, instead of the platform cutting it off mid-write.
//
// D1 calls are counted by construction. Lens code gets a LensEnv, which has
// no DB, only db, a CountedDb: a raw D1 call in src/lens.ts does not compile,
// and a query added later is charged without anyone remembering to.
// index.ts builds the LensEnv for each lens route and for the cron, whose own
// D1 calls go through the same db.

import type { Env } from "./check";
import { HttpError } from "./http";

export interface Limits {
  d1: number;
  // D1 calls held back for writes that must land even when the work before
  // them ran out of budget: the cron's attempt row and its cron_runs row.
  d1Reserve: number;
  external: number;
  internal: number;
  bundleReads: number;
}

export const ROUTE_LIMITS: Limits = { d1: 40, d1Reserve: 0, external: 40, internal: 500, bundleReads: 10 };
// The whole cron invocation: its watcher lookup, proposal expiry and
// cron_runs row as well as the lens refresh, 40 of the 50.
export const CRON_LIMITS: Limits = { d1: 40, d1Reserve: 2, external: 30, internal: 500, bundleReads: 10 };

export class Budget {
  readonly used = { d1: 0, external: 0, internal: 0, bundleReads: 0 };
  constructor(readonly limits: Limits) {}

  private take(kind: "d1" | "external" | "internal", what: string, cap: number) {
    if (this.used[kind] >= cap) {
      throw new HttpError(503, `this request would need more than its ${cap} ${kind} calls (at: ${what}); split the work`);
    }
    this.used[kind] += 1;
  }
  // A reserved call may use the reserve; any other stops short of it.
  d1(what: string, reserved = false) {
    this.take("d1", what, reserved ? this.limits.d1 : this.limits.d1 - this.limits.d1Reserve);
  }
  external(what: string) {
    this.take("external", what, this.limits.external);
  }
  internal(what: string) {
    this.take("internal", what, this.limits.internal);
  }
  // Bundle reads are optional context: past the cap the caller goes without.
  takeBundleRead(): boolean {
    if (this.used.bundleReads >= this.limits.bundleReads || this.used.internal >= this.limits.internal) return false;
    this.used.bundleReads += 1;
    this.used.internal += 1;
    return true;
  }
  usage() {
    return { d1_calls: this.used.d1, external_subrequests: this.used.external, internal_subrequests: this.used.internal, bundle_reads: this.used.bundleReads };
  }
}

const label = (sql: string) => sql.replace(/\s+/g, " ").slice(0, 60);

export class CountedStatement {
  constructor(
    readonly raw: D1PreparedStatement,
    private readonly budget: Budget,
    private readonly sql: string,
    private readonly reserved = false,
  ) {}
  bind(...values: unknown[]): CountedStatement {
    return new CountedStatement(this.raw.bind(...values), this.budget, this.sql, this.reserved);
  }
  first<T = Record<string, unknown>>(): Promise<T | null> {
    this.budget.d1(this.sql, this.reserved);
    return this.raw.first<T>();
  }
  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.budget.d1(this.sql, this.reserved);
    return this.raw.all<T>();
  }
  run(): Promise<D1Result> {
    this.budget.d1(this.sql, this.reserved);
    return this.raw.run();
  }
}

export class CountedDb {
  constructor(
    private readonly db: D1Database,
    private readonly budget: Budget,
  ) {}
  prepare(sql: string): CountedStatement {
    return new CountedStatement(this.db.prepare(sql), this.budget, label(sql));
  }
  // A statement charged to the reserve (Limits.d1Reserve).
  prepareReserved(sql: string): CountedStatement {
    return new CountedStatement(this.db.prepare(sql), this.budget, label(sql), true);
  }
  batch<T = Record<string, unknown>>(statements: CountedStatement[]): Promise<D1Result<T>[]> {
    this.budget.d1(`batch of ${statements.length}`);
    return this.db.batch<T>(statements.map((s) => s.raw));
  }
}

export type LensEnv = Omit<Env, "DB"> & { db: CountedDb; budget: Budget };

export function lensEnv(env: Env, limits: Limits): LensEnv {
  const { DB, ...rest } = env;
  const budget = new Budget(limits);
  return { ...rest, db: new CountedDb(DB, budget), budget };
}
