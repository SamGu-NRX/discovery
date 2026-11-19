import json

import pytest

from kworker import models
from kworker.api import Stats, canonical_json, sha256_bytes, sha256_json


class FakeApi:
    """The slice of KClient models.run uses, with D1 and R2 as dicts."""

    def __init__(self, caps, derivations=()):
        self.caps = caps
        self.derivations = list(derivations)
        self.blobs = {}
        self.calls = []

    def capabilities(self, step):
        return self.caps

    def lookup_derivations(self, keys):
        return [d for d in self.derivations if (d["input_sha"], d["step"]) in set(keys)]

    def get_blob(self, sha):
        return self.blobs[sha]

    def put_bytes(self, data, mime):
        sha = sha256_bytes(data)
        self.blobs[sha] = data
        return sha

    def record_derivation(self, row):
        self.derivations.append(row)

    def call(self, method, path, body=None, **kw):
        self.calls.append((method, path, body))
        raise AssertionError(f"unexpected Worker call {method} {path}")


class FakeCtx:
    def __init__(self, api):
        self.api = api
        self.stats = Stats()


CAPS = [
    {"step": "image_read", "rank": 1, "provider": "gemini", "model": "gemini-3.5-flash-lite", "runs_on": "worker", "prompt_v": "image-read-v1",
     "enabled": 1, "available": False, "quota_per_day": 500, "used_today": 0},
    {"step": "image_read", "rank": 2, "provider": "cliproxy", "model": "claude-haiku-5-5", "runs_on": "kworker", "prompt_v": "image-read-v1",
     "enabled": 1, "quota_per_day": None},
]


def build(cap):
    return models.Request(text="read it", inputs=[("a" * 64, "image/png")])


def test_cached_derivation_wins_without_any_call(monkeypatch):
    # The rerun guarantee: a derivation from any ranked capability is used
    # before anything is called.
    api = FakeApi(CAPS)
    out = canonical_json({"text": "hi", "kind": "photo", "description": "d"}).encode()
    sha = api.put_bytes(out, "application/json")
    key = build(CAPS[1]).input_sha()
    api.derivations.append({"input_sha": key, "step": "image_read", "provider": "cliproxy", "model": "claude-haiku-5-5", "prompt_v": "image-read-v1", "output_sha": sha})
    monkeypatch.setitem(models.KWORKER_ADAPTERS, "cliproxy", lambda *a: pytest.fail("adapter called on a cache hit"))
    ctx = FakeCtx(api)
    r = models.run(ctx, "image_read", build)
    assert r.cached and r.output_sha == sha and r.by.model == "claude-haiku-5-5"
    assert ctx.stats.model_calls == {} and api.calls == []


def test_miss_skips_unconfigured_worker_cap_and_records_derivation(monkeypatch):
    api = FakeApi(CAPS)
    calls = []

    def fake(ctx, cap, req):
        calls.append(cap["model"])
        return canonical_json({"text": "t", "kind": "photo", "description": "d"}), {"input_tokens": 10, "output_tokens": 5}

    monkeypatch.setitem(models.KWORKER_ADAPTERS, "cliproxy", fake)
    ctx = FakeCtx(api)
    r = models.run(ctx, "image_read", build)
    assert calls == ["claude-haiku-5-5"] and not r.cached
    (row,) = api.derivations
    assert (row["input_sha"], row["provider"], row["model"], row["prompt_v"]) == (build(CAPS[1]).input_sha(), "cliproxy", "claude-haiku-5-5", "image-read-v1")
    assert api.blobs[row["output_sha"]] == r.output.encode()
    assert ctx.stats.tokens == {"image_read.in": 10, "image_read.out": 5}


def test_bad_json_from_model_is_not_cached(monkeypatch):
    api = FakeApi(CAPS[1:])
    monkeypatch.setitem(models.KWORKER_ADAPTERS, "cliproxy", lambda ctx, cap, req: (models._json_only("I can't read that.", req), {}))
    with pytest.raises(models.ModelUnavailable, match="no JSON object"):
        models.run(FakeCtx(api), "image_read", build)
    assert api.derivations == []


def test_input_sha_recipe_matches_the_worker():
    # docs/KNOWLEDGE.md: sha256 of canonical JSON {inputs, prompt_sha, response_schema_sha?}.
    schema = {"type": "object"}
    req = models.Request(text="p", inputs=[("b" * 64, "image/jpeg")], schema=schema)
    want = sha256_json({"inputs": ["b" * 64], "prompt_sha": sha256_bytes(b"p"), "response_schema_sha": sha256_json(schema)})
    assert req.input_sha() == want


def test_json_only_strips_fences():
    assert json.loads(models._json_only('```json\n{"a": 1}\n```', None)) == {"a": 1}
