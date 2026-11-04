"""HTTP client for the discovery Worker, plus the local proposal outbox.

The runner token is read from its file on each process start and kept only in memory. Errors are
split by what the caller should do: WorkerUnavailable (route missing, 5xx, network) means back off
and retry later; LeaseLost (409 on complete) means another owner holds the candidate; any other
4xx is a bug and raises WorkerError.
"""
import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from . import config


class WorkerError(Exception):
    def __init__(self, status, method, path, body):
        super().__init__(f"{method} {path} -> {status}: {body[:300]}")
        self.status = status


class WorkerUnavailable(WorkerError):
    pass


class LeaseLost(WorkerError):
    pass


class Worker:
    def __init__(self, base_url: str, token: str, timeout: float = 60):
        self.base = base_url.rstrip("/")
        self._token = token
        self.timeout = timeout

    @classmethod
    def from_config(cls, cfg):
        token = Path(cfg["token_file"]).expanduser().read_text().strip()
        if not token:
            raise RuntimeError(f"{cfg['token_file']} is empty")
        return cls(cfg["worker_url"], token)

    def _call(self, method, path, body=None, query=None):
        url = self.base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self._token}", "Content-Type": "application/json",
            "User-Agent": "discovery-runner/1"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            e.close()
            if e.code == 404 or e.code >= 500:
                raise WorkerUnavailable(e.code, method, path, text) from None
            if e.code == 409:
                raise LeaseLost(e.code, method, path, text) from None
            raise WorkerError(e.code, method, path, text) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise WorkerUnavailable(None, method, path, str(e)) from None

    # Scoring
    def unscored_posts(self, limit=200):
        return self._call("GET", "/x/posts", query={"unscored": 1, "limit": limit})["posts"]

    def post_scores(self, scores):
        return self._call("POST", "/x/posts/scores", {"scores": scores})

    def embed(self, texts):
        if not texts:
            return []
        out = []
        for i in range(0, len(texts), 100):
            vecs = self._call("POST", "/embed", {"texts": texts[i:i + 100]})["vectors"]
            if len(vecs) != len(texts[i:i + 100]):
                raise WorkerError(200, "POST", "/embed", f"asked for {len(texts[i:i + 100])} vectors, got {len(vecs)}")
            out += vecs
        return out

    def positives(self):
        items, offset = [], 0
        while True:
            page = self._call("GET", "/positives", query={"limit": 2000, "offset": offset})
            items += page["items"]
            offset += len(page["items"])
            if not page["items"] or offset >= page.get("total", offset):
                return items

    # Candidates
    def create_candidate(self, kind, ref, title, url, score, score_parts):
        return self._call("POST", "/candidates", {"kind": kind, "ref": ref, "title": title, "url": url,
                                                  "score": score, "score_parts": score_parts})

    def claim(self, owner, ttl_s, limit):
        return self._call("POST", "/candidates/claim", {"owner": owner, "ttl_s": ttl_s, "limit": limit})["candidates"]

    def complete(self, cid, owner, state, note):
        return self._call("POST", f"/candidates/{urllib.parse.quote(cid, safe='')}/complete",
                          {"owner": owner, "state": state, "note": note[:2000]})

    def post_context(self, post_id):
        return self._call("GET", f"/x/posts/{urllib.parse.quote(post_id, safe='')}/context")

    # Proposals
    def create_proposal(self, body):
        return self._call("POST", "/proposals", body)

    def proposals(self, state=None, since=None):
        q = {k: v for k, v in (("state", state), ("since", since)) if v}
        return self._call("GET", "/proposals", query=q or None)["proposals"]


def outbox_dir() -> Path:
    d = config.home() / "outbox"
    d.mkdir(parents=True, exist_ok=True)
    return d


def submit_proposal(worker: Worker, body: dict) -> dict:
    """POST /proposals, or keep it in the outbox when the route is not live yet.

    Returns the Worker's response, or {"id": "outbox:<file>", "state": "queued"}. `body` must carry a
    stable `client_id` so a flush after a lost response can be recognized; it is stripped before sending.
    """
    try:
        return worker.create_proposal({k: v for k, v in body.items() if k != "client_id"})
    except WorkerUnavailable:
        f = outbox_dir() / f"{body['client_id']}.json"
        f.write_text(json.dumps(body, indent=1, ensure_ascii=False))
        return {"id": f"outbox:{f.name}", "state": "queued"}


def flush_outbox(worker: Worker) -> list:
    """Send queued proposals in creation order. Stops at the first WorkerUnavailable and leaves the rest."""
    sent = []
    for f in sorted(outbox_dir().glob("*.json"), key=lambda p: p.stat().st_mtime):
        body = json.loads(f.read_text())
        res = worker.create_proposal({k: v for k, v in body.items() if k != "client_id"})
        sent.append({"client_id": body["client_id"], **res})
        f.unlink()
    return sent


def new_client_id() -> str:
    return uuid.uuid4().hex
