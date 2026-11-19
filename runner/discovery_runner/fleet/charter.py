"""The charter: the block every new Claude and Codex session starts with, at most 40 lines.

It holds, in order: the sam-mode skill's lines (once that skill exists), the current repo's decisions, then
Sam's global decisions, newest first. A repo's decisions count only in a repo Sam owns: one whose
`.agents/topology.json` lists SamGu-NRX as an owner and whose `origin` remote matches the file, so a
cloned third-party repo can't put its "decisions" in front of a session as Sam's. A decision counts only when its entry says `Status: confirmed`, in the
template SecondBrain's decision log uses (`### YYYY-MM-DD — Title`, then `- **Status:**`, `- **Decision:**`).

It reaches a session three ways: Claude Code's SessionStart hook and Codex's (`fleet charter --hook claude`
or `--hook codex` prints the hook's JSON), and a pointer block between markers in a CLAUDE.md or AGENTS.md
(`fleet charter --publish <file>`), for hosts without hooks.
"""
import datetime as dt
import json
import re
from pathlib import Path

LINE_BUDGET = 40
SAM_MODE = Path("~/.agent-config/skills/sam-mode/SKILL.md")
GLOBAL_DECISIONS = [Path("~/SecondBrain/decisions/decision-log.md")]
REPO_DECISIONS = ("docs/DECISIONS.md", ".agents/decisions.md")
BEGIN, END = "<!-- fleet-charter:begin -->", "<!-- fleet-charter:end -->"
ENTRY = re.compile(r"^###\s+(\d{4}-\d{2}-\d{2})\s+[—-]+\s+(.+)$")


def decisions(path) -> list[dict]:
    f = Path(path).expanduser()
    if not f.exists():
        return []
    out, cur = [], None
    for line in f.read_text().splitlines():
        m = ENTRY.match(line.strip())
        if m:
            cur = {"date": m.group(1), "title": m.group(2).strip(), "status": None, "decision": "", "source": str(f)}
            out.append(cur)
            continue
        if cur is None:
            continue
        s = re.match(r"^-\s+\*\*(\w[\w /]*):\*\*\s*(.*)$", line.strip())
        if s:
            key = s.group(1).lower()
            if key == "status":
                cur["status"] = s.group(2).strip().lower()
            elif key == "decision":
                cur["decision"] = s.group(2).strip()
    return [d for d in out if d["status"] == "confirmed" and d["decision"] and d["date"] != "YYYY-MM-DD"]


def _sam_mode(path) -> list[str]:
    f = Path(path).expanduser()
    if not f.exists():
        return []
    body = f.read_text().split("\n---\n", 2)[-1] if f.read_text().startswith("---") else f.read_text()
    return [l for l in body.splitlines() if l.strip()]


def build(cwd=None, global_files=None, sam_mode=SAM_MODE, budget=LINE_BUDGET) -> str:
    lines = [f"Charter ({dt.date.today().isoformat()}): Sam's standing decisions. Follow them; a newer one wins."]
    lines += _sam_mode(sam_mode)
    repo = _repo_root(cwd) if cwd else None
    repo_ds = [d for name in REPO_DECISIONS for d in decisions(repo / name)] if repo and sams_repo(repo) else []
    global_ds = [d for f in (global_files if global_files is not None else GLOBAL_DECISIONS) for d in decisions(f)]
    for title, ds in ((f"Decisions in {repo.name}:" if repo else None, repo_ds), ("Global decisions:", global_ds)):
        if not ds:
            continue
        lines.append(title)
        lines += [f"- {d['date']} {d['title']}: {d['decision']}" for d in sorted(ds, key=lambda d: d["date"], reverse=True)]
    if len(lines) > budget:
        lines = lines[:budget - 1] + [f"(older decisions omitted to stay within {budget} lines)"]
    return "\n".join(lines)


OWNER = "SamGu-NRX"


def sams_repo(repo: Path) -> bool:
    from .envelope import _git, _same_remote, load_topology
    topo = load_topology(repo)
    actual = _git(repo, "remote", "get-url", "origin")
    return bool(topo and OWNER in (topo.get("owners") or []) and actual and topo.get("origin")
                and _same_remote(actual, topo["origin"]))


def _repo_root(cwd) -> Path | None:
    p = Path(cwd).expanduser().resolve()
    for d in (p, *p.parents):
        if (d / ".git").exists():
            return d
    return None


def hook_output(block: str) -> str:
    """SessionStart hook JSON. Claude Code and Codex both read `additionalContext` from this shape."""
    return json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": block}})


def publish(block: str, target) -> Path:
    """Write the block between markers in a CLAUDE.md or AGENTS.md, replacing the previous one."""
    f = Path(target).expanduser()
    text = f.read_text() if f.exists() else ""
    section = f"{BEGIN}\n{block}\n{END}"
    if BEGIN in text and END in text:
        text = text[:text.index(BEGIN)] + section + text[text.index(END) + len(END):]
    else:
        text = (text.rstrip("\n") + "\n\n" if text else "") + section + "\n"
    f.write_text(text)
    return f
