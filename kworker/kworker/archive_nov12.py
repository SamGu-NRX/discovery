"""Expansion source for the Nov 12 archive (x-bookmarks-eval branch
x-archive-2026-11-12), read-only.

Two inputs, both only read:
- `snapshot`: the committed branch extracted with `git archive` (data.json for
  both accounts, the judged context per save, fxtwitter records).
- `worktree`: the archive lead's working folder, for what it keeps out of git:
  each save's `context/raw/<save>/candidates.jsonl`, the full reply pool with
  text, and the downloaded media (used by kworker through KWORKER_MEDIA_DIRS).

The judge's keep/skip labels are not copied into the expansion: the gate
decides blind. acceptance/scale.py reads them to score the gate.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .archive import _iso

URL_RE = re.compile(r"https?://[^\s<>\"')\]]+")


def _load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


class Nov12:
    def __init__(self, snapshot: Path, worktree: Path, commit: str = "unknown"):
        self.snap = snapshot / "archive"
        self.work = worktree / "archive" / "2026-11-12"
        self.commit = commit
        self.posts = {**_load(self.snap / "2026-11-12-sgu" / "data.json")["posts"], **_load(self.snap / "2026-11-12" / "data.json")["posts"]}
        self.judged_dir = self.snap / "2026-11-12" / "context" / "judged"
        self.fx_dir = self.snap / "2026-11-12" / "raw" / "fxtwitter"

    def judged(self) -> list[str]:
        return sorted(p.stem for p in self.judged_dir.glob("*.json"))

    def judgment(self, save_id: str) -> dict:
        return _load(self.judged_dir / f"{save_id}.json")

    def _fx(self, status_id: str) -> dict | None:
        p = self.fx_dir / f"{status_id}.json"
        return (_load(p).get("tweet") or None) if p.exists() else None

    def candidates(self, save_id: str) -> list[dict]:
        p = self.work / "context" / "raw" / save_id / "candidates.jsonl"
        if not p.exists():
            return []
        rows, seen = [], set()
        # split("\n"), not splitlines(): post text can hold U+2028, which
        # splitlines() treats as a line break inside a JSON string.
        for line in p.read_text(encoding="utf-8").split("\n"):
            if not line.strip():
                continue
            r = json.loads(line)
            if r["status_id"] in seen:
                continue
            seen.add(r["status_id"])
            # Most rows carry no parent id; the fxtwitter record does.
            fx = self._fx(r["status_id"]) or {}
            r["reply_to_status_id"] = r.get("reply_to_status_id") or fx.get("replying_to_status")
            r["created_at"] = r.get("created_at") or _iso(fx.get("created_at"))
            rows.append(r)
        return rows

    def expansion(self, save_id: str) -> dict:
        post = self.posts.get(save_id)
        if post is None:
            raise KeyError(f"save {save_id} is in neither account's data.json under {self.snap}")
        author = post["author_handle"]
        cands = self.candidates(save_id)
        by_id = {c["status_id"]: c for c in cands}

        media = [_media(m) for m in post.get("media") or [] if isinstance(m, dict) and m.get("source_url")]

        # Self-thread: the save, the author's posts it replies to (from the
        # fxtwitter records), and the author's posts that continue it.
        ancestors = []
        fx = self._fx(save_id) or {}
        parent = fx.get("replying_to_status") or post.get("replying_to_status")
        upstream = None
        while parent:
            pfx = self._fx(parent)
            pc = by_id.get(parent)
            p_author = ((pfx or {}).get("author") or {}).get("screen_name") or (pc or {}).get("author_handle")
            p_text = (pfx or {}).get("text") or (pc or {}).get("rendered_text")
            if not p_author or p_text is None:
                break
            if p_author.lower() != author.lower():
                upstream = {"id": parent, "url": f"https://x.com/{p_author}/status/{parent}", "author_handle": p_author, "text": p_text}
                break
            ancestors.insert(0, {"id": parent, "url": f"https://x.com/{author}/status/{parent}", "created_at": _iso((pfx or {}).get("created_at") or (pc or {}).get("created_at")),
                                 "text": p_text, "is_save": False, "media": []})
            parent = (pfx or {}).get("replying_to_status") or (pc or {}).get("reply_to_status_id")
        thread_ids = {save_id} | {a["id"] for a in ancestors}
        after = []
        changed = True
        while changed:
            changed = False
            for c in cands:
                if c["status_id"] in thread_ids or c["author_handle"].lower() != author.lower():
                    continue
                if c.get("reply_to_status_id") in ({save_id} | {a["id"] for a in after}):
                    after.append({"id": c["status_id"], "url": c["url"], "created_at": _iso(c.get("created_at")), "text": c["rendered_text"], "is_save": False,
                                  "media": [_media(m) for m in c.get("media") or [] if isinstance(m, dict) and m.get("source_url")]})
                    thread_ids.add(c["status_id"])
                    changed = True
        after.sort(key=lambda t: t["created_at"] or "")
        thread = ancestors + [{"id": save_id, "url": post["url"], "created_at": _iso(post.get("created_at")), "text": post["text"], "is_save": True, "media": media}] + after

        candidates = []
        for c in cands:
            # fetch:* rows are posts the archive fetched for context (the
            # quoted post, a parent), not replies to judge.
            if c["status_id"] in thread_ids or str(c.get("view", "")).startswith("fetch:upstream"):
                continue
            candidates.append(
                {
                    "kind": "reply" if c.get("reply_to_status_id") else ("quote" if c.get("quoted_status_id") == save_id else "linking"),
                    "id": c["status_id"],
                    "author_handle": c["author_handle"],
                    "text": c.get("rendered_text") or "",
                    "links": [u for u in (c.get("urls") or []) if isinstance(u, str)] + [u for u in URL_RE.findall(c.get("rendered_text") or "") if "t.co/" not in u],
                    "source": f"candidates.jsonl:{c.get('view')}",
                }
            )
        candidates = [c for c in candidates if c["text"].strip()]

        links = []
        for l in post.get("links") or []:
            if isinstance(l, dict) and (l.get("expanded") or l.get("url")):
                links.append({"url": l["url"], "expanded": l.get("expanded") or l["url"], "title": l.get("title"), "note": l.get("error")})
        seen_links, uniq = set(), []
        for l in links:
            if l["expanded"] not in seen_links:
                seen_links.add(l["expanded"])
                uniq.append(l)

        q = post.get("quoted")
        quoted = None
        if isinstance(q, dict) and (q.get("text") is not None or q.get("url")):
            quoted = {
                "id": q.get("id"),
                "url": q.get("url"),
                "author_handle": q.get("author_handle"),
                "text": q.get("text") or "",
                "media": [_media(m) for m in q.get("media") or [] if isinstance(m, dict) and m.get("source_url")],
            }

        views = []
        vp = self.work / "context" / "raw" / save_id / "views.json"
        if vp.exists():
            v = _load(vp)
            views = [x.get("view") for x in (v if isinstance(v, list) else v.get("views", [])) if isinstance(x, dict) and x.get("view")]

        missing = [{"what": "linking", "ref": save_id, "reason": "posts linking this one come only from the views the archive read"}]
        if not upstream and (fx.get("replying_to_status") or post.get("replying_to_status")) and not ancestors:
            missing.append({"what": "upstream", "ref": save_id, "reason": "the post this one replies to is not in the archive's records"})
        if not cands:
            missing.append({"what": "reply_view", "ref": save_id, "reason": "the archive holds no candidate replies for this save"})
        return {
            "schema": "kexpansion/1",
            "source": f"x-bookmarks-eval x-archive-2026-11-12 at {self.commit}, judged context and candidates.jsonl",
            "post": {
                "id": save_id,
                "url": post["url"],
                "author_handle": author,
                "author_name": post.get("author_name"),
                "created_at": _iso(post.get("created_at")),
                "text": post["text"],
                "media": media,
                "links": uniq,
                "article": post.get("article"),
            },
            "saved_by": _accounts(post),
            "thread": thread,
            "upstream": upstream,
            "quoted": quoted,
            "candidates": candidates,
            "reply_views": views,
            "missing": missing,
        }


def _media(m: dict) -> dict:
    kind = m.get("kind") or "photo"
    out = {"kind": "photo" if kind in ("image", "photo") else kind, "source_url": m["source_url"]}
    if m.get("sha256"):
        out["sha256"] = m["sha256"]
    if m.get("local_path"):
        out["local_file"] = Path(m["local_path"]).name
    return out


def _accounts(post: dict) -> list[str]:
    acc = post.get("accounts") or post.get("saved_on") or []
    names = []
    for a in acc if isinstance(acc, list) else [acc]:
        name = a.get("account") if isinstance(a, dict) else a
        if name and name not in names:
            names.append(name)
    return names


def snapshot(repo: Path, ref: str, dest: Path) -> str:
    """Extracts the committed archive from `ref` into dest (git archive only
    reads the repository) and returns the commit."""
    dest.mkdir(parents=True, exist_ok=True)
    commit = subprocess.run(["git", "-C", str(repo), "rev-parse", ref], capture_output=True, text=True, check=True).stdout.strip()
    tar = dest / "snapshot.tar"
    subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", "-o", str(tar), commit, "archive/2026-11-12", "archive/2026-11-12-sgu"], check=True)
    subprocess.run(["tar", "-xf", str(tar), "-C", str(dest)], check=True)
    tar.unlink()
    return commit
