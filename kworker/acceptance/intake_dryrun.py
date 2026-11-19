"""Dry run of the daily loop: each judged Nov 12 save posted to /k/intake as
the extension's daily job would post it (kintake/1, context capped at 80
posts), so kworker reads it through the production path.

  python -m acceptance.intake_dryrun --snapshot DIR --worktree DIR [--base URL] [--ids ID,ID]

Reads the archive only; posts with the local intake token from worker/.dev.vars.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import httpx

from acceptance.run import dev_vars
from kworker.archive_nov12 import Nov12

CAP = 80  # the daily job's context cap
_ID = re.compile(r"/status/(\d+)")
_TCO = re.compile(r"https?://t\.co/\w+")


def resolutions(arch: Nov12) -> dict[str, str]:
    """t.co -> target, from the archive's link-resolutions.json: the daily job
    sends links expanded, so the dry run does too."""
    rows = json.loads((arch.snap / "2026-11-12" / "link-resolutions.json").read_text(encoding="utf-8"))
    return {r["url"]: r["expanded"] for r in rows if r.get("url") and r.get("expanded") and not r.get("error")}


def _expanded(text: str, res: dict[str, str]) -> list[dict]:
    return [{"url": u, "expanded": res[u]} for u in dict.fromkeys(_TCO.findall(text or "")) if u in res]


def _post(p: dict, media: list[dict] | None = None) -> dict:
    return {
        "id": p["id"],
        "url": p["url"],
        "author_handle": p["author_handle"],
        "text": p.get("text") or "",
        "media": [{"kind": m["kind"], "url": m["source_url"]} for m in (media if media is not None else p.get("media") or [])],
    }


def body(arch: Nov12, sid: str, res: dict[str, str] | None = None) -> dict:
    res = res if res is not None else resolutions(arch)
    exp = arch.expansion(sid)
    raw = arch.posts[sid]
    post = _post({**exp["post"], "author_handle": exp["post"]["author_handle"]})
    links = [{"url": l["url"], "expanded": l["expanded"], **({"title": l["title"]} if l.get("title") else {})} for l in exp["post"]["links"]]
    # The daily job takes post.links from X's entities, which expand every
    # t.co in the text; the archive's link-resolutions.json does that here.
    have = {l["url"] for l in links}
    links += [l for l in _expanded(exp["post"]["text"], res) if l["url"] not in have]
    post.update(author_name=exp["post"].get("author_name"), created_at=exp["post"].get("created_at"), links=links, reply_to=raw.get("replying_to_status"))
    q = exp.get("quoted")
    if q:
        qid = q.get("id") or (_ID.search(q.get("url") or "") or [None, None])[1]
        if qid and q.get("author_handle"):
            post["quoted"] = _post({"id": qid, "url": q["url"], "author_handle": q["author_handle"], "text": q["text"]}, q.get("media") or [])
    thread = [
        {**_post({"id": t["id"], "url": t["url"], "author_handle": exp["post"]["author_handle"], "text": t["text"]}, t["media"]), "links": _expanded(t["text"], res)}
        for t in exp["thread"]
    ]
    ids = {t["id"] for t in exp["thread"]}
    rows = [c for c in arch.candidates(sid) if c["status_id"] not in ids and not str(c.get("view", "")).startswith("fetch:upstream")]
    context = [
        {
            "id": c["status_id"],
            "author_handle": c["author_handle"],
            "text": c.get("rendered_text") or "",
            "reply_to": c.get("reply_to_status_id"),
            "quoted_id": c.get("quoted_status_id"),
            "view": c.get("view"),
            "created_at": c.get("created_at"),
            "links": [u for u in c.get("urls") or [] if isinstance(u, str) and not _TCO.match(u)] + _expanded(c.get("rendered_text") or "", res),
        }
        for c in rows[:CAP]
    ]
    up = exp.get("upstream")
    return {
        "schema": "kintake/1",
        "run_id": "dryrun-2026-11-12",
        "account": (exp.get("saved_by") or ["sdotgu"])[0],
        "post": post,
        "thread": thread,
        "upstream": [_post(u) for u in up or []],
        "context": context,
        "context_capped": len(rows) > CAP,
        "views_read": [{"view": v} for v in exp.get("reply_views") or []],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", required=True, type=Path)
    ap.add_argument("--worktree", required=True, type=Path)
    ap.add_argument("--base", default="http://127.0.0.1:8871")
    ap.add_argument("--ids")
    a = ap.parse_args()
    arch = Nov12(a.snapshot, a.worktree)
    ids = a.ids.split(",") if a.ids else arch.judged()
    v = dev_vars()
    res = resolutions(arch)
    out = []
    with httpx.Client(base_url=a.base, headers={"authorization": f"Bearer {v['KNOWLEDGE_INTAKE_TOKEN']}"}, timeout=60) as c:
        for sid in ids:
            b = body(arch, sid, res)
            r = c.post("/k/intake", content=json.dumps(b, ensure_ascii=False).encode("utf-8"), headers={"content-type": "application/json"})
            out.append((sid, r.status_code, r.json().get("job", r.json())))
            print(sid, r.status_code, json.dumps(r.json())[:200])
    print(json.dumps({"posted": len(out), "status": sorted({s for _, s, _ in out})}))


if __name__ == "__main__":
    main()
