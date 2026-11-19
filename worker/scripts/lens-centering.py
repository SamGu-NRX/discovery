"""Lens scoring with and without background subtraction, on the replay's posts.

Raw: taste = cosine(unit(v), centroid of exemplar unit vectors).
Centered: subtract b, the mean unit vector of all captured posts, from every
vector before normalizing, then the same centroid and thresholds.
Thresholds as in worker/src/lens.ts: open_at = median exemplar cosine,
glance_at = lower 10th percentile.

Usage: venv/bin/python scripts/lens-centering.py <bundles dir> <lenses.json> <out.json>
"""
import json, sys, glob, os, random
import numpy as np
from fastembed import TextEmbedding

bundles_dir, lenses_path, out_path = sys.argv[1:4]
posts = {}
for f in sorted(glob.glob(os.path.join(bundles_dir, "*-bundle.json"))):
    b = json.load(open(f))
    for p in b["posts"].values():
        if p.get("text") and not p.get("retweet_of_id"):
            posts[p["id"]] = p
ids = list(posts)
cache = os.path.join(os.path.dirname(out_path), "embeddings.npy")
if os.path.exists(cache) and os.path.exists(cache + ".ids.json") and json.load(open(cache + ".ids.json")) == ids:
    V = np.load(cache)
else:
    V = np.array(list(TextEmbedding("BAAI/bge-base-en-v1.5", threads=2).embed([posts[i]["text"] for i in ids], batch_size=32)))
    np.save(cache, V)
    json.dump(ids, open(cache + ".ids.json", "w"))
unit = lambda m: m / np.linalg.norm(m, axis=-1, keepdims=True)
U = unit(V)
index = {i: k for k, i in enumerate(ids)}
lenses = json.load(open(lenses_path))
bg = U.mean(axis=0)


def score(space, exemplar_rows):
    c = unit(space[exemplar_rows].mean(axis=0))
    ex = np.sort(space[exemplar_rows] @ c)
    open_at = float(np.median(ex))
    glance_at = float(ex[int(np.floor(0.1 * (len(ex) - 1)))])
    return space @ c, open_at, glance_at


def auc(pos, neg):
    pos, neg = np.asarray(pos), np.asarray(neg)
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


report = {"posts": len(ids)}
for name, space in [("raw", U), ("centered", unit(U - bg))]:
    rows = {l["id"]: [index[x] for x in l["exemplar_ids"] if x in index] for l in lenses}
    res = {"lenses": {}}
    near = {}
    tastes = {}
    for l in lenses:
        t, open_at, glance_at = score(space, rows[l["id"]])
        tastes[l["id"]] = t
        near[l["id"]] = t >= glance_at
        q = lambda p: round(float(np.quantile(t, p)), 3)
        res["lenses"][l["id"]] = {
            "open_at": round(open_at, 3), "glance_at": round(glance_at, 3),
            "spread": {"p10": q(0.1), "p50": q(0.5), "p90": q(0.9), "p99": q(0.99)},
            "near_share": round(float(near[l["id"]].mean()), 3),
            "open_share": round(float((t >= open_at).mean()), 3),
        }
    a, b = [l["id"] for l in lenses]
    res["near_both_share"] = round(float((near[a] & near[b]).mean()), 3)
    res["near_both_share_of_near_either"] = round(float((near[a] & near[b]).sum() / max(1, (near[a] | near[b]).sum())), 3)
    # The replay's view: each lens's top 50 by taste, and how many count as near the other lens.
    top = {k: np.argsort(-tastes[k])[:50] for k in (a, b)}
    res["top50_near_other"] = {a: int(near[b][top[a]].sum()), b: int(near[a][top[b]].sum())}
    # Held-out separation: a centroid from half of each lens's exemplars, the
    # other half scored; AUC of own held-out exemplars against the other
    # lens's held-out exemplars, and against all non-exemplar posts.
    rng = random.Random(7)
    sep = {a: [], b: []}
    vs_bg = {a: [], b: []}
    all_ex = set(rows[a]) | set(rows[b])
    rest = np.array([k for k in range(len(ids)) if k not in all_ex])
    for _ in range(20):
        half = {}
        for k in (a, b):
            r = rows[k][:]
            rng.shuffle(r)
            half[k] = (r[: len(r) // 2], r[len(r) // 2 :])
        for k, other in ((a, b), (b, a)):
            c = unit(space[half[k][0]].mean(axis=0))
            sep[k].append(auc(space[half[k][1]] @ c, space[half[other][1]] @ c))
            vs_bg[k].append(auc(space[half[k][1]] @ c, space[rest] @ c))
    res["heldout_auc_vs_other_lens"] = {k: round(float(np.mean(v)), 3) for k, v in sep.items()}
    res["heldout_auc_vs_all_posts"] = {k: round(float(np.mean(v)), 3) for k, v in vs_bg.items()}
    report[name] = res
json.dump(report, open(out_path, "w"), indent=1)
print(json.dumps(report, indent=1))
