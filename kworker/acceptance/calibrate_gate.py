"""Sets the gate's embedding thresholds from labeled data.

Positives are the archive's saved posts other than the ten acceptance saves
(the same set acceptance/run.py seeds into the local Worker). Labeled items
are the judged reply pool (results/judge/labels-*.json, a blind Sol High
judge) for every root except the ten saves, plus the archive's final kept
replies as relevant. For each threshold pair it reports how many replies the
embedding stage would settle and how many of those it would get wrong.

Usage: python -m acceptance.calibrate_gate <x-bookmarks-eval path> <out.json>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from fastembed import TextEmbedding

from acceptance.saves import SAVES
from kworker.gate import DROP_AT, KEEP_AT, TOP_K, bare

MODEL = "BAAI/bge-base-en-v1.5"


def main(root: Path, out: Path) -> None:
    data = json.loads((root / "archive/2026-10-26/data.json").read_text(encoding="utf-8"))
    positives = sorted({p["text"] for pid, p in data["posts"].items() if pid not in SAVES})
    items = []
    seen = set()
    for acct in ("sdotgu", "_sgu_"):
        pool = json.loads((root / f"results/judge/blind-replies-{acct}.json").read_text(encoding="utf-8"))["items"]
        labels = {x["item"]: x["relevant"] for x in json.loads((root / f"results/judge/labels-{acct}.json").read_text(encoding="utf-8"))["labels"]}
        for it in pool:
            if it["root_id"] in SAVES:
                continue
            key = " ".join(it["text"].split())
            seen.add(key)
            items.append((bare(it["text"]) or it["text"], labels[it["item"]], it["root_id"]))
    for r in data["replies"]:
        key = " ".join(r["text"].split())
        if r["root_id"] in SAVES or key in seen:
            continue
        items.append((bare(r["text"]) or r["text"], True, r["root_id"]))

    model = TextEmbedding(model_name=MODEL, cache_dir=str(Path.home() / ".cache/kworker/fastembed"))
    norm = lambda v: v / np.linalg.norm(v, axis=1, keepdims=True)
    p = norm(np.asarray(list(model.embed(positives)), dtype=np.float32))
    q = norm(np.asarray(list(model.embed([t for t, _, _ in items])), dtype=np.float32))
    sims = q @ p.T
    score = (-np.sort(-sims, axis=1)[:, :TOP_K]).mean(axis=1)
    rel = np.array([r for _, r, _ in items])

    grid = []
    for keep_at in np.arange(0.60, 0.96, 0.01):
        for drop_at in np.arange(0.40, keep_at, 0.01):
            keep = score >= keep_at
            drop = score <= drop_at
            grid.append(
                {
                    "keep_at": round(float(keep_at), 2),
                    "drop_at": round(float(drop_at), 2),
                    "settled": int(keep.sum() + drop.sum()),
                    "wrong_keeps": int((keep & ~rel).sum()),
                    "wrong_drops": int((drop & rel).sum()),
                }
            )
    # The widest zero-error zones: no relevant reply dropped, no irrelevant one kept.
    clean = [g for g in grid if g["wrong_keeps"] == 0 and g["wrong_drops"] == 0]
    best = max(clean, key=lambda g: g["settled"]) if clean else None
    # A dropped relevant reply is lost for good, a kept irrelevant one costs
    # a little storage: allow at most 1% of relevant replies dropped and 5%
    # of irrelevant ones kept.
    budget = [g for g in grid if g["wrong_drops"] <= 0.01 * rel.sum() and g["wrong_keeps"] <= 0.05 * (~rel).sum()]
    best_budget = max(budget, key=lambda g: g["settled"]) if budget else None
    report = {
        "model": MODEL,
        "top_k": TOP_K,
        "positives": len(positives),
        "labeled_items": len(items),
        "relevant": int(rel.sum()),
        "score_quantiles": {
            "relevant": np.quantile(score[rel], [0, 0.1, 0.5, 0.9, 1]).round(3).tolist(),
            "irrelevant": np.quantile(score[~rel], [0, 0.1, 0.5, 0.9, 1]).round(3).tolist(),
        },
        "shipped": {
            "keep_at": KEEP_AT,
            "drop_at": DROP_AT,
            "kept": int((score >= KEEP_AT).sum()),
            "dropped": int((score <= DROP_AT).sum()),
            "wrong_keeps": int(((score >= KEEP_AT) & ~rel).sum()),
            "wrong_drops": int(((score <= DROP_AT) & rel).sum()),
            "to_model": int(((score > DROP_AT) & (score < KEEP_AT)).sum()),
        },
        "best_zero_error": best,
        "best_within_budget": best_budget,
        "grid_zero_error_top": sorted(clean, key=lambda g: -g["settled"])[:10],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("labeled_items", "relevant", "shipped", "best_within_budget")}, indent=1))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
