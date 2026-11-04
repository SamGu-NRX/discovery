"""What the runner knows about existing proposals: the Worker's list, plus its own local record.

The local record (state/proposals.jsonl) covers proposals still in the outbox and lets duplicate
detection work before GET /proposals is live. Worker rows win when both exist.
"""
import datetime as dt
import json

from . import config
from .worker import WorkerUnavailable


def _local():
    f = config.path("state", "proposals.jsonl")
    return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []


def record_local(body, response):
    with open(config.path("state", "proposals.jsonl"), "a") as f:
        f.write(json.dumps({**body, "id": response.get("id"), "state": response.get("state"),
                            "created_at": config.now_iso()}, ensure_ascii=False) + "\n")


def recent(worker, days):
    """Open and recent proposals as [{id, title, why, target, created_at, state, candidate_ids}]."""
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = {}
    for p in _local():
        if p.get("created_at", "") >= since:
            rows[p["id"]] = p
    try:
        for p in worker.proposals(since=since):
            rows[p["id"]] = p
        for state in ("awaiting_approval", "later"):
            for p in worker.proposals(state=state):
                rows[p["id"]] = p
    except WorkerUnavailable:
        pass
    out = []
    for p in rows.values():
        inputs = p.get("inputs") or {}
        if isinstance(inputs, str):
            inputs = json.loads(inputs)
        out.append({"id": p["id"], "title": p.get("title", ""), "why": p.get("why", ""), "kind": p.get("kind"),
                    "target": inputs.get("target"), "source": inputs.get("source") or inputs.get("candidate_url"),
                    "created_at": p.get("created_at", ""), "state": p.get("state"),
                    "candidate_ids": p.get("candidate_ids") or json.loads(p.get("candidate_ids_json") or "[]")})
    return out


def skipped_texts(worker):
    try:
        return [f"{p.get('title', '')}\n{p.get('why', '')}" for p in worker.proposals(state="skipped")]
    except WorkerUnavailable:
        return []


def approved_authors(worker):
    out = set()
    try:
        for p in worker.proposals(state="approved") + worker.proposals(state="executed"):
            inputs = p.get("inputs") or {}
            if isinstance(inputs, str):
                inputs = json.loads(inputs)
            if inputs.get("author_handle"):
                out.add(inputs["author_handle"].lower())
    except WorkerUnavailable:
        pass
    return out
