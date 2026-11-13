"""What every job handler gets: settings, the Worker client, an external HTTP
client that counts every request it makes, and a scratch directory that is
deleted when the job ends."""

from __future__ import annotations

import shutil
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .api import KClient, Stats
from .config import Config

# A desktop Chrome UA. Sites that refuse unknown agents still see an honest
# client: it never logs in and never answers a challenge.
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"


# X's pages and APIs, which the archive lead's fetch queue uses. The static
# media CDN (pbs.twimg.com, video.twimg.com) is not in it: serving a file
# the archive could not copy here does not compete with that queue.
# fxtwitter is a third party that caches X and is the lead's chosen source
# for live reads, so it is not in the set.
X_HOSTS = {"x.com", "twitter.com", "mobile.twitter.com", "api.x.com", "t.co", "cdn.syndication.twimg.com"}


class XFetchRefused(RuntimeError):
    pass


@dataclass
class Ctx:
    cfg: Config
    api: KClient
    stats: Stats
    web: httpx.Client
    scratch: Path
    # A live capture (stage b): caches and archive copies are bypassed, so
    # every fetch goes to the origin again.
    live: bool = False

    def fetch(self, method: str, url: str, **kw) -> httpx.Response:
        """Every request kworker makes to anything but the Worker and the model
        gateway goes through here, so a rerun can prove it made none."""
        self._allowed(url)
        self.stats.fetches[urlsplit(url).hostname or "?"] += 1
        return self.web.request(method, url, **kw)

    def _allowed(self, url: str) -> None:
        host = (urlsplit(url).hostname or "").lower()
        if self.cfg.no_x and host in X_HOSTS:
            raise XFetchRefused(f"X fetches are off (KWORKER_NO_X=1) and {host} is not in the archive's records")

    @contextmanager
    def stream(self, method: str, url: str, **kw):
        self._allowed(url)
        self.stats.fetches[urlsplit(url).hostname or "?"] += 1
        with self.web.stream(method, url, **kw) as r:
            yield r


@contextmanager
def job_ctx(cfg: Config):
    stats = Stats()
    scratch = Path(tempfile.mkdtemp(prefix="kworker-"))
    web = httpx.Client(
        headers={"user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.9"},
        follow_redirects=True,
        timeout=httpx.Timeout(30.0, read=300.0),
    )
    api = KClient(cfg, stats)
    try:
        yield Ctx(cfg, api, stats, web, scratch)
    finally:
        web.close()
        api.http.close()
        # Windows can hold a just-closed video file open briefly.
        for _ in range(5):
            try:
                shutil.rmtree(scratch)
                break
            except OSError:
                time.sleep(0.5)
