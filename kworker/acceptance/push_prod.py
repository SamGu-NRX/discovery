"""Copies the local store (wrangler dev) to production, so production gets
the bundles and every cached fetch and model output without redoing any.

  python -m acceptance.push_prod --state DIR [--local URL] [--prod URL] [--all-bundles | --no-bundles]

Reads the local D1 file read-only and blob bytes through the local Worker.
Writes production through its /k/ routes with the KNOWLEDGE_TOKEN from
Windows Credential Manager (discovery-knowledge-token). Every write is
idempotent, so a cut-off push is simply run again. By default only bundles
with a digest card are registered.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path

import httpx

from acceptance.run import dev_vars
from kworker import wincred

PROD = "https://discovery-watcher.sgu07966.workers.dev"
PUT_MAX = 95 * 1024 * 1024


def rows(con: sqlite3.Connection, sql: str) -> list[dict]:
    con.row_factory = sqlite3.Row
    return [dict(r) for r in con.execute(sql)]


def post_batches(prod: httpx.Client, path: str, key: str, items: list[dict], n: int) -> int:
    done = 0
    for i in range(0, len(items), n):
        r = prod.post(path, json={key: items[i : i + n]})
        if r.status_code >= 400:
            raise SystemExit(f"{path} batch {i // n}: {r.status_code} {r.text[:300]}")
        done += len(items[i : i + n])
    return done


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True, type=Path, help="the wrangler dev --persist-to folder")
    ap.add_argument("--local", default="http://127.0.0.1:8871")
    ap.add_argument("--prod", default=PROD)
    ap.add_argument("--all-bundles", action="store_true")
    ap.add_argument("--no-bundles", action="store_true", help="blobs and cache rows only (before production can store cards)")
    a = ap.parse_args()
    d1 = next((a.state / "v3" / "d1" / "miniflare-D1DatabaseObject").glob("*.sqlite"))
    con = sqlite3.connect(f"file:{d1.resolve().as_posix()}?mode=ro", uri=True)
    cred = wincred.read("discovery-knowledge-token")
    if not cred:
        raise SystemExit("no discovery-knowledge-token credential")
    local = httpx.Client(base_url=a.local, headers={"authorization": f"Bearer {dev_vars()['KNOWLEDGE_TOKEN']}"}, timeout=600)
    prod = httpx.Client(base_url=a.prod, headers={"authorization": f"Bearer {cred[1]}"}, timeout=600)
    t0 = time.monotonic()
    report: dict = {}

    blobs = rows(con, "SELECT sha256, size, mime FROM blobs ORDER BY size")
    have: set[str] = set()
    for i in range(0, len(blobs), 100):
        r = prod.post("/k/blobs/has", json={"sha256s": [b["sha256"] for b in blobs[i : i + 100]]})
        r.raise_for_status()
        have |= set(r.json()["present"])
    sent = sent_bytes = 0
    too_big = []
    for b in blobs:
        if b["sha256"] in have:
            continue
        if b["size"] > PUT_MAX:
            too_big.append(b["sha256"])
            continue
        data = local.get(f"/k/blobs/{b['sha256']}").content
        r = prod.put(f"/k/blobs/{b['sha256']}", content=data, headers={"content-type": b["mime"]})
        if r.status_code not in (200, 201):
            raise SystemExit(f"blob {b['sha256']}: {r.status_code} {r.text[:200]}")
        sent += 1
        sent_bytes += b["size"]
    report["blobs"] = {"local": len(blobs), "already_in_prod": len(have), "sent": sent, "sent_mb": round(sent_bytes / 1e6, 1), "over_95_mib": too_big}

    fetch_cols = ["url_hash", "canonical_url", "final_url", "etag", "last_modified", "content_sha", "mime", "http_status", "rung", "status", "immutable", "note"]
    fetches = [{k: r[k] for k in fetch_cols if r[k] is not None} for r in rows(con, "SELECT * FROM fetches")]
    report["fetches"] = post_batches(prod, "/k/fetches", "rows", fetches, 50)
    der_cols = ["input_sha", "step", "provider", "model", "prompt_v", "output_sha", "input_tokens", "output_tokens", "ms"]
    ders = [{k: r[k] for k in der_cols if r[k] is not None} for r in rows(con, "SELECT * FROM derivations")]
    report["derivations"] = post_batches(prod, "/k/derivations", "rows", ders, 50)
    ver_cols = ["item_kind", "item_id", "save_id", "verdict", "reason", "stage", "score", "text_sha", "gate_v", "pack_sha", "pack_row"]
    vers = [{k: r[k] for k in ver_cols if r[k] is not None} for r in rows(con, "SELECT * FROM verdicts")]
    report["verdicts"] = post_batches(prod, "/k/verdicts", "rows", vers, 200)
    for p in rows(con, "SELECT host, start_rung, notes FROM domain_policy"):
        prod.post("/k/domain-policy", json={k: v for k, v in p.items() if v is not None}).raise_for_status()

    latest = rows(
        con,
        """SELECT b.*, s.body AS search_text FROM bundles b LEFT JOIN bundle_search s ON s.rowid = CAST(b.post_id AS INTEGER)
           WHERE b.version = (SELECT max(version) FROM bundles WHERE post_id = b.post_id)""",
    )
    registered = []
    for b in [] if a.no_bundles else latest:
        if not a.all_bundles and not b.get("card_json"):
            continue
        body = {
            "post_id": b["post_id"], "md_sha": b["md_sha"], "json_sha": b["json_sha"], "completeness": b["completeness"],
            "missing": json.loads(b["missing_json"]), "saved_by": json.loads(b["saved_by"]), "author": (json.loads(b["card_json"]) if b.get("card_json") else {}).get("author", ""),
            "search_text": b.get("search_text") or "",
        }
        if b.get("card_json"):
            body["card"] = json.loads(b["card_json"])
        r = prod.post("/k/bundles", json=body)
        if r.status_code not in (200, 201):
            raise SystemExit(f"bundle {b['post_id']}: {r.status_code} {r.text[:200]}")
        registered.append({"post_id": b["post_id"], "version": r.json().get("version"), "created": r.json().get("created")})
    report["bundles"] = {"local_latest": len(latest), "registered": len(registered), "rows": registered}
    report["wall_s"] = round(time.monotonic() - t0, 1)
    print(json.dumps({k: v for k, v in report.items() if k != "bundles"} | {"bundles": {k: v for k, v in report["bundles"].items() if k != "rows"}}, indent=1))
    out = Path(__file__).parent / "evidence" / "push-prod.json"
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
