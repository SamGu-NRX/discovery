"""Day-1 check: replay the last 14 days of T3 through the watcher and score it on three sets of real runs.

- Dead: the runs the design names (cogportal's failed run, M362K's run 4), every abnormal run Sam answered
  with "continue", then the newest run of each failure cause not yet covered, up to 10. Sam's own
  "continue" labels a run dead without using the watcher's logic.
- Sam-stopped: the 10 newest interrupted runs whose stop command came from Sam's app (a client UUID
  command id in T3's command receipts).
- Healthy: the 30 most recently updated threads whose runs in the window all completed.

The watcher replays from the window start with archived threads included (a thread archived since is
evidence about later, not about the run), and the check passes when it flags at least 9 of 10 dead runs,
none of the Sam-stopped runs, and nothing in a healthy thread.
"""
import datetime as dt
import json
import re

from . import probe, watch

NAMED = [("mcp:7ba549c4-90cb-4611-9802-3130994b5ab4", 216, "cogportal: 'your last run failed before it could reply'"),
         ("b8bac092-d682-4e18-b897-e613b2384539", 4, "M362K run 4, relayed again by hand")]
CONTINUE = re.compile(r"^\s*(continue|keep going|go on|resume|try again|retry|proceed)\b", re.I)


def _since(days):
    return dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)


def dead_set(con, since, n=10):
    out, seen = [], set()

    def add(run_id, why):
        if run_id and run_id not in seen and len(out) < n:
            seen.add(run_id)
            out.append({"run_id": run_id, "why": why})

    for tid, ordinal, why in NAMED:
        r = con.execute(f"SELECT run_id FROM {probe.RUNS} WHERE thread_id = ? AND ordinal = ?", (tid, ordinal)).fetchone()
        add(r[0] if r else None, why)
    abnormal = con.execute(
        f"SELECT run_id, thread_id, status, completed_at FROM {probe.RUNS} WHERE status IN ('failed', 'interrupted')"
        " AND requested_at >= ? ORDER BY completed_at DESC", (watch.iso(since),)).fetchall()
    for rid, tid, status, done in abnormal:
        nxt = probe.sam_messages_after(con, tid, done, limit=1)
        if nxt and CONTINUE.search(nxt[0]["text"]):
            add(rid, f"{status}; Sam then typed {nxt[0]['text'][:30]!r}")
    causes = {r["why"].split(";")[0] for r in out}
    for rid, tid, status, done in abnormal:
        if status != "failed":
            continue
        c = watch.cause(watch.failure(con, tid, rid))
        if c not in causes:
            causes.add(c)
            add(rid, f"failed: {c}")
    return out


def sam_stopped_set(con, since, n=10):
    out = []
    for rid, tid, req, done in con.execute(
            f"SELECT run_id, thread_id, requested_at, completed_at FROM {probe.RUNS} WHERE status = 'interrupted'"
            " AND requested_at >= ? ORDER BY completed_at DESC", (watch.iso(since - dt.timedelta(days=30)),)):
        ev = watch.stop_evidence(con, tid, rid, req, done)
        if ev["commands"] and all(o == "app" for o, _ in ev["commands"]):
            out.append({"run_id": rid, "why": f"app {ev['commands'][0][1]}: {ev['message']!r}"})
        if len(out) >= n:
            break
    return out


def healthy_set(con, since, n=30):
    rows = con.execute(
        f"SELECT t.thread_id, t.title FROM {probe.THREADS} t WHERE t.deleted_at IS NULL AND t.updated_at >= ?"
        f" AND EXISTS (SELECT 1 FROM {probe.RUNS} r WHERE r.thread_id = t.thread_id AND r.requested_at >= ?)"
        f" AND NOT EXISTS (SELECT 1 FROM {probe.RUNS} r WHERE r.thread_id = t.thread_id AND r.requested_at >= ?"
        "   AND r.status NOT IN ('completed'))"
        " ORDER BY t.updated_at DESC LIMIT ?", (watch.iso(since),) * 3 + (n,)).fetchall()
    return [{"thread_id": r[0], "title": r[1]} for r in rows]


def run(con, days=14) -> dict:
    since = _since(days)
    w = watch.Watcher(con, state=watch.MemoryState(), since=since)
    w.include_archived = True
    cards = w.cycle()
    flagged_runs = {c["run_id"] for c in cards}
    flagged_threads = {c["thread_id"] for c in cards}
    dead, stopped, healthy = dead_set(con, since), sam_stopped_set(con, since), healthy_set(con, since)
    for d in dead:
        d["flagged"] = d["run_id"] in flagged_runs
    for s in stopped:
        s["flagged"] = s["run_id"] in flagged_runs
    for h in healthy:
        h["flagged"] = h["thread_id"] in flagged_threads
    res = {
        "window_days": days, "cards": len(cards), "scan_rows": w.last_scan_rows,
        "dead_flagged": sum(d["flagged"] for d in dead), "dead_total": len(dead),
        "sam_stopped_flagged": sum(s["flagged"] for s in stopped), "sam_stopped_total": len(stopped),
        "healthy_flagged": sum(h["flagged"] for h in healthy), "healthy_total": len(healthy),
        "dead": dead, "sam_stopped": stopped, "healthy_flags": [h for h in healthy if h["flagged"]],
    }
    res["pass"] = (res["dead_total"] == 10 and res["dead_flagged"] >= 9 and res["sam_stopped_total"] == 10
                   and res["sam_stopped_flagged"] == 0 and res["healthy_total"] == 30 and res["healthy_flagged"] == 0)
    return res


if __name__ == "__main__":
    print(json.dumps(run(probe.connect("~/.t3/userdata/statev2.sqlite")), indent=1))
