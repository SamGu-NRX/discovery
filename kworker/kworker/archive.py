"""Step 1's expansion source: the x-bookmarks-eval archive of 2026-10-26.

For a saved post this reads the post, its self-thread, its quoted post, and
every reply any eval arm captured (the judged pool plus the verifier's
additions), and writes them as one `kexpansion/1` snapshot. Live capture of
replies in both orders, the upstream post and posts linking the save is a
later step; the snapshot says so in `missing`.

The pool's relevance labels are not copied: the gate must decide blind. They
are read only by acceptance/ to score the gate.
"""

from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

URL_RE = re.compile(r"https?://[^\s<>\"')\]]+")


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _iso(created_at: str | None) -> str | None:
    if not created_at:
        return None
    if "T" in created_at:
        return created_at
    # Syndication's "Wed Oct 21 01:07:58 +0000 2026".
    return datetime.strptime(created_at, "%a %b %d %H:%M:%S %z %Y").astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _norm(text: str) -> str:
    return " ".join(text.split())


# Some eval arms read replies off X's rendered page, so their text carries the
# card's date line and engagement counts. These are capture noise, not words
# the author wrote.
_DATE_LINE = re.compile(r"^(?:[A-Z][a-z]{2} \d{1,2}(?:, \d{4})?|\d{1,2}[smhd])$")
_COUNT_LINE = re.compile(r"^(?:\d[\d.,]*[KMB]?|Show (?:more )?replies|Show more)$")
_MENTIONS = re.compile(r"^(?:@\w+\s*)+")


def clean_capture(text: str) -> str:
    lines = text.strip().split("\n")
    if lines and _DATE_LINE.match(lines[0].strip()):
        lines = lines[1:]
    while lines and _COUNT_LINE.match(lines[-1].strip()):
        lines.pop()
    return "\n".join(lines).strip()


def _key(author: str, text: str) -> tuple[str, str]:
    return author.lower(), _norm(_MENTIONS.sub("", clean_capture(text)))


class Archive:
    def __init__(self, root: Path, date: str = "2026-10-26"):
        self.root = root
        self.dir = root / "archive" / date
        if not (self.dir / "data.json").exists():
            raise FileNotFoundError(f"no archive at {self.dir / 'data.json'}")
        self.data = _load(self.dir / "data.json")
        self.media_index = _load(self.dir / "media-index.json")["items"]
        self.gold_posts: dict[str, dict] = {}
        self.reply_views: dict[str, list] = {}
        for acct in ("sdotgu", "_sgu_"):
            g = _load(root / "gold" / f"{acct}.json")
            self.gold_posts.update(g["posts"])
            self.reply_views.update(g.get("reply_views_checked", {}))
        self.pool: dict[str, list[dict]] = {}
        for acct in ("sdotgu", "_sgu_"):
            for it in _load(root / "results" / "judge" / f"blind-replies-{acct}.json")["items"]:
                self.pool.setdefault(it["root_id"], []).append({**it, "pool": f"{acct}:{it['item']}"})
        self.threads = {t["root_id"]: t for t in self.data["threads"]}
        try:
            self.commit = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            self.commit = "unknown"

    def expansion(self, post_id: str) -> dict:
        post = self.data["posts"].get(post_id)
        if post is None:
            raise KeyError(f"post {post_id} is not in {self.dir / 'data.json'}")
        gold = self.gold_posts.get(post_id, {})

        # The save's own media: the exact variants the archive downloaded (the
        # media index), falling back to the gold media list.
        media = [{"kind": m["kind"], "source_url": m["source_url"]} for m in self.media_index if m["post_id"] == post_id]
        if not media:
            media = [{"kind": m["kind"], "source_url": m["source_url"]} for m in gold.get("media", [])]
        media = [{**m, "kind": "photo" if m["kind"] in ("image", "photo") else m["kind"]} for m in media]

        links = [l for l in post.get("links", []) if not l.get("source_reply_id")]
        reply_links: dict[str, list[str]] = {}
        for l in post.get("links", []):
            if l.get("source_reply_id"):
                reply_links.setdefault(l["source_reply_id"], []).append(l.get("expanded") or l["url"])

        thread_row = self.threads.get(post_id) or {"post_ids": [post_id], "other_posts": []}
        others = {o["id"]: o for o in thread_row.get("other_posts", [])}
        thread = []
        for pid in thread_row["post_ids"]:
            if pid == post_id:
                thread.append(
                    {"id": pid, "url": post["url"], "created_at": _iso(post.get("created_at")), "text": post["text"], "is_save": True, "media": media}
                )
            else:
                o = others.get(pid, {})
                thread.append(
                    {
                        "id": pid,
                        "url": o.get("url") or f"https://x.com/{post['author_handle']}/status/{pid}",
                        "created_at": _iso(o.get("created_at")),
                        "text": o.get("text", ""),
                        "is_save": False,
                        "media": [{"kind": _kind_of(u), "source_url": u} for u in o.get("media", [])],
                    }
                )

        # Replies: the archive's kept replies carry ids and expanded links; the
        # pool adds the ones the archive dropped. Matched by normalized text.
        candidates: list[dict] = []
        by_key: dict[tuple[str, str], dict] = {}
        for r in self.data["replies"]:
            if r["root_id"] != post_id:
                continue
            k = _key(r["author_handle"], r["text"])
            if k in by_key:
                # The same reply recorded twice (with and without its id or
                # leading mention): keep the copy that has an id.
                if r.get("id") and not by_key[k]["id"]:
                    by_key[k].update(id=r["id"], text=r["text"], links=reply_links.get(r["id"], []))
                continue
            c = {
                "kind": "reply",
                "id": r.get("id"),
                "author_handle": r["author_handle"],
                "text": r["text"],
                "links": reply_links.get(r.get("id") or "", []),
                "source": "archive",
            }
            by_key[k] = c
            candidates.append(c)
        for it in self.pool.get(post_id, []):
            k = _key(it["author_handle"], it["text"])
            if k in by_key:
                by_key[k]["source"] += f"+pool:{it['pool']}"
                continue
            c = {"kind": "reply", "id": None, "author_handle": it["author_handle"], "text": clean_capture(it["text"]), "links": [], "source": f"pool:{it['pool']}"}
            by_key[k] = c
            candidates.append(c)
        for c in candidates:
            # Unexpanded t.co links in the text still count as links the
            # reply carries (the gate's repo rule looks at both).
            c["links"] = list(dict.fromkeys(c["links"] + [u for u in URL_RE.findall(c["text"]) if "t.co/" not in u]))

        quoted = post.get("quoted")
        return {
            "schema": "kexpansion/1",
            "source": f"x-bookmarks-eval archive/2026-10-26 at {self.commit}",
            "post": {
                "id": post_id,
                "url": post["url"],
                "author_handle": post["author_handle"],
                "author_name": post.get("author_name"),
                "created_at": _iso(post.get("created_at")),
                "text": post["text"],
                "media": media,
                "links": [{"url": l["url"], "expanded": l.get("expanded") or l["url"], "title": l.get("title"), "note": l.get("status")} for l in links],
                "article": post.get("article"),
            },
            "saved_by": post.get("saved_on", []),
            "thread": thread,
            "quoted": quoted and {"url": quoted.get("url"), "text": quoted.get("text"), "author_handle": _author_of(quoted.get("url"))},
            "candidates": candidates,
            "reply_views": self.reply_views.get(post_id, []),
            "missing": [
                {"what": "upstream", "ref": post_id, "reason": "the 2026-10-26 archive does not record the post this one replies to, if any"},
                {"what": "linking", "ref": post_id, "reason": "posts that quote or link this one were not captured in the 2026-10-26 archive"},
            ],
        }


def _kind_of(url: str) -> str:
    return "video" if "video.twimg.com" in url else "photo"


def _author_of(url: str | None) -> str | None:
    m = re.match(r"https://(?:x|twitter)\.com/([^/]+)/status/", url or "")
    return m.group(1) if m else None
