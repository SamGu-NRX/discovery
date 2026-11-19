"""Receipts: one line per thing the runner checked itself, in ~/.discovery/logs/receipts.jsonl.

Levels, weakest first:
- `claimed`: an agent said so. The runner records the claim and nothing else.
- `observed`: the runner read T3's run status, the requested and executed models, and the worktree head.
- `verified`: the runner ran the acceptance command itself and kept the exit code and last 20 lines.

Flags:
- `mismatch`: a model that executed differs from the one requested.
- `uncertain`: a launch or send whose answer was lost (launcher.py writes these).
- `stale`: not rechecked since the Mac slept (computed when read, from the watcher's gaps).

Done means `verified` with no flag. Every field is written by code; `for` is Sam's own ask, quoted.
"""
import json
import subprocess

from .. import config
from . import probe

LEVELS = ("claimed", "observed", "verified")


def executed_models(con, run_id) -> list[str]:
    """Models T3's provider turns report for a run. Empty when the provider reports none (Muse,
    Antigravity and some Codex turns do not), which reads as "model unknown", never as a match."""
    models = []
    for (p,) in con.execute(
            f"SELECT pt.payload_json FROM {probe.ATTEMPTS} a JOIN {probe.PROVIDER_TURNS} pt"
            " ON pt.run_attempt_id = a.attempt_id WHERE a.run_id = ?", (run_id,)):
        d = json.loads(p)
        for m in [d.get("model"), *((d.get("turnTokenUsage") or {}).get("models") or [])]:
            if m and m not in models:
                models.append(m)
    return models


def _norm(model: str) -> str:
    # "custom:cliproxy:claude-opus-5-5", "anthropic/claude-opus-5-5" and "claude-opus-5-5[1m]" name one model.
    m = model.rsplit(":", 1)[-1].rsplit("/", 1)[-1]
    return m.split("[", 1)[0].strip().lower()


def model_flags(requested: str | None, executed: list[str]) -> list[str]:
    """["mismatch"] when any executed model differs from the requested one. No executed model is not a
    mismatch; the receipt shows it as "model unknown" instead."""
    if executed and any(_norm(e) != _norm(requested or "") for e in executed):
        return ["mismatch"]
    return []


def _git_head(path):
    if not path:
        return None
    r = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def observe(con, run_id, ask: str, key: str | None = None) -> dict:
    run = con.execute(
        f"SELECT r.thread_id, r.status, json_extract(r.payload_json, '$.modelSelection.model'),"
        f" json_extract(t.payload_json, '$.worktreePath') FROM {probe.RUNS} r JOIN {probe.THREADS} t"
        " ON t.thread_id = r.thread_id WHERE r.run_id = ?", (run_id,)).fetchone()
    if run is None:
        raise LookupError(f"run {run_id} is not in T3's database")
    thread_id, status, requested, worktree = run
    executed = executed_models(con, run_id)
    return {"ts": config.now_iso(), "level": "observed", "for": ask, "key": key, "thread_id": thread_id,
            "run_id": run_id, "status": status, "requested_model": requested, "executed_models": executed or "model unknown",
            "worktree": worktree, "head": _git_head(worktree), "flags": model_flags(requested, executed)}


def verify(receipt: dict, command: list[str], cwd, timeout=1800) -> dict:
    """Run the acceptance command in `cwd` and keep its exit code and last 20 lines of output."""
    try:
        p = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        code, out = p.returncode, (p.stdout + p.stderr)
    except subprocess.TimeoutExpired as e:
        code, out = None, f"timed out after {timeout}s\n{(e.stdout or b'')[-2000:]!r}"
    return {**receipt, "ts": config.now_iso(), "level": "verified" if code == 0 else receipt["level"],
            "command": command, "exit_code": code, "tail": out.splitlines()[-20:], "head": _git_head(cwd)}


def claimed(ask: str, thread_id: str, claim: str, key: str | None = None) -> dict:
    return {"ts": config.now_iso(), "level": "claimed", "for": ask, "key": key, "thread_id": thread_id,
            "claim": claim, "flags": []}


def write(receipt: dict) -> dict:
    with open(config.path("logs", "receipts.jsonl"), "a") as f:
        f.write(json.dumps(receipt) + "\n")
    return receipt


def read_all() -> list[dict]:
    f = config.path("logs", "receipts.jsonl")
    return [json.loads(l) for l in f.read_text().splitlines() if l.strip()] if f.exists() else []


def flags_now(receipt: dict, gaps: list[list[str]]) -> list[str]:
    """The receipt's flags plus `stale` when the Mac slept after it was written."""
    stale = any(start >= receipt["ts"] for start, _ in gaps)
    return receipt.get("flags", []) + (["stale"] if stale else [])


def done(receipt: dict, gaps=()) -> bool:
    return receipt["level"] == "verified" and receipt.get("exit_code") == 0 and not flags_now(receipt, list(gaps))
