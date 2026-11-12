"""Image jobs, and the download step images and videos share."""

from __future__ import annotations

import difflib
import hashlib
import json
from pathlib import Path

from . import models
from .canon import canonical_url, is_immutable, url_hash
from .ctx import Ctx

IMAGE_SCHEMA = {
    "type": "object",
    "properties": {"text": {"type": "string"}, "kind": {"type": "string"}, "description": {"type": "string"}},
    "required": ["text", "kind", "description"],
}
# Two readings of a text screenshot agree when their whitespace-normalized
# texts are this similar (difflib ratio). Below it the image is marked
# ocr_uncertain and both readings go into the bundle. No calibration run
# exists for this number; it tolerates a few differing characters per line.
AGREE_AT = 0.92


def fetch_media(ctx: Ctx, url: str) -> dict:
    """Downloads a media URL once. {sha256, mime, bytes, cached}; the bytes
    live in R2, not on disk, unless a later step asks for them."""
    canon = canonical_url(url)
    h = url_hash(canon)
    prior = ctx.api.lookup_fetches([h]).get(h)
    if prior and prior["status"] == "ok" and prior.get("content_sha"):
        ctx.stats.cache_hits["fetch"] += 1
        return {"sha256": prior["content_sha"], "mime": prior.get("mime") or "application/octet-stream", "cached": True, "url": canon}
    dest = ctx.scratch / f"dl-{h[:16]}"
    digest = hashlib.sha256()
    with ctx.stream("GET", url) as r:
        if r.status_code != 200:
            row = {"url_hash": h, "canonical_url": canon, "final_url": str(r.url), "rung": 1, "status": "not_found" if r.status_code in (404, 410) else "error",
                   "http_status": r.status_code, "immutable": 0, "note": f"media download HTTP {r.status_code}"}
            ctx.api.record_fetches([row])
            raise MediaError(f"{url}: HTTP {r.status_code}")
        mime = r.headers.get("content-type", "application/octet-stream").split(";")[0]
        with dest.open("wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                digest.update(chunk)
                f.write(chunk)
        final = str(r.url)
    sha = digest.hexdigest()
    ctx.api.put_file(dest, mime, sha)
    ctx.api.record_fetches(
        [{"url_hash": h, "canonical_url": canon, "final_url": final, "content_sha": sha, "mime": mime, "http_status": 200,
          "rung": 1, "status": "ok", "immutable": 1 if is_immutable(canon) else 0, "note": "media download"}]
    )
    return {"sha256": sha, "mime": mime, "cached": False, "url": canon, "path": str(dest)}


class MediaError(RuntimeError):
    pass


def local_copy(ctx: Ctx, media: dict) -> Path:
    """The media file on disk, downloaded from R2 (not the origin) if this job
    did not just fetch it."""
    p = Path(media["path"]) if media.get("path") else ctx.scratch / f"blob-{media['sha256'][:16]}"
    if not p.exists():
        ctx.api.download_blob(media["sha256"], p)
    media["path"] = str(p)
    return p


def _norm(t: str) -> str:
    return " ".join(t.split())


def agreement(a: str, b: str) -> float:
    """How alike two readings are: the better of in-order similarity and
    similarity of their sorted lines. A chart or a UI has no single reading
    order, so two readers can list the same labels in different orders."""
    seq = difflib.SequenceMatcher(None, _norm(a), _norm(b)).ratio()
    def lines(t: str) -> str:
        return "\n".join(sorted(_norm(l) for l in t.splitlines() if l.strip()))

    return max(seq, difflib.SequenceMatcher(None, lines(a), lines(b)).ratio())


def image_job(ctx: Ctx, payload: dict) -> dict:
    m = fetch_media(ctx, payload["source_url"])
    sha, mime = m["sha256"], m["mime"]

    def build_read(cap: dict):
        if cap["prompt_v"] != "image-read-v1":
            return None
        return models.Request(text=models.prompt("image-read-v1"), inputs=[(sha, mime)], schema=IMAGE_SCHEMA, max_output_tokens=8000)

    first = models.run(ctx, "image_read", build_read)
    read = json.loads(first.output)
    # Job results are capped at 32 KiB, so the readings travel as blob shas.
    out = {
        "sha256": sha,
        "mime": mime,
        "source_url": payload["source_url"],
        "post_id": payload["post_id"],
        "read_sha": first.output_sha,
        "read_by": first.by.as_dict(),
        "second_sha": None,
        "second_by": None,
        "agreement": None,
        "ocr_uncertain": False,
    }
    # A text screenshot is worth a second, independent reading.
    if read.get("kind") == "screenshot_text" or len(read.get("text", "")) > 200:

        def build_second(cap: dict):
            if cap["prompt_v"] != "image-read-v1" or (cap["provider"], cap["model"]) == (first.by.provider, first.by.model):
                return None
            return build_read(cap)

        second = models.run(ctx, "image_second_read", build_second)
        read2 = json.loads(second.output)
        ratio = agreement(read.get("text", ""), read2.get("text", ""))
        out.update(second_sha=second.output_sha, second_by=second.by.as_dict(), agreement=round(ratio, 4), ocr_uncertain=ratio < AGREE_AT)
    return out
