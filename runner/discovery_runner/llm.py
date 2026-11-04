"""Chat Completions client for CLIProxyAPI.

Adapted from runner/prototype/llm.py. The client key comes from the macOS Keychain, once per process,
and is kept in memory only. Every call, failures included, appends one line to logs/calls.jsonl with
stage, item, model, tokens, latency, status and list cost.

Only the three runtime models in the contract are allowed; the runtime uses no Claude model.
"""
import json
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request

from . import config

# List prices per token from the LiteLLM table in ~/.t3/userdata/usage-model-rates.json, which cites
# https://developers.openai.com/api/docs/pricing (read 2026-11-04).
PRICES = {
    "gpt-6-luna": {"in": 0.10e-6, "cached": 0.01e-6, "out": 0.50e-6},
    "gpt-6.1-sol": {"in": 2.00e-6, "cached": 0.10e-6, "out": 10.00e-6},
    "gpt-6-astra": {"in": 10.00e-6, "cached": 1.00e-6, "out": 50.00e-6},
}
ALLOWED_MODELS = set(PRICES)


def keychain_key(service):
    def read():
        out = subprocess.run(["security", "find-generic-password", "-s", service, "-w"],
                             capture_output=True, text=True, check=True)
        key = out.stdout.strip()
        if not key:
            raise RuntimeError(f"Keychain service {service} returned an empty key")
        return key
    return read


class Gateway:
    def __init__(self, url, key_provider, log_path=None, retries=4):
        self.url = url
        self._key_provider = key_provider
        self._key = None
        self.retries = retries
        self.log_path = log_path or config.path("logs", "calls.jsonl")
        self._lock = threading.Lock()

    @classmethod
    def from_config(cls, cfg):
        return cls(cfg["gateway_url"], keychain_key(cfg["gateway_keychain_service"]))

    def _log(self, rec):
        with self._lock, open(self.log_path, "a") as f:
            f.write(json.dumps(rec) + "\n")

    def chat(self, model, system, user, *, stage, item, effort="medium", json_mode=True):
        if model not in ALLOWED_MODELS:
            raise ValueError(f"model {model!r} is not allowed in the runner")
        if self._key is None:
            self._key = self._key_provider()
        body = {"model": model, "reasoning_effort": effort,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        data = json.dumps(body).encode()
        last = None
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(self.url, data=data, method="POST", headers={
                "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"})
            t0 = time.time()
            base = {"ts": config.now_iso(), "stage": stage, "item": item, "requested_model": model, "effort": effort,
                    "attempt": attempt}
            try:
                with urllib.request.urlopen(req, timeout=900) as r:
                    resp = json.load(r)
                u = resp.get("usage") or {}
                pin = u.get("prompt_tokens", 0)
                cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0
                out = u.get("completion_tokens", 0)
                p = PRICES[model]
                self._log({**base, "model": resp.get("model", model), "tokens_in": pin, "tokens_in_cached": cached,
                           "tokens_out": out,
                           "tokens_reasoning": (u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0),
                           "latency_s": round(time.time() - t0, 2), "status": "ok",
                           "list_cost_usd": round((pin - cached) * p["in"] + cached * p["cached"] + out * p["out"], 6)})
                return resp["choices"][0]["message"]["content"] or ""
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as e:
                code = getattr(e, "code", None)
                detail = ""
                if isinstance(e, urllib.error.HTTPError):
                    detail = e.read().decode(errors="replace")[:300]
                    e.close()
                last = f"{type(e).__name__} {code} {detail}".strip()
                self._log({**base, "latency_s": round(time.time() - t0, 2), "status": "error", "error": last})
                # 408 is the gateway reporting an upstream stream drop (seen 2026-11-04), so it is retried.
                if code is not None and code < 500 and code not in (408, 429):
                    break
                time.sleep(min(60, 5 * 2 ** attempt))
        raise RuntimeError(f"{model} call failed for {stage}/{item}: {last}")

    def chat_json(self, model, system, user, **kw):
        text = self.chat(model, system, user, **kw)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            s = re.sub(r"^```(?:json)?|```$", "", text.strip()).strip()
            return json.loads(s)


def summarize_calls(path=None, since=None):
    """Counts, tokens and list cost per model from calls.jsonl, optionally from an ISO time on."""
    path = path or config.path("logs", "calls.jsonl")
    by = {}
    if not path.exists():
        return by
    for line in path.read_text().splitlines():
        c = json.loads(line)
        if since and c["ts"] < since:
            continue
        m = by.setdefault(c["requested_model"], {"ok": 0, "errors": 0, "in": 0, "cached": 0, "out": 0, "usd": 0.0})
        if c["status"] != "ok":
            m["errors"] += 1
            continue
        m["ok"] += 1
        m["in"] += c["tokens_in"]
        m["cached"] += c["tokens_in_cached"]
        m["out"] += c["tokens_out"]
        m["usd"] = round(m["usd"] + c["list_cost_usd"], 6)
    return by
