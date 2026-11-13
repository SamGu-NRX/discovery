"""Link jobs: canonicalize, look up `fetches`, then climb the ladder
(docs/KNOWLEDGE.md, "Pipeline per save", step 3).

Rungs: 0 site adapters, 1 plain fetch, 2 Browser Rendering then r.jina.ai,
3 Wayback then archive.today, 4 Playwright on the `pipeline` profile,
7 blocked. Every attempt is recorded in the job result, skipped ones too.
"""

from __future__ import annotations

import json
import math
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from urllib.parse import quote, urlsplit

import httpx

from .api import canonical_json
from .canon import canonical_url, is_immutable, url_hash
from .ctx import X_HOSTS, Ctx
from .models import cached_code

EXTRACTOR = ("code/trafilatura", "trafilatura-2.3.1+v2")  # v2: long data: URIs replaced
# Characters of a page's extracted text kept in a bundle, in full in both
# bundle.json and bundle.md. The first blind grade marked a page cut at 6,000
# characters as not preserved. 200,000 keeps bundle.json well under the 1 MiB
# knowledge_bundle reads.
TEXT_MAX = 200_000
THIN = 400  # extracted characters below which a page is probably a JS shell
# A data: URI this long is a file inlined into the page, not text. The second
# blind grade flagged a CSV download link on postplan.dev that filled a
# bundle.md with one enormous line.
DATA_URI_MAX = 200
_DATA_URI = re.compile(r"data:([\w.+-]+/[\w.+-]+)?((?:;[\w.+-]+(?:=[\w.+-]+)?)*),([^\s)\]\"'<>]{%d,})" % DATA_URI_MAX)


def strip_data_uris(text: str) -> str:
    """Replaces each long inline data: URI with a note of its type and size."""

    def note(m: re.Match) -> str:
        return f"data:{m.group(1) or 'text/plain'} (inline file, {len(m.group(3)):,} characters, not kept)"

    return _DATA_URI.sub(note, text)

_GH_REPO = re.compile(r"https?://(?:www\.)?github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)")
_GH_NOT_OWNERS = {
    "features", "sponsors", "orgs", "topics", "login", "about", "pricing", "marketplace", "settings",
    "notifications", "enterprise", "collections", "trending", "site", "apps", "readme", "security", "customer-stories",
}
_CHALLENGE = re.compile(r"Just a moment\.\.\.|cf-chl-|challenge-platform|Attention Required! \| Cloudflare|captcha", re.I)
_LOGIN_PATH = re.compile(r"/(?:log-?in|sign-?in|signup|auth|sso)(?:[/?#]|$)", re.I)
_LOGIN_FORM = re.compile(r"<input[^>]+type=[\"']?password", re.I)


@dataclass
class Fetched:
    rung: int
    status: str  # ok | not_found | blocked | error
    final_url: str
    content: bytes = b""
    mime: str = ""
    http_status: int | None = None
    etag: str | None = None
    last_modified: str | None = None
    note: str = ""
    extra: dict = field(default_factory=dict)  # adapter metadata (repo facts, arXiv ids)


ADAPTER_MIME = "application/x-kadapter+json"


def _adapter(url: str, name: str, meta: dict, doc: str, note: str) -> Fetched:
    """Rung-0 output: one JSON blob with the adapter's metadata and its
    readable text, so the fetch row's content_sha carries both."""
    body = canonical_json({"adapter": name, "meta": meta, "doc": doc}).encode("utf-8")
    return Fetched(0, "ok", url, body, ADAPTER_MIME, 200, note=note, extra=meta)


class Skip(Exception):
    """This rung does not apply or has no credentials; climb on."""


def _repo_of(url: str) -> str | None:
    m = _GH_REPO.match(url)
    if not m or m.group(1).lower() in _GH_NOT_OWNERS:
        return None
    repo = m.group(2)
    repo = repo[:-4] if repo.endswith(".git") else repo
    return f"https://github.com/{m.group(1)}/{repo}".lower()


def repos_in_html(html: str, exclude_owner: str | None = None) -> list[str]:
    """GitHub repos a page links to, most-linked first."""
    counts = Counter(r for r in (_repo_of(m.group(0)) for m in _GH_REPO.finditer(html)) if r)
    return [r for r, _ in counts.most_common()]


# ---- rung 0: site adapters ----


def _gh(ctx: Ctx, path: str, raw: bool = False) -> httpx.Response:
    headers = {"accept": "application/vnd.github.raw" if raw else "application/vnd.github+json", "x-github-api-version": "2022-11-28"}
    if ctx.cfg.github_token:
        headers["authorization"] = f"Bearer {ctx.cfg.github_token}"
    return ctx.fetch("GET", f"https://api.github.com{path}", headers=headers)


def github_repo(ctx: Ctx, repo_url: str) -> Fetched:
    owner, name = urlsplit(repo_url).path.strip("/").split("/")[:2]
    r = _gh(ctx, f"/repos/{owner}/{name}")
    if r.status_code == 404:
        return Fetched(0, "not_found", repo_url, http_status=404, note="GitHub API: no such repo")
    if r.status_code != 200:
        raise Skip(f"GitHub API {r.status_code}: {r.text[:120]}")
    meta = r.json()
    readme = _gh(ctx, f"/repos/{owner}/{name}/readme", raw=True)
    commits = _gh(ctx, f"/repos/{owner}/{name}/commits?per_page=1")
    last = None
    if commits.status_code == 200 and commits.json():
        c = commits.json()[0]
        last = {"sha": c["sha"], "date": c["commit"]["committer"]["date"]}
    readme_text = readme.text if readme.status_code == 200 else ""
    extra = {
        "repo": {
            "url": meta["html_url"],
            "full_name": meta["full_name"],
            "description": meta.get("description"),
            "stars": meta.get("stargazers_count"),
            "default_branch": meta.get("default_branch"),
            "pushed_at": meta.get("pushed_at"),
            "last_commit": last,
            "license": (meta.get("license") or {}).get("spdx_id"),
            "archived": meta.get("archived"),
        }
    }
    doc = f"# {meta['full_name']}\n\n{meta.get('description') or ''}\n\n{readme_text}"
    return _adapter(meta["html_url"], "github_repo", extra, doc, "GitHub API")


def github_gist(ctx: Ctx, gist_id: str, url: str) -> Fetched:
    r = _gh(ctx, f"/gists/{gist_id}")
    if r.status_code != 200:
        raise Skip(f"GitHub gist API {r.status_code}")
    g = r.json()
    files = "\n\n".join(f"## {name}\n\n```\n{f.get('content') or ''}\n```" for name, f in g.get("files", {}).items())
    doc = f"# {g.get('description') or 'gist ' + gist_id}\n\n{files}"
    return _adapter(url, "github_gist", {"gist": {"id": gist_id, "owner": (g.get("owner") or {}).get("login"), "updated_at": g.get("updated_at")}}, doc, "GitHub gist API")


def arxiv(ctx: Ctx, arxiv_id: str, url: str) -> Fetched:
    r = ctx.fetch("GET", f"https://export.arxiv.org/api/query?id_list={quote(arxiv_id)}")
    if r.status_code != 200 or "<entry>" not in r.text:
        raise Skip(f"arXiv API {r.status_code}")
    title = _xml(r.text, "title", 1)
    summary = _xml(r.text, "summary", 0)
    authors = re.findall(r"<name>(.*?)</name>", r.text)
    doc = f"# {title}\n\n{', '.join(authors)}\n\n{summary}"
    return _adapter(url, "arxiv", {"arxiv": {"id": arxiv_id, "title": title, "authors": authors}}, doc, "arXiv API")


def _xml(text: str, tag: str, nth: int) -> str:
    found = re.findall(rf"<{tag}[^>]*>(.*?)</{tag}>", text, re.S)
    return " ".join(found[nth].split()) if len(found) > nth else ""


def x_post(ctx: Ctx, status_id: str, url: str) -> Fetched:
    cached = None if ctx.live else _x_from_cache(ctx, status_id, url)
    if cached is not None:
        return cached
    fx = _x_from_fxtwitter(ctx, status_id, url)
    if fx is not None:
        return fx
    # The token react-tweet computes for the public syndication endpoint.
    token = _syndication_token(status_id)
    r = ctx.fetch("GET", f"https://cdn.syndication.twimg.com/tweet-result?id={status_id}&token={token}&lang=en")
    if r.status_code == 404:
        return Fetched(0, "not_found", url, http_status=404, note="X syndication: not found or deleted")
    if r.status_code != 200 or not r.content:
        raise Skip(f"X syndication {r.status_code}")
    j = r.json()
    user = j.get("user") or {}
    doc = f"@{user.get('screen_name')} ({user.get('name')}), {j.get('created_at')}:\n\n{j.get('text', '')}"
    meta = {"x_post": {"id": status_id, "author_handle": user.get("screen_name"), "text": j.get("text"), "created_at": j.get("created_at")}}
    return _adapter(url, "x_syndication", meta, doc, "X syndication JSON")


def _x_from_cache(ctx: Ctx, status_id: str, url: str) -> Fetched | None:
    """An fxtwitter record the archive already holds (KWORKER_X_CACHE), so a
    run over archived saves adds nothing to X's load."""
    for d in ctx.cfg.x_cache:
        p = d / f"{status_id}.json"
        if not p.is_file():
            continue
        t = json.loads(p.read_text(encoding="utf-8")).get("tweet") or {}
        if not t.get("text") and not t.get("raw_text"):
            continue
        author = t.get("author") or {}
        text = t.get("text") or (t.get("raw_text") or {}).get("text", "")
        ctx.stats.cache_hits["x_archive"] += 1
        doc = f"@{author.get('screen_name')} ({author.get('name')}), {t.get('created_at')}:\n\n{text}"
        meta = {"x_post": {"id": status_id, "author_handle": author.get("screen_name"), "text": text, "created_at": t.get("created_at")}}
        return _adapter(url, "x_fxtwitter_archive", meta, doc, "fxtwitter record from the archive")
    return None


def _x_from_fxtwitter(ctx: Ctx, status_id: str, url: str) -> Fetched | None:
    """fxtwitter's public API, the source the archive itself used."""
    r = ctx.fetch("GET", f"https://api.fxtwitter.com/status/{status_id}")
    if r.status_code != 200:
        return None
    t = r.json().get("tweet") or {}
    if not t:
        return None
    author = t.get("author") or {}
    text = t.get("text") or (t.get("raw_text") or {}).get("text", "")
    doc = f"@{author.get('screen_name')} ({author.get('name')}), {t.get('created_at')}:\n\n{text}"
    meta = {"x_post": {"id": status_id, "author_handle": author.get("screen_name"), "text": text, "created_at": t.get("created_at")}}
    return _adapter(url, "x_fxtwitter", meta, doc, "fxtwitter API")


def _syndication_token(status_id: str) -> str:
    r"""((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ""),
    the token react-tweet sends. X ignored it on 2026-11-12; it is computed
    exactly anyway, following V8's DoubleToRadixCString, in case that changes."""
    return re.sub(r"(0+|\.)", "", _to_radix(float(int(status_id)) / 1e15 * math.pi, 36))


def _to_radix(value: float, radix: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    integer = math.floor(value)
    fraction = value - integer
    delta = max(0.5 * (math.nextafter(value, math.inf) - value), math.nextafter(0.0, 1.0))
    frac_digits: list[int] = []
    if fraction >= delta:
        while True:
            fraction *= radix
            delta *= radix
            digit = int(fraction)
            frac_digits.append(digit)
            fraction -= digit
            if fraction > 0.5 or (fraction == 0.5 and (digit & 1)):
                if fraction + delta > 1:
                    # Round up, carrying into earlier digits.
                    while True:
                        if not frac_digits:
                            integer += 1
                            break
                        d = frac_digits.pop()
                        if d + 1 < radix:
                            frac_digits.append(d + 1)
                            break
                    break
            if not fraction >= delta:
                break
    int_digits = ""
    n = int(integer)
    while True:
        n, d = divmod(n, radix)
        int_digits = chars[d] + int_digits
        if n == 0:
            break
    return int_digits + ("." + "".join(chars[d] for d in frac_digits) if frac_digits else "")


def rung0(ctx: Ctx, canon: str) -> Fetched:
    parts = urlsplit(canon)
    host, path = parts.hostname or "", parts.path
    if host == "github.com":
        repo = _repo_of(canon)
        if repo:
            return github_repo(ctx, repo)
    if host == "gist.github.com":
        segs = [s for s in path.split("/") if s]
        if segs:
            return github_gist(ctx, segs[-1], canon)
    if host == "arxiv.org" and path.startswith("/abs/"):
        return arxiv(ctx, path[len("/abs/") :], canon)
    m = re.match(r"^/[^/]+/status/(\d+)$", path)
    if host == "x.com" and m:
        return x_post(ctx, m.group(1), canon)
    raise Skip("no site adapter for this host")


# ---- rungs 1 to 4 ----


def _classify(r: httpx.Response, rung: int) -> Fetched:
    final = str(r.url)
    body = r.content
    mime = r.headers.get("content-type", "")
    head = body[:20000].decode("utf-8", "replace")
    f = Fetched(rung, "ok", final, body, mime, r.status_code, r.headers.get("etag"), r.headers.get("last-modified"))
    if r.status_code == 404 or r.status_code == 410:
        f.status, f.note = "not_found", f"HTTP {r.status_code}"
    elif r.status_code in (401, 403, 429, 503) or _CHALLENGE.search(head):
        f.status, f.note = "blocked", f"HTTP {r.status_code}" + (" with a challenge page" if _CHALLENGE.search(head) else "")
    elif r.status_code >= 400:
        f.status, f.note = "error", f"HTTP {r.status_code}"
    elif _LOGIN_PATH.search(urlsplit(final).path) or (_LOGIN_FORM.search(head) and len(body) < 200_000):
        f.status, f.note = "blocked", "login wall"
    return f


def rung1(ctx: Ctx, canon: str, prior: dict | None) -> Fetched:
    headers = {}
    if prior and prior.get("status") == "ok":
        if prior.get("etag"):
            headers["if-none-match"] = prior["etag"]
        if prior.get("last_modified"):
            headers["if-modified-since"] = prior["last_modified"]
    r = ctx.fetch("GET", canon, headers=headers)
    if r.status_code == 304 and prior:
        return Fetched(1, "ok", prior.get("final_url") or canon, b"", prior.get("mime") or "", 304, note="not modified", extra={"not_modified": True})
    return _classify(r, 1)


def rung2(ctx: Ctx, canon: str) -> Fetched:
    if ctx.cfg.cf_account_id and ctx.cfg.cf_browser_token:
        r = ctx.fetch(
            "POST",
            f"https://api.cloudflare.com/client/v4/accounts/{ctx.cfg.cf_account_id}/browser-rendering/markdown",
            headers={"authorization": f"Bearer {ctx.cfg.cf_browser_token}"},
            json={"url": canon},
        )
        if r.status_code == 200 and r.json().get("success"):
            md = r.json().get("result") or ""
            f = Fetched(2, "ok", canon, md.encode("utf-8"), "text/markdown; charset=utf-8", 200, note="Cloudflare Browser Rendering")
            if not _thin_markdown(md):
                return f
    r = ctx.fetch("GET", f"https://r.jina.ai/{canon}", headers={"accept": "text/plain", "x-return-format": "markdown"})
    if r.status_code != 200:
        return Fetched(2, "blocked" if r.status_code in (401, 403, 429, 451) else "error", canon, http_status=r.status_code, note=f"r.jina.ai HTTP {r.status_code}")
    text = r.text
    if _CHALLENGE.search(text[:3000]) or re.search(r"Target URL returned error (401|403|404)", text[:3000]):
        code = re.search(r"returned error (\d+)", text[:3000])
        status = "not_found" if code and code.group(1) == "404" else "blocked"
        return Fetched(2, status, canon, http_status=int(code.group(1)) if code else None, note="r.jina.ai: target refused")
    # r.jina.ai follows redirects and names where it ended up; a sign-in page
    # is a wall, not the content.
    source = re.search(r"^URL Source: (\S+)", text[:2000], re.M)
    final = source.group(1) if source else canon
    if _LOGIN_PATH.search(urlsplit(final).path):
        return Fetched(2, "blocked", final, http_status=200, note="r.jina.ai landed on a login page")
    return Fetched(2, "ok", final, text.encode("utf-8"), "text/markdown; charset=utf-8", 200, note="r.jina.ai")


def _thin_markdown(md: str) -> bool:
    return len(re.sub(r"\s+", " ", md)) < THIN


def rung3(ctx: Ctx, canon: str) -> Fetched:
    r = ctx.fetch("GET", f"https://archive.org/wayback/available?url={quote(canon, safe='')}")
    snap = (r.json().get("archived_snapshots") or {}).get("closest") if r.status_code == 200 else None
    if snap and snap.get("available") and str(snap.get("status", "200")).startswith("2"):
        # The id_ form returns the archived bytes without Wayback's toolbar.
        raw = re.sub(r"/web/(\d+)/", r"/web/\1id_/", snap["url"], count=1)
        page = ctx.fetch("GET", raw)
        f = _classify(page, 3)
        if f.status == "ok":
            f.note = f"Wayback snapshot {snap.get('timestamp')}"
            return f
    page = ctx.fetch("GET", f"https://archive.ph/newest/{canon}")
    f = _classify(page, 3)
    if f.status == "ok" and "archive.ph" in urlsplit(f.final_url).hostname and "/newest/" not in f.final_url:
        f.note = "archive.today snapshot"
        return f
    return Fetched(3, "not_found", canon, note="no Wayback or archive.today snapshot" + (" (archive.today challenged)" if f.status == "blocked" else ""))


def rung4(ctx: Ctx, canon: str) -> Fetched:
    from playwright.sync_api import Error as PlaywrightError

    from .browser import render

    try:
        html, final, status = render(ctx, canon)
    except PlaywrightError as e:
        # A timeout or an unresolvable host is this rung's result, not a job
        # failure (stage a lost two link jobs to it).
        raise RuntimeError(f"browser: {str(e).splitlines()[0][:200]}") from e
    f = Fetched(4, "ok", final, html.encode("utf-8"), "text/html; charset=utf-8", status, note="Playwright, headed Chrome profile pipeline")
    if status in (404, 410):
        f.status, f.note = "not_found", f"HTTP {status} in the browser"
    elif status in (401, 403) or _CHALLENGE.search(html[:20000]):
        f.status, f.note = "blocked", f"HTTP {status} in the browser" + (" with a challenge" if _CHALLENGE.search(html[:20000]) else "")
    elif _LOGIN_PATH.search(urlsplit(final).path) or _LOGIN_FORM.search(html):
        f.status, f.note = "blocked", "login wall in the browser"
    return f


# ---- the job ----


def extract(ctx: Ctx, content_sha: str, data: bytes, mime: str, url: str) -> tuple[str, str, str | None]:
    """(text, text_sha, title). Markdown and plain text pass through; HTML goes
    through trafilatura. Cached by (content_sha, extractor version)."""

    def compute() -> tuple[bytes, str]:
        if mime == ADAPTER_MIME:
            return strip_data_uris(json.loads(data)["doc"]).encode("utf-8"), "text/markdown; charset=utf-8"
        if "html" not in mime:
            return strip_data_uris(data.decode("utf-8", "replace")).encode("utf-8"), "text/markdown; charset=utf-8"
        import trafilatura

        html = data.decode("utf-8", "replace")
        text = trafilatura.extract(html, url=url, output_format="markdown", include_links=True, include_tables=True, favor_recall=True) or ""
        meta = trafilatura.extract_metadata(html, default_url=url)
        title = meta.title if meta and meta.title else ""
        return strip_data_uris(f"# {title}\n\n{text}" if title else text).encode("utf-8"), "text/markdown; charset=utf-8"

    sha, _ = cached_code(ctx, "extract", content_sha, EXTRACTOR[0], EXTRACTOR[1], compute)
    text = ctx.api.get_blob(sha).decode("utf-8")
    first = text.split("\n", 1)[0]
    title = first[2:].strip() if first.startswith("# ") else None
    return text, sha, title


def link_job(ctx: Ctx, payload: dict) -> dict:
    url = payload["url"]
    try:
        canon = canonical_url(url)
    except ValueError as e:
        return {"url": url, "status": "error", "note": str(e), "attempts": []}
    h = url_hash(canon)
    prior = ctx.api.lookup_fetches([h]).get(h)
    revalidate = payload.get("revalidate", False)
    live = payload.get("live", False)
    ctx.live = live
    if prior and prior["status"] in ("ok", "not_found", "blocked") and (prior["immutable"] or not revalidate) and not live:
        ctx.stats.cache_hits["fetch"] += 1
        return _result(ctx, payload, canon, prior, cached=True)

    host = urlsplit(canon).hostname or ""
    policy = ctx.api.call("GET", "/k/domain-policy", params={"host": host})["policy"]
    start = policy["start_rung"] if policy else 0
    attempts: list[dict] = []
    got: Fetched | None = None
    rungs = [(0, lambda: rung0(ctx, canon)), (1, lambda: rung1(ctx, canon, prior)), (2, lambda: rung2(ctx, canon)), (3, lambda: rung3(ctx, canon)), (4, lambda: rung4(ctx, canon))]
    worst: Fetched | None = None
    on_x = host in X_HOSTS
    for n, fn in rungs:
        if n < start and n != 0:
            attempts.append({"rung": n, "skipped": f"domain_policy start_rung {start}"})
            continue
        if n > 0 and on_x and ctx.cfg.no_x:
            # Proxies and the browser would still load X; only the archive's
            # own record (rung 0) may answer.
            attempts.append({"rung": n, "status": "blocked", "note": "X fetches are off (KWORKER_NO_X=1)"})
            continue
        t0 = time.monotonic()
        try:
            f = fn()
        except Skip as e:
            attempts.append({"rung": n, "skipped": str(e)})
            continue
        except (httpx.HTTPError, OSError, ValueError, RuntimeError) as e:
            attempts.append({"rung": n, "status": "error", "note": f"{type(e).__name__}: {e}"[:300]})
            continue
        attempt = {"rung": n, "status": f.status, "http_status": f.http_status, "note": f.note, "ms": int((time.monotonic() - t0) * 1000)}
        if f.status == "ok" and f.extra.get("not_modified"):
            attempts.append(attempt)
            ctx.stats.cache_hits["not_modified"] += 1
            return _result(ctx, payload, canon, prior, cached=True, attempts=attempts)
        if f.status == "ok":
            text_len = len(_quick_text(f))
            attempt["text_chars"] = text_len
            attempts.append(attempt)
            if text_len < THIN and n in (1, 2, 3):
                # A JS shell or near-empty page: keep climbing, but keep this
                # in case nothing better comes back.
                attempt["thin"] = True
                worst = worst or f
                continue
            got = f
            break
        attempts.append(attempt)
        if f.status == "not_found" and n == 0:
            got = f
            break
        if worst is None or (worst.status != "ok" and f.status == "blocked"):
            worst = f
    if got is None:
        tried = "; ".join(f"rung {a['rung']}: {a.get('note') or a['status']}" for a in attempts if "status" in a)
        got = worst if worst and worst.status == "ok" else Fetched(7, _final_failure(attempts), canon, note=f"every rung failed ({tried})"[:500])

    content_sha = ctx.api.put_bytes(got.content, got.mime or "application/octet-stream") if got.status == "ok" and got.content else None
    row = {
        "url_hash": h,
        "canonical_url": canon,
        "final_url": got.final_url,
        "etag": got.etag,
        "last_modified": got.last_modified,
        "content_sha": content_sha,
        "mime": got.mime or None,
        "http_status": got.http_status,
        "rung": got.rung,
        "status": got.status,
        "immutable": 1 if is_immutable(canon) else 0,
        "note": got.note[:500] or None,
    }
    ctx.api.record_fetches([row])
    _learn(ctx, host, start, attempts, got)
    return _result(ctx, payload, canon, row, cached=False, attempts=attempts)


def _final_failure(attempts: list[dict]) -> str:
    statuses = {a.get("status") for a in attempts}
    if "blocked" in statuses:
        return "blocked"
    if "not_found" in statuses:
        return "not_found"
    return "error"


def _learn(ctx: Ctx, host: str, start: int, attempts: list[dict], got: Fetched) -> None:
    """If plain rungs were refused (not merely thin) and a higher one worked,
    start this host there next time."""
    if got.status != "ok" or got.rung <= max(start, 1):
        return
    below = [a for a in attempts if 1 <= a["rung"] < got.rung and "status" in a]
    if below and all(a["status"] == "blocked" for a in below):
        ctx.api.call("POST", "/k/domain-policy", {"host": host, "start_rung": got.rung, "notes": f"rungs {[a['rung'] for a in below]} blocked; rung {got.rung} worked"})


def _quick_text(f: Fetched) -> str:
    if "html" in f.mime:
        t = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", f.content.decode("utf-8", "replace"))
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t)).strip()
    return f.content.decode("utf-8", "replace").strip()


def _result(ctx: Ctx, payload: dict, canon: str, row: dict, cached: bool, attempts: list | None = None) -> dict:
    out = {
        "url": payload["url"],
        "from": payload.get("from"),
        "canonical_url": canon,
        "final_url": row.get("final_url"),
        "status": row["status"],
        "rung": row["rung"],
        "http_status": row.get("http_status"),
        "note": row.get("note") or "",
        "content_sha": row.get("content_sha"),
        "cached": cached,
        "attempts": attempts or [],
        "meta": {},
    }
    if row["status"] != "ok" or not row.get("content_sha"):
        return out
    mime = row.get("mime") or ""
    data = ctx.api.get_blob(row["content_sha"])
    if mime == ADAPTER_MIME:
        out["meta"] = json.loads(data)["meta"]
    text, text_sha, title = extract(ctx, row["content_sha"], data, mime, canon)
    out.update(text_sha=text_sha, title=title)
    # The repo behind a product site, from its own HTML, before any model:
    # the most-linked repo whose owner or name is in the site's host, fetched
    # through the GitHub adapter. A page that merely links some other repo
    # (postplan.dev linking T3 Code) has none; its repos stay in site_repos.
    if "html" in mime and not payload.get("no_site_repo"):
        found = repos_in_html(data.decode("utf-8", "replace"))
        out["site_repos"] = found[:5]
        behind = next((r for r in found if site_owns_repo(row.get("final_url") or canon, r)), None)
        if behind:
            sub = link_job(ctx, {"url": behind, "from": f"site_html:{canon}", "no_site_repo": True})
            out["site_repo"] = {"url": behind, "status": sub["status"], "meta": sub["meta"], "text_sha": sub.get("text_sha")}
    return out


def site_owns_repo(site_url: str, repo_url: str) -> bool:
    host = (urlsplit(site_url).hostname or "").lower()
    labels = set(re.split(r"[.-]", host))
    owner, name = urlsplit(repo_url).path.strip("/").split("/")[:2]
    return any(part.lower() in labels or part.lower() in host.replace(".", "") for part in (owner, name) if len(part) >= 3)
