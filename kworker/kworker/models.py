"""Model calls behind the `capabilities` table (docs/KNOWLEDGE.md).

Every call is a derivation keyed by (input_sha, step, provider, model,
prompt_v). For a step, each enabled capability in rank order builds its own
request; the first one whose derivation already exists wins, before anything
is called. Only on a full miss does the first available capability run.
"""

from __future__ import annotations

import base64
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

from .api import KError, canonical_json, sha256_bytes, sha256_json
from .ctx import Ctx

PROMPTS = Path(__file__).parent / "prompts"


def prompt(name: str) -> str:
    return (PROMPTS / f"{name}.md").read_text(encoding="utf-8")


@dataclass(frozen=True)
class By:
    provider: str
    model: str
    prompt_v: str

    def as_dict(self) -> dict:
        return {"provider": self.provider, "model": self.model, "prompt_v": self.prompt_v}


@dataclass
class Request:
    """One capability's version of a call. `inputs` are blob shas with their
    mime types; `text` is the full prompt sent with them."""

    text: str
    inputs: list[tuple[str, str]] = field(default_factory=list)
    schema: dict | None = None
    max_output_tokens: int = 4096
    thinking: bool = True

    def input_sha(self) -> str:
        # The recipe the Worker's POST /k/model/run uses too, so a derivation
        # one side made is found by the other.
        key: dict[str, Any] = {"inputs": [s for s, _ in self.inputs], "prompt_sha": sha256_bytes(self.text.encode("utf-8"))}
        if self.schema is not None:
            key["response_schema_sha"] = sha256_json(self.schema)
        return sha256_json(key)


@dataclass
class Result:
    output: str
    output_sha: str
    by: By
    cached: bool


class ModelUnavailable(RuntimeError):
    pass


def run(ctx: Ctx, step: str, build: Callable[[dict], Request | None]) -> Result:
    """`build(cap)` returns that capability's request, or None when the
    capability cannot do this input (say, a frames reader with no frames)."""
    caps = [c for c in ctx.api.capabilities(step) if c["enabled"]]
    if not caps:
        raise ModelUnavailable(f"no enabled capability for step {step}")
    planned = []
    for cap in caps:
        req = build(cap)
        if req is not None:
            planned.append((cap, req, req.input_sha()))
    rows = ctx.api.lookup_derivations([(sha, step) for _, _, sha in planned])
    have = {(r["input_sha"], r["provider"], r["model"], r["prompt_v"]): r for r in rows}
    for cap, _req, sha in planned:
        row = have.get((sha, cap["provider"], cap["model"], cap["prompt_v"]))
        if row:
            ctx.stats.cache_hits[f"model:{step}"] += 1
            out = ctx.api.get_blob(row["output_sha"]).decode("utf-8")
            return Result(out, row["output_sha"], By(cap["provider"], cap["model"], cap["prompt_v"]), True)

    tried = []
    for cap, req, sha in planned:
        by = By(cap["provider"], cap["model"], cap["prompt_v"])
        quota = cap.get("quota_per_day")
        if quota is not None and cap.get("used_today", 0) >= quota:
            tried.append(f"{by.provider}/{by.model}: quota of {quota} a day used")
            continue
        try:
            if cap["runs_on"] == "worker":
                if not cap.get("available"):
                    tried.append(f"{by.provider}/{by.model}: not configured on the Worker")
                    continue
                return _run_on_worker(ctx, step, cap, req, by)
            adapter = KWORKER_ADAPTERS.get(cap["provider"])
            if adapter is None:
                tried.append(f"{by.provider}/{by.model}: no kworker adapter")
                continue
            t0 = time.monotonic()
            out, usage = adapter(ctx, cap, req)
            ms = int((time.monotonic() - t0) * 1000)
        except (httpx.HTTPError, KError, ModelUnavailable, ValueError) as e:
            tried.append(f"{by.provider}/{by.model}: {e}")
            continue
        ctx.stats.model_calls[f"{by.provider}/{by.model}"] += 1
        ctx.stats.tokens[f"{step}.in"] += usage.get("input_tokens", 0)
        ctx.stats.tokens[f"{step}.out"] += usage.get("output_tokens", 0)
        out_sha = ctx.api.put_bytes(out.encode("utf-8"), "application/json" if _is_json(out) else "text/plain; charset=utf-8")
        ctx.api.record_derivation(
            {
                "input_sha": sha,
                "step": step,
                "provider": by.provider,
                "model": by.model,
                "prompt_v": by.prompt_v,
                "output_sha": out_sha,
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
                "ms": ms,
            }
        )
        return Result(out, out_sha, by, False)
    raise ModelUnavailable(f"step {step}: every capability failed: " + "; ".join(tried))


def _is_json(s: str) -> bool:
    try:
        json.loads(s)
        return True
    except ValueError:
        return False


def _run_on_worker(ctx: Ctx, step: str, cap: dict, req: Request, by: By) -> Result:
    body = {
        "step": step,
        "provider": by.provider,
        "model": by.model,
        "prompt_v": by.prompt_v,
        "prompt": req.text,
        "inputs": [{"sha256": s, "mime": m} for s, m in req.inputs],
        "max_output_tokens": req.max_output_tokens,
    }
    if req.schema is not None:
        body["response_schema"] = req.schema
    r = ctx.api.call("POST", "/k/model/run", body)
    if r["cached"]:
        ctx.stats.cache_hits[f"model:{step}"] += 1
    else:
        ctx.stats.model_calls[f"{by.provider}/{by.model}"] += 1
        ctx.stats.tokens[f"{step}.in"] += r["usage"].get("input_tokens") or 0
        ctx.stats.tokens[f"{step}.out"] += r["usage"].get("output_tokens") or 0
    return Result(r["output"], r["output_sha"], by, r["cached"])


# ---- kworker adapters: CLIProxyAPI on this machine ----


def _cliproxy(ctx: Ctx, cap: dict, req: Request) -> tuple[str, dict]:
    cfg = ctx.cfg
    if not cfg.cliproxy:
        raise ModelUnavailable("CLIPROXY_URL/CLIPROXY_KEY (or ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN) not set")
    images = [(ctx.api.get_blob(sha), mime) for sha, mime in req.inputs]
    for _, mime in images:
        if not mime.startswith("image/"):
            raise ModelUnavailable(f"the cliproxy adapter reads images only, got {mime}")
    model = cap["model"]
    if model.startswith("claude-"):
        return _anthropic(cfg.cliproxy_url, cfg.cliproxy_key, model, req, images)
    return _openai_chat(cfg.cliproxy_url, cfg.cliproxy_key, model, req, images)


def _anthropic(base: str, key: str, model: str, req: Request, images) -> tuple[str, dict]:
    content: list[dict] = [
        {"type": "image", "source": {"type": "base64", "media_type": _api_mime(m), "data": base64.b64encode(b).decode()}} for b, m in images
    ]
    content.append({"type": "text", "text": req.text})
    body: dict[str, Any] = {"model": model, "max_tokens": req.max_output_tokens, "messages": [{"role": "user", "content": content}]}
    if not req.thinking:
        body["thinking"] = {"type": "disabled"}
    r = httpx.post(
        f"{base}/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json=body,
        timeout=300,
    )
    if r.status_code != 200:
        raise ModelUnavailable(f"HTTP {r.status_code}: {r.text[:200]}")
    j = r.json()
    text = "".join(c.get("text", "") for c in j.get("content", []) if c.get("type") == "text")
    u = j.get("usage", {})
    tokens_in = (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
    if j.get("stop_reason") == "max_tokens":
        raise ModelUnavailable(f"{model} hit max_tokens={req.max_output_tokens}")
    return _json_only(text, req), {"input_tokens": tokens_in, "output_tokens": u.get("output_tokens") or 0}


def _openai_chat(base: str, key: str, model: str, req: Request, images) -> tuple[str, dict]:
    content: list[dict] = [
        {"type": "image_url", "image_url": {"url": f"data:{_api_mime(m)};base64,{base64.b64encode(b).decode()}"}} for b, m in images
    ]
    content.append({"type": "text", "text": req.text})
    r = httpx.post(
        f"{base}/v1/chat/completions",
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
        json={"model": model, "messages": [{"role": "user", "content": content}], "max_completion_tokens": req.max_output_tokens},
        timeout=300,
    )
    if r.status_code != 200:
        raise ModelUnavailable(f"HTTP {r.status_code}: {r.text[:200]}")
    j = r.json()
    text = j["choices"][0]["message"].get("content") or ""
    u = j.get("usage", {})
    return _json_only(text, req), {"input_tokens": u.get("prompt_tokens") or 0, "output_tokens": u.get("completion_tokens") or 0}


def _api_mime(mime: str) -> str:
    return mime.split(";")[0].strip()


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


def _json_only(text: str, req: Request) -> str:
    """Prompts ask for JSON only. Returns it in canonical form, or raises so the
    next capability gets a turn instead of caching a malformed answer."""
    t = _FENCE.sub("", text.strip())
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"model returned no JSON object: {text[:120]!r}")
    return canonical_json(json.loads(t[start : end + 1]))


KWORKER_ADAPTERS: dict[str, Callable[[Ctx, dict, Request], tuple[str, dict]]] = {"cliproxy": _cliproxy}


def cached_code(ctx: Ctx, step: str, input_sha: str, tool: str, version: str, compute: Callable[[], tuple[bytes, str]]) -> tuple[str, bool]:
    """A derivation made by code or a local model (extractor, ffprobe, ffmpeg,
    whisper, embeddings): provider "code" or the local runtime's name."""
    provider, _, model = tool.partition("/")
    rows = ctx.api.lookup_derivations([(input_sha, step)])
    for r in rows:
        if r["provider"] == provider and r["model"] == model and r["prompt_v"] == version:
            ctx.stats.cache_hits[f"derive:{step}"] += 1
            return r["output_sha"], True
    t0 = time.monotonic()
    data, mime = compute()
    ms = int((time.monotonic() - t0) * 1000)
    out_sha = ctx.api.put_bytes(data, mime)
    if provider != "code":
        ctx.stats.model_calls[f"{provider}/{model}"] += 1
    ctx.api.record_derivation(
        {"input_sha": input_sha, "step": step, "provider": provider, "model": model, "prompt_v": version, "output_sha": out_sha, "ms": ms}
    )
    return out_sha, False
