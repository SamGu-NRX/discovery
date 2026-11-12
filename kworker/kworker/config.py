"""Settings come only from the environment, so a wiped folder plus the same
environment reproduces the worker. Secrets are read here and never logged."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class S3:
    endpoint: str
    access_key_id: str
    secret_access_key: str
    bucket: str


@dataclass(frozen=True)
class Config:
    base_url: str
    token: str
    owner: str
    cliproxy_url: str | None
    cliproxy_key: str | None
    s3: S3 | None
    large_via_worker: bool
    cf_account_id: str | None
    cf_browser_token: str | None
    github_token: str | None
    chrome_profile: Path
    model_cache: Path
    # Files an archive already downloaded: media by file name (sha-checked
    # before use) and fxtwitter records by post id. They spare X the fetch.
    media_dirs: tuple[Path, ...] = ()
    x_cache: tuple[Path, ...] = ()
    # Refuse every request to X's hosts (KWORKER_NO_X=1), so a run over an
    # archive cannot compete with the archive's own fetch queue.
    no_x: bool = False

    @property
    def cliproxy(self) -> bool:
        return bool(self.cliproxy_url and self.cliproxy_key)


def _get(name: str) -> str | None:
    v = os.environ.get(name, "").strip()
    return v or None


def _need(name: str) -> str:
    v = _get(name)
    if v is None:
        raise ConfigError(f"environment variable {name} is required")
    return v


def load() -> Config:
    s3_parts = {k: _get(k) for k in ("R2_S3_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")}
    given = [k for k, v in s3_parts.items() if v]
    if given and len(given) != len(s3_parts):
        missing = sorted(set(s3_parts) - set(given))
        raise ConfigError(f"R2 S3 upload needs all of R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY; missing {', '.join(missing)}")
    s3 = (
        S3(s3_parts["R2_S3_ENDPOINT"], s3_parts["R2_ACCESS_KEY_ID"], s3_parts["R2_SECRET_ACCESS_KEY"], _get("R2_BUCKET") or "x-knowledge")
        if given
        else None
    )
    local = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share")
    return Config(
        base_url=_need("KNOWLEDGE_URL").rstrip("/"),
        token=_need("KNOWLEDGE_TOKEN"),
        owner=_get("KWORKER_OWNER") or f"kworker@{socket.gethostname()}",
        # The gateway Claude Code itself uses on this machine, unless overridden.
        cliproxy_url=(_get("CLIPROXY_URL") or _get("ANTHROPIC_BASE_URL") or "").rstrip("/") or None,
        cliproxy_key=_get("CLIPROXY_KEY") or _get("ANTHROPIC_AUTH_TOKEN"),
        s3=s3,
        large_via_worker=_get("KWORKER_LARGE_VIA_WORKER") == "1",
        cf_account_id=_get("CF_ACCOUNT_ID"),
        cf_browser_token=_get("CF_BROWSER_TOKEN"),
        github_token=_get("GITHUB_TOKEN"),
        # Outside the repo, so wiping kworker/ does not delete the profile, and
        # separate from every profile another thread drives.
        chrome_profile=Path(_get("KWORKER_CHROME_PROFILE") or local / "kworker" / "chrome-profiles" / "pipeline"),
        # Model weights only (whisper, embeddings); pipeline state never lives
        # here. Not under ~/.cache: the Zephyrus's disk cleanup clears that
        # folder (2026-11-12), and the weights then download again.
        model_cache=Path(_get("KWORKER_MODEL_CACHE") or local / "kworker" / "models"),
        media_dirs=_paths("KWORKER_MEDIA_DIRS"),
        x_cache=_paths("KWORKER_X_CACHE"),
        no_x=_get("KWORKER_NO_X") == "1",
    )


def _paths(name: str) -> tuple[Path, ...]:
    """Read-only folders another process filled (an archive's media, its
    fxtwitter records). kworker reads from them and never writes."""
    return tuple(Path(p) for p in (_get(name) or "").split(os.pathsep) if p)
