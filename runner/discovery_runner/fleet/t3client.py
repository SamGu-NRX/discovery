"""The only code that writes to T3: an MCP client over HTTP, and the one-time sign-in that gives it a token.

Only launcher.py may import this module (tests/test_fleet.py checks every import in the package).

The token comes from T3's own OAuth flow for outside agents (t3code docs/user/outside-agents.md): register a
client, open T3's approval page with PKCE, and exchange the code. Sam approves at Auto in that page; the
token is saved to `~/.agent-secrets/discovery-t3-mcp` (mode 600) and lasts 30 days. The token is never
printed. T3 itself enforces the level: a send to a thread above the token's mode is refused
(t3code apps/server/src/mcp/threadAccess.ts, assertTargetWithinLimits).
"""
import base64
import hashlib
import http.client
import http.server
import json
import os
import secrets
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TOKEN_FILE = Path("~/.agent-secrets/discovery-t3-mcp")
RUNTIME = Path("~/.t3/userdata/server-runtime.json")
PROTOCOL = "2025-06-18"


class T3Error(RuntimeError):
    """T3 answered with an error (a tool failure or a JSON-RPC error)."""


class T3Unreachable(RuntimeError):
    """No answer: T3 is down, or the connection dropped before the response. The call may have landed."""


def origin() -> str:
    return json.loads(RUNTIME.expanduser().read_text())["origin"]


class Client:
    def __init__(self, endpoint: str, token: str, timeout=60):
        self.endpoint = endpoint
        self._token = token
        self.timeout = timeout
        self.session = None
        self._id = 0

    @classmethod
    def from_files(cls, token_file=TOKEN_FILE):
        f = Path(token_file).expanduser()
        if not f.exists():
            raise T3Error(f"no T3 sign-in at {f}; run `discovery-runner fleet login`")
        return cls(origin() + "/mcp", f.read_text().strip())

    def _post(self, body: dict):
        headers = {"content-type": "application/json", "accept": "application/json, text/event-stream",
                   "authorization": f"Bearer {self._token}", "mcp-protocol-version": PROTOCOL}
        if self.session:
            headers["mcp-session-id"] = self.session
        req = urllib.request.Request(self.endpoint, data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                self.session = r.headers.get("mcp-session-id") or self.session
                raw = r.read().decode()
                ctype = r.headers.get("content-type", "")
        except urllib.error.HTTPError as e:
            raise T3Error(f"T3 answered HTTP {e.code}: {e.read()[:300]!r}") from None
        except (urllib.error.URLError, ConnectionError, socket.timeout, http.client.HTTPException) as e:
            raise T3Unreachable(f"{type(e).__name__}: {e}") from None
        if not raw.strip():
            return None
        if "text/event-stream" in ctype:
            datas = [l[5:].strip() for l in raw.splitlines() if l.startswith("data:")]
            msgs = [json.loads(d) for d in datas if d]
            raw_msg = next((m for m in msgs if m.get("id") == body.get("id")), msgs[-1] if msgs else None)
        else:
            raw_msg = json.loads(raw)
        return raw_msg

    def _rpc(self, method, params=None, notify=False):
        body = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notify:
            self._id += 1
            body["id"] = self._id
        msg = self._post(body)
        if notify:
            return None
        if msg is None:
            raise T3Unreachable(f"empty answer to {method}")
        if "error" in msg:
            raise T3Error(f"{method}: {msg['error']}")
        return msg["result"]

    def open(self):
        if self.session is None:
            self._rpc("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                     "clientInfo": {"name": "discovery-fleet", "version": "1"}})
            self._rpc("notifications/initialized", notify=True)
        return self

    def call(self, tool: str, args: dict) -> dict:
        self.open()
        res = self._rpc("tools/call", {"name": tool, "arguments": args})
        if res.get("isError"):
            text = " ".join(c.get("text", "") for c in res.get("content", []))
            raise T3Error(f"{tool}: {text[:500]}")
        if "structuredContent" in res:
            return res["structuredContent"]
        text = "".join(c.get("text", "") for c in res.get("content", []))
        try:
            return json.loads(text)
        except ValueError:
            return {"text": text}


def login(t3_origin: str | None = None, token_file=TOKEN_FILE, open_browser=True, timeout=600) -> Path:
    """Sign the runner in to T3 once. Sam approves on T3's page and picks Auto. Returns the token file."""
    import webbrowser
    base = t3_origin or origin()
    meta = json.loads(urllib.request.urlopen(f"{base}/.well-known/oauth-authorization-server", timeout=30).read())
    got = {}
    done = threading.Event()

    class Callback(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header("content-type", "text/plain")
            self.end_headers()
            self.wfile.write(b"The discovery runner is signed in to T3. You can close this tab.")
            done.set()

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Callback)
    redirect = f"http://127.0.0.1:{srv.server_port}/callback"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        reg = json.loads(urllib.request.urlopen(urllib.request.Request(
            meta["registration_endpoint"], method="POST", headers={"content-type": "application/json"},
            data=json.dumps({"client_name": "discovery-runner fleet", "redirect_uris": [redirect],
                             "grant_types": ["authorization_code"], "response_types": ["code"],
                             "token_endpoint_auth_method": "none"}).encode()), timeout=30).read())
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(16)
        url = meta["authorization_endpoint"] + "?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": reg["client_id"], "redirect_uri": redirect, "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256", "resource": f"{base}/mcp"})
        print(f"Approve the discovery runner at Auto in T3:\n{url}", flush=True)
        if open_browser:
            webbrowser.open(url)
        if not done.wait(timeout):
            raise T3Error("no approval within the time limit")
        if got.get("state") != state or "code" not in got:
            raise T3Error(f"sign-in did not complete: {got.get('error') or 'state mismatch'}")
        tok = json.loads(urllib.request.urlopen(urllib.request.Request(
            meta["token_endpoint"], method="POST", headers={"content-type": "application/x-www-form-urlencoded"},
            data=urllib.parse.urlencode({"grant_type": "authorization_code", "code": got["code"],
                                         "redirect_uri": redirect, "client_id": reg["client_id"],
                                         "code_verifier": verifier, "resource": f"{base}/mcp"}).encode()),
            timeout=30).read())
    finally:
        srv.shutdown()
    f = Path(token_file).expanduser()
    f.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        out.write(tok["access_token"])
    return f
