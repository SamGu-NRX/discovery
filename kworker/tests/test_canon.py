import json
from pathlib import Path

import pytest

from kworker.canon import canonical_url, is_immutable

VECTORS = json.loads((Path(__file__).parents[2] / "docs" / "knowledge-canon-vectors.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize(("raw", "want"), VECTORS)
def test_shared_vectors(raw, want):
    # The Worker runs the same file; a divergence means knowledge_has misses
    # pages kworker fetched.
    assert canonical_url(raw) == want


def test_canonical_is_idempotent():
    for _, want in VECTORS:
        assert canonical_url(want) == want


def test_rejects_non_http():
    with pytest.raises(ValueError, match="http or https"):
        canonical_url("ftp://example.com/a")


@pytest.mark.parametrize(
    ("url", "immutable"),
    [
        ("https://x.com/theo/status/2112712092163957157", True),
        ("https://pbs.twimg.com/media/HVHcZjlbMAAfNQ3.jpg?name=orig", True),
        ("https://arxiv.org/abs/2609.26550v2", True),
        ("https://arxiv.org/abs/2609.26550", False),
        ("https://github.com/o/r/blob/0123456789abcdef0123456789abcdef01234567/a.md", True),
        ("https://github.com/o/r/blob/main/a.md", False),
        ("https://bencho.dev/", False),
    ],
)
def test_immutable_classes(url, immutable):
    assert is_immutable(url) is immutable
