"""Per-save report for a batch run (stage a): status, the reason when not
complete, tokens by step, wall time, bytes sent to R2, and, where the archive
lead judged the replies, how the gate's keeps compare with the judge's.

  python -m acceptance.scale --base URL --out FILE [--nov12-snapshot DIR] (--nov12 | --oct26 PATH)

Reads only the Worker's job and bundle records and the archive's committed
judgments; writes FILE (JSON) and prints a table.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import httpx

from acceptance.run import dev_vars


def _job(c: httpx.Client, kind: str, key: str) -> dict | None:
    # Looked up by key: a listing holds only the newest 200 rows per kind.
    rows = c.get("/k/jobs", params={"kind": kind, "key": key}).json()["jobs"]
    if not rows:
        return None
    r = rows[0]
    for k in ("payload", "result"):
        if isinstance(r.get(k), str) and r[k]:
            r[k] = json.loads(r[k])
    return r


def per_save(base: str, saves: list[str]) -> dict[str, dict]:
    out = {}
    v = dev_vars()
    with httpx.Client(base_url=base, headers={"authorization": f"Bearer {v['KNOWLEDGE_TOKEN']}"}, timeout=60) as c:
        for sid in saves:
            save, bundle = _job(c, "save", sid), _job(c, "bundle", sid)
            mine = [save, bundle] + ([_job(c, ch["kind"], ch["key"]) for ch in bundle["payload"]["children"]] if bundle else [])
            mine = [r for r in mine if r]
            tok, calls, wall, up, failed = Counter(), Counter(), 0.0, 0, []
            for r in mine:
                env = r.get("result") or {}
                st = env.get("stats") or {}
                tok.update(st.get("tokens", {}))
                calls.update(st.get("model_calls_by_model", {}))
                wall += env.get("wall_s") or 0
                up += st.get("uploaded_bytes", 0)
                if r["state"] == "failed":
                    failed.append(f"{r['kind']}: {(r.get('error') or '')[:200]}")
            b = c.get(f"/k/bundles/{sid}")
            meta = b.json() if b.status_code == 200 else None
            if meta is None:
                status = "failed" if failed or (save and save["state"] == "failed") else "not built"
                reasons = failed or [f"save job {save['state'] if save else 'missing'}"]
            else:
                gaps = [m for m in meta.get("missing", []) if m["what"] in ("media", "link")]
                status = meta["completeness"]
                if gaps and all("blocked" in m["reason"] for m in gaps):
                    status = "blocked"
                reasons = [f"{m['what']} {m['ref']}: {m['reason'][:160]}" for m in gaps]
            gate = (save or {}).get("result", {}) or {}
            out[sid] = {
                "status": status,
                "reasons": reasons,
                "version": meta and meta["version"],
                "wall_s": round(wall, 1),
                "r2_bytes": up,
                "tokens": dict(tok),
                "model_calls": dict(calls),
                "gate_sha": (gate.get("result") or {}).get("gate_sha"),
            }
    return out


def gate_vs_judge(base: str, report: dict, snapshot: Path) -> dict:
    """The judge's kept ids against the gate's, counted over candidates the
    gate saw (ids present in both)."""
    v = dev_vars()
    tp = fp = fn = tn = 0
    with httpx.Client(base_url=base, headers={"authorization": f"Bearer {v['KNOWLEDGE_TOKEN']}"}, timeout=60) as c:
        for sid, row in report.items():
            jp = snapshot / "archive" / "2026-11-12" / "context" / "judged" / f"{sid}.json"
            if not row["gate_sha"] or not jp.exists():
                continue
            judged = json.loads(jp.read_text(encoding="utf-8"))
            judge_keep = {k["id"] for k in judged["kept"]}
            judge_seen = judge_keep | {k["id"] for k in judged["skipped"]}
            g = c.get(f"/k/blobs/{row['gate_sha']}").json()
            kept = {k["item_id"] for k in g["kept"]} & judge_seen
            dropped = {d["item_id"] for d in g["dropped"]} & judge_seen
            s = dict(both_keep=len(kept & judge_keep), gate_only=len(kept - judge_keep), judge_only=len(dropped & judge_keep), both_drop=len(dropped - judge_keep))
            row["gate_vs_judge"] = s
            tp += s["both_keep"]; fp += s["gate_only"]; fn += s["judge_only"]; tn += s["both_drop"]
    return {"both_keep": tp, "gate_only": fp, "judge_only": fn, "both_drop": tn,
            "precision": round(tp / (tp + fp), 3) if tp + fp else None, "recall": round(tp / (tp + fn), 3) if tp + fn else None}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8871")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--nov12-snapshot", type=Path)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--nov12", action="store_true")
    g.add_argument("--oct26", type=Path, help="x-bookmarks-eval root")
    a = ap.parse_args()
    if a.nov12:
        saves = sorted(p.stem for p in (a.nov12_snapshot / "archive" / "2026-11-12" / "context" / "judged").glob("*.json"))
    else:
        saves = list(json.loads((a.oct26 / "archive/2026-10-26/data.json").read_text(encoding="utf-8"))["posts"])
    report = per_save(a.base, saves)
    summary = {"saves": len(saves), "status": dict(Counter(r["status"] for r in report.values()))}
    tot = Counter()
    for r in report.values():
        tot.update(r["tokens"])
    summary.update(tokens=dict(tot), wall_s=round(sum(r["wall_s"] for r in report.values()), 1), r2_mb=round(sum(r["r2_bytes"] for r in report.values()) / 1e6, 1))
    if a.nov12:
        summary["gate_vs_judge"] = gate_vs_judge(a.base, report, a.nov12_snapshot)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps({"summary": summary, "saves": report}, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, indent=1))
    for sid, r in report.items():
        if r["status"] != "complete":
            print(sid, r["status"], "; ".join(r["reasons"])[:300])


if __name__ == "__main__":
    main()
