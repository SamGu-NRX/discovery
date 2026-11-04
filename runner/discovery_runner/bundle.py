"""Context bundles: everything a model reads about one candidate, with a ref for every piece.

Refs match the contract's citation form: `op`, `op_followup` (T2, T3...), `reply:@handle`, `link:<url>`.
Linked sources are fetched directly and cached for a day under cache/fetch/: GitHub repos and gists
through `gh api`, arXiv through its export API, Greenhouse jobs through the public boards API (with
the application's questions), X posts through the Worker when captured and fxtwitter otherwise, and
anything else with curl. Every gap is listed in `missing_context`; nothing is silently dropped.

Fetched text is untrusted data. It is stored and quoted to models, never executed or obeyed.
"""
import hashlib
import html
import json
import re
import subprocess
import time
from html.parser import HTMLParser

from . import config

PAGE_CHARS = 12000
# The Nov 4 run missed a Treg breach note that sat past a 7,000-character README cut.
README_CHARS = 24000
MAX_SOURCES = 8
CACHE_TTL_S = 24 * 3600
URL_RE = re.compile(r"https?://[^\s)\]>\"']+")
X_STATUS_RE = re.compile(r"(?:x|twitter)\.com/[^/]+/(?:status|article)/(\d+)")
GREENHOUSE_RE = re.compile(r"(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io/([^/]+)/jobs/(\d+)")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"


class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template"}

    def __init__(self):
        super().__init__()
        self.parts, self.skip, self.title, self._in_title = [], 0, "", False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag == "title":
            self._in_title = True
        a = dict(attrs)
        if tag == "meta" and a.get("content") and (a.get("name") == "description" or a.get("property") in ("og:description", "og:title")):
            self.parts.append(f"[{a.get('name') or a.get('property')}] {a['content']}")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self.skip and data.strip():
            self.parts.append(data.strip())


def html_text(body):
    p = _Text()
    try:
        p.feed(body)
    except Exception:  # malformed markup: keep what parsed
        pass
    return p.title.strip(), html.unescape(re.sub(r"\s+", " ", " ".join(p.parts)))


def run(cmd, timeout=40):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    return p.returncode, p.stdout, p.stderr


def curl(url, timeout=25):
    code, out, _ = run(["curl", "-sL", "--max-time", str(timeout), "--max-filesize", "4000000", "-A", UA,
                        "-w", "\n__HTTP__%{http_code} %{url_effective}", url], timeout=timeout + 10)
    if code != 0:
        return None, None, f"curl exit {code}"
    body, _, meta = out.rpartition("\n__HTTP__")
    status, _, final = meta.partition(" ")
    return status, body, final


def cached(url, fn):
    f = config.path("cache", "fetch", hashlib.sha1(url.encode()).hexdigest()[:20] + ".json")
    if f.exists() and time.time() - f.stat().st_mtime < CACHE_TTL_S:
        return json.loads(f.read_text())
    try:
        rec = fn(url)
    except Exception as e:  # recorded, never hidden: it shows up in missing_context
        rec = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    rec["url"] = url
    f.write_text(json.dumps(rec, ensure_ascii=False))
    return rec


def fetch_page(url):
    status, body, final = curl(url)
    if status is None:
        return {"ok": False, "kind": "page", "error": final}
    title, text = html_text(body)
    gh = sorted(set(re.findall(r"https?://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", body)))
    ok = status.startswith("2") and len(text) >= 300
    return {"ok": ok, "kind": "page", "http": status, "final_url": final, "title": title[:200], "text": text[:PAGE_CHARS],
            "chars": len(text), "github_links": gh[:10],
            "error": None if ok else (f"HTTP {status}" if not status.startswith("2") else
                                      f"thin page ({len(text)} chars), likely rendered by JavaScript")}


def fetch_repo(owner, repo):
    code, out, err = run(["gh", "api", f"repos/{owner}/{repo}"])
    if code != 0:
        return {"ok": False, "kind": "repo", "error": err.strip()[:200]}
    meta = json.loads(out)
    code, readme, _ = run(["gh", "api", f"repos/{owner}/{repo}/readme", "-H", "Accept: application/vnd.github.raw"])
    return {"ok": True, "kind": "repo", "full_name": meta.get("full_name"), "description": meta.get("description"),
            "stars": meta.get("stargazers_count"), "pushed_at": meta.get("pushed_at"),
            "license": (meta.get("license") or {}).get("spdx_id"), "language": meta.get("language"),
            "archived": meta.get("archived"), "readme": readme[:README_CHARS] if code == 0 else None,
            "readme_chars": len(readme) if code == 0 else 0, "error": None if code == 0 else "no README"}


def fetch_github(url):
    m = re.match(r"https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)", url)
    if m:
        code, out, err = run(["gh", "api", f"repos/{m[1]}/{m[2]}/pulls/{m[3]}"])
        if code != 0:
            return {"ok": False, "kind": "pr", "error": err.strip()[:200]}
        j = json.loads(out)
        return {"ok": True, "kind": "pr", "title": j.get("title"), "state": j.get("state"),
                "merged": j.get("merged_at") is not None, "text": (j.get("body") or "")[:PAGE_CHARS]}
    m = re.match(r"https?://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.+)", url)
    if m:
        code, out, err = run(["gh", "api", f"repos/{m[1]}/{m[2]}/contents/{m[4]}?ref={m[3]}", "-H",
                              "Accept: application/vnd.github.raw"])
        return {"ok": code == 0, "kind": "file", "text": out[:PAGE_CHARS], "error": None if code == 0 else err.strip()[:200]}
    m = re.match(r"https?://github\.com/([^/#?]+)/([^/#?]+)", url)
    if m:
        return fetch_repo(m[1], m[2].removesuffix(".git"))
    return fetch_page(url)


def fetch_gist(url):
    gid = url.rstrip("/").split("/")[-1].split("#")[0]
    code, out, err = run(["gh", "api", f"gists/{gid}"])
    if code != 0:
        return {"ok": False, "kind": "gist", "error": err.strip()[:200]}
    j = json.loads(out)
    files = {n: (f.get("content") or "")[:6000] for n, f in list(j.get("files", {}).items())[:4]}
    return {"ok": True, "kind": "gist", "description": j.get("description"), "files": files}


def fetch_arxiv(url):
    aid = re.search(r"arxiv\.org/(?:abs|pdf|html)/([0-9.]+(?:v\d+)?)", url)
    if not aid:
        return fetch_page(url)
    status, body, _ = curl(f"https://export.arxiv.org/api/query?id_list={aid[1]}")
    title = re.search(r"<entry>.*?<title>(.*?)</title>", body or "", re.S)
    summ = re.search(r"<summary>(.*?)</summary>", body or "", re.S)
    if not summ:
        return {"ok": False, "kind": "arxiv", "error": "no abstract in arXiv API response"}
    return {"ok": True, "kind": "arxiv", "title": re.sub(r"\s+", " ", title[1]).strip() if title else "",
            "text": re.sub(r"\s+", " ", summ[1]).strip()}


def fetch_greenhouse(url):
    m = GREENHOUSE_RE.search(url)
    status, body, _ = curl(f"https://boards-api.greenhouse.io/v1/boards/{m[1]}/jobs/{m[2]}?questions=true")
    if status != "200":
        return {"ok": False, "kind": "job", "error": f"Greenhouse API HTTP {status}"}
    j = json.loads(body)
    _, text = html_text(html.unescape(j.get("content") or ""))
    questions = []
    for q in j.get("questions") or []:
        for f in q.get("fields") or []:
            questions.append({"label": q.get("label"), "required": q.get("required"), "name": f.get("name"),
                              "type": f.get("type"), "description": html_text(q.get("description") or "")[1][:500] or None,
                              "options": [v.get("label") for v in f.get("values") or []][:30] or None})
    return {"ok": True, "kind": "job", "board": m[1], "job_id": m[2], "title": j.get("title"),
            "location": (j.get("location") or {}).get("name"), "updated_at": j.get("updated_at"),
            "apply_url": j.get("absolute_url"), "text": text[:PAGE_CHARS * 2], "questions": questions}


def fetch_x(url, worker=None):
    sid = X_STATUS_RE.search(url)[1]
    if worker is not None:
        try:
            ctx = worker.post_context(sid)
            p = ctx.get("post") or {}
            if p.get("text"):
                return {"ok": True, "kind": "x", "via": "worker", "author": p.get("author_handle"), "text": p["text"]}
        except Exception:  # not captured yet; fall through to the public mirror
            pass
    status, body, _ = curl(f"https://api.fxtwitter.com/status/{sid}", timeout=20)
    try:
        t = json.loads(body)["tweet"]
        assert t
    except Exception:
        return {"ok": False, "kind": "x", "error": "post not captured and fxtwitter returned nothing"}
    art = t.get("article")
    art_text = None
    if art:
        blocks = (art.get("content") or {}).get("blocks") or []
        art_text = (art.get("title", "") + "\n" + "\n".join(b.get("text", "") for b in blocks))[:PAGE_CHARS]
    return {"ok": True, "kind": "x", "via": "fxtwitter", "author": (t.get("author") or {}).get("screen_name"),
            "text": t.get("text"), "article": art_text}


def fetch(url, worker=None):
    u = norm_url(url)
    if X_STATUS_RE.search(u):
        return cached(u, lambda x: fetch_x(x, worker))
    if "gist.github.com" in u:
        return cached(u, fetch_gist)
    if re.match(r"https://github\.com/", u):
        return cached(u, fetch_github)
    if "arxiv.org/" in u:
        return cached(u, fetch_arxiv)
    if GREENHOUSE_RE.search(u):
        return cached(u, fetch_greenhouse)
    return cached(u, fetch_page)


def norm_url(u):
    u = u.rstrip(".,;:!?…").split("?s=")[0]
    u = re.sub(r"^http://", "https://", u)
    if re.match(r"https://github\.com/[^/]+/[^/]+/?$", u):
        u = u.rstrip("/").removesuffix(".git")
    return u


def _post(p, ref):
    return {"ref": ref, "id": p.get("id"), "author": p.get("author_handle"), "created_at": p.get("created_at"),
            "text": p.get("text") or "", "urls": p.get("urls") or [], "media": p.get("media") or [],
            "metrics": p.get("metrics")}


def _attach_sources(b, urls, worker):
    order, where = [], {}
    for u, src in urls:
        if not u or any(h in u for h in ("t.co/", "pbs.twimg.com", "video.twimg.com")):
            continue
        n = norm_url(u)
        if n not in where:
            order.append(n)
            where[n] = src
    if len(order) > MAX_SOURCES:
        b["missing_context"].append(f"{len(order) - MAX_SOURCES} linked URLs not fetched (cap {MAX_SOURCES})")
    for u in order[:MAX_SOURCES]:
        rec = {k: v for k, v in fetch(u, worker).items() if v not in (None, "", [], {})}
        rec["ref"] = f"link:{u}"
        rec["found_in"] = where[u]
        b["sources"].append(rec)
        if not rec.get("ok"):
            b["missing_context"].append(f"source not readable: {u} ({rec.get('error', 'unknown')})")
        # Sam wants the repo behind a linked site; follow one GitHub link from a page.
        if rec.get("kind") == "page" and rec.get("github_links"):
            gl = [g for g in rec["github_links"] if not re.search(r"github\.com/(sponsors|features|about|login|orgs)/", g)]
            if gl and norm_url(gl[0]) not in where:
                g = norm_url(gl[0])
                where[g] = f"GitHub link on {u}"
                gr = {k: v for k, v in fetch(g, worker).items() if v not in (None, "", [], {})}
                gr["ref"] = f"link:{g}"
                gr["found_in"] = where[g]
                b["sources"].append(gr)


def x_post_bundle(worker, candidate):
    """Returns (bundle, thread_captured)."""
    ctx = worker.post_context(candidate["ref"])
    post = ctx["post"]
    b = {"kind": "x_post", "candidate_id": candidate["id"], "url": candidate.get("url"),
         "op": _post(post, "op"), "op_followups": [], "replies": [], "quoted": None, "sources": [],
         "missing_context": []}
    urls = [(u, "op") for u in post.get("urls") or []] + [(u, "op") for u in URL_RE.findall(post.get("text") or "")]
    if ctx.get("quoted"):
        q = ctx["quoted"]
        b["quoted"] = _post(q, f"link:https://x.com/{q.get('author_handle')}/status/{q.get('id')}")
        urls += [(u, "quoted") for u in ctx["quoted"].get("urls") or []]
    elif post.get("quoted_id"):
        b["missing_context"].append(f"quoted post {post['quoted_id']} not captured")
    # The contract lists op_self_thread and replies at the top level; the deployed Worker nests them under
    # `thread`. Read either.
    thread = ctx.get("thread") or {}
    self_thread = [t for t in (thread.get("op_self_thread") or ctx.get("op_self_thread") or []) if t.get("id") != post.get("id")]
    replies = thread.get("replies") or ctx.get("replies") or []
    if thread.get("missing_ids"):
        b["missing_context"].append(f"{len(thread['missing_ids'])} thread posts listed but not stored")
    for i, t in enumerate(self_thread, start=2):
        e = _post(t, "op_followup")
        e["n"] = f"T{i}"
        b["op_followups"].append(e)
        urls += [(u, e["ref"]) for u in t.get("urls") or []]
    for r in replies:
        e = _post(r, f"reply:@{r.get('author_handle')}")
        e["is_op"] = (r.get("author_handle") or "").lower() == (post.get("author_handle") or "").lower()
        if e["is_op"]:
            e["ref"] = "op_followup"
        b["replies"].append(e)
        urls += [(u, e["ref"]) for u in r.get("urls") or []]
    b["replies"] = b["replies"][:40]
    captured = bool(ctx.get("thread_captured"))
    if not captured:
        b["missing_context"].append("thread not captured: OP follow-ups and replies unseen")
    elif not b["replies"]:
        b["missing_context"].append("thread captured but no replies loaded")
    for m in post.get("media") or []:
        if m.get("type") in ("video", "animated_gif"):
            b["missing_context"].append(f"{m['type']} not transcribed")
        elif m.get("type") == "photo":
            b["missing_context"].append("photo content not described (no OCR in the runner)")
    _attach_sources(b, urls, worker)
    return b, captured


def board_jobs(board):
    def get(url):
        status, body, _ = curl(url)
        if status != "200":
            return {"ok": False, "error": f"HTTP {status}"}
        return {"ok": True, "jobs": [{"id": str(j["id"]), "title": j["title"], "url": j.get("absolute_url"),
                                      "location": (j.get("location") or {}).get("name")} for j in json.loads(body)["jobs"]]}
    return cached(f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs", get)


def watcher_bundle(worker, candidate):
    b = {"kind": "watcher_event", "candidate_id": candidate["id"], "url": candidate.get("url"),
         "title": candidate.get("title"), "ref": candidate.get("ref"), "sources": [], "missing_context": []}
    if candidate.get("url"):
        _attach_sources(b, [(candidate["url"], "watcher event")], worker)
    else:
        b["missing_context"].append("watcher event has no URL")
    # Other open postings of the same program (title before the first comma), so tracks and locations of
    # one program are compared in one proposal instead of judged one by one.
    for s in b["sources"]:
        if s.get("kind") == "job" and s.get("ok"):
            jobs = board_jobs(s["board"])
            family = (s.get("title") or "").split(",")[0].strip().lower()
            b["sibling_postings"] = [j for j in jobs.get("jobs", []) if j["id"] != s["job_id"]
                                     and j["title"].split(",")[0].strip().lower() == family]
    return b


def bundle_text(b):
    """Lower-cased, whitespace-normalized text of everything a citation may quote."""
    parts = []

    def walk(o):
        if isinstance(o, str):
            parts.append(o)
        elif isinstance(o, dict):
            for k, v in o.items():
                if k not in ("url", "ref", "id", "github_links", "final_url", "found_in"):
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk({k: v for k, v in b.items() if k != "missing_context"})
    return norm_ws(" ".join(parts))


def norm_ws(s):
    return re.sub(r"\s+", " ", s or "").strip().lower()


def refs(b):
    """Every citation `where` value this bundle supports."""
    out = {"op"} if b.get("op") else set()
    out |= {e["ref"] for e in b.get("op_followups", []) + b.get("replies", [])}
    out |= {s["ref"] for s in b.get("sources", [])}
    if b.get("quoted"):
        out.add(b["quoted"]["ref"])
    return out
