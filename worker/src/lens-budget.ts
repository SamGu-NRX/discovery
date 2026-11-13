// Per-invocation limits for lens work (src/lens.ts). Workers Free allows, per
// invocation, 50 external subrequests (fetch), 1,000 internal ones (Workers
// AI and R2 bindings), and 50 D1 calls, where a whole batch() counts as one.
// A lens request that would go past its share fails with 503 at the call
// that would cross it, instead of the platform cutting it off mid-write.
//
// D1 calls are counted by construction: lens code reaches D1 only through
// CountedDb, so a query added later is charged without anyone remembering
// to. The shares leave room for what the rest of the invocation does (the
// router; the cron's watcher checks and its cron_runs row).

import { HttpError } from "./http";

export interface Limits {
  d1: number;
  external: number;
  internal: number;
  bundleReads: number;
}

export const ROUTE_LIMITS: Limits = { d1: 40, external: 40, internal: 500, bundleReads: 10 };
export const CRON_LIMITS: Limits = { d1: 30, external: 30, internal: 500, bundleReads: 10 };

export class Budget {
  readonly used = { d1: 0, external: 0, internal: 0, bundleReads: 0 };
  constructor(readonly limits: Limits) {}

  private take(kind: keyof Limits, what: string) {
    if (this.used[kind] >= this.limits[kind]) {
      throw new HttpError(503, `this request would need more than its ${this.limits[kind]} ${kind} calls (at: ${what}); split the work`);
    }
    this.used[kind] += 1;
  }
  d1(what: string) {
    this.take("d1", what);
  }
  external(what: string) {
    this.take("external", what);
  }
  internal(what: string) {
    this.take("internal", what);
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

export class CountedStatement {
  constructor(
    readonly raw: D1PreparedStatement,
    private readonly budget: Budget,
    private readonly sql: string,
  ) {}
  bind(...values: unknown[]): CountedStatement {
    return new CountedStatement(this.raw.bind(...values), this.budget, this.sql);
  }
  first<T = Record<string, unknown>>(): Promise<T | null> {
    this.budget.d1(this.sql);
    return this.raw.first<T>();
  }
  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.budget.d1(this.sql);
    return this.raw.all<T>();
  }
  run(): Promise<D1Result> {
    this.budget.d1(this.sql);
    return this.raw.run();
  }
}

export class CountedDb {
  constructor(
    private readonly db: D1Database,
    private readonly budget: Budget,
  ) {}
  prepare(sql: string): CountedStatement {
    return new CountedStatement(this.db.prepare(sql), this.budget, sql.replace(/\s+/g, " ").slice(0, 60));
  }
  batch<T = Record<string, unknown>>(statements: CountedStatement[]): Promise<D1Result<T>[]> {
    this.budget.d1(`batch of ${statements.length}`);
    return this.db.batch<T>(statements.map((s) => s.raw));
  }
}
