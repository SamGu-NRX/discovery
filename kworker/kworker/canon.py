"""Canonical URLs, as specified in docs/KNOWLEDGE.md ("Canonical URL").

The Worker implements the same rules in TypeScript; both pass
docs/knowledge-canon-vectors.json, so a URL kworker fetched is found by an
agent's knowledge_has call.
"""

from __future__ import annotations

import hashlib
import re
from urllib.parse import urlsplit, urlunsplit

_X_HOSTS = {"twitter.com", "www.twitter.com", "mobile.twitter.com", "www.x.com", "mobile.x.com"}
_YT_HOSTS = {"m.youtube.com", "youtube.com"}
_DROP_ALWAYS = {"fbclid", "gclid", "mc_cid", "mc_eid", "igshid", "ref_src", "ref_url"}
_DROP_BY_HOST = {"x.com": {"s", "t", "ref"}, "www.youtube.com": {"si", "feature", "pp"}}
_DEFAULT_PORTS = {"http": 80, "https": 443}
_X_STATUS = re.compile(r"^/([^/]+)/status/(\d+)(?:/.*)?$")
_ARXIV_PDF = re.compile(r"^/pdf/(.+?)(?:\.pdf)?$")
_COMMIT = re.compile(r"/(?:blob|tree|commit)/[0-9a-f]{40}(?:/|$)")
_ARXIV_VERSIONED = re.compile(r"^/abs/[^/]+v\d+$")


def canonical_url(url: str) -> str:
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise ValueError(f"url must be http or https, got {url!r}")
    host = (parts.hostname or "").rstrip(".")
    if not host:
        raise ValueError(f"url has no host: {url!r}")
    port = parts.port
    path = parts.path or "/"
    pairs = [p for p in parts.query.split("&") if p] if parts.query else []

    if host in _X_HOSTS:
        host = "x.com"
    elif host in _YT_HOSTS:
        host = "www.youtube.com"
    elif host == "www.github.com":
        host = "github.com"
    elif host == "youtu.be":
        video_id = path.strip("/").split("/")[0]
        host, path = "www.youtube.com", "/watch"
        pairs = [f"v={video_id}"] + pairs

    drop = _DROP_ALWAYS | _DROP_BY_HOST.get(host, set())
    pairs = [p for p in pairs if not _param_name(p).startswith("utm_") and _param_name(p) not in drop]
    # sorted() is stable, so repeated names keep their order.
    pairs = sorted(pairs, key=_param_name)

    if host == "x.com":
        m = _X_STATUS.match(path)
        if m:
            path = f"/{m.group(1).lower()}/status/{m.group(2)}"
    elif host == "github.com":
        segs = path.split("/")
        for i in (1, 2):
            if len(segs) > i and segs[i]:
                segs[i] = segs[i].lower()
        if len(segs) == 3 and segs[2].endswith(".git"):
            segs[2] = segs[2][: -len(".git")]
        path = "/".join(segs)
    elif host == "arxiv.org":
        m = _ARXIV_PDF.match(path)
        if m:
            path = f"/abs/{m.group(1)}"

    netloc = host if port is None or port == _DEFAULT_PORTS[scheme] else f"{host}:{port}"
    return urlunsplit((scheme, netloc, path, "&".join(pairs), ""))


def _param_name(pair: str) -> str:
    return pair.split("=", 1)[0]


def url_hash(canonical: str) -> str:
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def is_immutable(canonical: str) -> bool:
    """URLs whose content cannot change, so a cached fetch is never redone."""
    parts = urlsplit(canonical)
    host, path = parts.hostname or "", parts.path
    if host in ("pbs.twimg.com", "video.twimg.com"):
        return True
    if host == "x.com" and _X_STATUS.match(path):
        return True
    if host == "arxiv.org" and _ARXIV_VERSIONED.match(path):
        return True
    if host in ("github.com", "raw.githubusercontent.com") and _COMMIT.search(path):
        return True
    return False
