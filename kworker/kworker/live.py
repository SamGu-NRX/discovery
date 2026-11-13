"""Live capture of a save (stage b): the post, its quote, its media and its
self-thread come from fxtwitter now, not from the archive. Reply candidates
still come from the archive, because the only live reply source is X itself
and that would compete with the archive's fetch queue. The expansion is
marked `live`, so the save's jobs bypass the fetch cache and the archive's
copies and go to each origin again.
"""

from __future__ import annotations

import re
import time

from .archive import _iso
from .ctx import Ctx

URL_RE = re.compile(r"https?://[^\s<>\"')\]]+")


def fxtwitter(ctx: Ctx, status_id: str) -> dict:
    r = ctx.fetch("GET", f"https://api.fxtwitter.com/status/{status_id}")
    if r.status_code != 200:
        raise RuntimeError(f"fxtwitter answered {r.status_code} for {status_id}")
    t = r.json().get("tweet")
    if not t:
        raise RuntimeError(f"fxtwitter has no post {status_id}")
    return t


def _media(t: dict) -> list[dict]:
    out = []
    for m in (t.get("media") or {}).get("all") or []:
        if m.get("type") == "photo":
            url = m["url"].split("?")[0] + "?name=orig"
            out.append({"kind": "photo", "source_url": url})
        elif m.get("type") in ("video", "gif"):
            mp4 = [f for f in m.get("formats") or [] if f.get("container") == "mp4" and f.get("url")]
            best = max(mp4, key=lambda f: f.get("bitrate") or 0)["url"] if mp4 else m["url"]
            out.append({"kind": m["type"], "source_url": best})
    return out


def _links(t: dict) -> list[dict]:
    seen, out = set(), []
    for f in (t.get("raw_text") or {}).get("facets") or []:
        u = f.get("replacement") or f.get("original") if f.get("type") == "url" else None
        if u and u not in seen:
            seen.add(u)
            out.append({"url": f.get("original") or u, "expanded": u, "title": f.get("display")})
    if not out:
        for u in URL_RE.findall(t.get("text") or ""):
            if u not in seen and "t.co/" not in u:
                seen.add(u)
                out.append({"url": u, "expanded": u, "title": None})
    return out


def live_expansion(ctx: Ctx, archived: dict) -> dict:
    exp = dict(archived)
    post_id = archived["post"]["id"]
    t = fxtwitter(ctx, post_id)
    post = dict(archived["post"])
    post.update(text=t.get("text") or (t.get("raw_text") or {}).get("text", ""), media=_media(t), links=_links(t), created_at=_iso(t.get("created_at")))
    thread = []
    for p in archived["thread"]:
        if p["is_save"]:
            thread.append({**p, "text": post["text"], "media": post["media"]})
            continue
        pt = fxtwitter(ctx, p["id"])
        thread.append({**p, "text": pt.get("text") or "", "media": _media(pt), "created_at": _iso(pt.get("created_at"))})
    q = t.get("quote")
    quoted = None
    if q:
        quoted = {"id": q.get("id"), "url": q.get("url"), "author_handle": (q.get("author") or {}).get("screen_name"), "text": q.get("text") or "", "media": _media(q)}
    exp.update(
        post=post,
        thread=thread,
        quoted=quoted,
        live=True,
        source=f"live: fxtwitter at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}; replies from {archived['source']}",
    )
    return exp
