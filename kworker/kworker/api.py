"""Client for the Worker's /k/ routes (docs/KNOWLEDGE.md, "Routes"), plus the
counters every job reports: external fetches, model calls, tokens, cache hits
and bytes uploaded."""

from __future__ import annotations

import base64
import hashlib
import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import httpx

from .config import Config

# Above this, a blob goes to R2's S3 API directly (docs/KNOWLEDGE.md, "Blobs").
SMALL_BLOB_MAX = 8 * 1024 * 1024
WORKER_BLOB_MAX = 95 * 1024 * 1024


class KError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, route: str):
        super().__init__(f"{route} -> {status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_json(v: Any) -> str:
    """Keys sorted at every depth, no whitespace: the hashing form for cache keys."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_json(v: Any) -> str:
    return sha256_bytes(canonical_json(v).encode("utf-8"))


@dataclass
class Stats:
    fetches: Counter = field(default_factory=Counter)  # host -> external requests
    model_calls: Counter = field(default_factory=Counter)  # "provider/model" -> calls
    tokens: Counter = field(default_factory=Counter)  # "<step>.in" / "<step>.out" -> tokens
    cache_hits: Counter = field(default_factory=Counter)  # kind -> hits
    uploaded_bytes: int = 0
    uploaded_blobs: int = 0
    # Large blobs sent through the Worker instead of the S3 API (local dev only).
    large_via_worker: int = 0

    def as_dict(self) -> dict:
        return {
            "fetches": sum(self.fetches.values()),
            "fetches_by_host": dict(self.fetches),
            "model_calls": sum(self.model_calls.values()),
            "model_calls_by_model": dict(self.model_calls),
            "tokens": dict(self.tokens),
            "cache_hits": dict(self.cache_hits),
            "uploaded_bytes": self.uploaded_bytes,
            "uploaded_blobs": self.uploaded_blobs,
            "large_via_worker": self.large_via_worker,
        }


class KClient:
    def __init__(self, cfg: Config, stats: Stats):
        self.cfg, self.stats = cfg, stats
        self.http = httpx.Client(
            base_url=cfg.base_url,
            headers={"authorization": f"Bearer {cfg.token}"},
            timeout=httpx.Timeout(60.0, read=600.0),
        )
        self._s3 = None

    # ---- plumbing ----

    def call(self, method: str, path: str, body: Any = None, **kw) -> Any:
        r = self.http.request(method, path, json=body, **kw)
        if r.status_code >= 400:
            try:
                err = r.json()
                code, message = err.get("error", "http_error"), err.get("message", r.text[:300])
            except ValueError:
                code, message = "http_error", r.text[:300]
            raise KError(r.status_code, code, message, f"{method} {path}")
        if r.status_code == 204 or not r.content:
            return None
        return r.json()

    # ---- blobs ----

    def has_blobs(self, shas: Iterable[str]) -> set[str]:
        shas = list(dict.fromkeys(shas))
        present: set[str] = set()
        for i in range(0, len(shas), 100):
            present |= set(self.call("POST", "/k/blobs/has", {"sha256s": shas[i : i + 100]})["present"])
        return present

    def put_bytes(self, data: bytes, mime: str) -> str:
        sha = sha256_bytes(data)
        if sha in self.has_blobs([sha]):
            self.stats.cache_hits["blob"] += 1
            return sha
        if len(data) > SMALL_BLOB_MAX:
            return self._put_large(sha, len(data), mime, data=data)
        self.call("PUT", f"/k/blobs/{sha}", content=data, headers={"content-type": mime})
        self.stats.uploaded_bytes += len(data)
        self.stats.uploaded_blobs += 1
        return sha

    def put_file(self, path: Path, mime: str, sha: str | None = None) -> str:
        sha = sha or sha256_file(path)
        if sha in self.has_blobs([sha]):
            self.stats.cache_hits["blob"] += 1
            return sha
        size = path.stat().st_size
        if size > SMALL_BLOB_MAX:
            return self._put_large(sha, size, mime, path=path)
        self.call("PUT", f"/k/blobs/{sha}", content=path.read_bytes(), headers={"content-type": mime})
        self.stats.uploaded_bytes += size
        self.stats.uploaded_blobs += 1
        return sha

    def put_json(self, v: Any) -> str:
        return self.put_bytes(canonical_json(v).encode("utf-8"), "application/json")

    def put_text(self, text: str, mime: str = "text/plain; charset=utf-8") -> str:
        return self.put_bytes(text.encode("utf-8"), mime)

    def _put_large(self, sha: str, size: int, mime: str, data: bytes | None = None, path: Path | None = None) -> str:
        if self.cfg.s3:
            client = self._s3_client()
            body = data if data is not None else path.open("rb")  # type: ignore[union-attr]
            try:
                client.put_object(
                    Bucket=self.cfg.s3.bucket,
                    Key=f"sha256/{sha}",
                    Body=body,
                    ContentType=mime,
                    ContentLength=size,
                    ChecksumSHA256=base64.b64encode(bytes.fromhex(sha)).decode(),
                )
            finally:
                if data is None:
                    body.close()  # type: ignore[union-attr]
            self.call("POST", "/k/blobs/commit", {"sha256": sha, "mime": mime})
        elif self.cfg.large_via_worker and size <= WORKER_BLOB_MAX:
            # Local wrangler dev has no S3 API. Streams through the Worker,
            # where R2's own checksum check still verifies the hash.
            content = data if data is not None else path.read_bytes()  # type: ignore[union-attr]
            self.call("PUT", f"/k/blobs/{sha}", content=content, headers={"content-type": mime})
            self.stats.large_via_worker += 1
        else:
            raise KError(
                0,
                "s3_not_configured",
                f"blob {sha} is {size} bytes, over {SMALL_BLOB_MAX}; set R2_S3_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY",
                "upload",
            )
        self.stats.uploaded_bytes += size
        self.stats.uploaded_blobs += 1
        return sha

    def _s3_client(self):
        if self._s3 is None:
            import boto3  # only needed on the S3 path
            from botocore.config import Config as BotoConfig

            s3 = self.cfg.s3
            assert s3 is not None
            self._s3 = boto3.client(
                "s3",
                endpoint_url=s3.endpoint,
                aws_access_key_id=s3.access_key_id,
                aws_secret_access_key=s3.secret_access_key,
                region_name="auto",
                config=BotoConfig(request_checksum_calculation="when_required"),
            )
        return self._s3

    def get_blob(self, sha: str) -> bytes:
        r = self.http.get(f"/k/blobs/{sha}")
        if r.status_code != 200:
            raise KError(r.status_code, "blob_read_failed", r.text[:200], f"GET /k/blobs/{sha}")
        return r.content

    def get_json(self, sha: str) -> Any:
        return json.loads(self.get_blob(sha))

    def download_blob(self, sha: str, dest: Path) -> Path:
        with self.http.stream("GET", f"/k/blobs/{sha}") as r:
            if r.status_code != 200:
                raise KError(r.status_code, "blob_read_failed", "", f"GET /k/blobs/{sha}")
            with dest.open("wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
        return dest

    # ---- index ----

    def lookup_fetches(self, url_hashes: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for i in range(0, len(url_hashes), 100):
            for row in self.call("POST", "/k/fetches/lookup", {"url_hashes": url_hashes[i : i + 100]})["fetches"]:
                out[row["url_hash"]] = row
        return out

    def record_fetches(self, rows: list[dict]) -> None:
        for i in range(0, len(rows), 50):
            self.call("POST", "/k/fetches", {"rows": rows[i : i + 50]})

    def lookup_derivations(self, keys: list[tuple[str, str]]) -> list[dict]:
        out: list[dict] = []
        uniq = list(dict.fromkeys(keys))
        for i in range(0, len(uniq), 100):
            body = {"keys": [{"input_sha": a, "step": s} for a, s in uniq[i : i + 100]]}
            out += self.call("POST", "/k/derivations/lookup", body)["derivations"]
        return out

    def record_derivation(self, row: dict) -> None:
        self.call("POST", "/k/derivations", {"rows": [row]})

    def capabilities(self, step: str) -> list[dict]:
        return self.call("GET", "/k/capabilities", params={"step": step})["capabilities"]
