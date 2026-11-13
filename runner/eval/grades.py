"""Tell real changes from grader noise across grading rounds.

Graders name items in free text (a URL, a title, "@handle"), so every score is first mapped to a stable key:
x:<handle> for a save, gh:<job id> for a posting (both Research Resident postings are one item, gh:resident,
because graders merge them). Grade files are JSON: {"round", "grader", "overall", "scores": {key: 0-10}}.

  grades.py key-table                               the keys and what they match
  grades.py noise A.json B.json                     per-item spread of two gradings of the same artifacts
  grades.py pairs <old-round> <new-round> <out-dir> blinded pairwise file for a fresh grader, plus its key
  grades.py pairwise <out-dir>/key.json G.json      win/tie/loss for the newer round from a pairwise verdict
  grades.py deltas OLD.json NEW.json [--noise N]    per-item change, flagged when larger than the noise
  grades.py gate <round>                            the round against each item's best so far (see gate())
  grades.py gate-resolve <round> <verdict.json>...  confirm or accept flagged drops from blinded pairwise verdicts
"""
import json
import random
import re
import statistics
import sys
from pathlib import Path

EVAL = Path.home() / ".discovery-eval"
SAVES = {
    "2113515032554160411": "hqmank", "2113505192951820770": "dominikmartn", "2108637982005833973": "lydiahallie",
    "2107615261893464226": "theo", "2113469231429980501": "imbabybrooklyn", "2112632133357346889": "omarsar0",
    "2113413180277887266": "terminalxw", "2112130582226378886": "DavidKPiano", "2112736749281759566": "poteto",
    "2113393903923581149": "ElliotPadfield", "2114674262179188755": "treg_ai", "2110720940665372825": "AnthropicAI",
    "2113025284148715845": "Railway", "2102553784509780281": "sheherenow_",
}
JOBS = {"5183044008": "gh:5183044008", "5183051008": "gh:5183051008", "5183053008": "gh:5183053008",
        "5439169008": "gh:resident", "5438311008": "gh:resident"}
TITLES = [("research resident", "gh:resident"), ("ml systems", "gh:5183051008"), ("reinforcement", "gh:5183051008"),
          ("economics", "gh:5183053008"), ("institute", "gh:5183053008"), ("ai safety", "gh:5183044008")]


def key_of(text):
    t = text or ""
    m = re.search(r"status/(\d+)", t)
    if m and m[1] in SAVES:
        return f"x:{SAVES[m[1]]}"
    m = re.search(r"\b(5\d{9})\b", t)
    if m and m[1] in JOBS:
        return JOBS[m[1]]
    low = t.lower()
    for handle in SAVES.values():
        if f"@{handle.lower()}" in low:
            return f"x:{handle}"
    for needle, k in TITLES:
        if needle in low:
            return k
    raise KeyError(f"no item key for {t[:120]!r}")


def load(path):
    g = json.loads(Path(path).read_text())
    if "items" in g:  # a raw grader answer
        scores = {}
        for it in g["items"]:
            scores.setdefault(key_of(it["candidate"]), []).append(it["score"])
        g = {**g, "scores": {k: sum(v) / len(v) for k, v in scores.items()}}
    return g


def noise(a, b):
    ga, gb = load(a), load(b)
    keys = sorted(set(ga["scores"]) & set(gb["scores"]))
    diffs = {k: gb["scores"][k] - ga["scores"][k] for k in keys}
    absd = [abs(d) for d in diffs.values()]
    return {"items": len(keys), "per_item_diff": diffs, "mean_abs_diff": round(statistics.mean(absd), 2),
            "max_abs_diff": max(absd), "share_diff_ge_3": round(sum(d >= 3 for d in absd) / len(absd), 2),
            "mean_a": round(statistics.mean(ga["scores"][k] for k in keys), 2),
            "mean_b": round(statistics.mean(gb["scores"][k] for k in keys), 2),
            "overall_a": ga.get("overall"), "overall_b": gb.get("overall")}


def sections(round_dir):
    """artifacts.md split by candidate, keyed like the grades; the two Resident sections are joined."""
    text = (Path(round_dir) / "artifacts.md").read_text()
    out = {}
    for part in re.split(r"\n(?=## Candidate: )", text)[1:]:
        src = re.search(r"^Source: (\S+)", part, re.M)
        k = key_of((src[1] if src else "") + " " + part.splitlines()[0])
        out[k] = (out[k] + "\n\n" + part) if k in out else part
    return out


def pairs(old_dir, new_dir, out_dir, seed=20261104):
    old, new = sections(old_dir), sections(new_dir)
    rng = random.Random(seed)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    key, lines = {}, ["# Paired outputs", "",
                      "Each item below is one thing Sam saved or was alerted to. Two versions of the system handled it. "
                      "They are labeled Option 1 and Option 2 in random order.", ""]
    for i, k in enumerate(sorted(set(old) | set(new)), 1):
        a = old.get(k, "## (no outcome: the system never reached this item)")
        b = new.get(k, "## (no outcome: the system never reached this item)")
        flip = rng.random() < 0.5
        key[f"item-{i}"] = {"key": k, "option_1": "new" if flip else "old"}
        o1, o2 = (b, a) if flip else (a, b)
        lines += [f"# item-{i}", "", "## Option 1", "", o1.replace("## Candidate:", "### Candidate:"), "",
                  "## Option 2", "", o2.replace("## Candidate:", "### Candidate:"), "", "---", ""]
    (out / "pairs.md").write_text("\n".join(lines))
    (out / "key.json").write_text(json.dumps(key, indent=1))
    return {"items": len(key), "file": str(out / "pairs.md")}


def pairwise(key_file, verdict_file):
    key = json.loads(Path(key_file).read_text())
    v = json.loads(Path(verdict_file).read_text())
    res, per = {"new_wins": 0, "ties": 0, "old_wins": 0}, {}
    for it in v["items"]:
        k = key[it["item"]]
        pick = it["prefer"]
        if pick == "tie":
            res["ties"] += 1
            per[k["key"]] = "tie"
            continue
        winner = k["option_1"] if pick == "1" else ("old" if k["option_1"] == "new" else "new")
        res[f"{winner}_wins"] += 1
        per[k["key"]] = winner
    return {**res, "per_item": per}


def deltas(old, new, noise_band=0.0):
    go, gn = load(old), load(new)
    out = {}
    for k in sorted(set(go["scores"]) | set(gn["scores"])):
        a, b = go["scores"].get(k), gn["scores"].get(k)
        if a is None or b is None:
            out[k] = {"old": a, "new": b}
            continue
        d = b - a
        out[k] = {"old": a, "new": b, "delta": d, "beyond_noise": abs(d) > noise_band}
    return out


GRADES = EVAL / "grades"
DROP = 3  # the measured noise band: a fresh re-grade of unchanged artifacts moved no item more than 2 points
LEDGER = EVAL / "best.json"


def combined(rnd):
    """Per item: both graders' scores and their mean, for one round."""
    c = load(GRADES / f"round-{rnd}-claude.json")["scores"]
    s = load(GRADES / f"round-{rnd}-sam.json")["scores"]
    return {k: {"claude": c.get(k), "sam": s.get(k),
                "combined": statistics.mean(x for x in (c.get(k), s.get(k)) if x is not None)}
            for k in set(c) | set(s)}


def ledger():
    return json.loads(LEDGER.read_text()) if LEDGER.exists() else {"items": {}, "rounds": [], "accepted": [], "causes": []}


def gate(rnd):
    """Each item's combined score this round against its best before this round.

    An item is flagged when it falls DROP or more below its best. A flagged drop is not yet a regression:
    absolute scores come from graders who each saw one round, so the drop goes to a blinded pairwise check
    of the best output against this round's (pairs file written here). gate-resolve records the outcome.
    Rounds already in the ledger are rebuilt from grade files when the ledger is missing them."""
    led = ledger()
    for r in range(1, int(rnd)):
        if r not in led["rounds"] and (GRADES / f"round-{r}-claude.json").exists():
            _update(led, r, set())
    now = combined(rnd)
    flagged = []
    for k, v in sorted(now.items()):
        best = led["items"].get(k)
        if best and best["combined"] - v["combined"] >= DROP:
            flagged.append({"key": k, "best_round": best["round"], "best": best["combined"], "now": v["combined"],
                            "now_claude": v["claude"], "now_sam": v["sam"]})
    out = EVAL / f"gate-{rnd}"
    out.mkdir(exist_ok=True)
    if flagged:
        _pairs_vs_best(flagged, rnd, out)
    (out / "flagged.json").write_text(json.dumps(flagged, indent=1))
    LEDGER.write_text(json.dumps(led, indent=1))
    return {"round": int(rnd), "flagged": flagged, "pairs": str(out / "pairs.md") if flagged else None}


def _pairs_vs_best(flagged, rnd, out, seed=7):
    rng = random.Random(seed)
    key, lines = {}, ["# Paired outputs", "", "Each item is one thing Sam saved or was alerted to. Two versions of the "
                      "system handled it, labeled Option 1 and Option 2 in random order.", ""]
    for i, f in enumerate(flagged, 1):
        best = sections(EVAL / f"round-{f['best_round']}").get(f["key"], "## (no outcome)")
        new = sections(EVAL / f"round-{rnd}").get(f["key"], "## (no outcome: the system never reached this item)")
        flip = rng.random() < 0.5
        key[f"item-{i}"] = {"key": f["key"], "option_1": "new" if flip else "old"}
        o1, o2 = (new, best) if flip else (best, new)
        lines += [f"# item-{i}", "", "## Option 1", "", o1.replace("## Candidate:", "### Candidate:"), "",
                  "## Option 2", "", o2.replace("## Candidate:", "### Candidate:"), "", "---", ""]
    (out / "pairs.md").write_text("\n".join(lines))
    (out / "key.json").write_text(json.dumps(key, indent=1))


def gate_resolve(rnd, *verdict_files):
    """A flagged drop is a confirmed regression when the pairwise graders prefer the best output (any grader
    preferring it and none preferring the new one); otherwise it is accepted, with the graders' verdicts as
    the reason. The round passes only with no confirmed regression. The ledger then takes every item where
    this round beats the best, and keeps the best where it does not."""
    out = EVAL / f"gate-{rnd}"
    led = ledger()
    flagged = json.loads((out / "flagged.json").read_text())
    verdicts = [pairwise(out / "key.json", v)["per_item"] for v in verdict_files] if flagged else []
    confirmed, accepted = [], []
    for f in flagged:
        votes = [v.get(f["key"]) for v in verdicts]
        (confirmed if "old" in votes and "new" not in votes else accepted).append({**f, "pairwise": votes})
    now = combined(rnd)
    for a in accepted:
        led["accepted"].append({"round": int(rnd), "key": a["key"], "reason": f"blinded pairwise vs best: {a['pairwise']}"})
        if "new" in a["pairwise"] and "old" not in a["pairwise"]:
            # The graders preferred this round's output to the stored best, whatever the absolute scores said,
            # so it becomes the output later rounds are compared with.
            led["items"][a["key"]] = {"round": int(rnd), **now[a["key"]], "replaced_by_pairwise": True}
    for c in confirmed:
        led["causes"].append({"round": int(rnd), "key": c["key"], "cause": None, "note": None})
    _update(led, int(rnd), {c["key"] for c in confirmed} | {a["key"] for a in accepted})
    LEDGER.write_text(json.dumps(led, indent=1))
    return {"round": int(rnd), "passes": not confirmed, "confirmed_regressions": confirmed, "accepted_drops": accepted}


def _update(led, rnd, skip):
    for k, v in combined(rnd).items():
        best = led["items"].get(k)
        if k in skip:
            continue
        if not best or v["combined"] > best["combined"]:
            led["items"][k] = {"round": rnd, **v}
    if rnd not in led["rounds"]:
        led["rounds"].append(rnd)


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    if cmd == "key-table":
        print(json.dumps({"saves": SAVES, "jobs": JOBS}, indent=1))
    elif cmd == "noise":
        print(json.dumps(noise(*args), indent=1))
    elif cmd == "pairs":
        print(json.dumps(pairs(*args)))
    elif cmd == "pairwise":
        print(json.dumps(pairwise(*args), indent=1))
    elif cmd == "gate":
        print(json.dumps(gate(args[0]), indent=1))
    elif cmd == "gate-resolve":
        print(json.dumps(gate_resolve(*args), indent=1))
    elif cmd == "deltas":
        band = float(args[args.index("--noise") + 1]) if "--noise" in args else 0.0
        print(json.dumps(deltas(args[0], args[1], band), indent=1))
