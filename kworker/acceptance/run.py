"""Step-1 acceptance for the ten saves in acceptance/saves.py, against a
Worker under `wrangler dev` (acceptance/stack.mjs).

  python -m acceptance.run first  --base URL --archive PATH   seed positives, queue the saves, run kworker
  python -m acceptance.run rerun  --base URL --archive PATH   same saves from a fresh copy of kworker/ (new venv, no files)
  python -m acceptance.run check  --base URL --archive PATH   read every bundle through the MCP tools and compare with gold
  python -m acceptance.run report --base URL                  numbers per save from the job records

Evidence goes to acceptance/evidence/. Tokens come from worker/.dev.vars
(random local values the harness writes), never from production.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path

import httpx

from acceptance.saves import SAVES

KWORKER = Path(__file__).resolve().parents[1]
REPO = KWORKER.parent
EVIDENCE = KWORKER / "acceptance" / "evidence"


def dev_vars() -> dict:
    out = {}
    for line in (REPO / "worker" / ".dev.vars").read_text(encoding="utf-8").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def api(base: str, token: str) -> httpx.Client:
    return httpx.Client(base_url=base, headers={"authorization": f"Bearer {token}"}, timeout=120)


def kworker_env(base: str) -> dict:
    v = dev_vars()
    env = {k: val for k, val in os.environ.items() if not k.startswith("R2_")}
    env.update(KNOWLEDGE_URL=base, KNOWLEDGE_TOKEN=v["KNOWLEDGE_TOKEN"], KWORKER_LARGE_VIA_WORKER="1", PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    return env


def run_kworker(folder: Path, python: Path, args: list[str], base: str, log: Path) -> float:
    t0 = time.monotonic()
    with log.open("a", encoding="utf-8") as f:
        f.write(f"\n$ kworker {' '.join(args)}\n")
        f.flush()
        r = subprocess.run([str(python), "-m", "kworker", *args], cwd=folder, env=kworker_env(base), stdout=f, stderr=subprocess.STDOUT)
    if r.returncode not in (0, 1):
        raise SystemExit(f"kworker {args[0]} exited {r.returncode}; see {log}")
    return time.monotonic() - t0


def jobs(base: str) -> list[dict]:
    v = dev_vars()
    with api(base, v["KNOWLEDGE_TOKEN"]) as c:
        rows = []
        for kind in ("save", "link", "image", "video", "bundle"):
            rows += c.get("/k/jobs", params={"kind": kind}).json()["jobs"]
    for r in rows:
        for k in ("payload", "result"):
            if isinstance(r.get(k), str) and r[k]:
                r[k] = json.loads(r[k])
    return rows


def seed_positives(base: str, root: Path) -> int:
    """The archive's other 59 saves, so the gate scores against Sam's taste
    without seeing the ten it is judged on."""
    data = json.loads((root / "archive/2026-10-26/data.json").read_text(encoding="utf-8"))
    items = [
        {"id": f"eval-2026-10-26-{pid}", "text": p["text"], "author_handle": p["author_handle"], "source": "x-bookmarks-eval archive/2026-10-26"}
        for pid, p in data["posts"].items()
        if pid not in SAVES and p["text"].strip()
    ]
    with api(base, dev_vars()["ADMIN_TOKEN"]) as c:
        r = c.post("/positives", json={"items": items})
        r.raise_for_status()
    return len(items)


def cmd_first(a) -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    log = EVIDENCE / "run1.log"
    n = seed_positives(a.base, a.archive)
    py = KWORKER / ".venv" / "Scripts" / "python.exe"
    run_kworker(KWORKER, py, ["enqueue-archive", "--archive", str(a.archive), "--acceptance"], a.base, log)
    wall = run_kworker(KWORKER, py, ["run"], a.base, log)
    (EVIDENCE / "run1.json").write_text(json.dumps({"positives": n, "wall_s": round(wall, 1), "jobs": jobs(a.base)}, indent=1), encoding="utf-8")
    print(f"first run: {wall:.0f}s; positives {n}")


def cmd_rerun(a) -> None:
    """A fresh copy of kworker/ from git (no venv, no caches, no files), then
    the same saves again. Proves nothing pipeline-related lives in the folder."""
    log = EVIDENCE / "run2.log"
    fresh = Path(tempfile.mkdtemp(prefix="kworker-wiped-"))
    archive_tar = fresh / "src.tar"
    subprocess.run(["git", "-C", str(REPO), "archive", "--format=tar", "-o", str(archive_tar), "HEAD", "kworker"], check=True)
    with tarfile.open(archive_tar) as t:
        t.extractall(fresh, filter="data")
    folder = fresh / "kworker"
    subprocess.run([sys.executable, "-m", "venv", str(folder / ".venv")], check=True)
    py = folder / ".venv" / "Scripts" / "python.exe"
    subprocess.run([str(py), "-m", "pip", "install", "-q", "-r", str(folder / "requirements.txt")], check=True)
    before = {r["id"]: r.get("runs") for r in jobs(a.base)}
    t0 = time.time()
    run_kworker(folder, py, ["enqueue-archive", "--archive", str(a.archive), "--acceptance", "--again"], a.base, log)
    wall = run_kworker(folder, py, ["run"], a.base, log)
    rows = [r for r in jobs(a.base) if r.get("runs") != before.get(r["id"]) or r["id"] not in before]
    total = Counter()
    hits = Counter()
    for r in rows:
        st = (r.get("result") or {}).get("stats") or {}
        total["fetches"] += st.get("fetches", 0)
        total["model_calls"] += st.get("model_calls", 0)
        total["uploaded_bytes"] += st.get("uploaded_bytes", 0)
        hits.update(st.get("cache_hits", {}))
    out = {"folder": str(folder), "wall_s": round(wall, 1), "jobs_rerun": len(rows), "totals": dict(total), "cache_hits": dict(hits), "jobs": rows}
    (EVIDENCE / "run2.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(json.dumps({k: out[k] for k in ("wall_s", "jobs_rerun", "totals", "cache_hits")}, indent=1))
    shutil.rmtree(fresh, ignore_errors=True)


class Mcp:
    """A bare JSON-RPC client: the only state it has is the URL and a token."""

    def __init__(self, base: str, token: str):
        self.c = httpx.Client(base_url=base, headers={"authorization": f"Bearer {token}", "content-type": "application/json", "accept": "application/json"}, timeout=60)
        self.n = 0

    def rpc(self, method: str, params: dict) -> dict:
        self.n += 1
        r = self.c.post("/mcp", json={"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        r.raise_for_status()
        j = r.json()
        if "error" in j:
            raise RuntimeError(f"{method}: {j['error']}")
        return j["result"]

    def tool(self, name: str, args: dict) -> dict:
        res = self.rpc("tools/call", {"name": name, "arguments": args})
        if res.get("isError"):
            raise RuntimeError(f"{name}: {res['content'][0]['text']}")
        return res["structuredContent"]


def _norm(t: str | None) -> str:
    return " ".join((t or "").split())


def _reply_key(t: str) -> str:
    from kworker.gate import bare

    return _norm(bare(t))


def cmd_check(a) -> None:
    root = a.archive
    gold_posts, gold_threads = {}, {}
    for acct in ("sdotgu", "_sgu_"):
        g = json.loads((root / f"gold/{acct}.json").read_text(encoding="utf-8"))
        gold_posts.update(g["posts"])
        for t in g["threads"]:
            for pid in t["post_ids"]:
                gold_threads.setdefault(pid, t["post_ids"])
    media_index = json.loads((root / "archive/2026-10-26/media-index.json").read_text(encoding="utf-8"))["items"]
    data = json.loads((root / "archive/2026-10-26/data.json").read_text(encoding="utf-8"))

    m = Mcp(a.base, dev_vars()["MAIL_T3_TOKEN"])
    listed = {t["name"] for t in m.rpc("tools/list", {})["tools"]}
    has = m.tool("knowledge_has", {"ids": list(SAVES), "urls": ["https://bencho.dev", "http://fx0.vercel.dev"]})
    search = m.tool("knowledge_search", {"query": "og:video", "k": 5})
    bundles_dir = EVIDENCE / "bundles"
    bundles_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for pid, what in SAVES.items():
        # One section per call, so a long media or links section cannot push
        # the fields compared below out of the 48 KiB answer.
        bj, cut = {}, []
        for sec in ("front", "post", "thread", "quoted", "replies", "media", "repos", "markdown"):
            r = m.tool("knowledge_bundle", {"post_id": pid, "sections": [sec]})
            bj[sec] = r["sections_untrusted"].get(sec)
            if r.get("truncated") or r.get("omitted"):
                cut.append(sec)
        # The whole bundle.md, paged through knowledge_blob by the sha the
        # bundle names, so a long page is read in full through MCP alone.
        bj.pop("markdown")
        chunks, offset = [], 0
        while offset is not None:
            part = m.tool("knowledge_blob", {"key": f"sha256/{r['md_sha']}", "offset": offset, "length": 65536})
            chunks.append(part["data_untrusted"].encode("utf-8") if part["encoding"] == "utf8" else base64.b64decode(part["data_untrusted"]))
            offset = part["next_offset"]
        (bundles_dir / f"{pid}.md").write_bytes(b"".join(chunks))
        bj["completeness"] = (bj.get("front") or {}).get("completeness")
        bj["missing"] = (bj.get("front") or {}).get("missing")
        g = gold_posts[pid]
        want_media = sorted(x["sha256"] for x in media_index if x["post_id"] == pid)
        got_media = sorted(x["sha256"] for x in (bj.get("media") or []) if x.get("post_id") == pid and x.get("sha256"))
        want_repos = sorted(r.lower() for r in g.get("repos", []))
        got_repos = sorted(r["url"].lower() for r in (bj.get("repos") or []))
        thread_want = gold_threads.get(pid, [pid])
        thread_got = [t["id"] for t in (bj.get("thread") or [])]
        # The archive holds some replies twice, with and without the leading
        # @mention, so replies compare by their text after the mentions.
        kept_truth = {_reply_key(r["text"]) for r in data["replies"] if r["root_id"] == pid}
        kept_got = {_reply_key(r["text"]) for r in (bj.get("replies") or [])}
        rows.append(
            {
                "post_id": pid,
                "what": what,
                "cut_sections": cut,
                "text_match": _norm((bj.get("post") or {}).get("text")) == _norm(g["text"]),
                "thread_match": thread_got == thread_want,
                "thread": {"want": thread_want, "got": thread_got},
                "media_match": got_media == want_media,
                "media": {"want": want_media, "got": got_media},
                "repos_match": got_repos == want_repos,
                "repos_recall": f"{len(set(want_repos) & set(got_repos))}/{len(want_repos)}",
                "repos": {"want": want_repos, "got": got_repos},
                "completeness": bj.get("completeness"),
                "missing": bj.get("missing"),
                "replies_kept": len(kept_got),
                "replies_in_archive": len(kept_truth),
                "replies_overlap": len(kept_truth & kept_got),
                "ocr_uncertain": [x["id"] for x in (bj.get("media") or []) if (x.get("image") or {}).get("ocr_uncertain")],
            }
        )
    blob_check = None
    first_media = next((r["media"]["got"][0] for r in rows if r["media"]["got"]), None)
    if first_media:
        part = m.tool("knowledge_blob", {"key": f"sha256/{first_media}", "offset": 0, "length": 64})
        blob_check = {k: (v if k != "data_untrusted" else f"{len(v)} chars") for k, v in part.items()}
    out = {"tools_listed": sorted(listed), "has": has, "search_og_video": search, "blob": blob_check, "saves": rows}
    (EVIDENCE / "mcp-check.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    for r in rows:
        print(r["post_id"], "text", r["text_match"], "thread", r["thread_match"], "media", r["media_match"], "repos", r["repos_match"], r["repos_recall"], r["completeness"])


def cmd_report(a) -> None:
    rows = jobs(a.base)
    by_save: dict[str, list[dict]] = defaultdict(list)
    key_to_save = {}
    for r in rows:
        if r["kind"] == "bundle":
            for c in r["payload"]["children"]:
                key_to_save[(c["kind"], c["key"])] = r["key"]
    run1 = json.loads((EVIDENCE / "run1.json").read_text(encoding="utf-8"))["jobs"]
    for r in run1:
        save = r["key"] if r["kind"] in ("save", "bundle") else key_to_save.get((r["kind"], r["key"]))
        if save in SAVES:
            by_save[save].append(r)
    table = []
    for pid in SAVES:
        tok = Counter()
        wall = 0.0
        uploaded = 0
        calls = Counter()
        for r in by_save[pid]:
            env = r.get("result") or {}
            st = env.get("stats") or {}
            tok.update(st.get("tokens", {}))
            calls.update(st.get("model_calls_by_model", {}))
            wall += env.get("wall_s") or 0
            uploaded += st.get("uploaded_bytes", 0)
        table.append({"post_id": pid, "what": SAVES[pid], "wall_s": round(wall, 1), "uploaded_bytes": uploaded, "tokens": dict(tok), "model_calls": dict(calls), "jobs": len(by_save[pid])})
    (EVIDENCE / "report.json").write_text(json.dumps(table, indent=1), encoding="utf-8")
    for t in table:
        print(t["post_id"], t["wall_s"], t["uploaded_bytes"], t["tokens"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["first", "rerun", "check", "report"])
    ap.add_argument("--base", default="http://127.0.0.1:8871")
    ap.add_argument("--archive", type=Path, default=Path.home() / "Programming Projects" / "x-bookmarks-eval")
    a = ap.parse_args()
    {"first": cmd_first, "rerun": cmd_rerun, "check": cmd_check, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    main()
