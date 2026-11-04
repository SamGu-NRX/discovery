"""Chat Completions client for the local CLIProxyAPI gateway.

The client key is read from the macOS Keychain once per process and kept in memory only.
Every call, including failures, appends one line to calls.jsonl: stage, item, model,
tokens in (and cached), tokens out (and reasoning), latency, status.
"""
import json
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CALLS = ROOT / "calls.jsonl"
URL = "http://127.0.0.1:8317/v1/chat/completions"
KEYCHAIN_SERVICE = "com.samgu.agentsetup.fable-advisor.cliproxy-client"
ALLOWED_MODELS = {"gpt-6-luna", "gpt-6.1-sol"}

# List prices per token from the LiteLLM table in ~/.t3/userdata/usage-model-rates.json,
# which cites https://developers.openai.com/api/docs/pricing (read 2026-11-04).
PRICES = {
    "gpt-6-luna": {"in": 0.10e-6, "cached": 0.01e-6, "out": 0.50e-6},
    "gpt-6.1-sol": {"in": 2.00e-6, "cached": 0.10e-6, "out": 10.00e-6},
}

_key = None
_lock = threading.Lock()


def _client_key():
    global _key
    if _key is None:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, check=True,
        )
        _key = out.stdout.strip()
        if not _key:
            raise RuntimeError(f"Keychain service {KEYCHAIN_SERVICE} returned an empty key")
    return _key


def _log(rec):
    with _lock, CALLS.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def chat(model, system, user, *, stage, item, effort="medium", json_mode=True, retries=4):
    """Returns (text, usage). Raises after the last retry; the failure is still logged."""
    if model not in ALLOWED_MODELS:
        raise ValueError(f"model {model!r} is not allowed in this pipeline")
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "reasoning_effort": effort,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    data = json.dumps(body).encode()
    last_err = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(URL, data=data, method="POST", headers={
            "Authorization": f"Bearer {_client_key()}", "Content-Type": "application/json"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                resp = json.load(r)
            dt = time.time() - t0
            u = resp.get("usage") or {}
            pin = u.get("prompt_tokens", 0)
            cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0
            out = u.get("completion_tokens", 0)
            p = PRICES[model]
            cost = (pin - cached) * p["in"] + cached * p["cached"] + out * p["out"]
            _log({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "stage": stage, "item": item,
                  "model": resp.get("model", model), "requested_model": model, "effort": effort,
                  "tokens_in": pin, "tokens_in_cached": cached, "tokens_out": out,
                  "tokens_reasoning": (u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0),
                  "latency_s": round(dt, 2), "status": "ok", "attempt": attempt,
                  "list_cost_usd": round(cost, 6)})
            text = resp["choices"][0]["message"]["content"] or ""
            return text, u
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as e:
            dt = time.time() - t0
            code = getattr(e, "code", None)
            detail = ""
            if isinstance(e, urllib.error.HTTPError):
                try:
                    detail = e.read().decode()[:300]
                except Exception:
                    pass
            last_err = f"{type(e).__name__} {code} {detail}".strip()
            _log({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "stage": stage, "item": item,
                  "requested_model": model, "effort": effort, "latency_s": round(dt, 2),
                  "status": "error", "attempt": attempt, "error": last_err})
            # 408 is the gateway reporting an upstream stream drop (seen 2026-11-04), so it is retried.
            if code is not None and code < 500 and code not in (408, 429):
                break
            time.sleep(min(60, 5 * 2 ** attempt))
    raise RuntimeError(f"{model} call failed for {stage}/{item}: {last_err}")


def chat_json(model, system, user, **kw):
    text, _ = chat(model, system, user, **kw)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Some responses wrap JSON in a code fence; strip it once, then fail loudly.
        s = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        return json.loads(s)
