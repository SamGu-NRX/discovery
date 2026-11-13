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


def test_card_that_cannot_fit_ends_with_an_error_instead_of_looping():
    # Review of f8c8d6f: with one link left and the shortest excerpt, the old
    # loop kept "shrinking" without changing anything and never returned.
    import threading

    b = bundle(text="z" * 5000, links=1)
    b["url"] = "https://x.com/" + "u" * 5000
    outcome = {}

    def attempt():
        try:
            outcome["card"] = make_card(b)
        except Exception as e:  # noqa: BLE001 - the test inspects it below
            outcome["error"] = e

    t = threading.Thread(target=attempt, daemon=True)
    t.start()
    t.join(10)
    assert not t.is_alive(), "make_card did not return within 10 s"
    assert "card" not in outcome
    assert "after every cut" in str(outcome["error"])
    assert type(outcome["error"]).__name__ == "CardTooLarge"


def test_a_long_link_url_is_dropped_to_fit():
    b = bundle(links=1)
    b["links"][0]["url"] = "https://e.com/" + "v" * 5000
    card = make_card(b)
    assert len(canonical_json(card).encode("utf-8")) <= CARD_MAX
    assert card["links"] == []


def test_a_saved_reply_is_judged_and_bundled_with_the_posts_it_answers(monkeypatch):
    """Through bundle.build: the intake's parent chain reaches the verdict's
    input and bundle.md, oldest post first."""
    from kworker import bundle as bundle_mod
    from kworker import models

    body = intake(upstream=[
        {"id": "2119000000000000002", "url": "https://x.com/p/status/2119000000000000002", "author_handle": "parent", "text": "the question"},
        {"id": "2119000000000000001", "url": "https://x.com/g/status/2119000000000000001", "author_handle": "grand", "text": "the root post"},
    ])
    body["post"]["reply_to"] = "2119000000000000002"
    exp = expansion(body)
    blobs = {"exp": exp, "gate": {"gate_v": "g", "kept": [], "dropped": []}}
    stored, registered, seen = {}, [], {}

    class Api:
        def get_json(self, sha):
            return blobs[sha]

        def put_bytes(self, data, mime):
            stored[len(stored)] = data
            return f"{len(stored):064x}"

        def put_text(self, text, mime="text/plain"):
            stored["md"] = text
            return "e" * 64

        def call(self, method, path, body=None, **kw):
            assert (method, path) == ("POST", "/k/bundles"), (method, path)
            registered.append(body)
            return {"created": True, "version": 1}

    def fake_run(ctx, step, build):
        req = build({"prompt_v": "save-verdict-v1", "provider": "p", "model": "m"})
        seen["text"] = req.text
        return models.Result('{"label": "read", "why": "w", "action": ""}', "f" * 64, models.By("p", "m", "save-verdict-v1"), False)

    monkeypatch.setattr(models, "run", fake_run)
    ctx = type("Ctx", (), {"api": Api()})()
    bundle_mod.build(ctx, {"post_id": SAVE, "expansion_sha": "exp", "gate_sha": "gate", "children": []})

    text = seen["text"]
    assert text.index("the root post") < text.index("the question") < text.index("use sol for CUA")
    md = stored["md"]
    assert md.index("## Replying to") < md.index("the root post") < md.index("the question")
    assert registered and registered[0]["card"]["verdict"]["label"] == "read"