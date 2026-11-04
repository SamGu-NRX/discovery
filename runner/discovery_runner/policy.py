"""Policy checks that run on every proposal before it is recorded (contract, Runner behavior).

Each check is a plain function with one correct answer for given inputs, so it can be tested without
a model. The model calls that feed them (classifying an employer's guidance page) live in pipeline.py.
"""
import json
import os
import re
import subprocess
import tomllib
from pathlib import Path
from urllib.parse import urlparse

from . import config
from .scoring import cos

# ---------------------------------------------------------------- employer AI-use guidance

ESSAY_KINDS = {"essay", "long_text", "free_text", "cover_letter", "statement"}


def apply_ai_policy(application, guidance):
    """Blank every essay field unless guidance explicitly allows AI drafting.

    application: {"employer", "fields": [{"name", "kind", "value", ...}]}
    guidance: {"url", "restricts_drafting": True|False|None, "quote"} or None. None (no page found)
    and restricts_drafting None (page unreadable or unclear) are treated as restricted: a drafted
    essay Sam submits against an employer's rule cannot be taken back, a blank one costs him minutes.
    Returns a new application with `ai_policy` describing what was done.
    """
    allowed = bool(guidance) and guidance.get("restricts_drafting") is False
    fields, blanked = [], []
    for f in application.get("fields", []):
        f = dict(f)
        if f.get("kind") in ESSAY_KINDS and not allowed:
            if f.get("value"):
                blanked.append(f["name"])
            f["value"] = ""
            f["left_to_sam"] = True
        fields.append(f)
    if not guidance:
        why = "No AI-use guidance page known for this employer; essays left to Sam."
    elif guidance.get("restricts_drafting") is None:
        why = f"AI-use guidance at {guidance.get('url')} could not be read clearly; essays left to Sam."
    elif guidance["restricts_drafting"]:
        why = f"{guidance.get('url')} limits AI drafting (\"{guidance.get('quote', '')[:160]}\"); essays left to Sam."
    else:
        why = f"{guidance.get('url')} allows AI drafting; essay drafts kept for Sam to edit."
    return {**application, "fields": fields, "ai_policy": {"essays_drafted": allowed, "blanked": blanked, "why": why,
                                                           "guidance_url": (guidance or {}).get("url")}}


def guidance_url(employer_domain, cfg):
    d = (employer_domain or "").lower().removeprefix("www.")
    for dom, url in cfg["ai_guidance"].items():
        if d == dom or d.endswith("." + dom):
            return url
    return None


# ---------------------------------------------------------------- live-state verification

# Read-only checks never open these, even to answer yes or no.
DENY = [Path(p).expanduser() for p in ("~/.agent-secrets", "~/.ssh", "~/.gnupg", "~/Library/Keychains", "~/.aws",
                                       "~/.config/gh", "~/.netrc")]
CHECKS = {"path_exists", "path_absent", "file_contains", "file_lacks", "repo_exists", "config_equals"}


def _resolve(p, roots):
    """An absolute or ~ path as given; a relative path is tried under each known repo root."""
    p = os.path.expanduser(p.strip())
    if os.path.isabs(p):
        return [Path(p)]
    return [Path(r).expanduser() / p for r in roots]


def _denied(p: Path):
    rp = p.expanduser().resolve()
    return any(rp == d or d in rp.parents for d in DENY)


def _read(p: Path, limit=2_000_000):
    with open(p, "rb") as f:
        return f.read(limit).decode(errors="replace")


def _config_value(p: Path, key):
    text = _read(p)
    if p.suffix == ".toml":
        data = tomllib.loads(text)
    else:
        data = json.loads(text)
    for part in key.split("."):
        if not isinstance(data, dict) or part not in data:
            raise KeyError(key)
        data = data[part]
    return data


def verify_claim(claim, roots):
    """Check one claim against this machine, read-only. Returns the claim with `status` and `detail`.

    status: verified (true now), false (checked and wrong), unverifiable (can't check safely or at all).
    claim: {"check": one of CHECKS, "path"|"repo", "text"?, "key"?, "value"?, "statement"}.
    """
    c = dict(claim)
    kind = c.get("check")
    try:
        if kind not in CHECKS:
            c.update(status="unverifiable", detail=f"no read-only check of kind {kind!r}")
            return c
        if kind == "repo_exists":
            repo = c.get("repo", "")
            if "/" in repo.strip("/") and not repo.startswith(("~", "/")):
                r = subprocess.run(["gh", "api", f"repos/{repo.strip('/')}", "--jq", ".full_name"], capture_output=True,
                                   text=True, timeout=30, stdin=subprocess.DEVNULL)
                ok = r.returncode == 0
                c.update(status="verified" if ok else "false", detail=r.stdout.strip() if ok else "not found on GitHub")
                return c
            hits = [p for p in _resolve(repo, roots) if (p / ".git").exists()]
            c.update(status="verified" if hits else "false",
                     detail=str(hits[0]) if hits else f"no git repo named {repo!r} under {', '.join(roots)}")
            return c
        cands = _resolve(c.get("path", ""), roots)
        if any(_denied(p) for p in cands):
            c.update(status="unverifiable", detail="path is in a credential directory the runner never reads")
            return c
        found = [p for p in cands if p.exists()]
        if kind == "path_exists":
            c.update(status="verified" if found else "false",
                     detail=str(found[0]) if found else "does not exist on this machine")
        elif kind == "path_absent":
            c.update(status="false" if found else "verified",
                     detail=f"exists: {found[0]}" if found else "absent")
        elif not found:
            c.update(status="false", detail="file does not exist on this machine")
        elif not found[0].is_file():
            c.update(status="unverifiable", detail=f"{found[0]} is not a file")
        elif kind in ("file_contains", "file_lacks"):
            has = c.get("text", "") in _read(found[0])
            ok = has if kind == "file_contains" else not has
            c.update(status="verified" if ok else "false",
                     detail=f"{found[0]} {'contains' if has else 'lacks'} the text")
        elif kind == "config_equals":
            try:
                v = _config_value(found[0], c.get("key", ""))
            except KeyError:
                c.update(status="false", detail=f"{c.get('key')} not set in {found[0]}")
                return c
            ok = v == c.get("value")
            c.update(status="verified" if ok else "false", detail=f"{c.get('key')} = {json.dumps(v)[:120]}")
    except (OSError, ValueError, tomllib.TOMLDecodeError, subprocess.TimeoutExpired) as e:
        c.update(status="unverifiable", detail=f"{type(e).__name__}: {e}"[:200])
    return c


PATH_RE = re.compile(r"(?<![\w/])(~/[^\s`'\"),]+|/Users/[^\s`'\"),]+)")


def paths_in(text):
    """Absolute and ~ paths mentioned in free text, so prose cannot assert a path no claim covers."""
    return sorted({m.rstrip(".:;") for m in PATH_RE.findall(text or "")})


def verify_all(claims, texts, roots):
    """Verify declared claims, plus a path_exists check for every path named in `texts` but not declared."""
    out = [verify_claim(c, roots) for c in claims]
    declared = {os.path.expanduser(c.get("path", "")) for c in claims}
    for p in paths_in("\n".join(texts)):
        if os.path.expanduser(p) not in declared:
            out.append(verify_claim({"check": "path_exists", "path": p, "statement": f"named in the proposal: {p}",
                                     "implicit": True}, roots))
    return out


# ---------------------------------------------------------------- duplicates

def norm_target(t):
    """Same thing, same string: URLs lose scheme, www, query and trailing slash; paths are expanded."""
    t = (t or "").strip()
    if not t:
        return ""
    if re.match(r"https?://", t):
        u = urlparse(t)
        return (u.netloc.lower().removeprefix("www.") + u.path.rstrip("/")).lower()
    if t.startswith(("~", "/")):
        return os.path.normpath(os.path.expanduser(t))
    return t.lower().rstrip("/")


def find_duplicate(new, existing, vec_of, days, threshold):
    """The existing proposal this one duplicates, or None.

    new/existing: {"id", "target", "created_at", "text"}; vec_of(text) returns a unit vector.
    A match is the same normalized target (any age), or cosine >= threshold within `days`.
    The closest match wins; a target match beats any cosine.
    """
    import datetime as dt
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    nt = norm_target(new.get("target"))
    for e in existing:
        if nt and norm_target(e.get("target")) == nt and e.get("state") not in ("skipped", "expired", "failed"):
            return {**e, "match": "same_target"}
    best, best_sim = None, threshold
    nv = vec_of(new["text"])
    for e in existing:
        if (e.get("created_at") or "") < cutoff:
            continue
        sim = cos(nv, vec_of(e["text"]))
        if sim >= best_sim:
            best, best_sim = e, sim
    return {**best, "match": f"cosine {best_sim:.3f}"} if best else None


# ---------------------------------------------------------------- coursework

def coursework_hit(texts, cfg):
    """The first coursework marker found in any text, or None. Course codes match with or without a space."""
    cw = cfg["coursework"]
    blob = "\n".join(t for t in texts if t)
    low = blob.lower()
    for code in cw["course_codes"]:
        m = re.match(r"([A-Za-z]+)\s*(\d+[A-Za-z]?)$", code.strip())
        pat = rf"(?<![A-Za-z]){re.escape(m[1])}\s*{re.escape(m[2])}(?![0-9A-Za-z])" if m else re.escape(code)
        if re.search(pat, blob, re.I):
            return f"course {code}"
    exceptions = [os.path.expanduser(e).rstrip("/") for e in cw.get("path_exceptions", [])]
    for p in cw["paths"]:
        full = os.path.expanduser(p).rstrip("/")
        for m in re.finditer(rf"(?:{re.escape(p.rstrip('/'))}|{re.escape(full)})(?=/|\b)[^\s`'\"),]*", blob):
            hit = os.path.expanduser(m.group(0))
            if not any(hit == e or hit.startswith(e + "/") for e in exceptions):
                return f"path {p}"
    for d in cw["domains"]:
        if d.lower() in low:
            return f"domain {d}"
    for w in cw["words"]:
        if re.search(rf"\b{re.escape(w)}\b", low):
            return f"word {w!r}"
    return None
