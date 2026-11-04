"""Step 1: build one context bundle per saved post.

Inputs are the Oct 26 archive (posts, self-threads, judged replies) and the gold files
(OP reply candidates the judge did not keep). Linked primary sources are fetched once and
cached under cache/: GitHub repos and gists through `gh api`, arXiv through its export API,
X posts and Articles through api.fxtwitter.com, everything else with curl. Each bundle lists
the context it could not get.

Fetched pages are untrusted data. They are stored as text and passed to models as quoted
material; nothing here executes them.
"""
import concurrent.futures as cf
import hashlib
import html
import json
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVAL = Path("/Users/samgu/Programming Projects/x-bookmarks-eval")
CACHE = ROOT / "cache"
BUNDLES = ROOT / "bundles"
PAGE_CHARS = 6000
README_CHARS = 7000
MAX_FETCH_PER_POST = 8
URL_RE = re.compile(r"https?://[^\s)\]>\"']+")
X_STATUS_RE = re.compile(r"(?:x|twitter)\.com/[^/]+/(?:status|article)/(\d+)")


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
        if tag == "meta" and a.get("content") and (a.get("name") in ("description",) or a.get("property") in ("og:description", "og:title")):
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


def run(cmd, timeout=40):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def cached(url, fn):
    path = CACHE / (hashlib.sha1(url.encode()).hexdigest()[:16] + ".json")
    if path.exists():
        return json.loads(path.read_text())
    try:
        rec = fn(url)
    except Exception as e:  # recorded, never hidden: shows up in the bundle's missing list
        rec = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    rec["url"] = url
    path.write_text(json.dumps(rec))
    return rec


def fetch_page(url):
    code, out, err = run(["curl", "-sL", "--max-time", "25", "--max-filesize", "3000000",
                          "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
                          "-w", "\n__HTTP__%{http_code} %{url_effective}", url])
    if code != 0:
        return {"ok": False, "kind": "page", "error": f"curl exit {code}"}
    body, _, meta = out.rpartition("\n__HTTP__")
    status, _, final = meta.partition(" ")
    p = _Text()
    try:
        p.feed(body)
    except Exception:
        pass
    text = html.unescape(re.sub(r"\s+", " ", " ".join(p.parts)))
    gh = sorted(set(re.findall(r"https?://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", body)))
    ok = status.startswith("2") and len(text) >= 300
    return {"ok": ok, "kind": "page", "http": status, "final_url": final, "title": p.title.strip()[:200],
            "text": text[:PAGE_CHARS], "chars": len(text), "github_links": gh[:10],
            "error": None if ok else (f"HTTP {status}" if not status.startswith("2") else f"thin page ({len(text)} chars), likely rendered by JavaScript")}


def fetch_repo(url):
    m = re.match(r"https?://github\.com/([^/]+)/([^/#?]+)", url)
    owner, repo = m.group(1), m.group(2).removesuffix(".git")
    code, out, err = run(["gh", "api", f"repos/{owner}/{repo}"])
    if code != 0:
        return {"ok": False, "kind": "repo", "error": err.strip()[:200]}
    meta = json.loads(out)
    code, readme, err = run(["gh", "api", f"repos/{owner}/{repo}/readme", "-H", "Accept: application/vnd.github.raw"])
    return {"ok": True, "kind": "repo", "full_name": meta.get("full_name"), "description": meta.get("description"),
            "stars": meta.get("stargazers_count"), "pushed_at": meta.get("pushed_at"), "license": (meta.get("license") or {}).get("spdx_id"),
            "language": meta.get("language"), "topics": meta.get("topics"),
            "readme": readme[:README_CHARS] if code == 0 else None, "readme_chars": len(readme) if code == 0 else 0,
            "error": None if code == 0 else "no README"}


def fetch_github_other(url):
    """PRs, blobs and org pages."""
    m = re.match(r"https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)", url)
    if m:
        code, out, err = run(["gh", "api", f"repos/{m.group(1)}/{m.group(2)}/pulls/{m.group(3)}"])
        if code != 0:
            return {"ok": False, "kind": "pr", "error": err.strip()[:200]}
        j = json.loads(out)
        return {"ok": True, "kind": "pr", "title": j.get("title"), "state": j.get("state"), "merged": j.get("merged_at") is not None,
                "text": (j.get("body") or "")[:PAGE_CHARS]}
    m = re.match(r"https?://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.+)", url)
    if m:
        code, out, err = run(["gh", "api", f"repos/{m.group(1)}/{m.group(2)}/contents/{m.group(4)}?ref={m.group(3)}",
                              "-H", "Accept: application/vnd.github.raw"])
        return {"ok": code == 0, "kind": "file", "text": out[:PAGE_CHARS], "error": None if code == 0 else err.strip()[:200]}
    m = re.match(r"https?://github\.com/([^/#?]+)/?$", url)
    if m:
        code, out, err = run(["gh", "api", f"users/{m.group(1)}"])
        j = json.loads(out) if code == 0 else {}
        return {"ok": code == 0, "kind": "org", "text": json.dumps({k: j.get(k) for k in ("name", "bio", "blog", "public_repos")}), "error": None if code == 0 else err.strip()[:200]}
    return fetch_repo(url)


def fetch_gist(url):
    gid = url.rstrip("/").split("/")[-1].split("#")[0]
    code, out, err = run(["gh", "api", f"gists/{gid}"])
    if code != 0:
        return {"ok": False, "kind": "gist", "error": err.strip()[:200]}
    j = json.loads(out)
    files = {n: (f.get("content") or "")[:4000] for n, f in list(j.get("files", {}).items())[:4]}
    return {"ok": True, "kind": "gist", "description": j.get("description"), "files": files}


def fetch_arxiv(url):
    aid = re.search(r"arxiv\.org/(?:abs|pdf)/([0-9.]+v?\d*)", url).group(1)
    code, out, err = run(["curl", "-sL", "--max-time", "25", f"http://export.arxiv.org/api/query?id_list={aid}"])
    title = re.search(r"<entry>.*?<title>(.*?)</title>", out, re.S)
    summ = re.search(r"<summary>(.*?)</summary>", out, re.S)
    if not summ:
        return {"ok": False, "kind": "arxiv", "error": "no abstract in arXiv API response"}
    return {"ok": True, "kind": "arxiv", "title": re.sub(r"\s+", " ", title.group(1)).strip() if title else "",
            "text": re.sub(r"\s+", " ", summ.group(1)).strip()}


def fetch_x(url):
    sid = X_STATUS_RE.search(url).group(1)
    code, out, err = run(["curl", "-s", "--max-time", "20", f"https://api.fxtwitter.com/status/{sid}"])
    try:
        t = json.loads(out)["tweet"]
        assert t
    except Exception:
        return {"ok": False, "kind": "x", "error": "fxtwitter returned no post (deleted, private or an Article id)"}
    art = t.get("article")
    art_text = None
    if art:
        blocks = (art.get("content") or {}).get("blocks") or []
        art_text = (art.get("title", "") + "\n" + "\n".join(b.get("text", "") for b in blocks))[:PAGE_CHARS * 2]
    q = t.get("quote")
    return {"ok": True, "kind": "x", "author": (t.get("author") or {}).get("screen_name"), "created_at": t.get("created_at"),
            "text": t.get("text"), "article": art_text,
            "quote": {"author": (q.get("author") or {}).get("screen_name"), "text": q.get("text")} if q else None}


def fetch(url):
    u = url.split("?s=")[0]
    if X_STATUS_RE.search(u):
        return cached(u, fetch_x)
    if "gist.github.com" in u:
        return cached(u, fetch_gist)
    if re.match(r"https?://github\.com/", u):
        return cached(u, fetch_github_other)
    if "arxiv.org/" in u:
        return cached(u, fetch_arxiv)
    return cached(u, fetch_page)


def norm(u):
    u = u.rstrip(".,;:!?…").split("?s=")[0]
    u = re.sub(r"^http://", "https://", u)
    if re.match(r"https://github\.com/[^/]+/[^/]+/?$", u):
        u = u.rstrip("/").removesuffix(".git")
    return u


def build(pid, post, thread, replies, op_cands):
    op = post["author_handle"]
    items, missing, urls = [], [], []

    def add_urls(text, source):
        for u in URL_RE.findall(text or ""):
            if "t.co/" in u or "pbs.twimg.com" in u or "video.twimg.com" in u:
                continue
            urls.append((norm(u), source))

    b = {"id": pid, "url": post["url"], "op": op, "author_name": post["author_name"], "created_at": post["created_at"],
         "saved_on": post["saved_on"], "op_text": post["text"]}
    add_urls(post["text"], "OP")
    for l in post["links"]:
        urls.append((norm(l.get("expanded") or l["url"]), "OP link"))
    for r in post["repos"]:
        urls.append((norm(r), "OP repo"))
    b["media"] = []
    for m in post["media"]:
        e = {"kind": m["kind"]}
        if m.get("ocr_text"):
            e["text_in_image"] = m["ocr_text"][:2500]
        elif m["kind"] in ("video", "gif"):
            missing.append(f"{m['kind']} content ({m.get('duration_s') or '?'} s) not transcribed or described")
        elif m.get("has_text") is not False:
            missing.append("image content seen only as OCR text (none extracted for this image)")
        b["media"].append(e)
    if post["media"] and any(m["kind"] in ("photo", "image") for m in post["media"]):
        missing.append("images represented by OCR text only; no visual description")
    # OP self-thread: T1 is the saved post, T2.. are the author's other posts in order.
    b["thread"] = []
    for i, o in enumerate(thread.get("other_posts", []), start=2):
        b["thread"].append({"ref": f"T{i}", "id": o["id"], "text": o["text"]})
        add_urls(o["text"], f"OP thread T{i}")
    if not thread.get("complete", True):
        missing.append("author self-thread marked incomplete in gold")
    if post["quoted"]:
        q = post["quoted"]
        b["quoted"] = {"url": q.get("url"), "text": q.get("text")}
        add_urls(q.get("text"), "quoted post")
        if q.get("url"):
            fx = fetch(q["url"])
            if fx.get("ok"):
                b["quoted"]["author"] = fx.get("author")
                if fx.get("article"):
                    b["quoted"]["article"] = fx["article"]
                if fx.get("quote"):
                    b["quoted"]["its_quote"] = fx["quote"]
                if fx.get("text") and len(fx["text"]) > len(q.get("text") or ""):
                    b["quoted"]["text"] = fx["text"]
                add_urls(fx.get("text"), "quoted post")
    # Replies: judged-relevant ones from the archive, then OP replies the judge did not keep.
    seen, reps = set(), []
    for r in replies:
        seen.add(r["id"])
        reps.append({"author": r["author_handle"], "is_op": r["author_handle"].lower() == op.lower(), "text": r["text"],
                     "why_kept": r.get("why"), "source": "judged relevant"})
    for r in op_cands:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        reps.append({"author": r["author_handle"], "is_op": True, "text": r["text"], "source": "OP reply candidate (unjudged)"})
    reps.sort(key=lambda r: (not r["is_op"],))
    reps = reps[:30]
    for i, r in enumerate(reps, start=1):
        r["ref"] = f"R{i}"
        add_urls(r["text"], f"reply R{i} @{r['author']}")
    b["replies"] = reps
    if not reps:
        missing.append("no replies captured (none judged relevant, or reply views not loaded)")
    # Fetch linked primary sources (deduped, capped).
    order, src = [], {}
    for u, s in urls:
        if u not in src:
            order.append(u)
            src[u] = s
    if len(order) > MAX_FETCH_PER_POST:
        missing.append(f"{len(order) - MAX_FETCH_PER_POST} linked URLs not fetched (cap {MAX_FETCH_PER_POST})")
    b["sources"] = []
    for u in order[:MAX_FETCH_PER_POST]:
        if X_STATUS_RE.search(u) and post["quoted"] and (post["quoted"].get("url") or "").split("?")[0] == u:
            continue
        if "/i/article/" in u and (b.get("quoted") or {}).get("article"):
            continue  # fxtwitter cannot resolve a bare Article id; the quoted post already carries this Article
        rec = fetch(u)
        rec = {k: v for k, v in rec.items() if v not in (None, "", [], {})}
        rec["found_in"] = src[u]
        b["sources"].append(rec)
        if not rec.get("ok"):
            missing.append(f"source not readable: {u} ({rec.get('error', 'unknown')})")
        # The repo behind a linked site matters to Sam; follow one GitHub link from a page.
        if rec.get("kind") == "page" and rec.get("github_links"):
            cands = [g for g in rec["github_links"] if not re.search(r"github\.com/(sponsors|features|about|login|orgs)/", g)]
            if cands and not any(norm(c) in src for c in cands):
                g = norm(cands[0])
                src[g] = f"GitHub link on {u}"
                gr = {k: v for k, v in fetch(g).items() if v not in (None, "", [], {})}
                gr["found_in"] = src[g]
                b["sources"].append(gr)
    b["missing_context"] = missing
    return b


def main():
    d = json.loads((EVAL / "archive/2026-10-26/data.json").read_text())
    threads = {t["root_id"]: t for t in d["threads"]}
    by_root = {}
    for r in d["replies"]:
        by_root.setdefault(r["root_id"], []).append(r)
    op_cands = {}
    for acct in ("sdotgu", "_sgu_"):
        g = json.loads((EVAL / f"gold/{acct}.json").read_text())
        for r in g.get("op_reply_candidates", []):
            op_cands.setdefault(r["root_id"], []).append(r)
    BUNDLES.mkdir(exist_ok=True)
    CACHE.mkdir(exist_ok=True)
    only = set(sys.argv[1:])

    def one(pid):
        b = build(pid, d["posts"][pid], threads.get(pid, {}), by_root.get(pid, []), op_cands.get(pid, []))
        (BUNDLES / f"{pid}.json").write_text(json.dumps(b, indent=1, ensure_ascii=False))
        return pid, len(b["sources"]), len(b["missing_context"])

    ids = [p for p in d["posts"] if not only or p in only]
    with cf.ThreadPoolExecutor(8) as ex:
        for pid, ns, nm in ex.map(one, ids):
            print(pid, "sources", ns, "missing", nm)


if __name__ == "__main__":
    main()
