"""The launch envelope: every field a launch needs, checked before T3 is called.

A launch missing its repo, origin, route model, base branch or round is refused, naming each field. The
route's provider, model and effort must be one of the T3 targets `routes.json` lists for that route; the
repo must carry `.agents/topology.json` and an `origin` remote that matches it. Runtime mode is Auto or lower.

A drafted launch carries text, so it also needs Sam's words: `ask_verbatim` is a list of excerpts, each
naming the T3 messages it quotes, and each message must be one Sam typed (T3's `createdBy` is "user").
The pieces of an excerpt, split at `[...]`, must appear byte for byte in one of those messages, in order,
without overlapping, starting and ending on word edges, each at least two words long. That keeps a cut
from reordering Sam's words or slicing a word in half. It cannot stop a cut from leaving out a word that
mattered, which is why every cut stays visible as `[...]`. The rendered brief puts those words below a
divider, unchanged. The brief itself is written by the drafter and is not checked against Sam's words;
Sam reads it before he types "go".

An unattended template (`wrap`, `correct`) carries ids only, each checked against a pattern, and its title
and text are built from them.
"""
import hashlib
import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from . import probe

ROUTES = Path("~/.agent-config/claude/agent-references/routing/routes.json")
TEMPLATES = ("drafted", "wrap", "correct")
TEMPLATE_IDS = {"wrap": {"date": re.compile(r"\d{4}-\d{2}-\d{2}")},
                "correct": {"class_id": re.compile(r"[a-z0-9][a-z0-9-]{0,39}")}}
MODES_AT_OR_BELOW_AUTO = ("approval-required", "auto-accept-edits", "auto")
MAX_ROUND = 3
CUT = "[...]"
DIVIDER = "---"
VERBATIM_HEADER = "Sam's words, verbatim:"


class Refused(ValueError):
    def __init__(self, problems: dict[str, str]):
        self.problems = problems
        super().__init__("launch refused: " + "; ".join(f"{k}: {v}" for k, v in problems.items()))


@dataclass
class Envelope:
    template: str
    title: str = ""
    repo: str | None = None
    origin: str | None = None
    base_branch: str | None = None
    route: str | None = None
    provider: str | None = None
    model: str | None = None
    effort: str | None = None
    round: int | None = None
    runtime_mode: str = "auto"
    brief: str = ""
    ask_verbatim: list = field(default_factory=list)  # [{"text": str, "source_message_ids": [str]}]
    ids: dict = field(default_factory=dict)  # template ids: wrap(date), correct(class_id)

    def key(self) -> str:
        """Stable across retries: the same envelope always yields the same clientRequestId."""
        body = json.dumps(self.__dict__, sort_keys=True, ensure_ascii=False)
        return "fk-" + hashlib.sha256(body.encode()).hexdigest()[:24]


def load_routes(path=ROUTES) -> dict:
    return {r["key"]: r for r in json.loads(Path(path).expanduser().read_text())["routes"]}


def load_topology(repo) -> dict | None:
    f = Path(repo).expanduser() / ".agents" / "topology.json"
    return json.loads(f.read_text()) if f.exists() else None


def _git(repo, *args):
    r = subprocess.run(["git", "-C", str(Path(repo).expanduser()), *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def _same_remote(a: str, b: str) -> bool:
    def norm(u):
        u = u.strip().removesuffix(".git").removesuffix("/")
        return u.replace("git@github.com:", "https://github.com/").lower()
    return norm(a) == norm(b)


def check(env: Envelope, con=None, routes=None) -> None:
    """Raise Refused naming every field that fails. `con` is T3's database, for the verbatim check."""
    p = {}
    if env.template not in TEMPLATES:
        p["template"] = f"{env.template!r} is not one of {TEMPLATES}"
    for name in ("repo", "origin", "base_branch", "route", "round"):
        if getattr(env, name) in (None, ""):
            p[name] = "missing"
    if env.runtime_mode not in MODES_AT_OR_BELOW_AUTO:
        p["runtime_mode"] = f"{env.runtime_mode!r} is above Auto; the operator launches at Auto or lower"
    if env.round is not None and not (isinstance(env.round, int) and 1 <= env.round <= MAX_ROUND):
        p["round"] = f"round {env.round} is outside 1..{MAX_ROUND}; a fourth round needs Sam"
    if env.template in TEMPLATE_IDS:
        if env.brief or env.ask_verbatim or env.title:
            p["brief"] = f"an unattended {env.template} launch carries ids only, no text"
        want = TEMPLATE_IDS[env.template]
        if set(env.ids) != set(want) or not all(isinstance(env.ids[k], str) and rx.fullmatch(env.ids[k])
                                                 for k, rx in want.items()):
            p["ids"] = f"{env.template} takes exactly {sorted(want)}, each matching its pattern"
    if env.repo and "repo" not in p:
        repo = Path(env.repo).expanduser()
        topo = load_topology(repo) if repo.is_dir() else None
        actual = _git(repo, "remote", "get-url", "origin") if repo.is_dir() else None
        if not repo.is_dir() or _git(repo, "rev-parse", "--git-dir") is None:
            p["repo"] = f"{repo} is not a git repository"
        elif topo is None:
            p["repo"] = f"{repo}/.agents/topology.json is missing; the operator launches only into repos that declare one"
        elif actual is None:
            p["origin"] = f"{repo} has no origin remote"
        elif env.origin and not _same_remote(actual, env.origin):
            p["origin"] = f"{env.origin} does not match the repo's origin {actual}"
        elif not topo.get("origin"):
            p["repo"] = f"{repo}/.agents/topology.json declares no origin"
        elif env.origin and not _same_remote(topo["origin"], env.origin):
            p["origin"] = f"{env.origin} does not match topology.json's {topo['origin']}"
        if env.base_branch and repo.is_dir() and "repo" not in p and \
                _git(repo, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{env.base_branch}") is None and \
                _git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{env.base_branch}") is None:
            p["base_branch"] = f"{env.base_branch!r} is not a branch of {repo}"
    if env.route and "route" not in p:
        routes = routes if routes is not None else load_routes()
        r = routes.get(env.route)
        if r is None:
            p["route"] = f"{env.route!r} is not a route in routes.json"
        else:
            targets = [t for t in r["targets"].get("t3", []) if "provider" in t]
            if not any(t["provider"] == env.provider and t["model"] == env.model and t.get("effort") == env.effort
                       for t in targets):
                allowed = [f"{t['provider']}/{t['model']}/{t.get('effort')}" for t in targets] or ["none"]
                p["model"] = (f"{env.provider}/{env.model}/{env.effort} is not a T3 target of route {env.route!r};"
                              f" allowed: {', '.join(allowed)}")
    if env.template == "drafted":
        if not env.brief.strip():
            p["brief"] = "a drafted launch needs a brief"
        elif any(l.strip() == DIVIDER or VERBATIM_HEADER in l or "fleet-key:" in l for l in env.brief.splitlines()):
            p["brief"] = "the brief may not contain the divider, the verbatim header or a fleet-key line"
        if not env.ask_verbatim:
            p["ask_verbatim"] = "a drafted launch quotes Sam's words"
        elif con is None:
            p["ask_verbatim"] = "cannot check Sam's words without T3's database"
        else:
            bad = verbatim_problems(con, env.ask_verbatim)
            if bad:
                p["ask_verbatim"] = bad
    if p:
        raise Refused(p)


MIN_PIECE_WORDS = 2


WORD = re.compile(r"[^\W_]+(?:['\u2019\-_][^\W_]+)*")  # "can't" and "non-blocking" are one word each


def _splits_word(text: str, i: int) -> bool:
    return any(m.start() < i < m.end() for m in WORD.finditer(text))


def _find_on_word_edges(text: str, piece: str, start: int) -> int:
    i = text.find(piece, start)
    while i >= 0:
        if not _splits_word(text, i) and not _splits_word(text, i + len(piece)):
            return i
        i = text.find(piece, i + 1)
    return -1


def excerpt_in(text: str, excerpt: str) -> bool:
    """The excerpt's pieces appear in `text` in order, without overlap, on word edges."""
    raw = excerpt.split(CUT)
    # Only whitespace beside a cut may differ from Sam's text; the excerpt's own ends stay exact.
    pieces = [p.lstrip() if i else p for i, p in enumerate(raw)]
    pieces = [p.rstrip() if i < len(raw) - 1 else p for i, p in enumerate(pieces)]
    cut = len(pieces) > 1
    if not any(p.strip() for p in pieces) or (cut and any(len(p.split()) < MIN_PIECE_WORDS for p in pieces if p)):
        return False
    if not cut:
        return _find_on_word_edges(text, excerpt, 0) >= 0
    pos = 0
    for piece in (p for p in pieces if p):
        i = _find_on_word_edges(text, piece, pos)
        if i < 0:
            return False
        pos = i + len(piece)
    return True


def verbatim_problems(con, excerpts) -> str | None:
    for i, ex in enumerate(excerpts, 1):
        text = ex.get("text") or ""
        if not text.strip():
            return f"excerpt {i} is empty"
        sources = []
        for mid in ex.get("source_message_ids") or []:
            row = con.execute(f"SELECT payload_json FROM {probe.MESSAGES} WHERE message_id = ?", (mid,)).fetchone()
            if row is None:
                return f"excerpt {i}: message {mid} is not in T3"
            payload = json.loads(row[0])
            if not probe.typed_by_sam(payload, mid):
                return f"excerpt {i}: message {mid} was not typed by Sam"
            sources.append(payload.get("text") or "")
        if not sources:
            return f"excerpt {i} names no source message"
        if not any(excerpt_in(src, text) for src in sources):
            return (f"excerpt {i}: {text[:60]!r} is not Sam's words in order, on word edges, with at least "
                    f"{MIN_PIECE_WORDS} words around each cut")
    return None


def title(env: Envelope) -> str:
    if env.template == "wrap":
        return f"Nightly wrap {env.ids['date']}"
    if env.template == "correct":
        return f"Correct mistake class {env.ids['class_id']}"
    return env.title or "Operator launch"


def template_text(env: Envelope) -> str:
    if env.template == "wrap":
        return f"Run the nightly wrap for {env.ids['date']} as runner/README.md, Fleet, describes."
    if env.template == "correct":
        return f"Fix mistake class {env.ids['class_id']} at the highest level that works, as runner/README.md describes."
    raise Refused({"template": f"{env.template} has no template text"})


def quote(text: str) -> str:
    return "\n".join(">" if line == "" else f"> {line}" for line in text.split("\n"))


def unquote(block: str) -> str:
    return "\n".join(line[2:] if line.startswith("> ") else line[1:] for line in block.split("\n"))


def render_brief(env: Envelope) -> str:
    """The brief as written, then a divider, then Sam's excerpts quoted unchanged, one block each."""
    parts = [env.brief.rstrip("\n"), "", DIVIDER, "", VERBATIM_HEADER]
    for ex in env.ask_verbatim:
        parts += ["", quote(ex["text"])]
    return "\n".join(parts) + "\n"


def verbatim_section(brief: str) -> list[str]:
    """Recover the excerpts from a rendered brief, for the byte-for-byte test."""
    tail = brief.rsplit(f"\n{DIVIDER}\n\n{VERBATIM_HEADER}\n", 1)[1]
    blocks, cur = [], []
    for line in tail.rstrip("\n").split("\n"):
        if line.startswith(">"):
            cur.append(line)
        elif cur:
            blocks.append(unquote("\n".join(cur)))
            cur = []
    if cur:
        blocks.append(unquote("\n".join(cur)))
    return blocks
