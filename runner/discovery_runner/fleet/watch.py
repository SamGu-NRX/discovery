"""The watcher: finds runs that ended abnormally and turns each into one card.

Each cycle runs one query on T3's run table, watermarked on `requested_at` and `completed_at` and joined to
the thread table for mode, parent and archived state, plus the few runs still open. Only abnormal ends get a
card, because T3 already tells Sam when a run finishes normally:

- `failed`: T3 marked the run failed. The card carries T3's failure class and message.
- `stopped_by_agent`: interrupted by an MCP caller (a lead stopping a child, an agent pausing for disk).
- `interrupted_unknown`: interrupted with no stop on record, or with evidence that disagrees.
- `stalled`: still open with no run activity for `stall_min` minutes while the watcher was awake.

A run Sam stopped gets no card. "Sam stopped it" needs both pieces of evidence T3 records: the stop command
came from his app (its command id is a client UUID, not an MCP id) and the interrupt item carries one of the
texts T3 writes for an app stop. Anything less certain is `interrupted_unknown`: a card, never an action.
"""
import datetime as dt
import json
import re
from pathlib import Path

from .. import config
from . import probe

OPEN = ("preparing", "starting", "running")
# Texts T3 writes on the interrupt item when the app stops a run: RunExecutionService.USER_STOP_REASON,
# Orchestrator's "Interrupt requested" for run.interrupt, and the steer that skips compaction
# (t3code apps/server/src/orchestration-v2/Orchestrator.ts:11456, 12714, 13297).
APP_STOP_TEXTS = {"Stopped by user", "Interrupt requested", "Skipped compaction to send a queued message"}
STOP_COMMANDS = ("thread.stop", "run.interrupt", "queued-message.promote-to-steer")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CARD_KINDS = ("failed", "stopped_by_agent", "interrupted_unknown", "stalled")

RUN_SELECT = f"""
SELECT r.run_id, r.thread_id, r.ordinal, r.status, r.requested_at, r.completed_at,
       json_extract(r.payload_json, '$.modelSelection.model') AS model,
       json_extract(r.payload_json, '$.startedAt') AS started_at,
       t.title, t.runtime_mode, t.archived_at, t.deleted_at,
       json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_id
FROM {probe.RUNS} r JOIN {probe.THREADS} t ON t.thread_id = r.thread_id
"""
RUN_SCAN = RUN_SELECT + "WHERE r.requested_at > :wm OR r.completed_at > :wm OR r.status IN ('preparing', 'starting', 'running')"


def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def parse(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def thread_info(con, thread_id) -> dict | None:
    r = con.execute(
        f"SELECT thread_id, title, runtime_mode, project_id, created_at, updated_at, archived_at,"
        f" json_extract(payload_json, '$.lineage.parentThreadId') AS parent_id,"
        f" json_extract(payload_json, '$.worktreePath') AS worktree FROM {probe.THREADS} WHERE thread_id = ?",
        (thread_id,)).fetchone()
    return dict(r) if r else None


def failure(con, thread_id, run_id) -> dict | None:
    r = con.execute(
        f"SELECT payload_json FROM {probe.TURN_ITEMS} WHERE thread_id = ? AND run_id = ? AND type = 'error'"
        " AND status = 'failed' ORDER BY updated_at DESC LIMIT 1", (thread_id, run_id)).fetchone()
    if not r:
        return None
    f = json.loads(r[0]).get("failure") or {}
    return {"class": f.get("class"), "message": (f.get("message") or "")[:400]}


def stop_evidence(con, thread_id, run_id, requested_at, completed_at) -> dict:
    """What T3 recorded about who stopped an interrupted run."""
    item = con.execute(
        f"SELECT json_extract(payload_json, '$.message') FROM {probe.TURN_ITEMS} WHERE thread_id = ? AND run_id = ?"
        " AND type = 'run_interrupt_request' LIMIT 1", (thread_id, run_id)).fetchone()
    end = iso(parse(completed_at or requested_at) + dt.timedelta(seconds=2))
    marks = ",".join("?" * len(STOP_COMMANDS))
    cmds = con.execute(
        f"SELECT command_id, command_type FROM {probe.RECEIPTS} WHERE aggregate_kind = 'thread' AND aggregate_id = ?"
        f" AND accepted_at >= ? AND accepted_at <= ? AND command_type IN ({marks})",
        (thread_id, requested_at, end, *STOP_COMMANDS)).fetchall()
    origins = sorted({("app" if UUID.match(c[0]) else "mcp" if "mcp" in c[0] else "other", c[1]) for c in cmds})
    return {"message": item[0] if item else None, "commands": origins}


def interrupted_by(ev: dict) -> str:
    """'sam', 'agent' or 'unknown'."""
    origins = {o for o, _ in ev["commands"]}
    msg = ev["message"]
    if origins == {"app"} and (msg is None or msg in APP_STOP_TEXTS):
        return "sam"
    if (msg or "").startswith("Stopped by an agent") or (origins == {"mcp"} and msg not in APP_STOP_TEXTS and msg):
        return "agent"
    return "unknown"


def cause(f: dict | None) -> str:
    if not f:
        return "no error recorded"
    m = (f.get("message") or "").lower()
    if f.get("class") == "usage_limit" or "429" in m or "usage limit" in m:
        return "usage limit"
    if "could not find this conversation" in m:
        return "conversation lost"
    if "disk is full" in m or "enospc" in m:
        return "disk full"
    if "auth_unavailable" in m or "api key" in m:
        return "no auth"
    return f.get("class") or "error"


def last_activity(con, thread_id, run_id, started_at) -> str | None:
    r = con.execute(f"SELECT max(updated_at) FROM {probe.TURN_ITEMS} WHERE thread_id = ? AND run_id = ?",
                    (thread_id, run_id)).fetchone()
    return max([x for x in (r[0], started_at) if x], default=None)


def run_facts(con, run_id) -> dict | None:
    r = con.execute(RUN_SELECT + "WHERE r.run_id = ?", (run_id,)).fetchone()
    return dict(r) if r else None


def classify(con, run: dict, now: dt.datetime | None = None, stall_min=30, awake_since=None) -> dict | None:
    """The card for one run, or None when the run needs none."""
    status = run["status"]
    card = None
    if status == "failed":
        f = failure(con, run["thread_id"], run["run_id"])
        card = {"kind": "failed", "cause": cause(f), "detail": (f or {}).get("message")}
    elif status == "interrupted":
        ev = stop_evidence(con, run["thread_id"], run["run_id"], run["requested_at"], run["completed_at"])
        who = interrupted_by(ev)
        if who == "sam":
            return None
        card = {"kind": "stopped_by_agent" if who == "agent" else "interrupted_unknown",
                "cause": "stopped by an agent" if who == "agent" else "no stop by Sam on record",
                "detail": ev["message"], "evidence": ev["commands"]}
    elif status in OPEN and now is not None:
        last = last_activity(con, run["thread_id"], run["run_id"], run.get("started_at") or run["requested_at"])
        cutoff = now - dt.timedelta(minutes=stall_min)
        # A sleeping Mac pauses runs and the watcher alike, so a stall counts only after the watcher has
        # itself been awake for the whole window.
        if last and parse(last) < cutoff and (awake_since is None or parse(awake_since) <= cutoff):
            card = {"kind": "stalled", "cause": f"no run activity since {last[:16]}Z", "detail": None}
    if card is None:
        return None
    lead = None
    if run.get("parent_id"):
        p = thread_info(con, run["parent_id"])
        open_lead = con.execute(f"SELECT count(*) FROM {probe.RUNS} WHERE thread_id = ? AND status IN"
                                " ('preparing','starting','running','waiting','queued')", (run["parent_id"],)).fetchone()[0]
        lead = {"thread_id": run["parent_id"], "title": p["title"] if p else None, "idle": open_lead == 0}
    return {"key": f"{run['run_id']}:{card['kind']}", **card, "run_id": run["run_id"], "ordinal": run["ordinal"],
            "thread_id": run["thread_id"], "title": run["title"], "mode": run["runtime_mode"],
            "model": run.get("model"), "lead": lead, "at": run["completed_at"] or run["requested_at"]}


class MemoryState(dict):
    def save(self):
        pass


class FileState(dict):
    def __init__(self, f: Path):
        self.f = f
        super().__init__(json.loads(f.read_text()) if f.exists() else {})

    def save(self):
        tmp = self.f.with_suffix(".tmp")
        tmp.write_text(json.dumps(self, indent=1))
        tmp.replace(self.f)


class Watcher:
    OVERLAP = dt.timedelta(minutes=2)  # projection rows can land a little after their timestamps
    SEEN_DAYS = 14
    GAP = dt.timedelta(minutes=6)  # three missed 2-minute cycles: the Mac slept or the job was off

    def __init__(self, con, state=None, since: dt.datetime | None = None, stall_min=30):
        self.con = con
        self.state = state if state is not None else FileState(config.path("state", "fleet-watch.json"))
        self.stall_min = stall_min
        self.last_scan_rows = 0
        # Live, a thread Sam archived needs no card. A replay of past days sets this, because a thread
        # archived since then says nothing about the run at the time.
        self.include_archived = False
        if "watermark" not in self.state:
            self.state["watermark"] = iso(since or dt.datetime.now(dt.timezone.utc))
        self.state.setdefault("seen", {})
        self.state.setdefault("gaps", [])

    def cycle(self, now: dt.datetime | None = None) -> list[dict]:
        now = now or dt.datetime.now(dt.timezone.utc)
        last = self.state.get("last_cycle")
        if last is None or now - parse(last) > self.GAP:
            if last is not None:
                self.state["gaps"] = (self.state["gaps"] + [[last, iso(now)]])[-20:]
            self.state["awake_since"] = iso(now)
        wm = parse(self.state["watermark"])
        rows = [dict(r) for r in self.con.execute(RUN_SCAN, {"wm": iso(wm - self.OVERLAP)})]
        self.last_scan_rows = len(rows)
        cards = []
        for run in rows:
            if run["deleted_at"] or (run["archived_at"] and not self.include_archived):
                continue
            if run["status"] not in ("failed", "interrupted", *OPEN):
                continue
            keys = [f"{run['run_id']}:{k}" for k in CARD_KINDS]
            if any(k in self.state["seen"] for k in keys):
                continue
            card = classify(self.con, run, now, self.stall_min, self.state.get("awake_since"))
            if card:
                self.state["seen"][card["key"]] = iso(now)
                cards.append(card)
        stamps = [r[k] for r in rows for k in ("requested_at", "completed_at") if r[k]]
        if stamps:
            self.state["watermark"] = min(max(stamps), iso(now))
        cutoff = iso(now - dt.timedelta(days=self.SEEN_DAYS))
        self.state["seen"] = {k: v for k, v in self.state["seen"].items() if v >= cutoff}
        self.state["last_cycle"] = iso(now)
        self.state.save()
        return cards


def render(cards: list[dict], link) -> str:
    """One message for the Operator thread. `link(thread_id)` gives a clickable thread link."""
    lines = [f"{len(cards)} run{'s' if len(cards) != 1 else ''} ended abnormally. Open a thread to resume it there."]
    for i, c in enumerate(cards, 1):
        what = {"failed": "failed", "stopped_by_agent": "was stopped by an agent", "stalled": "stalled",
                "interrupted_unknown": "was interrupted, and nothing shows that you stopped it"}[c["kind"]]
        lines.append(f"\n{i}. {link(c['thread_id'], c['title'])} run {c['ordinal']} {what} ({c['cause']}).")
        if c.get("detail"):
            lines.append(f"   T3 says: {' '.join(str(c['detail']).split())[:240]}")
        if c.get("lead"):
            state = "idle" if c["lead"]["idle"] else "still running"
            lines.append(f"   Its lead is {link(c['lead']['thread_id'], c['lead']['title'])}, {state}. "
                         "Nothing was sent to either.")
        if c.get("mode") == "full-access":
            lines.append("   Full access: only you can resume it.")
    return "\n".join(lines)
