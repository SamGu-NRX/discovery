"""Sam's context for the models, assembled read-only from his machine.

Four parts, most stable first: the standing profile (runner/context/sam.md), confirmed Second Brain
notes, his git repos with each README's first lines, and his recent T3 thread titles as a "working on
now" signal. Second Brain counts an entry as confirmed only when it says so (AGENTS.md, Canonicality),
so only lines marked "Confirmed by Sam" and decision entries marked "Status: confirmed" are used.
"""
import datetime as dt
import json
import re
import sqlite3
from functools import lru_cache
from pathlib import Path

from .policy import coursework_hit

STANDING = Path(__file__).resolve().parent.parent / "context" / "sam.md"
CONFIRMED_DIRS = ("context", "decisions", "projects", "wiki")


def confirmed_notes(root):
    root = Path(root).expanduser()
    out = []
    for d in CONFIRMED_DIRS:
        for f in sorted((root / d).rglob("*.md")) if (root / d).exists() else []:
            text = f.read_text(errors="replace")
            for block in re.split(r"\n(?=#{2,3} |- )", text):
                if re.search(r"confirmed by sam|\*\*status:\*\*\s*confirmed", block, re.I):
                    out.append(f"- ({f.relative_to(root)}) {' '.join(block.split())[:600]}")
    return out


def _readme_head(repo: Path, chars=220):
    for name in ("README.md", "readme.md", "README"):
        f = repo / name
        if f.exists():
            lines = [l.strip() for l in f.read_text(errors="replace").splitlines()
                     if l.strip() and not l.startswith(("![", "<", "[!", "```", "|", "---"))]
            body = " ".join(l.lstrip("# ") for l in lines[:6])
            return body[:chars]
    return ""


def repos(roots, limit=40):
    """Main git checkouts (a .git directory, not a worktree's .git file), most recently touched first."""
    seen = []
    for r in roots:
        r = Path(r).expanduser()
        if r == Path.home():
            cands = [Path.home() / "AgentSetup"]
        else:
            cands = [p for p in r.iterdir() if p.is_dir()] if r.exists() else []
        seen += [p for p in cands if (p / ".git").is_dir()]
    seen.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [f"- {p.name} ({p}): {_readme_head(p)}" for p in seen[:limit]]


def t3_titles(db, days=14, limit=40):
    db = Path(db).expanduser()
    if not db.exists():
        return []
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT title, max(updated_at) FROM orchestration_v2_projection_threads"
            " WHERE deleted_at IS NULL AND updated_at >= ?"
            " AND coalesce(json_extract(payload_json, '$.lineage.relationshipToParent'), '') != 'subagent'"
            " GROUP BY title ORDER BY max(updated_at) DESC LIMIT ?", (since, limit)).fetchall()
    finally:
        con.close()
    return [f"- {t} ({u[:10]})" for t, u in rows]


@lru_cache(maxsize=1)
def _cached(hour, cfg_json):
    cfg = json.loads(cfg_json)
    parts = [STANDING.read_text()]
    notes = confirmed_notes(cfg["second_brain"])
    parts.append("## Confirmed Second Brain notes\n" + ("\n".join(notes) if notes else "(none marked confirmed)"))
    parts.append("## His git repos, most recently touched first (name, path, README opening)\n" +
                 "\n".join(repos(cfg["repo_roots"])))
    # Coursework titles are dropped so no model is nudged toward classes (policy: never touch coursework).
    titles = [t for t in t3_titles(cfg["t3_state_db"]) if not coursework_hit([t], cfg)]
    parts.append("## Working on now: his T3 thread titles from the last 14 days, newest first\n" + "\n".join(titles))
    return "\n\n".join(parts)


def sam_context(cfg):
    """Rebuilt at most once an hour per process."""
    return _cached(dt.datetime.now().strftime("%Y%m%d%H"), json.dumps(cfg, sort_keys=True))
