"""The relevance gate (docs/KNOWLEDGE.md, "Pipeline per save", step 2).

Runs on text only, before any media download or link fetch, so a dropped
reply costs no bytes beyond its tombstone.
"""

from __future__ import annotations

import json
import re
import struct
from dataclasses import dataclass

import numpy as np

from . import models
from .api import canonical_json, sha256_bytes
from .ctx import Ctx
from .embed import embed_texts, to_int8

# Thresholds on the mean of the 5 highest cosine similarities to positives,
# from acceptance/calibrate_gate.py on the 2026-10-26 judged reply pool minus
# the ten acceptance saves (acceptance/evidence/gate-calibration.json, 351
# labeled replies, 116 relevant). The scores of relevant and irrelevant
# replies overlap almost entirely, so the embedding stage settles few:
# KEEP_AT is the lowest keep with no irrelevant reply above it, and DROP_AT
# the highest drop that loses at most 1% of relevant replies. Everything
# between goes to the model.
KEEP_AT = 0.76
DROP_AT = 0.53
TOP_K = 5
_WORDS = re.compile(r"[^\W_]+(?:['’][^\W_]+)?")
_URL_OR_CODE = re.compile(r"https?://|`")
OP_MIN_WORDS = 6
GATE_V = f"gate-v2(keep>={KEEP_AT},drop<={DROP_AT},top{TOP_K},op>={OP_MIN_WORDS}w,brief-v1,gate-band-v1)"

_REPO = re.compile(r"(?:github\.com|gitlab\.com|codeberg\.org)/[\w.-]+/[\w.-]+|gist\.github\.com/", re.I)
_CODE = re.compile(r"```|^\s*(?:\$ |npm |npx |pnpm |pip |uv |brew |git |curl |docker )|[{};]\s*$|=>|def |function |import ", re.I | re.M)
_PROMPT = re.compile(r"\bprompt\b|\bsystem prompt\b|\bskill\.md\b|you are an?\b", re.I)
_MENTIONS = re.compile(r"^(?:@\w+\s*)+")


@dataclass
class Decision:
    item: dict
    item_id: str
    verdict: str  # keep | drop
    stage: str  # rule | embed | model
    reason: str
    score: float | None = None
    by: dict | None = None


def item_id(c: dict) -> str:
    return c.get("id") or "t:" + sha256_bytes(f"{c['author_handle'].lower()}\n{c['text']}".encode("utf-8"))[:20]


def bare(text: str) -> str:
    return _MENTIONS.sub("", text).strip()


def rule(c: dict, save_author: str) -> tuple[str, str] | None:
    """('keep', reason) or ('model', reason) or None (go to embeddings)."""
    blob = c["text"] + "\n" + "\n".join(c.get("links", []))
    if c["author_handle"].lower() == save_author.lower():
        # The first acceptance run kept every OP reply, and 15 of the 45
        # kept replies were OP thank-yous and emoji ("thanks man! 🙌🏻").
        # An OP reply with a link, code or six words is kept; a shorter one
        # goes to the model, which keeps it if it answers something.
        if len(_WORDS.findall(bare(c["text"]))) >= OP_MIN_WORDS or _URL_OR_CODE.search(blob):
            return "keep", "reply by the original poster"
        return "model", "short reply by the original poster"
    if _REPO.search(blob):
        return "model", "carries a repo link"
    if _CODE.search(c["text"]):
        return "model", "carries code or a command"
    if _PROMPT.search(c["text"]) and len(c["text"]) > 200:
        return "model", "may carry a prompt"
    return None


def scores(ctx: Ctx, texts: list[str]) -> tuple[np.ndarray, np.ndarray] | None:
    """(score per text, its unit vector): the mean of the top-k cosine
    similarities to Sam's positives. None when there are no positives."""
    pos = _positives(ctx)
    if not pos:
        return None
    p = embed_texts(ctx, pos)
    q = embed_texts(ctx, texts, provider=p.provider)
    sims = q.vectors @ p.vectors.T
    k = min(TOP_K, sims.shape[1])
    top = -np.sort(-sims, axis=1)[:, :k]
    return top.mean(axis=1), q.vectors


def _positives(ctx: Ctx) -> list[str]:
    texts, offset = [], 0
    while True:
        r = ctx.api.call("GET", "/positives", params={"limit": 2000, "offset": offset})
        texts += [it["text"] for it in r["items"]]
        offset += len(r["items"])
        if not r["items"] or offset >= r["total"]:
            break
    # Order-independent, so the cache key holds when rows arrive in a new order.
    return sorted(set(texts))


def run_gate(ctx: Ctx, expansion: dict) -> dict:
    post = expansion["post"]
    author = post["author_handle"]
    decisions: list[Decision] = []
    to_embed: list[dict] = []
    to_model: list[tuple[dict, str]] = []
    for c in expansion["candidates"]:
        r = rule(c, author)
        if r and r[0] == "keep":
            decisions.append(Decision(c, item_id(c), "keep", "rule", r[1]))
        elif r:
            to_model.append((c, r[1]))
        else:
            to_embed.append(c)

    # Rule-routed items are embedded too, so a drop the model makes still
    # leaves its int8 tombstone vector; only to_embed items are scored.
    vectors: dict[str, np.ndarray] = {}
    pending = to_embed + [c for c, _ in to_model]
    if pending:
        scored = scores(ctx, [bare(c["text"]) or c["text"] for c in pending])
        if scored is None:
            to_model += [(c, "no positives to score against") for c in to_embed]
        else:
            s, q = scored
            for i, c in enumerate(pending):
                vectors[item_id(c)] = q[i]
                if i >= len(to_embed):
                    continue
                score = float(s[i])
                c["_score"] = score
                if score >= KEEP_AT:
                    decisions.append(Decision(c, item_id(c), "keep", "embed", f"close to Sam's saves (score {score:.3f})", score))
                elif score <= DROP_AT:
                    decisions.append(Decision(c, item_id(c), "drop", "embed", f"far from Sam's saves (score {score:.3f})", score))
                else:
                    to_model.append((c, f"in the band (score {score:.3f})"))

    if to_model:
        decisions += _band(ctx, post, [c for c, _ in to_model])

    drops = [d for d in decisions if d.verdict == "drop"]
    pack_sha = _tombstones(ctx, drops, vectors) if drops else None
    rows = []
    for d in decisions:
        row = {
            "item_kind": d.item["kind"],
            "item_id": d.item_id,
            "save_id": post["id"],
            "verdict": d.verdict,
            "reason": d.reason,
            "stage": d.stage,
            "score": d.score,
            "text_sha": sha256_bytes(d.item["text"].encode("utf-8")),
            "gate_v": GATE_V,
        }
        if d.verdict == "drop" and pack_sha:
            row["pack_sha"], row["pack_row"] = pack_sha, [x.item_id for x in drops].index(d.item_id)
        rows.append(row)
    for i in range(0, len(rows), 200):
        ctx.api.call("POST", "/k/verdicts", {"rows": rows[i : i + 200]})

    order = {item_id(c): i for i, c in enumerate(expansion["candidates"])}
    decisions.sort(key=lambda d: order[d.item_id])
    return {
        "gate_v": GATE_V,
        "kept": [
            {**_public(d.item), "item_id": d.item_id, "kept_because": d.reason, "stage": d.stage, "score": d.score, "by": d.by}
            for d in decisions
            if d.verdict == "keep"
        ],
        "dropped": [{"item_id": d.item_id, "stage": d.stage, "reason": d.reason, "score": d.score} for d in drops],
        "tombstone_pack": pack_sha,
    }


def _public(c: dict) -> dict:
    return {k: v for k, v in c.items() if not k.startswith("_")}


def _band(ctx: Ctx, post: dict, items: list[dict]) -> list[Decision]:
    brief = models.prompt("interest-brief-v1")
    listing = "\n".join(
        f"<item i=\"{i}\" author=\"@{c['author_handle']}\">{c['text']}" + (f"\nlinks: {' '.join(c['links'])}" if c.get("links") else "") + "</item>"
        for i, c in enumerate(items)
    )
    text = models.prompt("gate-band-v1").replace("{brief}", brief).replace("{author}", post["author_handle"]).replace("{post}", post["text"]).replace("{items}", listing)
    schema = {
        "type": "object",
        "properties": {
            "decisions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"i": {"type": "integer"}, "keep": {"type": "boolean"}, "reason": {"type": "string"}},
                    "required": ["i", "keep", "reason"],
                },
            }
        },
        "required": ["decisions"],
    }

    def build(cap: dict):
        if cap["prompt_v"] != "gate-band-v1":
            return None
        return models.Request(text=text, schema=schema, max_output_tokens=2000 + 120 * len(items), thinking=False)

    res = models.run(ctx, "gate_band", build)
    got = {d["i"]: d for d in json.loads(res.output)["decisions"]}
    missing = [i for i in range(len(items)) if i not in got]
    if missing:
        raise ValueError(f"gate_band answer skipped items {missing}")
    out = []
    for i, c in enumerate(items):
        d = got[i]
        out.append(
            Decision(c, item_id(c), "keep" if d["keep"] else "drop", "model", str(d["reason"]), c.get("_score"), res.by.as_dict())
        )
    return out


def _tombstones(ctx: Ctx, drops: list[Decision], vectors: dict[str, np.ndarray]) -> str:
    """One pack per gate run: a JSON header line, then one int8 row per drop
    (zeros for a drop the model made without an embedding)."""
    dim = next((v.shape[0] for v in vectors.values()), 768)
    header = {"schema": "ktomb/1", "gate_v": GATE_V, "dim": dim, "rows": [d.item_id for d in drops]}
    body = b"".join(to_int8(vectors[d.item_id]).tobytes() if d.item_id in vectors else bytes(dim) for d in drops)
    data = canonical_json(header).encode("utf-8") + b"\n" + struct.pack("<I", len(drops)) + body
    return ctx.api.put_bytes(data, "application/x-ktomb1")
