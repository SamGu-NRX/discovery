import { DurableObject } from "cloudflare:workers";
import { runCheck, type CheckResult, type Env, type Trigger } from "./check";

// One instance per watcher, named by watcher id. Its alarm is the watcher's
// schedule: every check ends by setting the alarm to the next check time that
// check computed, so the interval can change from one check to the next.
export class WatcherDO extends DurableObject<Env> {
  // An alarm and a manual or backstop check can arrive together, and the
  // input gate opens while the source fetch is in flight. Joining the running
  // check keeps one fetch per watcher at a time.
  private running: Promise<CheckResult> | null = null;

  async start(watcherId: string, firstCheckAt: number): Promise<void> {
    await this.ctx.storage.put("watcherId", watcherId);
    await this.ctx.storage.setAlarm(firstCheckAt);
  }

  async checkNow(trigger: Exclude<Trigger, "alarm" | "push">): Promise<CheckResult> {
    return this.check(trigger);
  }

  async alarm(): Promise<void> {
    await this.check("alarm");
  }

  async alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  // Simulates a lost alarm so the evidence run can show the cron backstop
  // picking the watcher up.
  async dropAlarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

  private check(trigger: Trigger): Promise<CheckResult> {
    this.running ??= this.runAndReschedule(trigger).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runAndReschedule(trigger: Trigger): Promise<CheckResult> {
    const watcherId = await this.ctx.storage.get<string>("watcherId");
    if (!watcherId) throw new Error("WatcherDO used before start()");
    const result = await runCheck(this.env, watcherId, trigger);
    await this.ctx.storage.setAlarm(result.next_check_at);
    return result;
  }
}
