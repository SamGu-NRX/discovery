import pytest

from kworker.archive import clean_capture
from kworker.gate import rule


def reply(author, text, links=()):
    return {"kind": "reply", "id": None, "author_handle": author, "text": text, "links": list(links)}


@pytest.mark.parametrize(
    ("c", "want"),
    [
        (reply("Theo", "@someone yes, it's in the repo for everyone"), "keep"),  # the OP, any casing
        (reply("theo", "@someone thanks man! 🙌🏻"), "model"),  # a short OP reply is the model's call
        (reply("theo", "@someone here https://t3.gg"), "keep"),
        (reply("x", "here: https://github.com/o/r"), "model"),
        (reply("x", "check this", ["https://github.com/stevysmith/fx0"]), "model"),  # the link only in expanded links
        (reply("x", "```\nnpm i foo\n```"), "model"),
        (reply("x", "so cool, love it"), None),
    ],
)
def test_rules(c, want):
    got = rule(c, "theo")
    assert (got[0] if got else None) == want


def test_clean_capture_strips_card_chrome_only():
    # From the eval pool: an arm read the reply off X's rendered card.
    assert clean_capture("Oct 21\nonly imessage iirc\n2\n20\n2.8K\nShow replies") == "only imessage iirc"
    assert clean_capture("we tried 3 models\nQwen3.5 won") == "we tried 3 models\nQwen3.5 won"


def test_agreement_ignores_reading_order_but_not_wording():
    from kworker.media import AGREE_AT, agreement

    chart_a = "Cost per task\nFable 5 · 81\n$1.0k\nOpus 5.5 · 22\n$10"
    chart_b = "Cost per task\n$1.0k\n$10\nFable 5 · 81\nOpus 5.5 · 22"
    assert agreement(chart_a, chart_b) >= AGREE_AT
    assert agreement("run npm install --save-dev vitest", "run pnpm add -D jest") < AGREE_AT


def test_syndication_times_become_iso():
    from kworker.archive import _iso

    # "Tue" contains a T; the first acceptance bundles showed this time raw.
    assert _iso("Tue Oct 20 20:50:13 +0000 2026") == "2026-10-20T20:50:13Z"
    assert _iso("2026-10-20T19:48:00Z") == "2026-10-20T19:48:00Z"
