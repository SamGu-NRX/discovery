import pytest

from kworker.links import _final_failure, _syndication_token, repos_in_html

# From Node 20: ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "")
TOKENS = {
    "2112712092163957157": "54da3wfu4sn",
    "20": "6dq1a2xwd93",
    "1": "bhi2ay3f28n",
    "2114435444587065486": "54ipjcmykc",
    "999999999999999999": "2f9lc2ug9mm",
}


@pytest.mark.parametrize(("status_id", "token"), TOKENS.items())
def test_syndication_token_matches_v8(status_id, token):
    assert _syndication_token(status_id) == token


def test_repo_from_product_site_html():
    # A product site's own HTML is where its repo is found, before any model.
    html = """
      <a href="https://github.com/vercel-labs/fx0">GitHub</a>
      <a href="https://github.com/vercel-labs/fx0/issues">Issues</a>
      <a href="https://github.com/sponsors/someone">Sponsor</a>
      <a href="https://github.com/features/actions">Actions</a>
      <a href="https://github.com/Other/Thing.git">fork</a>
    """
    assert repos_in_html(html) == ["https://github.com/vercel-labs/fx0", "https://github.com/other/thing"]


@pytest.mark.parametrize(
    ("statuses", "want"),
    [(["not_found", "blocked"], "blocked"), (["not_found", None], "not_found"), (["error", None], "error")],
)
def test_final_failure_prefers_blocked(statuses, want):
    # A login wall anywhere on the ladder is reported as blocked, not as a 404.
    assert _final_failure([{"status": s} for s in statuses]) == want


@pytest.mark.parametrize(
    ("site", "repo", "owns"),
    [
        ("https://bencho.dev/", "https://github.com/cabralorenzo/bencho", True),
        ("https://fx0.vercel.dev/", "https://github.com/vercel-labs/fx0", True),
        ("https://pomerado.ai/", "https://github.com/pomerado/pomerado", True),
        # From the first acceptance run: a page linking an unrelated repo.
        ("https://rkufoapn89co.postplan.dev/", "https://github.com/pingdotgg/t3code", False),
    ],
)
def test_site_owns_repo(site, repo, owns):
    from kworker.links import site_owns_repo

    assert site_owns_repo(site, repo) is owns


def test_no_x_refuses_x_pages_and_apis_not_the_media_cdn():
    from types import SimpleNamespace

    from kworker.api import Stats
    from kworker.ctx import Ctx, XFetchRefused

    ctx = Ctx(SimpleNamespace(no_x=True), None, Stats(), None, None)
    for url in ("https://cdn.syndication.twimg.com/tweet-result?id=1", "https://x.com/a/status/1", "https://t.co/abc"):
        with pytest.raises(XFetchRefused):
            ctx.fetch("GET", url)
    assert ctx.stats.fetches == {}
    ctx._allowed("https://video.twimg.com/a.mp4")  # the media CDN stays open
    ctx._allowed("https://api.fxtwitter.com/status/1")  # and fxtwitter, the lead's live source


def test_long_data_uris_are_replaced_short_ones_kept():
    from kworker.links import strip_data_uris

    csv = "data:text/csv;charset=utf-8," + "a%2Cb%0A" * 500
    out = strip_data_uris(f"[Download task data CSV]({csv}) and an icon data:image/png;base64,iVBORw0KGgo=")
    assert out.startswith("[Download task data CSV](data:text/csv (inline file, 4,000 characters, not kept))")
    assert "data:image/png;base64,iVBORw0KGgo=" in out
