"""Every write the operator makes to T3 goes through here: posting cards, launching, resuming its own threads.

Each write has a stable key (`fk-...`), sent as T3's `clientRequestId` and also written as a last line,
`fleet-key: <key>`, in the message itself. The key is recorded in a journal before the call and marked
accepted after it. On any retry the launcher first searches T3's database for that line, so a write that
landed is never sent again, even when the answer was lost, the runner was killed after T3 accepted, or T3
restarted and its replay of `clientRequestId` no longer applies (T3 scopes the replay to the sign-in
session: t3code apps/server/src/mcp/OrchestratorMcpService.ts stableCommandId).

Two modes, from config `fleet_mode`:
- `cards` (the default): post cards to the Operator thread. Nothing else.
- `full`: also launch drafted briefs Sam approved with "go", the unattended templates, and resume threads
  the operator launched itself.
"""
import fcntl
import hashlib
import json
import shutil
from contextlib import contextmanager
from pathlib import Path

from .. import config
from . import envelope, probe, receipts, watch
from .t3client import Client, T3Error, T3Unreachable, login  # noqa: F401 (login: the CLI's sign-in)

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

    def find_marker(self, key, thread_id=None):
        """The message carrying `fleet-key: <key>`, from T3's database, or None."""
        q = f'"{MARK}{key}"'
        sql = (f"SELECT m.thread_id, m.message_id FROM {probe.MESSAGE_SEARCH} s JOIN {probe.MESSAGES} m"
               f" ON m.rowid = s.rowid WHERE {probe.MESSAGE_SEARCH} MATCH ? AND m.role = 'user'")
        args = [q]
        if thread_id:
            sql += " AND m.thread_id = ?"
            args.append(thread_id)
        r = self.con.execute(sql + " LIMIT 1", args).fetchone()
        return {"thread_id": r[0], "message_id": r[1]} if r else None

    def write(self, op: str, key: str, tool: str, args: dict, thread_id=None, ask="") -> dict:
        with journal() as j:
            rec = j.get(key)
        if rec and rec["state"] == "accepted":
            return rec
        if rec:
            found = self.find_marker(key, thread_id)
            if found:
                return self._record(key, {**rec, "state": "accepted", **found, "recovered": True})
        self._record(key, {"op": op, "state": "pending", "thread_id": thread_id, "at": config.now_iso(),
                           "attempts": (rec or {}).get("attempts", 0) + 1})
        try:
            result = self.client.call(tool, {**args, "clientRequestId": key})
        except T3Unreachable as e:
            self._record(key, {"op": op, "state": "uncertain", "thread_id": thread_id, "at": config.now_iso(),
                               "error": str(e)[:300], "attempts": (rec or {}).get("attempts", 0) + 1})
            receipts.write({"ts": config.now_iso(), "level": "claimed", "for": ask, "key": key, "op": op,
                            "thread_id": thread_id, "flags": ["uncertain"], "error": str(e)[:300]})
            raise
        except T3Error as e:
            self._record(key, {"op": op, "state": "refused", "thread_id": thread_id, "at": config.now_iso(),
                               "error": str(e)[:300]})
            raise
        self._after_accept(key, result)
        return self._record(key, {"op": op, "state": "accepted", "at": config.now_iso(),
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

    def tree_runs(self, root_thread_id) -> int:
        """Runs in a launched thread and every thread under it (T3's lineage.rootThreadId)."""
        return self.con.execute(
            f"SELECT count(*) FROM {probe.RUNS} r JOIN {probe.THREADS} t ON t.thread_id = r.thread_id"
            " WHERE t.thread_id = ? OR json_extract(t.payload_json, '$.lineage.rootThreadId') = ?",
            (root_thread_id, root_thread_id)).fetchone()[0]

    def project_for(self, repo) -> str:
        root = str(Path(repo).expanduser().resolve())
        r = self.con.execute("SELECT project_id FROM projection_projects WHERE workspace_root = ?"
                             " AND deleted_at IS NULL", (root,)).fetchone()
        if r is None:
            raise envelope.Refused({"repo": f"{root} is not a T3 project"})
        return r[0]

    def launch(self, env: envelope.Envelope, approved_by_go=False, routes=None) -> dict:
        envelope.check(env, self.con, routes)
        self._require_full("a launch")
        if env.template == "drafted" and not approved_by_go:
            raise envelope.Refused({"approval": "a drafted brief waits for Sam's \"go\""})
        free_gb = shutil.disk_usage(Path(env.repo).expanduser()).free / 1e9
        if free_gb < self.lim["disk_floor_gb"]:
            raise envelope.Refused({"disk": f"{free_gb:.1f} GB free, under the {self.lim['disk_floor_gb']} GB floor"})
        if self.open_launches() >= self.lim["concurrent"]:
            raise envelope.Refused({"concurrent": f"{self.lim['concurrent']} launched threads are still open"})
        key = env.key()
        with journal() as j:
            already = key in j
        if not already and not config.take("fleet_launches", self.lim["launches_per_day"]):
            raise envelope.Refused({"launches_per_day": f"{self.lim['launches_per_day']} launches today already"})
        message = (envelope.render_brief(env) if env.template == "drafted" else template_text(env)) + f"\n{MARK}{key}\n"
        args = {"projectId": self.project_for(env.repo), "title": env.title or f"{env.template} {env.ids}",
                "message": message, "runtimeMode": env.runtime_mode,
                "modelSelection": {"instanceId": env.provider, "model": env.model,
                                   "options": [{"id": "reasoningEffort" if env.provider.startswith("codex")
                                                else "effort", "value": env.effort}]},
                "workspaceStrategy": {"type": "worktree", "baseRef": f"origin/{env.base_branch}",
                                      "startFromOrigin": True}}
        ask = "\n".join(e["text"] for e in env.ask_verbatim)
        return self.write("launch", key, "t3_thread_launch", args, ask=ask)

    def resume_own(self, thread_id, run_id) -> dict:
        """Continue a thread the operator launched. Any other thread is Sam's to resume."""
        self._require_full("a resume")
        if thread_id not in self.own_threads():
            raise envelope.Refused({"thread": f"{thread_id} was not launched by the operator; Sam resumes it"})
        key = "fk-resume-" + hashlib.sha256(f"{thread_id}\n{run_id}".encode()).hexdigest()[:24]
        text = (f"Your run {run_id} ended without finishing. Continue the task from where it stopped, and say "
                f"what changed since.\n\n{MARK}{key}\n")
        return self.write("resume", key, "t3_thread_send", {"threadId": thread_id, "message": text, "mode": "queue"},
                          thread_id=thread_id)


def template_text(env: envelope.Envelope) -> str:
    if env.template == "wrap":
        return f"Run the nightly wrap for {env.ids['date']} as runner/README.md, Fleet, describes."
    if env.template == "correct":
        return f"Fix mistake class {env.ids['class_id']} at the highest level that works, as runner/README.md describes."
    raise envelope.Refused({"template": f"{env.template} has no launch text"})
