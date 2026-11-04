"""Replay real inputs through the runner offline, for grading rounds before Worker v2 is deployed.

Inputs: the Nov 4 action-loop bundles (Sam's real saves with their threads and replies) loaded into the mock
Worker as captured posts, all 69 saves as positives, and live Greenhouse postings as watcher candidates. The
runner then does exactly what `work` does: real bundle building and link fetching, real model calls through
CLIProxyAPI, real live-machine checks and real `codex exec` preps. Only the Worker is the mock, and its
embeddings are hashed bags of words standing in for bge-base (they pick related saves less well).

Usage: python3 runner/eval/replay.py <round-dir> [--ids id,id] [--watchers all|none|ref,ref]
Writes <round-dir>/artifacts.md (what Sam would see, without judge verdicts) and <round-dir>/summary.json.
"""
import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "tests"))

ACTION_LOOP = Path("/Users/samgu/.t3/scratch/2026-11-02-i-want-help-setting-up-2ce4a97d/action-loop")
GROKBOT = ACTION_LOOP.parent / "GROKBOT.md"


def load_saves():
    out = {}
    for f in sorted((ACTION_LOOP / "bundles").glob("*.json")):
        out[f.stem] = json.loads(f.read_text())
    return out


def as_post(pid, author, text, urls=(), created="2026-10-20T00:00:00Z"):
    return {"id": pid, "author_handle": author, "text": text, "urls": list(urls), "media": [], "created_at": created,
            "quoted_id": None, "metrics": {}}


def load_mock(state, saves, sample_saves, watchers, mock_mod):
    ms = mock_mod.ms
    old = mock_mod.now() - dt.timedelta(days=2)
    for pid, b in saves.items():
        text = b["op_text"]
        ocr = " ".join(m.get("text_in_image", "") for m in b.get("media") or [] if m.get("text_in_image"))
        state.positives.append({"id": pid, "text": (text + ("\n[image text] " + ocr if ocr else ""))[:6000],
                                "author_handle": b["op"], "source": "bookmark"})
    for pid in sample_saves:
        b = saves[pid]
        urls = [s["url"] for s in b.get("sources") or [] if s.get("found_in", "").startswith("OP") and s.get("url")]
        post = as_post(pid, b["op"], b["op_text"], urls, b.get("created_at") or "2026-10-20T00:00:00Z")
        ocr = [m["text_in_image"] for m in b.get("media") or [] if m.get("text_in_image")]
        if ocr:
            post["text"] += "\n\n[text in attached image] " + "\n".join(ocr)[:3000]
        post["bookmarked"] = 1
        state.posts[pid] = post
        thread = [post] + [as_post(t["id"], b["op"], t["text"]) for t in b.get("thread") or []]
        replies = [as_post(f"{pid}-r{i}", r["author"], r["text"]) for i, r in enumerate(b.get("replies") or [])]
        quoted = None
        if b.get("quoted"):
            q = b["quoted"]
            quoted = as_post(f"{pid}-q", q.get("author") or "unknown", (q.get("text") or "") +
                             ("\n\n" + q["article"] if q.get("article") else ""))
            post["quoted_id"] = quoted["id"]
        state.contexts[pid] = {"post": post, "quoted": quoted, "thread_captured": True,
                               "thread": {"op_self_thread": thread, "replies": replies, "missing_ids": []}}
        state.add_candidate("x_post", pid, f"@{b['op']}: {b['op_text'][:80]}", b["url"], created_at=ms(old))
    for w in watchers:
        state.add_candidate("watcher_event", w["ref"], w["title"], w["url"], created_at=ms(old))


WATCHERS = [
    {"ref": "anthropic-greenhouse:5183044008", "title": "Anthropic Fellows Program, AI Safety & Security",
     "url": "https://job-boards.greenhouse.io/anthropic/jobs/5183044008"},
    {"ref": "anthropic-greenhouse:5183051008", "title": "Anthropic Fellows Program, ML Systems & Reinforcement Learning",
     "url": "https://job-boards.greenhouse.io/anthropic/jobs/5183051008"},
    {"ref": "anthropic-greenhouse:5183053008", "title": "Anthropic Fellows Program, The Anthropic Institute (Economics & Policy)",
     "url": "https://job-boards.greenhouse.io/anthropic/jobs/5183053008"},
    {"ref": "anthropic-greenhouse:5439169008", "title": "Anthropic Research Resident",
     "url": "https://job-boards.greenhouse.io/anthropic/jobs/5439169008"},
    {"ref": "anthropic-greenhouse:5438311008", "title": "Anthropic Research Resident",
     "url": "https://job-boards.greenhouse.io/anthropic/jobs/5438311008"},
]

SAMPLE = ["2113515032554160411", "2113505192951820770", "2108637982005833973", "2107615261893464226",
          "2113469231429980501", "2112632133357346889", "2113413180277887266", "2112130582226378886",
          "2112736749281759566", "2113393903923581149", "2114674262179188755", "2110720940665372825",
          "2113025284148715845", "2102553784509780281"]


def file_excerpt(path, limit=6000):
    p = Path(path)
    if not p.exists() or not p.is_file():
        return None
    t = p.read_text(errors="replace")
    return t if len(t) <= limit else t[:limit] + f"\n[... {len(t) - limit} more characters in {p.name}]"


def artifacts(home, mock_state):
    """Every candidate's outcome as Sam would see it in the morning, without the judge's verdicts."""
    runs = [json.loads(f.read_text()) for f in sorted((home / "runs").rglob("*.json")) if not f.name.endswith(".bundle.json")]
    lines = ["# Discovery runner output for one grading round", "",
             "Each section is one candidate the runner handled: either the proposal Sam would see (with the files it "
             "prepared) or the reason nothing was proposed.", ""]
    summary = []
    for r in runs:
        c = r["candidate"]
        comp = r.get("complete") or {}
        lines += [f"## Candidate: {c['title']}", f"Source: {c.get('url')}", ""]
        item = {"candidate": c["ref"], "kind": c["kind"], "outcome": comp.get("state"), "note": comp.get("note")}
        prop = (r.get("proposal") or {}).get("body")
        if prop:
            item.update(title=prop["title"], proposal_kind=prop["kind"], final_step_kind=prop["final_step_kind"])
            lines += [f"**Proposal ({prop['kind']}): {prop['title']}**", "", prop["why"], ""]
            if prop["inputs"].get("approval_line"):
                lines += [f"Ask: {prop['inputs']['approval_line']}", ""]
            lines += [f"Final step: {prop['final_step_kind'] or 'none (recorded as done, never asks)'}"
                      f"{' — ' + prop['final_step'] if prop.get('final_step') else ''}", ""]
            if prop["evidence"]:
                lines += ["Evidence:"] + [f"- \"{e['quote']}\" ({e['where']})" for e in prop["evidence"]] + [""]
            if prop["inputs"].get("connects"):
                lines += ["Connects to:"] + [f"- {x.get('id')}: {x.get('how')}" for x in prop["inputs"]["connects"]] + [""]
            lines += ["Prepared:"]
            for p in prop["prepared"]:
                lines.append(f"- {p['type']}: {Path(p['ref']).name} — {p['summary']}")
            for p in prop["prepared"]:
                if p["type"] in ("file", "draft", "note") and not Path(p["ref"]).name == "PROPOSAL.md":
                    ex = file_excerpt(p["ref"])
                    if ex:
                        lines += ["", f"<details><summary>{Path(p['ref']).name}</summary>", "", "```", ex, "```", "</details>"]
            prep = r.get("prep")
            if prep:
                lines += ["", f"Agent prep: {prep.get('verdict')} in {prep.get('seconds')} s — {prep.get('summary')}"]
                md = file_excerpt(Path(prop["prepared"][0]["ref"]).parent / "PREP.md", 5000)
                if md:
                    lines += ["", "<details><summary>PREP.md</summary>", "", md, "</details>"]
        elif r.get("merged_into"):
            lines += [f"Merged into an existing proposal: {r['merged_into'].get('title')} ({r['merged_into'].get('match')})"]
        else:
            lines += [f"No proposal. {comp.get('state')}: {comp.get('note')}"]
        lines += ["", "---", ""]
        summary.append(item)
    return "\n".join(lines), summary


def grokbot_section_2():
    t = GROKBOT.read_text()
    start = t.index("## 2. What you actually repeat")
    end = t.index("## 3. Architecture")
    return t[start:end]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("round_dir")
    ap.add_argument("--ids", default="")
    ap.add_argument("--watchers", default="all", help="all | none | comma-separated refs")
    a = ap.parse_args()
    home = Path(a.round_dir).expanduser().resolve()
    home.mkdir(parents=True, exist_ok=True)
    os.environ["DISCOVERY_HOME"] = str(home)
    import mock_worker
    from discovery_runner import config
    from discovery_runner.llm import Gateway
    from discovery_runner.pipeline import Runner
    from discovery_runner.worker import Worker

    ids = [] if a.ids == "none" else ([i for i in a.ids.split(",") if i] or SAMPLE)
    watchers = [] if a.watchers == "none" else [w for w in WATCHERS if a.watchers == "all" or w["ref"] in a.watchers]
    with mock_worker.MockWorker() as m:
        load_mock(m.state, load_saves(), ids, watchers, mock_worker)
        tok = home / "token"
        tok.write_text(mock_worker.TOKEN)
        # Grading needs every sampled candidate handled in one round, so the eval home's daily budgets are
        # larger than the live defaults (20 deep reads, 5 preps). Prep timeout and scratch limits stay the same.
        cfg = {**config.DEFAULTS, "worker_url": m.url, "token_file": str(tok), "claim_limit": 3,
               "codex_preps_per_day": 12, "deep_reads_per_day": 40}
        (home / "config.json").write_text(json.dumps(cfg, indent=1))
        cfg = config.load()
        runner = Runner(cfg, Worker.from_config(cfg), Gateway.from_config(cfg),
                        log=lambda msg: print(f"{config.now_iso()} {msg}", flush=True))
        while True:
            runs = runner.work()
            if not runs:
                break
            for r in runs:
                print(r["candidate"]["ref"], json.dumps(r.get("complete"))[:240], flush=True)
        text, summary = artifacts(home, m.state)
    (home / "artifacts.md").write_text(text)
    (home / "grokbot-section-2.md").write_text(grokbot_section_2())
    from discovery_runner.llm import summarize_calls
    (home / "summary.json").write_text(json.dumps({"items": summary, "calls": summarize_calls(home / "logs" / "calls.jsonl")},
                                                  indent=1))
    print(json.dumps(summarize_calls(home / "logs" / "calls.jsonl"), indent=1))


if __name__ == "__main__":
    main()
