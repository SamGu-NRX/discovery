"""python -m kworker <command>

  run [--forever] [--kinds save,link,...]   claim and run jobs until none is left
  enqueue-archive --archive PATH (--ids ID,ID | --acceptance) [--again]
                                            snapshot saves from x-bookmarks-eval and queue them
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import config, jobs
from .archive import Archive
from .ctx import job_ctx


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="kworker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--forever", action="store_true")
    r.add_argument("--kinds", default=",".join(jobs.KINDS))
    e = sub.add_parser("enqueue-archive")
    e.add_argument("--archive", required=True, type=Path)
    g = e.add_mutually_exclusive_group(required=True)
    g.add_argument("--ids")
    g.add_argument("--acceptance", action="store_true")
    e.add_argument("--again", action="store_true", help="requeue saves already done, to rebuild them from the caches")
    a = ap.parse_args(argv)
    cfg = config.load()

    if a.cmd == "run":
        kinds = a.kinds.split(",")
        unknown = set(kinds) - set(jobs.KINDS)
        if unknown:
            ap.error(f"--kinds has unknown kinds {sorted(unknown)}; known: {','.join(jobs.KINDS)}")
        done = jobs.drain(cfg, kinds, forever=a.forever)
        print(json.dumps({"jobs": len(done), "failed": sum(1 for d in done if d["state"] == "failed")}))
        return 1 if any(d["state"] == "failed" for d in done) else 0

    if a.cmd == "enqueue-archive":
        if a.acceptance:
            sys.path.insert(0, str(Path(__file__).parents[1]))
            from acceptance.saves import SAVES

            ids = list(SAVES)
        else:
            ids = [i.strip() for i in a.ids.split(",") if i.strip()]
        arch = Archive(a.archive)
        with job_ctx(cfg) as ctx:
            for pid in ids:
                sha = ctx.api.put_json(arch.expansion(pid))
                job = jobs.enqueue(ctx, "save", pid, {"post_id": pid, "expansion_sha": sha}, again=a.again)
                print(f"save {pid}: job {job['id']} {job['state']} (runs {job.get('runs')})")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
