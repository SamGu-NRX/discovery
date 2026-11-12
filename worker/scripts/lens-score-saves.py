"""Scores Sam's 170 Nov 12 saves against the agent-harnesses lens.

Exemplars come from his Oct 26 saves, not the Nov 12 ones, so the scoring
is not circular: every Oct 26 save whose archive findings carry a harness
topic. Each save is scored on its post text, the text the reader sees in the
feed (worker/src/lens.ts labels posts by their text). Raw and
background-centered scoring are both reported; the background is the mean
unit vector of the replay's captured posts (embeddings.npy from
lens-centering.py).

Gold is the archive lead's disposition of the 170 saves
(curated/saves-nov12/notes.md: kept or skipped, against what bears on Sam's
model and tool setup) and the topics on the kept saves' findings.

Usage: venv/bin/python scripts/lens-score-saves.py <raw-oct dir> <raw-nov dir> <oct findings.json>
         <nov findings.json> <nov notes.md> <embeddings.npy> <out.json>
"""
import json, re, sys, os
import numpy as np
from fastembed import TextEmbedding

raw_oct, raw_nov, oct_findings, nov_findings, nov_notes, bg_path, out_path = sys.argv[1:8]

CHARTER = (
    "Agent harnesses: how Claude Code, Codex, T3 Code and other coding-agent harnesses are set up and run, "
    "including subagents and orchestration, model routing and effort, MCP tools, skills and instruction files, "
    "memory, sessions and long-running agents."
)
HARNESS_TOPICS = {
    "orchestration", "model-routing", "harness-choice", "subagents", "t3-code", "codex", "skills", "mcp",
    "mcp-context-cost", "tool-loading", "memory-second-brain", "threads-sessions", "long-running-agents",
    "instructions-files", "caching-compaction", "context-management", "computer-use", "effort-levels", "grokbot", "hooks",
}
MARK = re.compile(r"^\[[A-Z0-9 ]+\]")


def post_text(path):
    lines = open(path, encoding="utf-8").read().splitlines()
    try:
        start = lines.index("[POST TEXT]") + 1
    except ValueError:
        return ""
    out = []
    for line in lines[start:]:
        if MARK.match(line):
            break
        out.append(line)
    return "\n".join(out).strip()


def topics_by_save(path):
    by = {}
    for e in json.load(open(path)):
        m = re.search(r"status/(\d+)", e.get("source_url") or "")
        if m:
            by.setdefault(m.group(1), set()).update(e.get("topics", []))
    return by


oct_topics = topics_by_save(oct_findings)
nov_topics = topics_by_save(nov_findings)
exemplars = {}
for f in os.listdir(raw_oct):
    sid = f.split(".")[0]
    if oct_topics.get(sid, set()) & HARNESS_TOPICS:
        t = post_text(os.path.join(raw_oct, f))
        if t:
            exemplars[sid] = t

disp = {}
for line in open(nov_notes, encoding="utf-8"):
    m = re.match(r"^\d{3}\. (\d+) @(\S+) \((kept|skipped)", line)
    if m:
        disp[m.group(1)] = {"handle": m.group(2), "kept": m.group(3) == "kept"}
saves = {}
for f in os.listdir(raw_nov):
    sid = f.split(".")[0]
    if sid in disp:
        saves[sid] = post_text(os.path.join(raw_nov, f))

model = TextEmbedding("BAAI/bge-base-en-v1.5", threads=2)
unit = lambda m: m / np.linalg.norm(m, axis=-1, keepdims=True)
ex_ids = list(exemplars)
sv_ids = [s for s in saves if saves[s]]
EX = unit(np.array(list(model.embed([exemplars[i] for i in ex_ids], batch_size=32))))
SV = unit(np.array(list(model.embed([saves[i] for i in sv_ids], batch_size=32))))
bg = unit(np.load(bg_path)).mean(axis=0)

kept = np.array([disp[s]["kept"] for s in sv_ids])
harness = np.array([disp[s]["kept"] and bool(nov_topics.get(s, set()) & HARNESS_TOPICS) for s in sv_ids])


def auc(scores, labels):
    pos, neg = scores[labels], scores[~labels]
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


def rates(flag, gold):
    n = int(flag.sum())
    hit = int((flag & gold).sum())
    return {"labeled": n, "precision": round(hit / n, 3) if n else None, "recall": round(hit / int(gold.sum()), 3)}


report = {
    "charter": CHARTER,
    "exemplars": {"count": len(ex_ids), "source": "Oct 26 saves whose findings carry a harness topic", "ids": ex_ids},
    "saves": {"scored": len(sv_ids), "without_post_text": [s for s in saves if not saves[s]], "kept": int(kept.sum()), "kept_with_harness_topic": int(harness.sum())},
}
for name, ex, sv in [("raw", EX, SV), ("centered", unit(EX - bg), unit(SV - bg))]:
    c = unit(ex.mean(axis=0))
    ec = np.sort(ex @ c)
    open_at, glance_at = float(np.median(ec)), float(ec[int(np.floor(0.1 * (len(ec) - 1)))])
    t = sv @ c
    opened, near = t >= open_at, t >= glance_at
    order = np.argsort(-t)
    report[name] = {
        "open_at": round(open_at, 3), "glance_at": round(glance_at, 3),
        "spread": {k: round(float(np.quantile(t, q)), 3) for k, q in [("p10", 0.1), ("p50", 0.5), ("p90", 0.9)]},
        "auc_kept_vs_skipped": round(auc(t, kept), 3),
        "auc_harness_vs_rest": round(auc(t, harness), 3),
        "open": {"vs_kept": rates(opened, kept), "vs_harness": rates(opened, harness)},
        "near": {"vs_kept": rates(near, kept), "vs_harness": rates(near, harness)},
        "top15": [{"id": sv_ids[k], "taste": round(float(t[k]), 3), "kept": bool(kept[k]), "harness": bool(harness[k]), "handle": disp[sv_ids[k]]["handle"], "text": saves[sv_ids[k]][:110].replace("\n", " ")} for k in order[:15]],
        "open_but_skipped": [{"id": sv_ids[k], "taste": round(float(t[k]), 3), "handle": disp[sv_ids[k]]["handle"], "text": saves[sv_ids[k]][:110].replace("\n", " ")} for k in order if opened[k] and not kept[k]],
        "harness_missed": [{"id": sv_ids[k], "taste": round(float(t[k]), 3), "handle": disp[sv_ids[k]]["handle"], "text": saves[sv_ids[k]][:110].replace("\n", " ")} for k in order if harness[k] and not near[k]],
    }
json.dump(report, open(out_path, "w"), indent=1)
print(json.dumps({k: (v if k in ("saves",) else {kk: vv for kk, vv in v.items() if kk not in ("top15", "open_but_skipped", "harness_missed", "ids")}) if isinstance(v, dict) else v for k, v in report.items()}, indent=1))
