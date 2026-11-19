"""Local paths, the config file, the emergency stop and the daily budgets.

Everything the runner keeps lives under ~/.discovery (override with DISCOVERY_HOME, which the tests
use to get a throwaway home). The config file is created with the defaults below on first run; the
director edits it by hand. Budgets are counted per UTC day in state/usage.json.
"""
import datetime as dt
import fcntl
import json
import os
from contextlib import contextmanager
from pathlib import Path

DEFAULTS = {
    "worker_url": "https://discovery-watcher.sgu07966.workers.dev",
    "token_file": "~/.agent-secrets/discovery-runner-token",
    "gateway_url": "http://127.0.0.1:8317/v1/chat/completions",
    "gateway_keychain_service": "com.samgu.agentsetup.fable-advisor.cliproxy-client",
    "models": {"triage": "gpt-6-luna", "deep_read": "gpt-6.1-sol", "judge": "gpt-6-astra", "prep": "gpt-6.1-sol"},
    "judge_effort": "low",
    # Contract starting value. `discovery-runner calibrate` measures it on Sam's saves and
    # records the numbers in state/calibration.json; it does not rewrite this value.
    "score_threshold": 0.75,
    "session_top_fraction": 0.02,
    "author_prior": 0.02,
    "unbookmarked_candidates_per_day": 15,
    # Runaway guards, not budgets. Measured on two full 19-candidate rounds (Nov 4, rounds 5 and 6): 24 deep
    # reads each (at most 2 per item) and 12 codex preps each, capped, on 8 to 9 items (at most 2 per item);
    # uncapped demand was about 14 preps. Daily inflow is at most about 25 candidates: 15 unbookmarked (the
    # contract cap), about 3.5 saves a day (69 saves Oct 7 to 26), and a few watcher events. 25 x 2 = 50 deep
    # reads and preps, so 60 and 50 stop a loop (round 6's re-claim loop) without ever binding on real work.
    "max_deep_reads_per_day": 60,
    "max_codex_preps_per_day": 50,
    # Prep runs while the Codex pool has headroom, read from AgentSetup's usage snapshot (written by
    # scripts/codex-usage.mjs, a read-only quota probe). On Nov 4 at 21:28Z: 6 of 13 accounts usable at 0-39%
    # of their weekly window; a full round used about 0.7-0.8M codex tokens. Constrained means fewer than
    # pool_min_usable_accounts accounts below pool_weekly_ceiling_pct.
    "codex_usage_snapshot": "~/Library/Application Support/AgentSetup/codex-usage-latest.json",
    "pool_weekly_ceiling_pct": 90,
    "pool_min_usable_accounts": 1,
    "prep_timeout_s": 600,
    "prep_scratch_mb": 200,
    "claim_limit": 3,
    "claim_ttl_s": 2700,
    "loop_interval_s": 600,
    "backoff_max_s": 3600,
    "defer_uncaptured_thread_h": 6,
    "dedupe_days": 14,
    "dedupe_cosine": 0.85,
    "coursework": {
        "course_codes": ["GOV 310L", "CS 311"],
        "paths": ["~/UT"],
        # Under ~/UT but not coursework: the resume and application sources the facts file cites.
        "path_exceptions": ["~/UT/Internship_Job_Hunt"],
        "domains": ["canvas.utexas.edu", "utexas.instructure.com", "utexas.zoom.us", "panopto"],
        "words": ["homework", "problem set", "canvas assignment"],
    },
    # Employer AI-use guidance pages, keyed by the employer's domain. Unknown employers get no
    # drafted essays (the conservative default); add a page here to let the check read it.
    "ai_guidance": {"anthropic.com": "https://www.anthropic.com/candidate-ai-guidance"},
    # Where repo names and relative paths in proposals are looked up, in order.
    "repo_roots": ["~/Programming Projects", "~/Startups/Curate", "~"],
    "second_brain": "~/SecondBrain",
    # Verified application facts (each with its source), used to fill non-essay form fields.
    "application_facts": "~/.claude/skills/application-letters/references/facts.md",
    "t3_state_db": "~/.t3/userdata/statev2.sqlite",
}


def home() -> Path:
    return Path(os.environ.get("DISCOVERY_HOME", "~/.discovery")).expanduser()


def path(*parts) -> Path:
    p = home().joinpath(*parts)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def load() -> dict:
    f = path("config.json")
    if not f.exists():
        f.write_text(json.dumps(DEFAULTS, indent=2) + "\n")
    cfg = json.loads(f.read_text())
    # Keys retired on Nov 4 (fixed daily budgets that starved items; see max_codex_preps_per_day) are dropped.
    for old in ("deep_reads_per_day", "codex_preps_per_day"):
        cfg.pop(old, None)
    unknown = set(cfg) - set(DEFAULTS)
    if unknown:
        raise ValueError(f"{f}: unknown config keys {sorted(unknown)}")
    return {**DEFAULTS, **cfg}


def stopped() -> bool:
    return path("STOP").exists()


class Stopped(Exception):
    """~/.discovery/STOP exists. Raised between steps so in-flight work halts at the next boundary."""


def check_stop():
    if stopped():
        raise Stopped(str(path("STOP")))


def today() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


@contextmanager
def _usage():
    f = path("state", "usage.json")
    with open(path("state", "usage.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = json.loads(f.read_text()) if f.exists() else {}
        yield data
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        tmp.replace(f)


def pool_headroom(cfg) -> dict:
    """Codex pool headroom from AgentSetup's snapshot: usable accounts below the weekly ceiling.

    A missing or day-old snapshot is "unknown", and unknown is not constrained: only measured shortage holds
    work back, and the runaway guard still bounds a day."""
    import datetime as _dt
    f = Path(cfg["codex_usage_snapshot"]).expanduser()
    if not f.exists():
        return {"state": "unknown", "reason": f"no snapshot at {f}"}
    data = json.loads(f.read_text())
    fresh = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=24)
    usable, sampled = 0, 0
    for acc in data.values():
        if not isinstance(acc, dict) or "sampledAt" not in acc:
            continue
        if parse_iso(acc["sampledAt"]) < fresh:
            continue
        sampled += 1
        weekly = next((w.get("usedPercent") for w in acc.get("windows") or [] if w.get("kind") == "secondary"), None)
        if acc.get("allowed") and not acc.get("limitReached") and (weekly is None or weekly < cfg["pool_weekly_ceiling_pct"]):
            usable += 1
    if not sampled:
        return {"state": "unknown", "reason": "no account sampled in the last 24 h"}
    return {"state": "constrained" if usable < cfg["pool_min_usable_accounts"] else "available",
            "usable_accounts": usable, "sampled_accounts": sampled}


def used(kind: str) -> int:
    with _usage() as u:
        return u.get(today(), {}).get(kind, 0)


def take(kind: str, limit: int, n: int = 1) -> bool:
    """Reserve n units of today's `kind` budget. False, and nothing reserved, when it would exceed `limit`."""
    with _usage() as u:
        day = u.setdefault(today(), {})
        if day.get(kind, 0) + n > limit:
            return False
        day[kind] = day.get(kind, 0) + n
        return True


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s) -> dt.datetime:
    """An ISO string, or epoch milliseconds (the deployed Worker's candidate timestamps)."""
    if isinstance(s, (int, float)):
        return dt.datetime.fromtimestamp(s / 1000, dt.timezone.utc)
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
