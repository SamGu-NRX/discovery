"""A kintake/1 body (POST /k/intake, docs/KNOWLEDGE.md "Daily loop") as the
kexpansion/1 snapshot the rest of the pipeline reads. The Worker has
already checked the required fields."""

from __future__ import annotations

import re

from .archive import _iso

URL_RE = re.compile(r"https?://[^\s<>\"')\]]+")


def _media(items) -> list[dict]:
    return [{"kind": m["kind"], "source_url": m["url"]} for m in items or [] if m.get("url")]


def _links(items) -> list[dict]:
    out = []
    for l in items or []:
        if isinstance(l, str):
            out.append({"url": l, "expanded": l, "title": None})
        elif l.get("url"):
            out.append({"url": l["url"], "expanded": l.get("expanded") or l["url"], "title": l.get("title")})
    return out


_TCO = re.compile(r"https?://t\.co/\w+")


def unexpanded_tco(post: dict) -> list[str]:
    """t.co links in the post's text with no expansion in post.links. The
    pipeline never fetches t.co (it is X), so each one is a gap the card must
    show. X ends the text of a post with media with one more t.co, the
    media's own link; that one is not a gap."""
    found = list(dict.fromkeys(_TCO.findall(post.get("text") or "")))
    covered = {l["url"] for l in _links(post.get("links"))}
    gaps = [u for u in found if u not in covered]
    if gaps and post.get("media") and (post.get("text") or "").rstrip().endswith(gaps[-1]):
        gaps.pop()
    return gaps


def _thread_post(p: dict, is_save: bool) -> dict:
    return {"id": p["id"], "url": p["url"], "created_at": _iso(p.get("created_at")), "text": p.get("text") or "", "is_save": is_save, "media": _media(p.get("media")),
            "links": [l["expanded"] for l in _links(p.get("links"))]}


def expansion(intake: dict) -> dict:
    post = intake["post"]
    sid = post["id"]
    thread_in = intake.get("thread") or []
    if not any(t["id"] == sid for t in thread_in):
        thread_in = [post] + thread_in
    thread = [_thread_post(post if t["id"] == sid else t, t["id"] == sid) for t in thread_in]
    thread_ids = {t["id"] for t in thread}

    # The reply-parent walk, nearest parent first: a saved reply is read and
    # judged with the posts it answers.
    upstream = [{"id": u["id"], "url": u["url"], "author_handle": u["author_handle"], "text": u.get("text") or ""} for u in intake.get("upstream") or []]
    up_ids = {u["id"] for u in upstream}
    candidates = []
    for c in intake.get("context") or []:
        if c["id"] in thread_ids or c["id"] in up_ids:
            continue
        kind = "reply" if c.get("reply_to") else ("quote" if c.get("quoted_id") == sid else "linking")
        links = [l["expanded"] for l in _links(c.get("links"))] + [u for u in URL_RE.findall(c.get("text") or "") if "t.co/" not in u]
        candidates.append({"kind": kind, "id": c["id"], "author_handle": c["author_handle"], "text": c.get("text") or "", "links": list(dict.fromkeys(links)),
                           "source": f"intake:{c.get('view') or 'context'}"})
    candidates = [c for c in candidates if c["text"].strip()]

    q = post.get("quoted")
    quoted = q and {"id": q["id"], "url": q["url"], "author_handle": q["author_handle"], "text": q.get("text") or "", "media": _media(q.get("media"))}
    missing = []
    if intake.get("context_capped"):
        missing.append({"what": "reply_view", "ref": sid, "reason": "the daily job's context cap cut the replies short"})
    if post.get("reply_to") and not upstream:
        missing.append({"what": "upstream", "ref": sid, "reason": "the post this one replies to was not in the intake"})
    missing += [{"what": "link", "ref": u, "reason": "a t.co link in the post's text that the intake did not expand; kworker does not fetch X"} for u in unexpanded_tco(post)]
    return {
        "schema": "kexpansion/1",
        "source": f"daily intake {intake['run_id']} from @{intake['account']}" + (f" at {intake['captured_at']}" if intake.get("captured_at") else ""),
        "post": {
            "id": sid,
            "url": post["url"],
            "author_handle": post["author_handle"],
            "author_name": post.get("author_name"),
            "created_at": _iso(post.get("created_at")),
            "text": post.get("text") or "",
            "media": _media(post.get("media")),
            "links": _links(post.get("links")),
            "article": None,
        },
        "saved_by": [intake["account"]],
        "thread": thread,
        "upstream": upstream,
        "quoted": quoted,
        "candidates": candidates,
        "reply_views": [v.get("view") for v in intake.get("views_read") or [] if v.get("view")],
        "missing": missing,
    }
