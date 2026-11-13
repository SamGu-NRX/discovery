import json

from kworker.api import canonical_json
from kworker.bundle import CARD_MAX, make_card
from kworker.intake import expansion

SAVE = "2119124661443457189"


def intake(**extra):
    body = {
        "schema": "kintake/1",
        "run_id": "daily-1",
        "account": "sdotgu",
        "post": {"id": SAVE, "url": f"https://x.com/corbtt/status/{SAVE}", "author_handle": "corbtt", "text": "use sol for CUA",
                 "media": [{"kind": "photo", "url": "https://pbs.twimg.com/media/A.jpg?name=orig"}], "reply_to": None},
        "thread": [],
        "context": [
            {"id": "2119125016797479391", "author_handle": "corbtt", "text": "self-thread post", "reply_to": SAVE},
            {"id": "2119126954519740788", "author_handle": "b", "text": "a reply https://github.com/o/r", "reply_to": SAVE, "view": "relevant"},
            {"id": "2119126954519740789", "author_handle": "c", "text": "a quote", "quoted_id": SAVE},
            {"id": "2119126954519740790", "author_handle": "d", "text": "   "},
        ],
    }
    body.update(extra)
    return body


def test_context_becomes_gate_candidates_and_thread_posts_do_not():
    t = {"id": "2119125016797479391", "url": "https://x.com/corbtt/status/2119125016797479391", "author_handle": "corbtt", "text": "self-thread post"}
    e = expansion(intake(thread=[t]))
    # The save is added to its own thread when the job sent the rest only.
    assert [p["id"] for p in e["thread"]] == [SAVE, "2119125016797479391"]
    assert [(c["id"], c["kind"]) for c in e["candidates"]] == [("2119126954519740788", "reply"), ("2119126954519740789", "quote")]
    assert e["candidates"][0]["links"] == ["https://github.com/o/r"]
    assert e["post"]["media"] == [{"kind": "photo", "source_url": "https://pbs.twimg.com/media/A.jpg?name=orig"}]
    assert e["saved_by"] == ["sdotgu"]


def test_capped_context_and_missing_parent_are_recorded():
    body = intake(context_capped=True)
    body["post"]["reply_to"] = "2119000000000000000"
    whats = {m["what"] for m in expansion(body)["missing"]}
    assert whats == {"reply_view", "upstream"}


def bundle(text="x", replies=3, links=5):
    return {
        "post_id": SAVE, "url": "u", "author": {"handle": "corbtt", "name": "Kyle"}, "created_at": None, "saved_by": ["sdotgu"],
        "completeness": "partial",
        "missing": [{"what": "link", "ref": "https://a", "reason": "blocked at rung 7 (login wall)"}, {"what": "linking", "ref": SAVE, "reason": "not captured"}],
        "post": {"text": text}, "thread": [], "media": [],
        "replies": [{"author_handle": f"r{i}", "text": "y" * 900} for i in range(replies)],
        "links": [{"url": f"https://e.com/{i}", "title": "t" * 300, "status": "ok", "repo": None} for i in range(links)],
        "repos": [], "verdict": {"label": "try", "why": "w", "action": "a", "by": {"provider": "p", "model": "m", "prompt_v": "v"}},
    }


def test_card_fits_the_workers_limit_and_names_blocked():
    card = make_card(bundle(text="z" * 5000))
    assert len(canonical_json(card).encode("utf-8")) <= CARD_MAX
    # Every media or link gap is a block, so the save reads as blocked; the
    # expansion's own limits are not listed as gaps.
    assert card["status"] == "blocked"
    assert card["missing"] == ["link https://a: blocked at rung 7 (login wall)"]
    assert card["verdict"]["label"] == "try"
