"""Read-only access to T3's database, and the schema probe that guards it.

T3 keeps its state in `~/.t3/userdata/statev2.sqlite` (about 17 GB, WAL mode). The fleet code opens it with
`mode=ro` and `query_only`, so no statement it runs can write. Every column the fleet queries is listed in
REQUIRED. `check_schema` compares that list with the live database at startup, and a missing table or column
stops the watcher with SchemaChanged, naming each one, instead of letting a query fail or silently match
nothing after a T3 update.
"""
import json
import sqlite3
import time
from pathlib import Path

RUNS = "orchestration_v2_projection_runs"
THREADS = "orchestration_v2_projection_threads"
TURN_ITEMS = "orchestration_v2_projection_turn_items"
ATTEMPTS = "orchestration_v2_projection_run_attempts"
PROVIDER_TURNS = "orchestration_v2_projection_provider_turns"
MESSAGES = "orchestration_v2_projection_messages"
RECEIPTS = "orchestration_command_receipts"
MESSAGE_SEARCH = "orchestration_v2_message_search"

REQUIRED = {
    RUNS: {"run_id", "thread_id", "ordinal", "status", "requested_at", "completed_at", "payload_json"},
    THREADS: {"thread_id", "project_id", "title", "runtime_mode", "created_at", "updated_at", "archived_at",
              "deleted_at", "payload_json"},
    TURN_ITEMS: {"thread_id", "run_id", "type", "status", "updated_at", "payload_json"},
    ATTEMPTS: {"attempt_id", "run_id"},
    PROVIDER_TURNS: {"run_attempt_id", "payload_json"},
    MESSAGES: {"message_id", "thread_id", "role", "created_at", "payload_json"},
    RECEIPTS: {"command_id", "aggregate_kind", "aggregate_id", "accepted_at", "command_type"},
    MESSAGE_SEARCH: set(),  # contentless FTS5: only its existence is checked
}

# JSON paths read out of payload_json columns. A T3 update that renames one leaves the column in place, so
# probe() reports how many recent rows carry each path; zero on a busy database means the path moved.
PAYLOAD_PATHS = {
    RUNS: ["$.modelSelection.model", "$.startedAt"],
    THREADS: ["$.lineage.parentThreadId", "$.worktreePath"],
}


class SchemaChanged(RuntimeError):
    """T3's database no longer has a table or column the fleet reads. The watcher stops rather than guess."""


def connect(db) -> sqlite3.Connection:
    db = Path(db).expanduser()
    if not db.exists():
        raise FileNotFoundError(f"T3 database not found at {db}")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    con.execute("PRAGMA query_only = 1")
    con.row_factory = sqlite3.Row
    return con


def missing_schema(con) -> list[str]:
    missing = []
    for table, cols in REQUIRED.items():
        have = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        if not have:
            missing.append(table)
            continue
        missing += [f"{table}.{c}" for c in sorted(cols - have)]
    return missing


def check_schema(con):
    missing = missing_schema(con)
    if missing:
        raise SchemaChanged("T3's database schema changed; the fleet watcher is disabled until runner/discovery_runner/"
                            f"fleet/probe.py REQUIRED is updated. Missing: {', '.join(missing)}")


def probe(con, sample_thread_ids=None) -> dict:
    """Day 0: prove every read the fleet makes, with the time a full watcher poll takes.

    Prints every field the watcher, receipts and find read for three kinds of thread: an archived one, a
    delegated child, and one running at Auto (or the given ids)."""
    from . import watch  # late import: watch imports this module

    out = {"schema_missing": missing_schema(con)}
    if out["schema_missing"]:
        return out
    picks = dict(sample_thread_ids or {})
    queries = {
        "archived": f"SELECT t.thread_id FROM {THREADS} t WHERE t.archived_at IS NOT NULL AND t.deleted_at IS NULL"
                    f" AND EXISTS (SELECT 1 FROM {RUNS} r WHERE r.thread_id = t.thread_id)"
                    " ORDER BY t.archived_at DESC LIMIT 1",
        "child": f"SELECT thread_id FROM {THREADS} WHERE json_extract(payload_json,'$.lineage.parentThreadId')"
                 " IS NOT NULL AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
        "auto": f"SELECT thread_id FROM {THREADS} WHERE runtime_mode = 'auto' AND deleted_at IS NULL"
                " ORDER BY updated_at DESC LIMIT 1",
    }
    for kind, q in queries.items():
        if kind not in picks:
            row = con.execute(q).fetchone()
            picks[kind] = row[0] if row else None
    out["threads"] = {}
    for kind, tid in picks.items():
        if tid is None:
            out["threads"][kind] = None
            continue
        t = watch.thread_info(con, tid)
        run = con.execute(f"SELECT run_id FROM {RUNS} WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1",
                          (tid,)).fetchone()
        r = watch.run_facts(con, run[0]) if run else None
        from . import receipts
        out["threads"][kind] = {"thread": t, "latest_run": r,
                                "executed_models": receipts.executed_models(con, run[0]) if run else None,
                                "sam_messages": [m["text"][:120] for m in sam_messages(con, tid, limit=2)]}
    # A full poll is the first one after install or a long sleep: every run of the last 14 days.
    import datetime as dt
    t0 = time.monotonic()
    w = watch.Watcher(con, state=watch.MemoryState(),
                      since=dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=14))
    w.cycle()
    out["full_poll_s"] = round(time.monotonic() - t0, 3)
    out["full_poll_rows"] = w.last_scan_rows
    t0 = time.monotonic()
    w.cycle()
    out["incremental_poll_s"] = round(time.monotonic() - t0, 3)
    out["payload_paths"] = {}
    for table, paths in PAYLOAD_PATHS.items():
        ts = "requested_at" if table == RUNS else "updated_at"
        for p in paths:
            n = con.execute(f"SELECT count(*) FROM (SELECT payload_json FROM {table} ORDER BY {ts} DESC LIMIT 500)"
                            f" WHERE json_extract(payload_json, ?) IS NOT NULL", (p,)).fetchone()[0]
            out["payload_paths"][f"{table}{p[1:]}"] = n
    return out


def sam_messages(con, thread_id, limit=20, before=None):
    """Messages Sam typed (role user, not written by an agent), newest first."""
    return [{"message_id": r[0], "created_at": r[1], "text": r[2] or ""} for r in con.execute(
        f"SELECT message_id, created_at, json_extract(payload_json, '$.text') FROM {MESSAGES} WHERE thread_id = ?"
        f" AND role = 'user' AND {TYPED_BY_SAM_SQL} AND (? IS NULL OR created_at < ?)"
        " ORDER BY created_at DESC LIMIT ?", (thread_id, before, before, limit))]


def sam_messages_after(con, thread_id, after, limit=1):
    """The first messages Sam typed in a thread after a timestamp, oldest first."""
    return [{"message_id": r[0], "created_at": r[1], "text": r[2] or ""} for r in con.execute(
        f"SELECT message_id, created_at, json_extract(payload_json, '$.text') FROM {MESSAGES} WHERE thread_id = ?"
        f" AND role = 'user' AND created_at > ? AND {TYPED_BY_SAM_SQL}"
        " ORDER BY created_at LIMIT ?", (thread_id, after, limit))]


# A scheduled task's message and an answered question ("<agent's question>\n<answer>", which an agent can
# also answer) carry createdBy "user" but are not text Sam typed (t3code ScheduledTaskService.ts,
# Orchestrator.ts async-answer).
NOT_TYPED = ("scheduled-task-message:", "async-answer:")
TYPED_BY_SAM_SQL = ("json_extract(payload_json, '$.createdBy') = 'user'"
                    " AND coalesce(json_extract(payload_json, '$.creationSource'), '') IN ('web', 'mobile', 'server')"
                    + "".join(f" AND substr(message_id, 1, {len(p)}) <> '{p}'" for p in NOT_TYPED))


def typed_by_sam(payload: dict, message_id: str = "") -> bool:
    """Text Sam typed in T3's app. T3 marks every user-role message with `createdBy` and `creationSource`.
    Measured on user-role messages since 2026-10-01: "user" with "web", "mobile" or "server" (his queued
    messages) is Sam; "agent" covers t3_thread_send (the t3 CLI's `thread send` included),
    delegate_task and scheduled tasks. A scheduled task's message takes the task's own `createdBy`
    (t3code ScheduledTaskService.ts), and "user" with "mcp" came from an MCP client, so both are left out."""
    mid = message_id or str(payload.get("id") or "")
    return (payload.get("createdBy") == "user" and payload.get("creationSource") in ("web", "mobile", "server")
            and not mid.startswith(NOT_TYPED))
