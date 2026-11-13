"""Stage-a batch runs against `wrangler dev`: queue an archive's saves, run
kworker until the queue is empty, then write the per-save report.

  python -m acceptance.batch nov12 --repo X-BOOKMARKS-EVAL --worktree ARCHIVE-WORKTREE --out FILE
  python -m acceptance.batch oct26 --archive X-BOOKMARKS-EVAL --out FILE

Both run with KWORKER_NO_X=1: X posts come from the archive's fxtwitter
records and media from its downloads, so nothing competes with the archive
lead's fetch queue. Both archives are only read.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path

from acceptance.run import KWORKER, kworker_env

PY = KWORKER / ".venv" / "Scripts" / "python.exe"


def sh(args: list[str], env: dict, log: Path) -> str:
    with log.open("a", encoding="utf-8") as f:
        f.write(f"\n$ {' '.join(args)}  ({time.strftime('%H:%M:%S')})\n")
        f.flush()
        # Lines go to the log as they come, so a long run can be followed.
        p = subprocess.Popen(args, cwd=KWORKER, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8")
        out = []
        for line in p.stdout:
            out.append(line)
            f.write(line)
            f.flush()
        code = p.wait()
    if code not in (0, 1):
        raise SystemExit(f"{args[2:4]} exited {code}; see {log}")
    return "".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("which", choices=["nov12", "oct26"])
    ap.add_argument("--base", default="http://127.0.0.1:8871")
    ap.add_argument("--repo", type=Path)
    ap.add_argument("--worktree", type=Path)
    ap.add_argument("--archive", type=Path)
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()
    log = a.out.with_suffix(".log")
    env = kworker_env(a.base) | {"KWORKER_NO_X": "1"}
    t0 = time.monotonic()
    if a.which == "nov12":
        wt = a.worktree / "archive" / "2026-11-12"
        env["KWORKER_MEDIA_DIRS"] = str(wt / "media")
        out = sh([str(PY), "-m", "kworker", "enqueue-nov12", "--repo", str(a.repo), "--worktree", str(a.worktree)], env, log)
        snap = Path(json.loads(out.strip().splitlines()[-1])["snapshot"])
        env["KWORKER_X_CACHE"] = str(snap / "archive" / "2026-11-12" / "raw" / "fxtwitter")
        sh([str(PY), "-m", "kworker", "run"], env, log)
        report = ["--nov12", "--nov12-snapshot", str(snap)]
    else:
        sh([str(PY), "-m", "kworker", "enqueue-archive", "--archive", str(a.archive), "--all"], env, log)
        sh([str(PY), "-m", "kworker", "run"], env, log)
        report = ["--oct26", str(a.archive)]
    wall = round(time.monotonic() - t0, 1)
    sh([str(PY), "-m", "acceptance.scale", "--base", a.base, "--out", str(a.out), *report], env, log)
    with log.open("a", encoding="utf-8") as f:
        f.write(f"\nBATCH DONE {a.which} wall_s={wall}\n")


if __name__ == "__main__":
    main()
