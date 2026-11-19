"""`discovery-runner fleet <command>`. See runner/README.md, "Fleet"."""
import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import time
import traceback
from pathlib import Path

from .. import config
from . import charter, envelope, find, probe, receipts, replay, watch

GO = re.compile(r"^\s*go((?:\s+\d+)+)\s*$", re.I)


def log(msg):
    print(f"{config.now_iso()} fleet {msg}", flush=True)


def heartbeat(status, **extra):
    config.path("logs", "fleet-heartbeat").write_text(json.dumps({"ts": config.now_iso(), "status": status, **extra}) + "\n")


def _con(cfg):
    con = probe.connect(cfg["t3_state_db"])
    probe.check_schema(con)
    return con


class Outbox:
    """Card batches found but not yet accepted by T3, oldest first. A batch keeps its cards, and so its key,
    until T3 accepts it, so a failed post loses no card and a retry is the same write."""

    def __init__(self):
        self.f = config.path("state", "fleet-outbox.json")

    def load(self) -> list[list[dict]]:
        return json.loads(self.f.read_text()) if self.f.exists() else []

    def save(self, batches):
        tmp = self.f.with_suffix(".tmp")
        tmp.write_text(json.dumps(batches, indent=1))
        tmp.replace(self.f)


def record_cards(cards):
    with open(config.path("logs", "fleet-cards.jsonl"), "a") as f:
        for c in cards:
            f.write(json.dumps({"ts": config.now_iso(), **c}) + "\n")


def drafts() -> dict:
    """Drafted launches waiting for Sam. `last_go` starts when the file is made, so a "go" typed before then
    never counts."""
    f = config.path("state", "fleet-drafts.json")
    return json.loads(f.read_text()) if f.exists() else {"next": 1, "items": {}, "last_go": _now_ms()}


def _now_ms():
    return watch.iso(dt.datetime.now(dt.timezone.utc))  # T3's own format, so times compare as strings


def save_drafts(d):
    config.path("state", "fleet-drafts.json").write_text(json.dumps(d, indent=1))


def take_go(con, operator_thread, d) -> list[tuple[int, str]]:
    """(number, time) for each draft Sam named in a "go 2 4" he typed in the Operator thread, in order."""
    out = []
    for m in probe.sam_messages_after(con, operator_thread, d["last_go"], limit=50):
        g = GO.match(m["text"])
        if g:
            out += [(int(x), m["created_at"]) for x in g.group(1).split()]
        d["last_go"] = m["created_at"]
    return out


def run_drafts(cfg, con, launcher, d) -> list[dict]:
    """Show each new draft in the Operator thread, then launch the ones Sam approved after seeing them."""
    op = cfg["fleet_operator_thread"]
    for n, item in d["items"].items():
        if item.get("posted_at"):
            continue
        env = envelope.Envelope(**item["envelope"])
        key = "fk-draft-" + env.key()[3:]
        text = (f"Draft {n}: {envelope.title(env)}\n\n{envelope.render_brief(env)}\nReply `go {n}` to launch it."
                f"\n\n{launcher_mark()}{key}")
        rec = launcher.write("draft", key, "t3_thread_send", {"threadId": op, "message": text, "mode": "queue"},
                             thread_id=op)
        if rec["state"] == "accepted":
            item["posted_at"] = _now_ms()
    launched = []
    for n, said_at in take_go(con, op, d):
        item = d["items"].get(str(n))
        if item is None or not item.get("posted_at") or said_at <= item["posted_at"]:
            log(f"go {n}: no draft {n} had been shown when Sam typed it")
            continue
        try:
            launched.append(launcher.launch(envelope.Envelope(**item["envelope"]), approved_by_go=True))
            d["items"].pop(str(n))
        except envelope.Refused as e:
            item["refused"] = str(e)  # the draft stays; Sam can type "go" again once the reason clears
            key = f"fk-note-{n}-" + hashlib.sha256(f"{said_at}\n{e}".encode()).hexdigest()[:16]
            launcher.write("note", key, "t3_thread_send",
                           {"threadId": op, "mode": "queue",
                            "message": f"Draft {n} was not launched: {e}\n\n{launcher_mark()}{key}"},
                           thread_id=op)
    return launched


def launcher_mark():
    from .launcher import MARK
    return MARK


def cycle(cfg, con, watcher, launcher, outbox):
    cards = watcher.cycle(commit=False)
    if watcher.errors:
        log(f"watcher skipped {len(watcher.errors)} runs: {watcher.errors[:3]}")
    if cards:
        record_cards(cards)
        log(f"{len(cards)} new cards: {[c['key'] for c in cards]}")
    batches = outbox.load()
    if launcher is not None and cards:
        batches.append(cards)
        outbox.save(batches)  # before the watcher records them as seen, so a crash re-finds them
    watcher.commit()
    if launcher is not None:
        while batches:
            posted = launcher.post_cards(cfg["fleet_operator_thread"], batches[0])
            if not posted or posted["state"] != "accepted":
                break  # held by the daily card cap
            batches.pop(0)
            outbox.save(batches)
    launched, stopped = [], []
    if launcher is not None and launcher.mode == "full":
        stopped = launcher.enforce_tree_budget()
        d = drafts()
        try:
            launched = run_drafts(cfg, con, launcher, d)
        finally:
            save_drafts(d)
    return {"cards": len(cards), "unposted": sum(len(b) for b in batches), "launched": len(launched),
            "stopped": stopped,
            "scan_rows": watcher.last_scan_rows}


def loop(cfg):
    from .launcher import Launcher  # only the loop needs the write path
    con, next_schema_check = None, 0.0
    while True:
        if config.stopped():
            heartbeat("stopped", stop_file=str(config.path("STOP")))
            time.sleep(60)
            continue
        try:
            cfg = config.load()
            if con is None or time.time() >= next_schema_check:
                con = _con(cfg)
                next_schema_check = time.time() + 3600
                watcher = watch.Watcher(con, stall_min=cfg["fleet_stall_min"],
                                        exclude_threads={cfg["fleet_operator_thread"]} - {None})
                launcher = None
                if cfg["fleet_operator_thread"]:
                    launcher = Launcher(con, mode=cfg["fleet_mode"], log=log)
                else:
                    log("fleet_operator_thread is not set; cards are kept in logs/fleet-cards.jsonl only")
            if launcher is not None:
                launcher.mode = cfg["fleet_mode"]  # a mode change applies at the next cycle, not the next hour
            summary = cycle(cfg, con, watcher, launcher, Outbox())
            heartbeat("ok", **summary)
        except probe.SchemaChanged as e:
            log(f"WATCHER DISABLED: {e}")
            heartbeat("disabled", error=str(e)[:500])
            con, next_schema_check = None, time.time() + 3600
            time.sleep(3600)
            continue
        except Exception as e:  # one bad cycle must not kill the job; launchd would restart-loop it
            heartbeat("error", error=f"{type(e).__name__}: {e}"[:300])
            log("cycle error\n" + traceback.format_exc())
        time.sleep(cfg["fleet_interval_s"])


def main(argv):
    ap = argparse.ArgumentParser(prog="discovery-runner fleet")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe", help="day 0: prove every read against live T3 and time a full poll")
    sub.add_parser("loop", help="the fleet-loop launchd job: one watcher cycle every fleet_interval_s")
    sub.add_parser("cycle", help="one watcher cycle that prints cards and posts nothing")
    rp = sub.add_parser("replay", help="day-1 check: replay the last days through the watcher")
    rp.add_argument("--days", type=int, default=14)
    rp.add_argument("--full", action="store_true", help="print every set member")
    fd = sub.add_parser("find", help="which thread was that?")
    fd.add_argument("question", nargs="?")
    fd.add_argument("--eval", help="a JSON file of labeled cases; prints the score")
    fd.add_argument("-k", type=int, default=3)
    ch = sub.add_parser("charter", help="print the session-start block")
    ch.add_argument("--cwd", default=".")
    ch.add_argument("--hook", choices=["claude", "codex"])
    ch.add_argument("--decisions", action="append", help="decision-log files (default: SecondBrain's)")
    ch.add_argument("--publish", help="write the block between markers in this CLAUDE.md or AGENTS.md")
    ob = sub.add_parser("observe", help="write an observed receipt for a T3 run")
    ob.add_argument("run_id")
    ob.add_argument("--ask", required=True, help="Sam's ask, quoted")
    dr = sub.add_parser("draft", help="queue a drafted launch envelope (JSON) for Sam's go")
    dr.add_argument("envelope")
    sub.add_parser("login", help="sign the runner in to T3 at Auto (Sam approves in T3's page)")
    a = ap.parse_args(argv)
    cfg = config.load()
    if a.cmd == "login":
        from .launcher import login
        return print(f"saved the T3 sign-in to {login()}")
    if a.cmd == "loop":
        return loop(cfg)
    if a.cmd == "charter":
        block = charter.build(a.cwd, global_files=a.decisions)
        if a.publish:
            return print(f"wrote {charter.publish(block, a.publish)}")
        return print(charter.hook_output(block) if a.hook else block)
    con = _con(cfg)
    if a.cmd == "probe":
        print(json.dumps(probe.probe(con), indent=1, default=str))
    elif a.cmd == "cycle":
        w = watch.Watcher(con, state=watch.MemoryState(), since=dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=24))
        cards = w.cycle()
        print(watch.render(cards, link=lambda tid, title: f"{title} ({tid})") if cards else "no abnormal ends in 24 h")
    elif a.cmd == "replay":
        res = replay.run(con, a.days)
        if not a.full:
            res = {k: v for k, v in res.items() if not isinstance(v, list)} | {"healthy_flags": res["healthy_flags"]}
        print(json.dumps(res, indent=1))
        sys.exit(0 if res["pass"] else 1)
    elif a.cmd == "find":
        if a.eval:
            res = find.evaluate(con, json.loads(Path(a.eval).read_text()), k=a.k)
            print(json.dumps(res, indent=1))
        else:
            for r in find.search(con, a.question, k=a.k):
                print(f"{r['title']}  ({r['thread_id']}, updated {r['updated_at'][:10]}"
                      f"{', archived' if r['archived'] else ''})")
    elif a.cmd == "observe":
        print(json.dumps(receipts.write(receipts.observe(con, a.run_id, a.ask)), indent=1))
    elif a.cmd == "draft":
        env = envelope.Envelope(**json.loads(Path(a.envelope).read_text()))
        envelope.check(env, con)
        d = drafts()
        n = d["next"]
        d["items"][str(n)] = {"envelope": env.__dict__}
        d["next"] = n + 1
        save_drafts(d)
        print(f"draft {n} queued; the loop shows it in the Operator thread, and Sam replies \"go {n}\" to launch it")
