"""Every write the operator makes to T3 goes through here: posting cards, launching, resuming its own threads.

Each write has a stable key (`fk-...`), sent as T3's `clientRequestId` and also written as a last line,
`fleet-key: <key>`, in the message itself. The key is recorded in a journal before the call and marked
accepted after it. T3 replays a repeated `clientRequestId` within one sign-in, across T3 restarts
(t3code apps/server/src/mcp/OrchestratorMcpService.ts stableCommandId; auth/McpOAuth.ts:627). A new
`fleet login` starts a new sign-in, and the replay no longer applies. So on any retry the launcher first
reads T3's messages table for the key line, written since the first attempt, and sends only when it is
absent. T3's search index leaves out messages agents write, so the lookup reads the table itself.

Two modes, from config `fleet_mode`:
- `cards` (the default): post cards to the Operator thread. Nothing else.
- `full`: also launch drafted briefs Sam approved with "go". Resuming the operator's own threads and the
  unattended wrap and correct launches are not wired to the loop yet.
"""
import datetime as dt
import fcntl
import hashlib
import json
import shutil
from contextlib import contextmanager
from pathlib import Path

from .. import config
from . import envelope, probe, receipts, watch
from .t3client import Client, T3Down, T3Error, T3Unreachable, login  # noqa: F401 (login: the CLI's sign-in)

LIMITS_FILE = Path("~/.agent-config/operator/limits.json")
# Starting values from the design (final-design.md 3.3), not measured.
LIMITS = {"launches_per_day": 12, "concurrent": 3, "disk_floor_gb": 8, "runs_per_launch": 20,
          "card_messages_per_day": 24}
MARK = "fleet-key: "


def limits(path=LIMITS_FILE) -> dict:
    f = Path(path).expanduser()
    over = json.loads(f.read_text()) if f.exists() else {}
    unknown = set(over) - set(LIMITS)
    if unknown:
        raise ValueError(f"{f}: unknown limit keys {sorted(unknown)}")
    return {**LIMITS, **over}


@contextmanager
def journal():
    f = config.path("state", "fleet-journal.json")
    with open(config.path("state", "fleet-journal.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = json.loads(f.read_text()) if f.exists() else {}
        yield data
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        tmp.replace(f)


class Launcher:
    def __init__(self, con, client_factory=Client.from_files, mode="cards", lim=None, log=print):
        self.con = con
        self.client_factory = client_factory
        self._client = None
        self.mode = mode
        self.lim = lim or limits()
        self.log = log

    @property
    def client(self):
        if self._client is None:
            self._client = self.client_factory()
        return self._client

    def _after_accept(self, key, result):
        """Test seam: runs after T3 accepted and before the journal records it."""

    def find_marker(self, key, rec) -> dict | None:
        """What a landed write left in T3's database since the key's first attempt, or None: the message
        carrying `fleet-key: <key>`, or for a stop, the interrupt item carrying its reason."""
        since = watch.iso(watch.parse(rec["first_at"]) - dt.timedelta(minutes=5))
        if rec.get("op") == "stop":
            r = self.con.execute(
                f"SELECT run_id FROM {probe.TURN_ITEMS} WHERE thread_id = ? AND type = 'run_interrupt_request'"
                " AND updated_at >= ? AND json_extract(payload_json, '$.message') = ? LIMIT 1",
                (rec["thread_id"], since, rec.get("match"))).fetchone()
            return {"thread_id": rec["thread_id"], "run_id": r[0]} if r else None
        line = f"{MARK}{key}"
        if rec.get("thread_id"):
            threads = [rec["thread_id"]]
        else:  # a launch: the new thread is in the project, created since the first attempt
            threads = [r[0] for r in self.con.execute(
                f"SELECT thread_id FROM {probe.THREADS} WHERE project_id = ? AND created_at >= ?",
                (rec.get("project_id"), since))]
        for tid in threads:
            for mid, payload in self.con.execute(
                    f"SELECT message_id, payload_json FROM {probe.MESSAGES} WHERE thread_id = ? AND role = 'user'"
                    " AND created_at >= ? ORDER BY created_at", (tid, since)):
                if line in (json.loads(payload).get("text") or "").splitlines():
                    return {"thread_id": tid, "message_id": mid}
        return None

    def write(self, op: str, key: str, tool: str, args: dict, thread_id=None, project_id=None, ask="",
              match=None) -> dict:
        with journal() as j:
            rec = j.get(key)
        if rec and rec["state"] == "accepted":
            return rec
        if rec and rec["state"] in ("pending", "uncertain"):
            found = self.find_marker(key, rec)
            if found:
                return self._record(key, {**rec, "state": "accepted", **found, "recovered": True})
        base = {"op": op, "thread_id": thread_id, "project_id": project_id, "match": match,
                "first_at": (rec or {}).get("first_at") or config.now_iso(),
                "attempts": (rec or {}).get("attempts", 0) + 1}
        self._record(key, {**base, "state": "pending", "at": config.now_iso()})
        try:
            result = self.client.call(tool, {**args, "clientRequestId": key})
        except T3Down:
            self._client = None  # T3 may come back on another port; read its address again next time
            raise  # the call never reached T3; the entry stays pending
        except T3Unreachable as e:
            self._client = None
            self._record(key, {**base, "state": "uncertain", "at": config.now_iso(), "error": str(e)[:300]})
            receipts.write({"ts": config.now_iso(), "level": "claimed", "for": ask, "key": key, "op": op,
                            "thread_id": thread_id, "flags": ["uncertain"], "error": str(e)[:300]})
            raise
        except T3Error as e:
            self._record(key, {**base, "state": "refused", "at": config.now_iso(), "error": str(e)[:300]})
            raise
        self._after_accept(key, result)
        return self._record(key, {**base, "state": "accepted", "at": config.now_iso(),
                                  "thread_id": result.get("threadId") or thread_id, "run_id": result.get("runId")})

    def _record(self, key, rec):
        with journal() as j:
            j[key] = rec
        return rec

    # Cards ---------------------------------------------------------------------------------------------

    def post_cards(self, operator_thread_id: str, cards: list[dict]) -> dict | None:
        if not cards:
            return None
        key = "fk-cards-" + hashlib.sha256("\n".join(sorted(c["key"] for c in cards)).encode()).hexdigest()[:24]
        with journal() as j:
            already = key in j
        if not already and not config.take("fleet_card_messages", self.lim["card_messages_per_day"]):
            self.log(f"card message cap ({self.lim['card_messages_per_day']} a day) reached; {len(cards)} cards held")
            return None
        text = watch.render(cards, link=lambda tid, title: f"{title or tid} (`{tid}`)") + f"\n\n{MARK}{key}"
        return self.write("cards", key, "t3_thread_send",
                          {"threadId": operator_thread_id, "message": text, "mode": "queue"},
                          thread_id=operator_thread_id)

    # Launches ------------------------------------------------------------------------------------------

    def _require_full(self, what):
        if self.mode != "full":
            raise envelope.Refused({"fleet_mode": f"{what} needs fleet_mode 'full'; this runner posts cards only"})

    def own_threads(self) -> dict:
        with journal() as j:
            return {r["thread_id"]: k for k, r in j.items() if r.get("op") == "launch" and r["state"] == "accepted"}

    def open_launches(self) -> int:
        ids = list(self.own_threads())
        if not ids:
            return 0
        marks = ",".join("?" * len(ids))
        return self.con.execute(
            f"SELECT count(DISTINCT thread_id) FROM {probe.RUNS} WHERE thread_id IN ({marks})"
            " AND status IN ('queued','preparing','starting','running','waiting')", ids).fetchone()[0]

    TREE = ("(t.thread_id = ? OR CASE WHEN json_valid(t.payload_json) THEN"  # this form uses T3's index
            " json_extract(t.payload_json, '$.lineage.rootThreadId') END = ?)")

    def tree_runs(self, root_thread_id) -> int:
        """Runs in a launched thread and every thread under it (T3's lineage.rootThreadId)."""
        return self.con.execute(
            f"SELECT count(*) FROM {probe.THREADS} t JOIN {probe.RUNS} r ON r.thread_id = t.thread_id"
            f" WHERE {self.TREE}", (root_thread_id, root_thread_id)).fetchone()[0]

    def tree_open(self, root_thread_id) -> bool:
        return self.con.execute(
            f"SELECT 1 FROM {probe.THREADS} t JOIN {probe.RUNS} r ON r.thread_id = t.thread_id WHERE {self.TREE}"
            " AND r.status IN ('queued','preparing','starting','running','waiting') LIMIT 1",
            (root_thread_id, root_thread_id)).fetchone() is not None

    def sam_took_over(self, root_thread_id, since) -> bool:
        """Sam typed in the launched thread himself, so its runs are his, not the operator's."""
        return bool(probe.sam_messages_after(self.con, root_thread_id, since, limit=1))

    def over_budget(self) -> list[str]:
        """Launched trees still running past `runs_per_launch` runs, children counted, that Sam has not
        taken over."""
        with journal() as j:
            launched = {r["thread_id"]: r.get("at") or "" for r in j.values()
                        if r.get("op") == "launch" and r["state"] == "accepted"}
        return [t for t, at in launched.items() if self.tree_open(t) and not self.sam_took_over(t, at)
                and self.tree_runs(t) > self.lim["runs_per_launch"]]

    def enforce_tree_budget(self) -> list[str]:
        """Stop each tree over budget the way its Stop button does (its delegated tasks included)."""
        self._require_full("stopping a launched tree")
        stopped = []
        for tid in self.over_budget():
            n = self.tree_runs(tid)
            key = "fk-stop-" + hashlib.sha256(f"{tid}\n{n}".encode()).hexdigest()[:24]
            reason = f"Operator budget: this launch used {n} runs, over its {self.lim['runs_per_launch']}."
            rec = self.write("stop", key, "t3_thread_interrupt", {"threadId": tid, "stop": True, "reason": reason},
                             thread_id=tid, match=f"Stopped by an agent: {reason}")
            if rec["state"] == "accepted":
                stopped.append(tid)
        return stopped

    def project_for(self, repo) -> str:
        root = str(Path(repo).expanduser().resolve())
        r = self.con.execute("SELECT project_id FROM projection_projects WHERE workspace_root = ?"
                             " AND deleted_at IS NULL", (root,)).fetchone()
        if r is None:
            raise envelope.Refused({"repo": f"{root} is not a T3 project"})
        return r[0]

    def launch(self, env: envelope.Envelope, approved_by_go=False, routes=None) -> dict:
        """Every check runs before the daily budget is spent and before T3 is called."""
        envelope.check(env, self.con, routes)
        self._require_full("a launch")
        if env.template == "drafted" and not approved_by_go:
            raise envelope.Refused({"approval": "a drafted brief waits for Sam's \"go\""})
        free_gb = shutil.disk_usage(Path(env.repo).expanduser()).free / 1e9
        if free_gb < self.lim["disk_floor_gb"]:
            raise envelope.Refused({"disk": f"{free_gb:.1f} GB free, under the {self.lim['disk_floor_gb']} GB floor"})
        over = self.over_budget()
        if over:
            raise envelope.Refused({"runs_per_launch": f"{len(over)} launched trees are over their run budget"})
        if self.open_launches() >= self.lim["concurrent"]:
            raise envelope.Refused({"concurrent": f"{self.lim['concurrent']} launched threads are still open"})
        project_id = self.project_for(env.repo)
        key = env.key()
        message = (envelope.render_brief(env) if env.template == "drafted" else envelope.template_text(env))
        args = {"projectId": project_id, "title": envelope.title(env), "message": message + f"\n{MARK}{key}\n",
                "runtimeMode": env.runtime_mode,
                "modelSelection": {"instanceId": env.provider, "model": env.model,
                                   "options": [{"id": "reasoningEffort" if env.provider.startswith("codex")
                                                else "effort", "value": env.effort}]},
                "workspaceStrategy": {"type": "worktree", "baseRef": f"origin/{env.base_branch}",
                                      "startFromOrigin": True}}
        with journal() as j:
            already = key in j
        if not already and not config.take("fleet_launches", self.lim["launches_per_day"]):
            raise envelope.Refused({"launches_per_day": f"{self.lim['launches_per_day']} launches today already"})
        ask = "\n".join(e["text"] for e in env.ask_verbatim)
        try:
            return self.write("launch", key, "t3_thread_launch", args, project_id=project_id, ask=ask)
        except T3Unreachable:
            raise
        except T3Error as e:  # T3's own refusal, reported to Sam like the envelope's
            raise envelope.Refused({"t3": str(e)[:300]}) from None
