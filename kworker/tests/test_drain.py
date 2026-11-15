"""The scheduled drain on 2026-11-14 had no gateway settings and failed three
good saves; the digest then showed nothing. These pin the fixes: the
gateway comes from Credential Manager, a step this machine cannot run blocks
the drain before it claims, and a gateway-wide failure hands the job back
instead of failing it."""

from contextlib import contextmanager

import httpx
import pytest

from kworker import __main__ as cli
from kworker import config, jobs, models
from kworker.api import KError, Stats

GATEWAY_ENV = ("CLIPROXY_URL", "CLIPROXY_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN")

# Production's gate_band rows: the gateway first, Gemini (not set up on the
# Worker) second.
GATE_CAPS = [
    {"step": "gate_band", "rank": 1, "provider": "cliproxy", "model": "claude-haiku-5-5", "runs_on": "kworker", "prompt_v": "gate-v2", "enabled": 1, "quota_per_day": None},
    {"step": "gate_band", "rank": 2, "provider": "gemini", "model": "gemini-3.5-flash-lite", "runs_on": "worker", "prompt_v": "gate-v2",
     "enabled": 1, "available": False, "quota_per_day": 500, "used_today": 0},
]


def load_cfg(monkeypatch, creds=None):
    """config.load() as the Task Scheduler's environment gives it: no gateway
    variables, the token in the environment, Credential Manager as `creds`."""
    for k in GATEWAY_ENV:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("KNOWLEDGE_URL", "https://worker.invalid")
    monkeypatch.setenv("KNOWLEDGE_TOKEN", "t")
    monkeypatch.setattr(config.wincred, "read", lambda target: (creds or {}).get(target))
    return config.load()


class FakeApi:
    def __init__(self, caps, model_run_error=None):
        self.caps = caps
        self.calls = []
        self.model_run_error = model_run_error

    def capabilities(self, step):
        return [c for c in self.caps if c["step"] == step]

    def lookup_derivations(self, keys):
        return []

    def call(self, method, path, body=None, **kw):
        self.calls.append((method, path, body))
        if path == "/k/jobs/claim":
            # One job, once: a drain that should have stopped then ends
            # instead of claiming forever.
            first = sum(p == "/k/jobs/claim" for _, p, _ in self.calls) == 1
            return {"jobs": [{"id": "j1", "kind": "save", "key": "2120974821920051695", "payload": {"post_id": "2120974821920051695"}, "lease_token": "L"}] if first else []}
        if path == "/k/jobs/j1/complete":
            return {}
        if path == "/k/model/run" and self.model_run_error:
            raise self.model_run_error
        raise AssertionError(f"unexpected Worker call {method} {path}")


class FakeCtx:
    def __init__(self, cfg, api):
        self.cfg, self.api, self.stats = cfg, api, Stats()


def fake_ctx(monkeypatch, cfg, api):
    @contextmanager
    def ctx(_cfg):
        yield FakeCtx(cfg, api)

    monkeypatch.setattr(jobs, "job_ctx", ctx)
    monkeypatch.setattr(jobs, "check_disk", lambda path=None: 0)
    monkeypatch.setattr(jobs, "_heartbeat", lambda cfg, job, stop: None)


def gate_request(cap):
    return models.Request(text="judge these replies")


def test_the_gateway_comes_from_its_credential_when_the_environment_lacks_it(monkeypatch):
    cfg = load_cfg(monkeypatch, {config.CLIPROXY_CREDENTIAL: ("http://127.0.0.1:8317/", "gateway-key")})
    assert (cfg.cliproxy_url, cfg.cliproxy_key) == ("http://127.0.0.1:8317", "gateway-key")


def test_a_step_no_model_could_be_reached_for_is_models_down(monkeypatch):
    # The exact 2026-11-14 failure: no gateway settings, Gemini not set up.
    cfg = load_cfg(monkeypatch)
    with pytest.raises(models.ModelsDown, match="not set"):
        models.run(FakeCtx(cfg, FakeApi(GATE_CAPS)), "gate_band", gate_request)


def gateway_answers(monkeypatch, status, text):
    monkeypatch.setattr(models.httpx, "post", lambda *a, **kw: httpx.Response(status, text=text))


def test_a_gateway_that_rejected_the_input_keeps_it_the_saves_failure(monkeypatch):
    # Through the real cliproxy adapter: a 400 is a request the gateway will
    # never take; Gemini is unreachable. One rejection fails the save.
    cfg = load_cfg(monkeypatch, {config.CLIPROXY_CREDENTIAL: ("http://gw.invalid", "k")})
    gateway_answers(monkeypatch, 400, "prompt is too long")
    with pytest.raises(models.ModelUnavailable, match="HTTP 400") as e:
        models.run(FakeCtx(cfg, FakeApi(GATE_CAPS)), "gate_band", gate_request)
    assert not isinstance(e.value, models.ModelsDown)


# Gemini on the Worker as the only usable capability (the gateway unset).
WORKER_CAPS = [dict(GATE_CAPS[1], available=True)]


@pytest.mark.parametrize(
    "error",
    [
        KError(502, "model_error", "Gemini generateContent answered 400 INVALID_ARGUMENT", "POST /k/model/run"),
        KError(502, "model_error", "Gemini stopped with finishReason SAFETY; nothing was cached", "POST /k/model/run"),
        KError(404, "object_missing", "the blob row for aa has no R2 object", "POST /k/model/run"),
    ],
    ids=["gemini-400", "safety-stop", "missing-blob"],
)
def test_a_worker_answer_about_the_input_fails_the_save(monkeypatch, error):
    # Review of 052b8f7, P2: every Worker 404 and 5xx counted as an outage,
    # so a missing blob or a refused prompt was handed back forever.
    cfg = load_cfg(monkeypatch)
    with pytest.raises(models.ModelUnavailable) as e:
        models.run(FakeCtx(cfg, FakeApi(WORKER_CAPS, model_run_error=error)), "gate_band", gate_request)
    assert not isinstance(e.value, models.ModelsDown)


@pytest.mark.parametrize(
    "error",
    [
        KError(502, "model_error", "Gemini generateContent answered 503 UNAVAILABLE", "POST /k/model/run"),
        KError(503, "capability_unavailable", "provider gemini is unavailable: the Worker has no GEMINI_API_KEY", "POST /k/model/run"),
        KError(429, "quota_exhausted", "model gemini-3.5-flash-lite has made 500 of its 500 calls today (UTC)", "POST /k/model/run"),
    ],
    ids=["gemini-503", "no-key", "quota"],
)
def test_a_worker_answer_about_the_model_is_models_down(monkeypatch, error):
    cfg = load_cfg(monkeypatch)
    with pytest.raises(models.ModelsDown):
        models.run(FakeCtx(cfg, FakeApi(WORKER_CAPS, model_run_error=error)), "gate_band", gate_request)


def test_a_gateway_error_that_echoes_the_key_does_not_record_it(monkeypatch):
    cfg = load_cfg(monkeypatch, {config.CLIPROXY_CREDENTIAL: ("http://gw.invalid", "sk-secret-key")})
    gateway_answers(monkeypatch, 401, "invalid api key sk-secret-key")
    with pytest.raises(models.ModelsDown) as e:
        models.run(FakeCtx(cfg, FakeApi(GATE_CAPS)), "gate_band", gate_request)
    assert "sk-secret-key" not in str(e.value) and "<key>" in str(e.value)


def test_the_drain_claims_nothing_when_a_step_has_no_usable_model(monkeypatch):
    cfg = load_cfg(monkeypatch)
    api = FakeApi(GATE_CAPS)
    fake_ctx(monkeypatch, cfg, api)
    with pytest.raises(jobs.Blocked, match="step gate_band has no capability this machine can use"):
        jobs.drain(cfg, ["save"])
    assert api.calls == []


def test_the_drain_claims_nothing_when_the_gateway_does_not_answer(monkeypatch):
    cfg = load_cfg(monkeypatch, {config.CLIPROXY_CREDENTIAL: ("http://127.0.0.1:1", "k")})
    api = FakeApi(GATE_CAPS)
    fake_ctx(monkeypatch, cfg, api)
    with pytest.raises(jobs.Blocked, match="did not answer"):
        jobs.drain(cfg, ["save"])
    assert api.calls == []


def test_models_down_mid_job_hands_the_job_back_queued_and_stops_the_drain(monkeypatch):
    cfg = load_cfg(monkeypatch, {config.CLIPROXY_CREDENTIAL: ("http://gw.invalid", "k")})
    api = FakeApi(GATE_CAPS)
    fake_ctx(monkeypatch, cfg, api)

    def gateway_went_down(ctx, payload):
        raise models.ModelsDown("step gate_band: every capability failed: cliproxy/claude-haiku-5-5: HTTP 503: down")

    monkeypatch.setitem(jobs.HANDLERS, "save", gateway_went_down)
    with pytest.raises(jobs.Blocked, match="handed back"):
        jobs.run_one(cfg, ["save"])
    (complete,) = [b for m, p, b in api.calls if p == "/k/jobs/j1/complete"]
    assert complete["state"] == "queued" and complete["lease_token"] == "L"
    assert "HTTP 503" in complete["error"]


def test_run_exits_4_with_the_reason_when_blocked(monkeypatch, capsys):
    load_cfg(monkeypatch)

    def blocked(cfg, kinds, forever=False):
        raise jobs.Blocked("blocked before claiming: step gate_band has no capability this machine can use")

    monkeypatch.setattr(jobs, "drain", blocked)
    assert cli.main(["run"]) == 4
    assert "step gate_band has no capability" in capsys.readouterr().out
