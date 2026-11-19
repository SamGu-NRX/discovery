"""Rung 4: a page rendered in headed Chrome on its own profile, `pipeline`.

The profile lives outside the repo (Config.chrome_profile) and holds no
logins. kworker never types into a page, never submits a form and never
answers a challenge: it loads the URL, waits for the network to settle, and
reads the HTML.
"""

from __future__ import annotations

from .ctx import Ctx


def render(ctx: Ctx, url: str, timeout_ms: int = 30_000) -> tuple[str, str, int]:
    """(html, final_url, http_status) of the main document."""
    from playwright.sync_api import TimeoutError as PlaywrightTimeout
    from playwright.sync_api import sync_playwright

    ctx.cfg.chrome_profile.mkdir(parents=True, exist_ok=True)
    ctx.stats.fetches[f"browser:{url.split('/')[2]}"] += 1
    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            str(ctx.cfg.chrome_profile),
            channel="chrome",
            headless=False,
            viewport={"width": 1280, "height": 900},
            accept_downloads=False,
        )
        try:
            page = browser.new_page()
            resp = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            try:
                page.wait_for_load_state("networkidle", timeout=10_000)
            except PlaywrightTimeout:
                pass  # long-polling pages never go idle; the DOM is enough
            return page.content(), page.url, resp.status if resp else 0
        finally:
            browser.close()
