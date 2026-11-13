"""Bundle jobs: code, no model. Reads the save's expansion, the gate's
decisions and its children's results, and writes `bundle.json`
(schema kbundle/1, docs/KNOWLEDGE.md) and `bundle.md`, the verbatim archive
entry Sam and his agents read (x-bookmarks-eval baseline/CONVENTIONS.md)."""

from __future__ import annotations

import json
from urllib.parse import urlsplit

from . import models
from .api import canonical_json
from .ctx import Ctx
from .links import TEXT_MAX

SEARCH_MAX = 60_000


def _job_results(ctx: Ctx, children: list[dict]) -> dict[tuple[str, str], dict]:
    out = {}
    for c in children:
        rows = ctx.api.call("GET", "/k/jobs", params={"kind": c["kind"], "key": c["key"]})["jobs"]
        if not rows:
            raise RuntimeError(f"child job {c['kind']}/{c['key']} not found")
        row = rows[0]
        envelope = row.get("result")
        if isinstance(envelope, str):
            envelope = json.loads(envelope) if envelope else None
        # jobs.run_one stores {result, stats, wall_s}.
        result = envelope.get("result") if isinstance(envelope, dict) else None
        out[(c["kind"], c["key"])] = {"state": row["state"], "result": result, "error": row.get("error")}
    return out


def build(ctx: Ctx, payload: dict) -> dict:
    exp = ctx.api.get_json(payload["expansion_sha"])
    gate = ctx.api.get_json(payload["gate_sha"])
    results = _job_results(ctx, payload["children"])
    post = exp["post"]
    missing = list(exp.get("missing", []))

    media, media_ids = [], {}
    for c in payload["children"]:
        if c["kind"] not in ("image", "video"):
            continue
        r = results[(c["kind"], c["key"])]
        mid = f"m{len(media)}"
        media_ids[c["source_url"]] = mid
        if r["state"] != "done" or not r["result"]:
            media.append({"id": mid, "post_id": c["post_id"], "kind": c["media_kind"], "source_url": c["source_url"], "sha256": None, "error": r["error"]})
            missing.append({"what": "media", "ref": c["source_url"], "reason": r["error"] or f"job {r['state']}"})
            continue
        res = r["result"]
        item = {
            "id": mid,
            "post_id": c["post_id"],
            "kind": c["media_kind"],
            "source_url": c["source_url"],
            "sha256": res["sha256"],
            "r2_key": f"sha256/{res['sha256']}",
            "mime": res["mime"],
        }
        if c["kind"] == "image":
            rd = ctx.api.get_json(res["read_sha"])
            second = None
            if res.get("second_sha"):
                second = {"text": ctx.api.get_json(res["second_sha"]).get("text", ""), "agreement": res["agreement"], "by": res["second_by"]}
            item["image"] = {
                "text": rd.get("text", ""),
                "kind": rd.get("kind"),
                "description": rd.get("description"),
                "ocr_uncertain": res["ocr_uncertain"],
                "by": res["read_by"],
                "second_reader": second,
            }
        else:
            p = res["probe"]
            rd = ctx.api.get_json(res["read_sha"])
            t = ctx.api.get_json(res["transcript_sha"]) if res.get("transcript_sha") else {"language": None, "segments": []}
            item["video"] = {
                "duration_s": p["duration_s"],
                "width": p["width"],
                "height": p["height"],
                "has_audio": p["has_audio"],
                "transcript": {"language": t.get("language"), "segments": t["segments"], "note": res.get("transcript_note"), "by": res.get("transcript_by")},
                "read": {"description": rd.get("description"), "scenes": rd.get("scenes", []), "by": res["read_by"]},
                "key_frames": [{"t": f["t"], "sha256": f["sha256"], "r2_key": f"sha256/{f['sha256']}"} for f in res["key_frames"]],
            }
        media.append(item)

    links, repos = [], {}
    for c in payload["children"]:
        if c["kind"] != "link":
            continue
        r = results[(c["kind"], c["key"])]
        res = r["result"]
        if r["state"] != "done" or not res:
            links.append({"url": c["url"], "from": c["from"], "status": "error", "rung": None, "note": r["error"], "text": None, "repo": None})
            missing.append({"what": "link", "ref": c["url"], "reason": r["error"] or f"job {r['state']}"})
            continue
        text = ctx.api.get_blob(res["text_sha"]).decode("utf-8")[:TEXT_MAX] if res.get("text_sha") else None
        link = {
            "url": c["url"],
            "canonical_url": res["canonical_url"],
            "final_url": res.get("final_url"),
            "from": c["from"],
            "title": res.get("title"),
            "rung": res["rung"],
            "status": res["status"],
            "note": res.get("note"),
            "text": text,
            "text_sha": res.get("text_sha"),
            "repo": None,
        }
        if res["status"] != "ok":
            missing.append({"what": "link", "ref": c["url"], "reason": f"{res['status']} at rung {res['rung']}: {res.get('note')}"})
        repo_meta = (res.get("meta") or {}).get("repo")
        if repo_meta:
            _add_repo(ctx, repos, repo_meta, res.get("text_sha"), "reply" if c["from"].startswith("reply:") else "link")
            link["repo"] = repo_meta["url"].lower()
        site = res.get("site_repo")
        if site and (site.get("meta") or {}).get("repo"):
            _add_repo(ctx, repos, site["meta"]["repo"], site.get("text_sha"), "site_html")
            link["repo"] = site["meta"]["repo"]["url"].lower()
        links.append(link)

    thread = [
        {
            "id": t["id"],
            "url": t["url"],
            "created_at": t.get("created_at"),
            "text": t["text"],
            "is_save": t["is_save"],
            "media": [media_ids.get(m["source_url"]) for m in t.get("media", []) if media_ids.get(m["source_url"])],
        }
        for t in exp["thread"]
    ]
    replies = [
        {
            "id": k.get("id"),
            "item_id": k["item_id"],
            "author_handle": k["author_handle"],
            "text": k["text"],
            "kept_because": k["kept_because"],
            "stage": k["stage"],
            "by": k.get("by"),
        }
        for k in gate["kept"]
    ]
    completeness = "partial" if any(m["what"] in ("media", "link") for m in missing) else "complete"
    bundle = {
        "schema": "kbundle/1",
        "post_id": post["id"],
        "url": post["url"],
        "author": {"handle": post["author_handle"], "name": post.get("author_name")},
        "created_at": post.get("created_at"),
        "saved_by": exp.get("saved_by", []),
        "completeness": completeness,
        "missing": missing,
        "expansion": {
            "source": exp["source"],
            "reply_views": exp.get("reply_views", []),
            "gate_v": gate["gate_v"],
            "kept": len(gate["kept"]),
            "dropped": len(gate["dropped"]),
            # The gate's reason for each drop, never the dropped text.
            "dropped_reasons": [{"stage": d["stage"], "reason": d["reason"]} for d in gate["dropped"]],
            "tombstone_pack": gate.get("tombstone_pack"),
        },
        "post": {"text": post["text"]},
        "thread": thread,
        "quoted": exp.get("quoted"),
        "replies": replies,
        "media": media,
        "links": links,
        "repos": sorted(repos.values(), key=lambda r: r["url"]),
    }
    bundle["verdict"] = assess(ctx, bundle)
    card = make_card(bundle)
    bundle["card"] = card
    md = render_md(bundle)
    json_sha = ctx.api.put_bytes(canonical_json(bundle).encode("utf-8"), "application/json")
    md_sha = ctx.api.put_text(md, "text/markdown; charset=utf-8")
    reg = ctx.api.call(
        "POST",
        "/k/bundles",
        {
            "post_id": post["id"],
            "md_sha": md_sha,
            "json_sha": json_sha,
            "completeness": completeness,
            "missing": missing,
            "saved_by": bundle["saved_by"],
            "author": post["author_handle"],
            "search_text": search_text(bundle)[:SEARCH_MAX],
            "card": card,
        },
    )
    return {"post_id": post["id"], "json_sha": json_sha, "md_sha": md_sha, "registered": reg, "completeness": completeness, "missing": len(missing)}


VERDICT_SCHEMA = {
    "type": "object",
    "properties": {"label": {"type": "string", "enum": ["try", "read", "reference", "skip"]}, "why": {"type": "string"}, "action": {"type": "string"}},
    "required": ["label", "why", "action"],
}
SAVE_TEXT_MAX = 9000  # characters of the save shown to the verdict model


def _save_text(b: dict) -> str:
    """The save as the verdict model sees it: verbatim text first, then what
    the pipeline read from its media and links, each part cut short."""
    parts = [f"@{b['author']['handle']}: {b['post']['text']}"]
    parts += [f"(thread) {t['text'][:600]}" for t in b["thread"] if not t["is_save"]][:6]
    if b.get("quoted"):
        parts.append(f"(quoted @{b['quoted'].get('author_handle')}) {(b['quoted'].get('text') or '')[:600]}")
    parts += [f"(reply @{r['author_handle']}) {r['text'][:300]}" for r in b["replies"][:6]]
    for m in b["media"]:
        if "image" in m:
            parts.append(f"(image) {(m['image'].get('description') or '')[:300]} Text: {(m['image'].get('text') or '')[:500]}")
        if "video" in m:
            parts.append(f"(video) {(m['video']['read'].get('description') or '')[:500]}")
    for l in b["links"]:
        parts.append(f"(link {l['status']}) {l.get('title') or l['url']}: {(l.get('text') or '')[:400]}")
    for r in b["repos"]:
        parts.append(f"(repo {r['url']}, {r.get('stars')} stars, last commit {r.get('last_commit_at')}) {r.get('description') or ''}")
    return "\n".join(parts)[:SAVE_TEXT_MAX]


def assess(ctx: Ctx, b: dict) -> dict:
    """One model call per save: is it something to try, read, keep or skip,
    and why. The morning brief is written from these."""
    text = models.prompt("save-verdict-v1").replace("{brief}", models.prompt("interest-brief-v1")).replace("{save}", _save_text(b))

    def build(cap: dict):
        if cap["prompt_v"] != "save-verdict-v1":
            return None
        return models.Request(text=text, schema=VERDICT_SCHEMA, max_output_tokens=600, thinking=False)

    res = models.run(ctx, "save_verdict", build)
    v = json.loads(res.output)
    if v.get("label") not in ("try", "read", "reference", "skip"):
        raise ValueError(f"save_verdict label {v.get('label')!r} is not try|read|reference|skip")
    return {"label": v["label"], "why": str(v.get("why", ""))[:300], "action": str(v.get("action", ""))[:200], "by": res.by.as_dict()}


CARD_MAX = 4000  # bytes; the Worker refuses a card over 4 KiB


def _cut(s: str | None, n: int) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def make_card(b: dict) -> dict:
    """The save as GET /k/digest returns it (docs/KNOWLEDGE.md, "Daily loop")."""
    gaps = [m for m in b["missing"] if m["what"] in ("media", "link")]
    status = b["completeness"]
    if gaps and all("blocked" in m["reason"] for m in gaps):
        status = "blocked"
    repo_by_url = {r["url"]: r for r in b["repos"]}
    links = []
    for l in b["links"][:5]:
        item = {"url": l.get("final_url") or l["url"], "title": _cut(l.get("title"), 80) or None, "status": l["status"]}
        r = repo_by_url.get(l.get("repo") or "")
        if r:
            item["repo"] = {"name": r.get("full_name") or r["url"].split("github.com/")[-1], "stars": r.get("stars"), "last_commit": r.get("last_commit_at")}
        links.append(item)
    for r in b["repos"]:
        if len(links) < 5 and not any((x.get("repo") or {}).get("name") == r.get("full_name") for x in links):
            links.append({"url": r["url"], "title": _cut(r.get("description"), 80) or None, "status": "ok",
                          "repo": {"name": r.get("full_name") or r["url"].split("github.com/")[-1], "stars": r.get("stars"), "last_commit": r.get("last_commit_at")}})
    a = b["author"]
    card = {
        "post_id": b["post_id"],
        "url": b["url"],
        "author": f"@{a['handle']}" + (f" ({a['name']})" if a.get("name") else ""),
        "created_at": b.get("created_at"),
        "saved_by": b["saved_by"],
        "status": status,
        "missing": [_cut(f"{m['what']} {m['ref']}: {m['reason']}", 160) for m in gaps[:3]],
        "excerpt": _cut(b["post"]["text"], 280),
        "verdict": b["verdict"],
        "context": [_cut(f"@{r['author_handle']}: {r['text']}", 200) for r in b["replies"][:3]],
        "links": links,
        "media": {"photos": sum(1 for m in b["media"] if m["kind"] == "photo"), "videos": sum(1 for m in b["media"] if m["kind"] in ("video", "gif"))},
    }
    # Shrink the longest parts until the card fits.
    while len(canonical_json(card).encode("utf-8")) > CARD_MAX:
        if card["context"]:
            card["context"].pop()
        elif len(card["links"]) > 1:
            card["links"].pop()
        else:
            card["excerpt"] = _cut(card["excerpt"], max(40, len(card["excerpt"]) // 2))
    return card


def _add_repo(ctx: Ctx, repos: dict, meta: dict, text_sha: str | None, via: str) -> None:
    url = meta["url"].lower()
    if url in repos:
        return
    readme = ctx.api.get_blob(text_sha).decode("utf-8") if text_sha else ""
    last = meta.get("last_commit") or {}
    repos[url] = {
        "url": url,
        "full_name": meta.get("full_name"),
        "description": meta.get("description"),
        "stars": meta.get("stars"),
        "last_commit_at": last.get("date"),
        "last_commit": last.get("sha"),
        "license": meta.get("license"),
        "archived": meta.get("archived"),
        "readme_sha": text_sha,
        "readme_excerpt": readme[:3000],
        "found_via": via,
    }


def search_text(b: dict) -> str:
    parts = [b["post"]["text"]]
    parts += [t["text"] for t in b["thread"] if not t["is_save"]]
    if b.get("quoted"):
        parts.append(b["quoted"].get("text") or "")
    parts += [r["text"] for r in b["replies"]]
    for m in b["media"]:
        if "image" in m:
            parts += [m["image"]["text"], m["image"].get("description") or ""]
        if "video" in m:
            parts.append(m["video"]["read"].get("description") or "")
            parts += [s["text"] for s in m["video"]["transcript"]["segments"]]
    for l in b["links"]:
        parts += [l.get("title") or "", (l.get("text") or "")[:3000]]
    for r in b["repos"]:
        parts += [r["url"], r.get("description") or ""]
    return "\n".join(p for p in parts if p)


# ---- markdown ----


def _quote(text: str) -> str:
    return "\n".join("> " + line if line else ">" for line in text.splitlines()) or ">"


def _fence(text: str) -> str:
    ticks = "````" if "```" in text else "```"
    return f"{ticks}text\n{text}\n{ticks}"


def _by(by: dict | None) -> str:
    return f"{by['provider']} {by['model']}, prompt {by['prompt_v']}" if by else "code"


def _when(iso: str | None) -> str:
    return iso.replace("T", " ").replace("Z", " UTC") if iso else "time unknown"


RUNGS = {0: "site adapter", 1: "plain fetch", 2: "rendered page", 3: "archived copy", 4: "headed browser", 7: "every rung failed"}


def render_md(b: dict) -> str:
    a = b["author"]
    out = [
        "---",
        f"post_id: \"{b['post_id']}\"",
        f"url: {b['url']}",
        f"author: \"@{a['handle']}\"" + (f"  # {a['name']}" if a.get("name") else ""),
        f"created_at: {b.get('created_at')}",
        f"saved_by: [{', '.join(b['saved_by'])}]",
        f"completeness: {b['completeness']}",
        f"schema: {b['schema']}",
        "missing:" + ("" if b["missing"] else " []"),
    ]
    out += [f"  - {m['what']}: {json.dumps(m['ref'])}  # {m['reason']}" for m in b["missing"]]
    out += ["---", ""]
    out += [f"# @{a['handle']}" + (f" ({a['name']})" if a.get("name") else "") + f" · {_when(b.get('created_at'))}", "", f"<{b['url']}>", "", _quote(b["post"]["text"]), ""]

    v = b.get("verdict")
    if v:
        out += [f"**{v['label']}**: {v['why']}" + (f" Next: {v['action']}" if v.get("action") else "") + f" ({_by(v['by'])})", ""]

    media_by_id = {m["id"]: m for m in b["media"]}
    save_media = next((t["media"] for t in b["thread"] if t["is_save"]), [])
    if save_media:
        out += ["Media in this post: " + ", ".join(f"[{mid}](#{mid}) {media_by_id[mid]['kind']}" for mid in save_media), ""]

    if b.get("quoted"):
        q = b["quoted"]
        out += [f"## Quoted post" + (f" by @{q['author_handle']}" if q.get("author_handle") else ""), "", f"<{q['url']}>" if q.get("url") else "", "", _quote(q.get("text") or ""), ""]

    if len(b["thread"]) > 1:
        out += [f"## Self-thread ({len(b['thread'])} posts by @{a['handle']}, in order)", ""]
        for i, t in enumerate(b["thread"], 1):
            if t["is_save"]:
                out += [f"{i}. [{t['id']}]({t['url']}) · {_when(t.get('created_at'))} (the saved post, quoted at the top)", ""]
                continue
            out += [f"{i}. [{t['id']}]({t['url']}) · {_when(t.get('created_at'))}", ""]
            out += ["   " + line for line in _quote(t["text"]).splitlines()]
            if t["media"]:
                out += ["", "   Media: " + ", ".join(f"[{mid}](#{mid}) {media_by_id[mid]['kind']}" for mid in t["media"])]
            out.append("")

    e = b["expansion"]
    out += [f"## Replies kept ({e['kept']} kept, {e['dropped']} dropped by the gate)", ""]
    out += [f"Source: {e['source']}. Reply views checked: {', '.join(e['reply_views']) or 'not recorded'}. Gate: `{e['gate_v']}`.", ""]
    if not b["replies"]:
        out += ["None kept.", ""]
    if e.get("dropped_reasons"):
        out += ["Dropped, with the gate's reason (the dropped text is not kept):", ""]
        out += [f"- {d['reason']} ({d['stage']})" for d in e["dropped_reasons"]]
        out.append("")
    for r in b["replies"]:
        link = f"[{r['id']}](https://x.com/{r['author_handle']}/status/{r['id']})" if r.get("id") else "id not recorded"
        out += [f"- **@{r['author_handle']}** ({link}). Kept because: {r['kept_because']} ({r['stage']}{'; ' + _by(r['by']) if r.get('by') else ''})", ""]
        out += ["  " + line for line in _quote(r["text"]).splitlines()]
        out.append("")

    if b["media"]:
        out += ["## Media", ""]
    for m in b["media"]:
        out += [f"### {m['id']}", "", f"<a id=\"{m['id']}\"></a>{m['kind']} in post {m['post_id']}. Original: <{m['source_url']}>.", ""]
        if not m.get("sha256"):
            out += [f"Not downloaded: {m.get('error')}", ""]
            continue
        out += [f"Stored: `{m['r2_key']}` ({m['mime']}).", ""]
        if "image" in m:
            im = m["image"]
            out += [f"Text in the image, verbatim ({_by(im['by'])}):", "", _fence(im["text"] or "(no text)"), ""]
            sr = im.get("second_reader")
            if sr:
                verdict = "the readings differ: **ocr_uncertain**" if im["ocr_uncertain"] else "the readings agree"
                out += [f"Second reading ({_by(sr['by'])}): similarity {sr['agreement']}, {verdict}."]
                if im["ocr_uncertain"]:
                    out += ["", _fence(sr["text"] or "(no text)")]
                out.append("")
            out += [f"Kind: {im['kind']}. Description ({_by(im['by'])}): {im['description']}", ""]
        if "video" in m:
            v = m["video"]
            out += [f"{v['duration_s']:.1f} s, {v['width']}×{v['height']}{'' if v['has_audio'] else ', no audio'}.", ""]
            out += [f"What it shows ({_by(v['read']['by'])}): {v['read']['description']}", ""]
            if v["read"]["scenes"]:
                out += ["Scenes:", ""]
                for s in v["read"]["scenes"]:
                    out += [f"- {float(s['t']):.1f} s: {s['description']}"]
                    if (s.get("on_screen_text") or "").strip():
                        out += ["", "  On screen, verbatim:", ""] + ["  " + line for line in _fence(s["on_screen_text"].strip()).splitlines()]
                    out.append("")
            tr = v["transcript"]
            if tr["segments"]:
                out += [f"Transcript ({_by(tr['by'])}, language {tr.get('language')}), verbatim:", ""]
                out += [_fence("\n".join(f"[{s['start']:.1f}–{s['end']:.1f}] {s['text']}" for s in tr["segments"])), ""]
            else:
                out += [f"Transcript: none ({tr.get('note') or 'no speech found'}).", ""]
            if v["key_frames"]:
                out += ["Key frames: " + ", ".join(f"{f['t']:.1f} s `{f['r2_key']}`" for f in v["key_frames"]), ""]

    if b["links"]:
        out += ["## Links", ""]
    for l in b["links"]:
        title = l.get("title") or urlsplit(l.get("final_url") or l["url"]).hostname
        out += [f"### {title}", "", f"<{l['url']}>" + (f", resolved to <{l['final_url']}>" if l.get("final_url") and l["final_url"] != l["url"] else ""), ""]
        source = l["from"].replace("reply:", "a kept reply ").replace("thread:", "thread post ")
        rung = "" if l.get("rung") is None else f" at rung {l['rung']}, {RUNGS.get(l['rung'], '?')}"
        note = f" ({l['note']})" if l.get("note") else ""
        out += [f"From: {source}. Fetch: {l['status']}{rung}{note}." + (f" Repo: <{l['repo']}>." if l.get("repo") else ""), ""]
        if l.get("repo") and l["repo"] == (l.get("canonical_url") or "").lower():
            out += ["The README is under Repos.", ""]
        elif l.get("text"):
            t = l["text"]
            out += [_fence(t), ""]
            if len(t) >= TEXT_MAX:
                out += [f"The page's extracted text is longer than {TEXT_MAX:,} characters; all of it is `sha256/{l['text_sha']}`.", ""]

    if b["repos"]:
        out += ["## Repos", ""]
    for r in b["repos"]:
        facts = [f"★ {r['stars']:,}" if r.get("stars") is not None else None, f"last commit {r['last_commit_at']}" if r.get("last_commit_at") else None,
                 r.get("license"), "archived" if r.get("archived") else None, f"found via {r['found_via'].replace('_', ' ')}"]
        out += [f"### <{r['url']}>", "", (r.get("description") or "No description.") + " " + " · ".join(f for f in facts if f) + ".", ""]
        if r.get("readme_excerpt"):
            out += ["README, first part:", "", _fence(r["readme_excerpt"]), ""]

    if b["missing"]:
        gaps = [m for m in b["missing"] if m["what"] in ("media", "link")]
        limits = [m for m in b["missing"] if m["what"] not in ("media", "link")]
        if gaps:
            out += ["## Not captured", ""]
            out += [f"- {m['what']}: {m['ref']}. {m['reason']}" for m in gaps]
            out.append("")
        if limits:
            out += ["## Outside this capture", "", "This entry was expanded from the 2026-10-26 archive, which did not record:", ""]
            out += [f"- {m['what']}: {m['reason']}" for m in limits]
            out.append("")
    return "\n".join(out).rstrip() + "\n"
