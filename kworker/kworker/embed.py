"""Text embeddings behind the `embed` capability: Workers AI through the
Worker's POST /embed first, local ONNX (fastembed) when the Worker can't.
Both run bge-base-en-v1.5, but their vectors are not interchangeable, so a
score only ever compares vectors from the same provider."""

from __future__ import annotations

import struct
from dataclasses import dataclass

import httpx
import numpy as np

from .api import KError, sha256_json
from .ctx import Ctx
from .models import cached_code

_MAGIC = b"KEMB1"
_fastembed = {}


@dataclass
class Embedded:
    vectors: np.ndarray  # rows L2-normalized, float32
    provider: str
    model: str
    cached: bool


def pack(vectors: np.ndarray) -> bytes:
    v = np.ascontiguousarray(vectors, dtype="<f4")
    return _MAGIC + struct.pack("<II", *v.shape) + v.tobytes()


def unpack(data: bytes) -> np.ndarray:
    if data[:5] != _MAGIC:
        raise ValueError("not a KEMB1 vector pack")
    n, dim = struct.unpack("<II", data[5:13])
    return np.frombuffer(data[13:], dtype="<f4").reshape(n, dim)


def _normalize(v: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    return v / np.where(norms == 0, 1, norms)


def embed_texts(ctx: Ctx, texts: list[str], provider: str | None = None) -> Embedded:
    """Embeds `texts` with `provider`, or with the first capability that works.
    The derivation key is the sha of the text list, so the same list is never
    embedded twice by the same provider."""
    caps = [c for c in ctx.api.capabilities("embed") if c["enabled"] and (provider is None or c["provider"] == provider)]
    if not caps:
        raise RuntimeError(f"no enabled embed capability{f' for provider {provider}' if provider else ''}")
    input_sha = sha256_json({"texts": texts})
    errors = []
    for cap in caps:
        try:
            compute = _COMPUTE[cap["provider"]]
        except KeyError:
            errors.append(f"{cap['provider']}: no kworker implementation")
            continue
        try:
            sha, cached = cached_code(
                ctx, "embed", input_sha, f"{cap['provider']}/{cap['model']}", cap["prompt_v"], lambda: (pack(compute(ctx, cap["model"], texts)), "application/x-kemb1")
            )
        except (KError, httpx.HTTPError, RuntimeError) as e:
            errors.append(f"{cap['provider']}: {e}")
            continue
        return Embedded(unpack(ctx.api.get_blob(sha)), cap["provider"], cap["model"], cached)
    raise RuntimeError("every embed capability failed: " + "; ".join(errors))


def _workers_ai(ctx: Ctx, model: str, texts: list[str]) -> np.ndarray:
    out = []
    for i in range(0, len(texts), 100):
        r = ctx.api.call("POST", "/embed", {"texts": texts[i : i + 100]})
        if r.get("model") != model:
            raise RuntimeError(f"/embed answered with model {r.get('model')}, expected {model}")
        out += r["vectors"]
    return _normalize(np.asarray(out, dtype=np.float32))


def _local(ctx: Ctx, model: str, texts: list[str]) -> np.ndarray:
    if model not in _fastembed:
        from fastembed import TextEmbedding

        _fastembed[model] = TextEmbedding(model_name=model, cache_dir=str(ctx.cfg.model_cache / "fastembed"))
    return _normalize(np.asarray(list(_fastembed[model].embed(texts)), dtype=np.float32))


_COMPUTE = {"workers-ai": _workers_ai, "fastembed": _local}


def to_int8(v: np.ndarray) -> np.ndarray:
    """Tombstone form: each unit-vector component scaled to [-127, 127]."""
    return np.clip(np.round(v * 127), -127, 127).astype(np.int8)
