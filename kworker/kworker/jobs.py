"""The job loop: claim, run the handler, complete. kworker keeps nothing
between jobs; everything a later job needs is in D1 or R2."""

from __future__ import annotations

import json
import re
import threading
import time
import traceback

from . import bundle, gate, intake, links, media, video
from .api import KError
from .canon import canonical_url, url_hash
from .config import Config
from .ctx import Ctx, job_ctx

KINDS = ["save", "link", "image", "video", "bundle"]
TTL_S = {"save": 600, "link": 600, "image": 900, "video": 3600, "bundle": 600}
_URL = re.compile(r"https?://[^\s<>\"')\]]+")
_MEDIA_HOSTS = ("pbs.twimg.com", "video.twimg.com")


def enqueue(ctx: Ctx, kind: str, key: str, payload: dict, deps: list[str] | None = None, again: bool = False) -> dict:
    body = {"kind": kind, "key": key, "payload": payload, "again": again}
    if deps:
        body["deps"] = deps
    return ctx.api.call("POST", "/k/jobs", body)["job"]


def save_job(ctx: Ctx, payload: dict) -> dict:
    """Gate the expansion, then fan out one job per media item and kept link,
    and a bundle job that waits for all of them."""
    if "intake_sha" in payload:
        # Filed by POST /k/intake: the daily job's body, turned into the
        # expansion the gate and the bundle read.
        exp = intake.expansion(ctx.api.get_json(payload["intake_sha"]))
        expansion_sha = ctx.api.put_json(exp)
    else:
        expansion_sha = payload["expansion_sha"]
        exp = ctx.api.get_json(expansion_sha)
    decided = gate.run_gate(ctx, exp)
    gate_sha = ctx.api.put_json(decided)

    children: list[dict] = []
    seen_media = set()
    quoted = exp.get("quoted") or {}
    owners = [(t["id"], t.get("media", [])) for t in exp["thread"]] + [(quoted.get("id") or "quoted", quoted.get("media") or [])]
    for owner, items in owners:
        for m in items:
            if m["source_url"] in seen_media:
                continue
            seen_media.add(m["source_url"])
            kind = "video" if m["kind"] in ("video", "gif") else "image"
            child = {"kind": kind, "key": url_hash(canonical_url(m["source_url"])), "source_url": m["source_url"], "media_kind": m["kind"], "post_id": owner}
            if exp.get("live"):
                child["live"] = True
            # Where the archive already has the file (read-only, sha-checked).
            child.update({k: m[k] for k in ("sha256", "local_file") if m.get(k)})
            children.append(child)

    wanted: list[tuple[str, str]] = []  # (url, from)
    for l in exp["post"]["links"]:
        wanted.append((l["expanded"], "post"))
    for t in exp["thread"]:
        if not t["is_save"]:
            wanted += [(u, f"thread:{t['id']}") for u in _URL.findall(t["text"])]
    # The quoted post's text is already in the expansion, so it is not fetched.
    for k in decided["kept"]:
        wanted += [(u, f"reply:{k['item_id']}") for u in k.get("links", [])]
    seen_links = set()
    for url, src in wanted:
        url = url.rstrip(".,;:!?…")
        try:
            canon = canonical_url(url)
        except ValueError:
            continue
        host = canon.split("/")[2]
        if host in _MEDIA_HOSTS or canon in seen_links:
            continue
        seen_links.add(canon)
        children.append({"kind": "link", "key": url_hash(canon), "url": url, "from": src, **({"live": True} if exp.get("live") else {})})

    ids = []
    for c in children:
        job_payload = {k: v for k, v in c.items() if k not in ("kind", "key")}
        ids.append(enqueue(ctx, c["kind"], c["key"], job_payload, again=True)["id"])
    b = enqueue(
        ctx,
        "bundle",
        exp["post"]["id"],
        {"post_id": exp["post"]["id"], "expansion_sha": expansion_sha, "gate_sha": gate_sha, "children": children},
        deps=ids,
        again=True,
    )
    return {"gate_sha": gate_sha, "kept": len(decided["kept"]), "dropped": len(decided["dropped"]), "children": len(children), "bundle_job": b["id"]}


HANDLERS = {
    "save": save_job,
    "link": links.link_job,
    "image": media.image_job,
    "video": video.video_job,
    "bundle": bundle.build,
}


def _heartbeat(cfg: Config, job: dict, stop: threading.Event) -> None:
    import httpx

    ttl = TTL_S[job["kind"]]
    with httpx.Client(base_url=cfg.base_url, headers={"authorization": f"Bearer {cfg.token}"}, timeout=30) as c:
        c.post(f"/k/jobs/{job['id']}/heartbeat", json={"owner": cfg.owner, "lease_token": job["lease_token"], "ttl_s": ttl})
        while not stop.wait(min(ttl, 600) / 3):
            c.post(f"/k/jobs/{job['id']}/heartbeat", json={"owner": cfg.owner, "lease_token": job["lease_token"], "ttl_s": ttl})


# kworker stops claiming below this much free space on the drive its
# scratch files and the local Worker state share. C: on the Zephyrus filled up
# on 2026-11-12 and swings by about 30 GB within minutes, so the margin is wide.
MIN_FREE_BYTES = 15 * 1024**3


class DiskLow(RuntimeError):
    pass


def check_disk(path: str | None = None) -> int:
    import shutil
    import tempfile

    free = shutil.disk_usage(path or tempfile.gettempdir()).free
    if free < MIN_FREE_BYTES:
        raise DiskLow(f"blocked: {free / 1024**3:.1f} GB free, under the {MIN_FREE_BYTES // 1024**3} GB kworker needs before claiming a job")
    return free


def run_one(cfg: Config, kinds: list[str]) -> dict | None:
    """Claims and runs one job. None when nothing is claimable."""
    check_disk()
    with job_ctx(cfg) as ctx:
        # A short first lease; the heartbeat extends it to the kind's TTL, so a
        # crashed worker's job is free again within ten minutes.
        claimed = ctx.api.call("POST", "/k/jobs/claim", {"owner": cfg.owner, "kinds": kinds, "ttl_s": 600, "limit": 1})["jobs"]
        if not claimed:
            return None
        job = claimed[0]
        payload = job["payload"] if isinstance(job["payload"], dict) else json.loads(job["payload"])
        stop = threading.Event()
        beat = threading.Thread(target=_heartbeat, args=(cfg, job, stop), daemon=True)
        beat.start()
        t0 = time.monotonic()
        state, result, error = "done", None, None
        try:
            result = HANDLERS[job["kind"]](ctx, payload)
        except Exception as e:  # noqa: BLE001 - any failure is recorded on the job, then the loop goes on
            state, error = "failed", f"{type(e).__name__}: {e}"[:2000]
            traceback.print_exc()
        finally:
            stop.set()
        wall = round(time.monotonic() - t0, 2)
        envelope = {"result": result, "stats": ctx.stats.as_dict(), "wall_s": wall}
        try:
            ctx.api.call("POST", f"/k/jobs/{job['id']}/complete", {"owner": cfg.owner, "lease_token": job["lease_token"], "state": state, "result": envelope, "error": error})
        except KError as e:
            print(f"[kworker] could not complete {job['kind']} {job['key']}: {e}")
        print(f"[kworker] {job['kind']} {job['key'][:24]} {state} in {wall}s fetches={envelope['stats']['fetches']} model_calls={envelope['stats']['model_calls']}" + (f" error={error}" if error else ""))
        return {"job": job, "state": state, **envelope}


def drain(cfg: Config, kinds: list[str] = KINDS, forever: bool = False, idle_s: float = 15.0) -> list[dict]:
    """Runs jobs until none is claimable, or, with forever, keeps polling."""
    done = []
    while True:
        r = run_one(cfg, kinds)
        if r is not None:
            done.append(r)
            continue
        if not forever:
            return done
        time.sleep(idle_s)
