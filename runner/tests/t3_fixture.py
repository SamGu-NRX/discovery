"""A small T3 database with the tables and columns the fleet reads, and a fake T3 MCP server over it.

The schema copies the columns of T3's statev2.sqlite (checked against the live file on 2026-11-19); rows are
written the way T3 writes them: run ids `run:thread:<id>:ordinal:<n>`, `createdBy` on messages, interrupt
items with T3's texts, command receipts with client UUIDs or MCP ids, and a contentless trigram FTS table
whose rowid is the message's rowid.
"""
import datetime as dt
import hashlib
import http.server
import json
import sqlite3
import threading
import uuid

SCHEMA = """
CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
  default_provider TEXT, runtime_mode TEXT, interaction_mode TEXT, active_provider_thread_id TEXT, created_at TEXT,
  updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER,
  provider TEXT, provider_thread_id TEXT, status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT,
  provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT,
  node_id TEXT, provider_thread_id TEXT, provider_turn_id TEXT, parent_item_id TEXT, ordinal INTEGER, type TEXT,
  status TEXT, updated_at TEXT, payload_json TEXT, inline_work_output TEXT);
CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT,
  attempt_ordinal INTEGER, root_node_id TEXT, provider TEXT, provider_thread_id TEXT, provider_turn_id TEXT,
  status TEXT, payload_json TEXT, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, thread_id TEXT,
  provider_thread_id TEXT, node_id TEXT, run_attempt_id TEXT, ordinal INTEGER, status TEXT, started_at TEXT,
  completed_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT,
  node_id TEXT, role TEXT, streaming INTEGER, created_at TEXT, updated_at TEXT, payload_json TEXT, search_text TEXT);
CREATE TABLE orchestration_command_receipts (command_id TEXT PRIMARY KEY, aggregate_kind TEXT, aggregate_id TEXT,
  accepted_at TEXT, result_sequence INTEGER, status TEXT, error TEXT, command_type TEXT);
CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT, deleted_at TEXT);
CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(text, content = '', contentless_delete = 1,
  tokenize = 'trigram remove_diacritics 1');
"""


class T3DB:
    def __init__(self, path):
        self.path = str(path)
        self.con = sqlite3.connect(self.path, check_same_thread=False)
        self.con.executescript(SCHEMA)
        self.lock = threading.Lock()

    def commit(self):
        self.con.commit()

    def thread(self, tid, title="t", mode="full-access", parent=None, created="2026-11-10T00:00:00.000Z",
               updated=None, archived=None, project="p1", worktree=None, root=None):
        payload = {"lineage": {"parentThreadId": parent, "rootThreadId": root,
                               "relationshipToParent": "subagent" if parent else None}, "worktreePath": worktree}
        self.con.execute("INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, runtime_mode,"
                         " interaction_mode, created_at, updated_at, archived_at, payload_json) VALUES (?,?,?,?,?,?,?,?,?)",
                         (tid, project, title, mode, "default", created, updated or created, archived, json.dumps(payload)))
        self.commit()
        return tid

    def run(self, tid, ordinal, status, requested, completed=None, model="claude-opus-5-5", started="requested",
            executed=None, continues=None, held=False):
        rid = f"run:thread:{tid}:ordinal:{ordinal}"
        payload = {"id": rid, "status": status, "modelSelection": {"model": model},
                   "requestedAt": requested, "startedAt": requested if started == "requested" else started,
                   "completedAt": completed}
        if continues:
            payload["restartContinuationOfRunId"] = continues
        if held:
            payload["queueHeld"] = True
        self.con.execute("INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, status,"
                         " requested_at, completed_at, payload_json) VALUES (?,?,?,?,?,?,?)",
                         (rid, tid, ordinal, status, requested, completed, json.dumps(payload)))
        if executed is not None:
            att = f"run-attempt:{rid}:attempt:1"
            self.con.execute("INSERT INTO orchestration_v2_projection_run_attempts (attempt_id, thread_id, run_id)"
                             " VALUES (?,?,?)", (att, tid, rid))
            for i, m in enumerate(executed if isinstance(executed, list) else [executed]):
                self.con.execute("INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, thread_id,"
                                 " run_attempt_id, payload_json) VALUES (?,?,?,?)",
                                 (f"pt:{rid}:{i}", tid, att, json.dumps({"model": m})))
        self.commit()
        return rid

    def item(self, tid, rid, type_, status, updated, **payload):
        self.con.execute("INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, type,"
                         " status, updated_at, payload_json) VALUES (?,?,?,?,?,?,?)",
                         (f"ti:{uuid.uuid4()}", tid, rid, type_, status, updated, json.dumps({"type": type_, **payload})))
        self.commit()

    def failure(self, tid, rid, at, cls="provider_error", message="Claude API is overloaded (529)."):
        self.item(tid, rid, "error", "failed", at, failure={"class": cls, "message": message})

    def interrupt(self, tid, rid, at, message):
        self.item(tid, rid, "run_interrupt_request", "completed", at, message=message)

    def receipt(self, tid, command_type, at, by="app", cid=None):
        cid = cid or (str(uuid.uuid4()) if by == "app" else f"command:mcp:{uuid.uuid4()}:{command_type}")
        self.con.execute("INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id,"
                         " accepted_at, status, command_type) VALUES (?,?,?,?,?,?)",
                         (cid, "thread", tid, at, "accepted", command_type))
        self.commit()

    def message(self, tid, text, role="user", by="user", at="2026-11-10T00:00:00.000Z", mid=None):
        mid = mid or str(uuid.uuid4())
        payload = {"id": mid, "role": role, "text": text, "createdBy": by,
                   "creationSource": "web" if by == "user" else "mcp"}
        cur = self.con.execute("INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role,"
                               " created_at, updated_at, payload_json) VALUES (?,?,?,?,?,?)",
                               (mid, tid, role, at, at, json.dumps(payload)))
        # T3 indexes assistant messages and the user-role ones Sam typed, never an agent's
        # (t3code apps/server/src/orchestration-v2/messageSearchIndex.ts indexedMessageCondition).
        if role == "assistant" or by == "user":
            self.con.execute("INSERT INTO orchestration_v2_message_search (rowid, text) VALUES (?, ?)",
                             (cur.lastrowid, text))
        self.commit()
        return mid

    def project(self, pid, root):
        self.con.execute("INSERT INTO projection_projects VALUES (?,?,?,NULL)", (pid, pid, root))
        self.commit()


def _now():
    t = dt.datetime.now(dt.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


class FakeT3:
    """T3's MCP endpoint for the fleet's two writes, with T3's idempotency and access rules.

    `clientRequestId` replays within one sign-in namespace, as T3 does (stableCommandId), and survives a
    restart because T3 keeps command receipts; a new sign-in (`relogin`) gets a new namespace. A send to a
    thread above the token's mode is refused (threadAccess.ts assertTargetWithinLimits). `drop_next` makes
    the server commit a call and then close the connection without answering: a lost response."""

    def __init__(self, db: T3DB, token_mode="auto"):
        self.db = db
        self.token_mode = token_mode
        self.calls = []
        self.replays = {}
        self.drop_next = False
        self.reject_next = False
        self.rejected = set()
        self.namespace = f"client:{uuid.uuid4()}"
        fake = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                if body.get("method") == "notifications/initialized":
                    self.send_response(202)
                    self.end_headers()
                    return
                if body["method"] == "initialize":
                    return self._send({"jsonrpc": "2.0", "id": body["id"], "result": {"protocolVersion": "x"}},
                                      session="s1")
                args = body["params"]["arguments"]
                result = fake.handle(body["params"]["name"], args)
                if fake.drop_next:
                    fake.drop_next = False
                    self.close_connection = True
                    self.connection.shutdown(2)
                    return
                self._send({"jsonrpc": "2.0", "id": body["id"], "result": result})

            def _send(self, msg, session=None):
                raw = json.dumps(msg).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                if session:
                    self.send_header("mcp-session-id", session)
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *a):
                pass

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}/mcp"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()

    def relogin(self):
        """The runner signed in again: a new session, so T3's replay of earlier keys no longer applies."""
        self.namespace = f"client:{uuid.uuid4()}"

    def handle(self, tool, args):
        with self.db.lock:
            self.calls.append((tool, args))
            replay_key = (self.namespace, tool, args.get("clientRequestId"))
            if replay_key in self.rejected or self.reject_next:
                # T3 stores a dispatch rejection and answers every retry of that command id with it.
                self.reject_next = False
                self.rejected.add(replay_key)
                return {"isError": True, "content": [{"type": "text", "text": "previously rejected"}]}
            if args.get("clientRequestId") and replay_key in self.replays:
                return self.replays[replay_key]
            if tool == "t3_thread_send":
                row = self.db.con.execute("SELECT runtime_mode FROM orchestration_v2_projection_threads WHERE"
                                          " thread_id = ?", (args["threadId"],)).fetchone()
                order = ["approval-required", "auto-accept-edits", "auto", "full-access"]
                if row is None or order.index(row[0]) > order.index(self.token_mode):
                    return {"isError": True, "content": [{"type": "text", "text": f"Thread \"{args['threadId']}\""
                            f" runs in {row and row[0]}, above this caller's {self.token_mode} limit."}]}
                mid = self.db.message(args["threadId"], args["message"], by="agent", at=_now())
                result = {"structuredContent": {"threadId": args["threadId"], "messageId": mid}}
            elif tool == "t3_thread_launch":
                tid = "mcp:launch:" + hashlib.sha256(json.dumps([self.namespace, args.get("clientRequestId")]).encode()).hexdigest()
                self.db.thread(tid, title=args["title"], mode=args.get("runtimeMode", "auto"),
                               project=args.get("projectId", "p1"), created=_now())
                self.db.message(tid, args["message"], by="agent", at=_now())
                result = {"structuredContent": {"threadId": tid, "runId": None, "status": "starting"}}
            elif tool == "t3_thread_interrupt":
                result = {"structuredContent": {"threadId": args["threadId"], "status": "interrupt_requested"}}
            else:
                return {"isError": True, "content": [{"type": "text", "text": f"unknown tool {tool}"}]}
            self.replays[replay_key] = result
            return result

    def messages_in(self, tid):
        return self.db.con.execute("SELECT count(*) FROM orchestration_v2_projection_messages WHERE thread_id = ?",
                                   (tid,)).fetchone()[0]

    def threads_titled(self, title):
        return self.db.con.execute("SELECT count(*) FROM orchestration_v2_projection_threads WHERE title = ?",
                                   (title,)).fetchone()[0]

    def go(self, tid, text):
        """Sam types in a thread."""
        return self.db.message(tid, text, by="user", at=_now())
