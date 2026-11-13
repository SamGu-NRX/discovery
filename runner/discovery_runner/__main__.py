"""discovery-runner: score | work | loop | flush | calibrate | status | stop | resume."""
import argparse
import json
import sys
import time
import traceback

from . import config
from .llm import Gateway, summarize_calls
from .pipeline import Runner, stop_preps
from .scoring import calibrate, run_score
from .worker import Worker, WorkerUnavailable, flush_outbox


def log(msg):
    print(f"{config.now_iso()} {msg}", flush=True)


def heartbeat(status, **extra):
    config.path("logs", "heartbeat").write_text(json.dumps({"ts": config.now_iso(), "status": status, **extra}) + "\n")


def cycle(cfg, worker, runner):
    """One score-then-work pass. Returns a summary; raises WorkerUnavailable for the loop to back off."""
    sent = flush_outbox(worker)
    if sent:
        log(f"flushed {len(sent)} queued proposals")
    scored = run_score(worker, cfg, log)
    runs = runner.work()
    return {"flushed": len(sent), **scored, "worked": [(r["candidate"]["id"], (r.get("complete") or {}).get("state"))
                                                       for r in runs]}


def loop(cfg):
    worker = Worker.from_config(cfg)
    runner = Runner(cfg, worker, Gateway.from_config(cfg), log)
    backoff = cfg["loop_interval_s"]
    while True:
        if config.stopped():
            heartbeat("stopped", stop_file=str(config.path("STOP")))
            time.sleep(60)
            continue
        try:
            cfg = config.load()
            runner.cfg = cfg
            summary = cycle(cfg, worker, runner)
            heartbeat("ok", **summary)
            log(f"cycle ok {summary}")
            backoff = cfg["loop_interval_s"]
            wait = cfg["loop_interval_s"]
        except config.Stopped:
            heartbeat("stopped", stop_file=str(config.path("STOP")))
            wait = 60
        except WorkerUnavailable as e:
            backoff = min(backoff * 2, cfg["backoff_max_s"])
            heartbeat("worker_unavailable", error=str(e)[:300], retry_in_s=backoff)
            log(f"worker unavailable, retry in {backoff}s: {e}")
            wait = backoff
        except Exception as e:  # a crash in one cycle must not kill the daemon; launchd would restart-loop it
            heartbeat("error", error=f"{type(e).__name__}: {e}"[:300])
            log("cycle error\n" + traceback.format_exc())
            wait = cfg["loop_interval_s"]
        time.sleep(wait)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="discovery-runner")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("score")
    sub.add_parser("work")
    sub.add_parser("loop")
    sub.add_parser("flush")
    c = sub.add_parser("calibrate")
    c.add_argument("--apply", action="store_true", help="write the suggested threshold to config.json")
    c.add_argument("--archive", help="x-bookmarks-eval data.json: use its unsaved replies as sightings when the "
                                     "Worker has none yet (harder negatives than random timeline posts)")
    sp = sub.add_parser("seed-positives", help="POST Sam's saves from an x-bookmarks-eval archive to /positives")
    sp.add_argument("archive")
    sub.add_parser("status")
    st = sub.add_parser("stop")
    st.add_argument("--kill-preps", action="store_true", help="also end running codex preps this runner started")
    sub.add_parser("stop-preps", help="end running codex preps this runner started (recorded pids only)")
    sub.add_parser("resume")
    a = ap.parse_args(argv)
    cfg = config.load()
    if a.cmd == "stop":
        config.path("STOP").write_text(f"stopped at {config.now_iso()}\n")
        print(f"wrote {config.path('STOP')}; the loop halts at its next step")
        if a.kill_preps:
            stop_preps()
        return
    if a.cmd == "stop-preps":
        return print(json.dumps(stop_preps()))
    if a.cmd == "resume":
        config.path("STOP").unlink(missing_ok=True)
        return print("removed STOP")
    if a.cmd == "status":
        hb = config.path("logs", "heartbeat")
        return print(json.dumps({"stopped": config.stopped(), "heartbeat": hb.read_text().strip() if hb.exists() else None,
                                 "usage_today": {k: config.used(k) for k in ("deep_reads", "codex_preps",
                                                                             "unbookmarked_candidates")},
                                 "outbox": len(list(config.path("outbox", "x").parent.glob("*.json"))),
                                 "calls_today": summarize_calls(since=config.today())}, indent=1))
    if a.cmd == "loop":
        return loop(cfg)
    if config.stopped():
        sys.exit(f"{config.path('STOP')} exists; run `discovery-runner resume` first")
    worker = Worker.from_config(cfg)
    if a.cmd == "score":
        print(json.dumps(run_score(worker, cfg, log)))
    elif a.cmd == "work":
        runs = Runner(cfg, worker, Gateway.from_config(cfg), log).work()
        for r in runs:
            print(r["candidate"]["id"], json.dumps(r.get("complete")))
    elif a.cmd == "flush":
        print(json.dumps(flush_outbox(worker)))
    elif a.cmd == "seed-positives":
        d = json.loads(open(a.archive).read())
        items = [{"id": pid, "text": p["text"], "author_handle": p["author_handle"], "source": f"bookmark:{a.archive}"}
                 for pid, p in d["posts"].items() if p.get("text")]
        print(json.dumps(worker._call("POST", "/positives", {"items": items})))
    elif a.cmd == "calibrate":
        sightings, source = None, "x_posts scored by this runner"
        if a.archive:
            d = json.loads(open(a.archive).read())
            saved = set(d["posts"])
            sightings = [{"id": r["id"], "text": r["text"], "author_handle": r["author_handle"], "urls": [],
                          "exclude_id": r["root_id"]}
                         for r in d["replies"] if r["id"] not in saved and r.get("text")]
            source = f"unsaved replies under saves in {a.archive}"
        res = calibrate(worker, cfg, sightings=sightings, sighting_source=source)
        config.path("state", "calibration.json").write_text(json.dumps(res, indent=1))
        if a.apply and "suggested_threshold" in res:
            f = config.path("config.json")
            on_disk = json.loads(f.read_text())
            on_disk["score_threshold"] = res["suggested_threshold"]
            f.write_text(json.dumps(on_disk, indent=2) + "\n")
        print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
