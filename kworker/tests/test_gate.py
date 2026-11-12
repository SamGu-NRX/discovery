import pytest

from kworker.archive import clean_capture
from kworker.gate import rule


def reply(author, text, links=()):
    return {"kind": "reply", "id": None, "author_handle": author, "text": text, "links": list(links)}


@pytest.mark.parametrize(
    ("c", "want"),
    [
        (reply("Theo", "@someone yes, it's in the repo"), "keep"),  # the OP, any casing
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
