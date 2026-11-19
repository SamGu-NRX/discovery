"""An in-memory Worker that follows docs/CONTRACT.md's runner endpoints, for tests and local runs.

Where the deployed Worker (worker/src/candidates.ts, x.ts) settled a detail the contract leaves open, the
mock does the same: candidate times are epoch milliseconds, a post's context nests its thread under
`thread`, and the daily unbookmarked cap answers 429. One deliberate difference: complete accepts state
"new", which the contract's deferral needs and the deployed Worker refuses (runner/README.md, Open issues).

Embeddings are hashed bags of words (768 dims), so texts sharing words are similar; they stand in for
bge-base only in shape. `routes_down` makes chosen routes answer 404, the way an undeployed slice does.
Run standalone with `python3 runner/tests/mock_worker.py 8788`.
"""
import datetime as dt
import hashlib
import json
import math
import re
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TOKEN = "test-runner-token"


def now():
    return dt.datetime.now(dt.timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def ms(t):
    return int(t.timestamp() * 1000)


STOP = set("a an and are as at be but by for from has have i if in into is it its of on or that the this to was we "
           "were will with you your our not just so can more all they he she them my me do what when how".split())


def hashed_vector(text, dim=768):
    v = [0.0] * dim
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        if w in STOP or len(w) < 3:
            continue
        h = int(hashlib.md5(w.encode()).hexdigest(), 16)
        v[h % dim] += 1.0 if (h >> 20) & 1 else -1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class State:
    def __init__(self):
        self.posts = {}       # id -> post (+ account, bookmarked, session_id, surface, score)
        self.contexts = {}    # id -> context response
        self.positives = []
        self.candidates = {}  # id -> row
        self.proposals = {}
        self.routes_down = set()
        self.daily_cap = 15
        self.issue_tokens = True  # contract 10b06ac; False reproduces a Worker that predates lease tokens
        self.lock = threading.Lock()
        self.log = []

    def add_candidate(self, kind, ref, title, url, score=None, parts=None, created_at=None):
        for c in self.candidates.values():
            if c["kind"] == kind and c["ref"] == ref:
                return c
        cid = uuid.uuid4().hex[:12]
        c = {"id": cid, "kind": kind, "ref": ref, "title": title, "url": url, "score": score, "score_parts": parts,
             "state": "new", "owner": None, "lease_until": None, "attempts": 0,
             "created_at": created_at or ms(now()), "updated_at": ms(now()), "note": None}
        self.candidates[cid] = c
        return c


def make_handler(state):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")

        def handle_any(self, method):
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            path = u.path
            state.log.append((method, path))
            if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                return self.reply(401, {"error": "bad token"})
            route = re.sub(r"/[0-9a-f]{12}(/|$)", r"/:id\1", re.sub(r"/x/posts/[^/]+/context", "/x/posts/:id/context", path))
            if (method, route) in state.routes_down or path in state.routes_down:
                return self.reply(404, {"error": "route not implemented yet"})
            with state.lock:
                return self.route(method, path, q)

        def route(self, method, path, q):
            s = state
            if method == "POST" and path == "/embed":
                return self.reply(200, {"vectors": [hashed_vector(t) for t in self.body()["texts"]]})
            if method == "GET" and path == "/positives":
                off, lim = int(q.get("offset", 0)), int(q.get("limit", 2000))
                return self.reply(200, {"total": len(s.positives), "offset": off, "items": s.positives[off:off + lim]})
            if method == "GET" and path == "/x/posts":
                lim = int(q.get("limit", 200))
                rows = [p for p in s.posts.values() if p.get("score") is None][:lim]
                return self.reply(200, {"posts": rows})
            if method == "POST" and path == "/x/posts/scores":
                for r in self.body()["scores"]:
                    s.posts[r["id"]]["score"] = r["score"]
                return self.reply(200, {"ok": True})
            m = re.fullmatch(r"/x/posts/([^/]+)/context", path)
            if method == "GET" and m:
                if m[1] in s.contexts:
                    return self.reply(200, s.contexts[m[1]])
                if m[1] in s.posts:
                    return self.reply(200, {"post": s.posts[m[1]], "quoted": None, "thread": None,
                                            "thread_captured": False})
                return self.reply(404, {"error": "no such post"})
            if method == "POST" and path == "/candidates":
                b = self.body()
                if b["kind"] == "x_post" and not s.posts.get(b["ref"], {}).get("bookmarked"):
                    known = any(c["kind"] == "x_post" and c["ref"] == b["ref"] for c in s.candidates.values())
                    made = sum(1 for c in s.candidates.values()
                               if c["kind"] == "x_post" and not s.posts.get(c["ref"], {}).get("bookmarked"))
                    if not known and made >= s.daily_cap:
                        return self.reply(429, {"error": "daily cap reached"})
                c = s.add_candidate(b["kind"], b["ref"], b["title"], b["url"], b.get("score"), b.get("score_parts"))
                return self.reply(201, {"created": True, "candidate": c})
            if method == "POST" and path == "/candidates/claim":
                b = self.body()
                out = []
                for c in sorted(s.candidates.values(), key=lambda c: c["created_at"]):
                    if len(out) >= b["limit"]:
                        break
                    expired = c["state"] == "claimed" and c["lease_until"] < ms(now())
                    if c["state"] == "new" or expired:
                        c.update(state="claimed", owner=b["owner"], attempts=c["attempts"] + 1,
                                 lease_until=ms(now() + dt.timedelta(seconds=b["ttl_s"])),
                                 lease_token=uuid.uuid4().hex if s.issue_tokens else None)
                        out.append(dict(c))
                return self.reply(200, {"candidates": out})
            m = re.fullmatch(r"/candidates/([^/]+)/complete", path)
            if method == "POST" and m:
                b = self.body()
                c = s.candidates.get(m[1])
                if not c:
                    return self.reply(404, {"error": "no such candidate"})
                if c["owner"] != b["owner"] or c["state"] != "claimed":
                    return self.reply(409, {"error": "stale owner"})
                if c.get("lease_token") and b.get("lease_token") != c["lease_token"]:
                    return self.reply(409, {"error": "stale lease token"})
                c.update(state=b["state"], note=b.get("note"), updated_at=ms(now()), lease_until=None,
                         owner=None if b["state"] == "new" else c["owner"])
                return self.reply(200, {"ok": True})
            if method == "POST" and path == "/proposals":
                b = self.body()
                pid = uuid.uuid4().hex[:12]
                st = "awaiting_approval" if b.get("final_step_kind") else "done"
                s.proposals[pid] = {**b, "id": pid, "state": st, "created_at": iso(now())}
                return self.reply(200, {"id": pid, "state": st})
            if method == "GET" and path == "/proposals":
                rows = [p for p in s.proposals.values()
                        if (not q.get("state") or p["state"] == q["state"]) and (not q.get("since") or p["created_at"] >= q["since"])]
                return self.reply(200, {"proposals": rows})
            return self.reply(404, {"error": "not found"})

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

    return H


class MockWorker:
    def __init__(self, port=0):
        self.state = State()
        self.server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(self.state))
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *a):
        self.server.shutdown()
        self.server.server_close()


class FakeGateway:
    """A CLIProxyAPI stand-in: answers by stage with canned JSON and records each request's model."""

    def __init__(self, answers):
        self.answers = answers  # stage marker in the system prompt -> dict
        self.calls = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                system = body["messages"][0]["content"]
                key = next(k for k in outer.answers if k in system)
                outer.calls.append({"model": body["model"], "stage": key})
                ans = outer.answers[key]
                ans = ans() if callable(ans) else ans
                out = json.dumps({"model": body["model"], "usage": {"prompt_tokens": 10, "completion_tokens": 5},
                                  "choices": [{"message": {"content": json.dumps(ans)}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1/chat/completions"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    with MockWorker(port) as m:
        print(f"mock worker on {m.url}, token {TOKEN!r}")
        m.thread.join()
