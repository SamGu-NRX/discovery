"""Tests for the runner's components that have one correct answer. Run: python3 -m unittest discover runner/tests

Each test names the regression it catches. Model outputs are canned by FakeGateway; prompt wording is
never asserted.
"""
import datetime as dt
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from discovery_runner import config, policy, scoring  # noqa: E402
from discovery_runner.llm import Gateway  # noqa: E402
from discovery_runner.pipeline import Runner  # noqa: E402
from discovery_runner.worker import Worker, flush_outbox  # noqa: E402
from mock_worker import TOKEN, FakeGateway, MockWorker, hashed_vector, iso, now  # noqa: E402


class Home(unittest.TestCase):
    """A throwaway ~/.discovery with a config pointing at the mock Worker and a fake gateway."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["DISCOVERY_HOME"] = self.tmp.name
        self.mock = MockWorker().__enter__()
        tok = Path(self.tmp.name) / "token"
        tok.write_text(TOKEN)
        self.cfg_over = {"worker_url": self.mock.url, "token_file": str(tok)}
        self.gw = None

    def tearDown(self):
        self.mock.__exit__()
        if self.gw:
            self.gw.close()
        os.environ.pop("DISCOVERY_HOME", None)
        self.tmp.cleanup()

    def cfg(self, **over):
        c = {**config.DEFAULTS, **self.cfg_over, **over}
        Path(self.tmp.name, "config.json").write_text(json.dumps(c))
        return config.load()

    def runner(self, answers, **over):
        self.gw = FakeGateway(answers)
        cfg = self.cfg(gateway_url=self.gw.url, **over)
        return Runner(cfg, Worker.from_config(cfg), Gateway(cfg["gateway_url"], lambda: "k", retries=0), log=lambda m: None)

    def captured_post(self, pid="111", text="new eval harness for agent runners", age_h=0.0):
        s = self.mock.state
        post = {"id": pid, "author_handle": "dev", "text": text, "urls": [], "media": [], "created_at": iso(now())}
        s.posts[pid] = {**post, "session_id": "s1", "bookmarked": 1}
        s.contexts[pid] = {"post": post, "quoted": None, "thread_captured": True,
                           "op_self_thread": [{"id": "112", "author_handle": "dev", "text": "the trick is replaying real recordings"}],
                           "replies": [{"id": "113", "author_handle": "ann", "text": "this broke for us on long traces"}]}
        return s.add_candidate("x_post", pid, "t", f"https://x.com/dev/status/{pid}",
                               created_at=iso(now() - dt.timedelta(hours=age_h)))


TRIAGE_TRY = {"action_type": "try_tool", "why_it_matters": "ledger", "confidence": 0.8, "gist": "g"}
TRIAGE_NONE = {"action_type": "no_action", "why_it_matters": "nothing to do", "confidence": 0.9, "gist": "g"}
JUDGE_OK = {"verdict": "approve", "busywork": False, "reason": "useful"}


def deep_read(target, claims=(), **kw):
    return {"decline": False, "kind": "try_tool", "title": "Replay the watcher recordings", "why": "w",
            "target": target, "claims": list(claims), "prep": {"needs_tools": False},
            "evidence": [{"quote": "the trick is replaying real recordings", "where": "op_followup"},
                         {"quote": "a sentence nobody wrote", "where": "op"}],
            "final_step_kind": "open_pr", "final_step": "open the PR", "approval_line": "Open it?", **kw}


class AiPolicy(unittest.TestCase):
    APP = {"employer": "Anthropic", "fields": [
        {"name": "Why Anthropic?", "kind": "essay", "value": "Because I love safety."},
        {"name": "Graduation", "kind": "fact", "value": "May 2028"}]}

    def test_restricting_guidance_blanks_essays_and_keeps_facts(self):
        # fails if a model-drafted essay reaches Sam when the employer limits AI drafting
        out = policy.apply_ai_policy(self.APP, {"url": "u", "restricts_drafting": True, "quote": "draft it yourself"})
        f = {x["name"]: x for x in out["fields"]}
        self.assertEqual(f["Why Anthropic?"]["value"], "")
        self.assertTrue(f["Why Anthropic?"]["left_to_sam"])
        self.assertEqual(f["Graduation"]["value"], "May 2028")
        self.assertEqual(out["ai_policy"]["blanked"], ["Why Anthropic?"])

    def test_missing_or_unclear_guidance_is_treated_as_restrictive(self):
        # fails if an employer with no known guidance page silently gets AI-drafted essays
        for g in (None, {"url": "u", "restricts_drafting": None}):
            out = policy.apply_ai_policy(self.APP, g)
            self.assertEqual(out["fields"][0]["value"], "")

    def test_explicit_permission_keeps_drafts(self):
        out = policy.apply_ai_policy(self.APP, {"url": "u", "restricts_drafting": False, "quote": "q"})
        self.assertEqual(out["fields"][0]["value"], "Because I love safety.")


class Duplicates(unittest.TestCase):
    def setUp(self):
        self.vecs = {"a": [1.0, 0.0], "a2": [0.9, 0.4359], "b": [0.0, 1.0]}  # cos(a, a2) = 0.9

    def find(self, new, existing):
        return policy.find_duplicate(new, existing, lambda t: self.vecs[t], 14, 0.85)

    def test_similar_recent_proposal_is_merged(self):
        # fails if two near-identical proposals from different posts both reach Sam (seven did on Nov 4)
        recent = iso(now() - dt.timedelta(days=3))
        d = self.find({"text": "a2", "target": None}, [{"id": "p1", "text": "a", "created_at": recent}])
        self.assertEqual(d["id"], "p1")

    def test_similar_but_old_proposal_is_not_merged(self):
        old = iso(now() - dt.timedelta(days=20))
        self.assertIsNone(self.find({"text": "a2", "target": None}, [{"id": "p1", "text": "a", "created_at": old}]))

    def test_same_target_merges_even_when_wording_differs(self):
        # fails if URL spelling (scheme, www, trailing slash) hides that two proposals act on the same thing
        d = self.find({"text": "b", "target": "https://www.github.com/acme/tool/"},
                      [{"id": "p2", "text": "a", "target": "http://github.com/acme/tool", "created_at": iso(now())}])
        self.assertEqual(d["id"], "p2")


class PathVerification(unittest.TestCase):
    def test_nonexistent_path_is_labeled_false(self):
        # fails if a proposal can assert a path that does not exist (8 did on Nov 4)
        c = policy.verify_claim({"check": "path_exists", "path": "~/no-such-dir-xyz/ledger/tests"}, ["/tmp"])
        self.assertEqual(c["status"], "false")

    def test_path_named_only_in_prose_is_checked(self):
        out = policy.verify_all([], ["edit ~/no-such-dir-xyz/app.py to add the gate"], ["/tmp"])
        self.assertEqual([(c["path"], c["status"]) for c in out], [("~/no-such-dir-xyz/app.py", "false")])

    def test_already_in_place_claim_is_checked_against_file(self):
        # fails if "setting X is not on yet" is believed when the file already has it (the Nov 4 cache case)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write('{"env": {"ENABLE_PROMPT_CACHING_1H": "1"}}')
        try:
            lacks = policy.verify_claim({"check": "file_lacks", "path": f.name, "text": "ENABLE_PROMPT_CACHING_1H"}, [])
            eq = policy.verify_claim({"check": "config_equals", "path": f.name, "key": "env.ENABLE_PROMPT_CACHING_1H",
                                      "value": "1"}, [])
        finally:
            os.unlink(f.name)
        self.assertEqual((lacks["status"], eq["status"]), ("false", "verified"))

    def test_credential_paths_are_never_read(self):
        c = policy.verify_claim({"check": "file_contains", "path": "~/.agent-secrets/discovery-runner-token",
                                 "text": "a"}, [])
        self.assertEqual(c["status"], "unverifiable")


class Coursework(unittest.TestCase):
    cfg = config.DEFAULTS

    def test_course_markers_are_excluded(self):
        # fails if any proposal touching Sam's classes gets through (GOV 310L bans generative AI)
        for t in ("Draft GOV310L reading notes", "summarize gov 310l section 8", "~/UT/CS 311/pset7.pdf",
                  "/Users/samgu/UT/Canvas/x", "https://utexas.instructure.com/courses/1", "finish my homework"):
            self.assertIsNotNone(policy.coursework_hit([t], self.cfg), t)

    def test_non_coursework_is_not_excluded(self):
        # fails if the filter swallows applications (resume sources live under ~/UT) or other schools' courses
        for t in ("~/UT/Internship_Job_Hunt/Resume/cv.tex", "Stanford CS 336 lectures on LLMs", "CS 3110 OCaml notes"):
            self.assertIsNone(policy.coursework_hit([t], self.cfg), t)

    def test_coursework_candidate_is_skipped_before_any_model_call(self):
        h = Home()
        h.setUp()
        try:
            r = h.runner({})
            h.mock.state.add_candidate("watcher_event", "canvas:1", "New assignment", "https://utexas.instructure.com/x")
            runs = r.work()
            self.assertEqual(runs[0]["complete"]["state"], "skipped")
            self.assertEqual(h.gw.calls, [])
        finally:
            h.tearDown()


class BudgetsAndStop(Home):
    def test_stop_file_halts_work_before_claiming(self):
        # fails if the emergency stop does not stop the runner from taking new work
        r = self.runner({})
        self.captured_post()
        config.path("STOP").write_text("x")
        with self.assertRaises(config.Stopped):
            r.work()
        self.assertNotIn(("POST", "/candidates/claim"), self.mock.state.log)

    def test_stop_mid_candidate_returns_it_to_the_queue(self):
        # fails if a STOP during a candidate lets later model calls run or strands the candidate as claimed
        def triage():
            config.path("STOP").write_text("x")
            return TRIAGE_TRY
        r = self.runner({"You triage": triage})
        c = self.captured_post()
        with self.assertRaises(config.Stopped):
            r.work()
        self.assertEqual([x["stage"] for x in self.gw.calls], ["You triage"])
        self.assertEqual(self.mock.state.candidates[c["id"]]["state"], "new")

    def test_exhausted_deep_read_budget_claims_nothing(self):
        r = self.runner({}, deep_reads_per_day=2)
        self.assertTrue(config.take("deep_reads", 2, 2))
        self.captured_post()
        self.assertEqual(r.work(), [])
        self.assertNotIn(("POST", "/candidates/claim"), self.mock.state.log)

    def test_budget_reservation_never_exceeds_limit(self):
        self.cfg()
        self.assertEqual([config.take("codex_preps", 5) for _ in range(7)], [True] * 5 + [False] * 2)


class Leases(Home):
    def test_uncaptured_young_thread_is_deferred_with_a_note(self):
        # fails if a candidate is deep-read before its replies exist, or deferred without a reason
        r = self.runner({})
        s = self.mock.state
        s.posts["222"] = {"id": "222", "author_handle": "a", "text": "x", "urls": [], "media": []}
        c = s.add_candidate("x_post", "222", "t", "u", created_at=iso(now() - dt.timedelta(hours=1)))
        r.work()
        row = s.candidates[c["id"]]
        self.assertEqual(row["state"], "new")
        self.assertIn("deferred", row["note"])
        self.assertEqual(self.gw.calls, [])

    def test_uncaptured_old_thread_proceeds_and_records_the_gap(self):
        r = self.runner({"You triage": TRIAGE_NONE})
        s = self.mock.state
        s.posts["223"] = {"id": "223", "author_handle": "a", "text": "x", "urls": [], "media": []}
        s.add_candidate("x_post", "223", "t", "u", created_at=iso(now() - dt.timedelta(hours=7)))
        run = r.work()[0]
        self.assertIn("thread not captured: OP follow-ups and replies unseen", run["missing_context"])

    def test_lease_taken_by_another_owner_is_reported_not_raised(self):
        # fails if a 409 on complete crashes the cycle and abandons the other claimed candidates
        def steal():
            for c in self.mock.state.candidates.values():
                c["owner"] = "someone-else"
            return TRIAGE_NONE
        r = self.runner({"You triage": steal})
        self.captured_post()
        run = r.work()[0]
        self.assertIn("lease_lost", run["complete"])

    def test_no_proposal_is_posted_after_the_lease_expires(self):
        # fails if a runner whose lease ran out still posts, so two runners create the same proposal
        r = self.runner({"You triage": TRIAGE_TRY, "You deep-read": deep_read("~/x"), "independent": JUDGE_OK},
                        claim_ttl_s=5)
        self.captured_post()
        run = r.work()[0]
        self.assertIn("aborted", run)
        self.assertEqual(self.mock.state.proposals, {})


class EndToEnd(Home):
    def test_proposal_cites_only_verified_quotes_and_judge_is_a_different_model(self):
        # fails if the judge runs on the proposer's model (Sol approved all of Sol's work on Nov 4), or a
        # misquote or false path reaches the recorded proposal unlabeled
        missing = "~/no-such-dir-xyz/watcher"
        dr = deep_read(missing, claims=[{"check": "path_exists", "path": missing, "statement": "watcher dir", "premise": False}])
        r = self.runner({"You triage": TRIAGE_TRY, "You deep-read": dr, "independent": JUDGE_OK})
        self.captured_post()
        r.work()
        (p,) = self.mock.state.proposals.values()
        self.assertEqual([e["quote"] for e in p["evidence"]], ["the trick is replaying real recordings"])
        self.assertIn("Unverified", p["why"])
        self.assertEqual(p["final_step_kind"], "open_pr")
        models = {c["stage"]: c["model"] for c in self.gw.calls}
        self.assertEqual(models["You deep-read"], "gpt-6.1-sol")
        self.assertEqual(models["independent"], "gpt-6-astra")

    def test_judge_maybe_is_recorded_without_asking(self):
        # fails if a proposal the independent judge only rated "maybe" notifies Sam (asks must stay rare)
        r = self.runner({"You triage": TRIAGE_TRY, "You deep-read": deep_read("~/x"),
                         "independent": {"verdict": "maybe", "busywork": False, "reason": "later"}})
        self.captured_post()
        r.work()
        (p,) = self.mock.state.proposals.values()
        self.assertIsNone(p["final_step_kind"])
        self.assertEqual(p["state"], "done")

    def test_second_candidate_with_same_target_merges(self):
        r = self.runner({"You triage": TRIAGE_TRY, "You deep-read": deep_read("https://github.com/acme/tool"),
                         "independent": JUDGE_OK})
        self.captured_post("111")
        self.captured_post("311", text="another post about the same tool")
        runs = r.work()
        self.assertEqual(len(self.mock.state.proposals), 1)
        self.assertIn("merged into proposal", runs[1]["complete"]["note"])

    def test_proposals_wait_in_outbox_until_the_route_is_live(self):
        # fails if proposals are lost while POST /proposals is not deployed
        r = self.runner({"You triage": TRIAGE_TRY, "You deep-read": deep_read("~/x"), "independent": JUDGE_OK})
        self.mock.state.routes_down.add(("POST", "/proposals"))
        self.captured_post()
        r.work()
        self.assertEqual(self.mock.state.proposals, {})
        self.mock.state.routes_down.clear()
        flush_outbox(r.worker)
        self.assertEqual(len(self.mock.state.proposals), 1)
        self.assertEqual(list(config.path("outbox", "x").parent.glob("*.json")), [])


class Scoring(Home):
    def test_score_is_top5_positive_mean_minus_top5_skipped_plus_author_prior(self):
        # fails if the contract's scoring formula changes (k, sign of skipped, or the prior)
        v = [1.0, 0.0]
        pos = [[1.0, 0.0]] * 2 + [[0.0, 1.0]] * 4   # top 5 sims: 1, 1, 0, 0, 0
        skipped = [[0.6, 0.8]]
        s, parts = scoring.score(v, "Dev", pos, skipped, {"dev"}, 0.02)
        self.assertAlmostEqual(s, 0.4 - 0.6 + 0.02)
        self.assertEqual(parts["skipped_top5"], 0.6)

    def test_unbookmarked_candidates_are_capped_and_bookmarks_left_to_the_worker(self):
        # fails if more than 15 unbookmarked candidates a day reach the queue, or bookmarks are queued twice
        self.mock.state.positives = [{"id": "p", "text": "agent eval harness replay", "author_handle": "x"}]
        for i in range(20):
            self.mock.state.posts[str(i)] = {"id": str(i), "author_handle": "a", "text": "agent eval harness replay",
                                             "urls": [], "session_id": "s", "bookmarked": 1 if i == 0 else 0}
        cfg = self.cfg(score_threshold=0.5)
        res = scoring.run_score(Worker.from_config(cfg), cfg, log=lambda m: None)
        made = {c["ref"] for c in self.mock.state.candidates.values()}
        self.assertEqual((res["scored"], res["candidates"], res["capped"]), (20, 15, 4))
        self.assertNotIn("0", made)


if __name__ == "__main__":
    unittest.main()
