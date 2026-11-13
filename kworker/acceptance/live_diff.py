"""Stage b: compare a live capture of a save with its archive-built bundle.

  python -m acceptance.live_diff before --ids ID,ID --out FILE   record the archive bundles' versions
  python -m acceptance.live_diff diff --before FILE --out FILE   compare the latest (live) bundles with them

Compares post text, self-thread posts, media (and, per media item, whether
the live download hashed the same as the archive's), links (status, rung,
final URL, and how much of the extracted text agrees) and repos.
"""

from __future__ import annotations

import argparse
import difflib
import json
from pathlib import Path

import httpx

from acceptance.run import dev_vars
from kworker.canon import canonical_url, url_hash

BASE = "http://127.0.0.1:8871"


def client() -> httpx.Client:
    return httpx.Client(base_url=BASE, headers={"authorization": f"Bearer {dev_vars()['KNOWLEDGE_TOKEN']}"}, timeout=120)


def latest(c: httpx.Client, sid: str) -> dict:
    row = c.get(f"/k/bundles/{sid}").json()
    return {"version": row["version"], "json_sha": row["json_sha"]}


def _norm(t: str | None) -> str:
    return " ".join((t or "").split())


def _ratio(a: str | None, b: str | None) -> float:
    a, b = _norm(a)[:20000], _norm(b)[:20000]
    return round(difflib.SequenceMatcher(None, a, b, autojunk=False).ratio(), 3) if a or b else 1.0


def compare(old: dict, new: dict, media_checks: dict) -> dict:
    out = {"post_text_same": _norm(old["post"]["text"]) == _norm(new["post"]["text"])}
    if not out["post_text_same"]:
        out["post_text_ratio"] = _ratio(old["post"]["text"], new["post"]["text"])
    ot, nt = {t["id"]: t for t in old["thread"]}, {t["id"]: t for t in new["thread"]}
    out["thread"] = {"same_ids": list(ot) == list(nt), "text_differs": [i for i in ot if i in nt and _norm(ot[i]["text"]) != _norm(nt[i]["text"])]}
    om, nm = {m["source_url"]: m for m in old["media"]}, {m["source_url"]: m for m in new["media"]}
    media = []
    for url in sorted(set(om) | set(nm)):
        o, n = om.get(url), nm.get(url)
        row = {"url": url, "archive_sha": (o or {}).get("sha256"), "live_sha": (n or {}).get("sha256")}
        row["same"] = bool(o and n and o.get("sha256") == n.get("sha256"))
        row.update(media_checks.get(url, {}))
        media.append(row)
    out["media"] = media
    ol, nl = {l["canonical_url"] if l.get("canonical_url") else l["url"]: l for l in old["links"]}, {l["canonical_url"] if l.get("canonical_url") else l["url"]: l for l in new["links"]}
    links = []
    for u in sorted(set(ol) | set(nl)):
        o, n = ol.get(u), nl.get(u)
        links.append(
            {
                "url": u,
                "archive": o and {"status": o["status"], "rung": o.get("rung"), "final_url": o.get("final_url")},
                "live": n and {"status": n["status"], "rung": n.get("rung"), "final_url": n.get("final_url"), "note": n.get("note")},
                "text_ratio": _ratio((o or {}).get("text"), (n or {}).get("text")) if o and n else None,
            }
        )
    out["links"] = links
    out["repos"] = {"archive": sorted(r["url"] for r in old["repos"]), "live": sorted(r["url"] for r in new["repos"])}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["before", "diff"])
    ap.add_argument("--ids")
    ap.add_argument("--before", type=Path)
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()
    with client() as c:
        if a.cmd == "before":
            rows = {sid: latest(c, sid) for sid in a.ids.split(",")}
            a.out.write_text(json.dumps(rows, indent=1), encoding="utf-8")
            print(json.dumps(rows, indent=1))
            return
        before = json.loads(a.before.read_text(encoding="utf-8"))
        result = {}
        for sid, b in before.items():
            now = latest(c, sid)
            if now["json_sha"] == b["json_sha"]:
                result[sid] = {"error": "no live version: the latest bundle is still the archive one"}
                continue
            old, new = c.get(f"/k/blobs/{b['json_sha']}").json(), c.get(f"/k/blobs/{now['json_sha']}").json()
            checks = {}
            for m in new["media"]:
                kind = "video" if m["kind"] in ("video", "gif") else "image"
                rows = c.get("/k/jobs", params={"kind": kind, "key": url_hash(canonical_url(m["source_url"]))}).json()["jobs"]
                env = rows[0].get("result") if rows else None
                env = json.loads(env) if isinstance(env, str) else env
                lc = ((env or {}).get("result") or {}).get("live_check")
                if lc:
                    # The live download against the hash the archive recorded
                    # and against kworker's own earlier fetch.
                    checks[m["source_url"]] = {**lc, "live_matches_archive": m.get("sha256") == lc.get("archive_sha") if lc.get("archive_sha") else None,
                                               "live_matches_previous": m.get("sha256") == lc.get("previous_sha") if lc.get("previous_sha") else None}
            result[sid] = {"archive_version": b["version"], "live_version": now["version"], **compare(old, new, checks)}
        a.out.write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(result, indent=1, ensure_ascii=False)[:6000])


if __name__ == "__main__":
    main()
