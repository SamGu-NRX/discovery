"""Tests for the fleet watcher, launcher, receipts, find and charter. Run: python3 -m unittest discover -s runner/tests

Each test names the regression it catches. T3 is a fixture database (t3_fixture.T3DB) and a fake MCP endpoint
(t3_fixture.FakeT3) that keeps T3's replay and access rules; nothing here reads Sam's real T3.
"""
import ast
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from discovery_runner import config  # noqa: E402
from discovery_runner.fleet import charter, envelope, find, probe, receipts, watch  # noqa: E402
from discovery_runner.fleet.launcher import Launcher  # noqa: E402
from discovery_runner.fleet.t3client import Client, T3Error, T3Unreachable  # noqa: E402
from t3_fixture import FakeT3, T3DB  # noqa: E402

FLEET = Path(__file__).resolve().parent.parent / "discovery_runner" / "fleet"
NOW = dt.datetime(2026, 11, 19, 12, 0, tzinfo=dt.timezone.utc)


def at(minutes_ago: float) -> str:
    return watch.iso(NOW - dt.timedelta(minutes=minutes_ago))


class Fleet(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["DISCOVERY_HOME"] = self.tmp.name
        self.db = T3DB(Path(self.tmp.name) / "statev2.sqlite")
        self.con = probe.connect(self.db.path)

    def tearDown(self):
        self.con.close()
        self.db.con.close()
        os.environ.pop("DISCOVERY_HOME", None)
        self.tmp.cleanup()

    def watcher(self, since_min=600):
        return watch.Watcher(self.con, state=watch.MemoryState(), since=NOW - dt.timedelta(minutes=since_min))

    def awake(self, w, minutes=60):
        """The watcher has cycled every two minutes for `minutes`, so a stall can count."""
        w.state["last_cycle"] = at(2)
        w.state["awake_since"] = at(minutes)


class Watcher(Fleet):
    def test_failed_run_becomes_one_card_with_t3s_cause(self):
        # Regression: a failed run (cogportal's "your last run failed") went unnoticed until Sam typed "continue".
        self.db.thread("a", title="CogPortal")
        rid = self.db.run("a", 1, "failed", at(30), at(29))
        self.db.failure("a", rid, at(29), message="Claude Code could not find this conversation to resume.")
        w = self.watcher()
        cards = w.cycle(NOW)
        self.assertEqual([(c["kind"], c["cause"]) for c in cards], [("failed", "conversation lost")])
        self.assertEqual(w.cycle(NOW + dt.timedelta(minutes=2)), [], "the same run must not make a second card")

    def test_run_sam_stopped_from_the_app_gets_no_card(self):
        # Regression: a card (or worse, a resend) for a run Sam stopped himself.
        self.db.thread("a")
        rid = self.db.run("a", 1, "interrupted", at(30), at(29))
        self.db.receipt("a", "thread.stop", at(29.01), by="app")
        self.db.interrupt("a", rid, at(29), "Stopped by user")
        self.assertEqual(self.watcher().cycle(NOW), [])

    def test_steer_from_the_app_is_sams_stop(self):
        self.db.thread("a")
        rid = self.db.run("a", 1, "interrupted", at(30), at(29))
        self.db.receipt("a", "queued-message.promote-to-steer", at(29.01), by="app")
        self.db.interrupt("a", rid, at(29), "Skipped compaction to send a queued message")
        self.assertEqual(self.watcher().cycle(NOW), [])

    def test_agent_stop_and_unclear_stops_get_cards_never_actions(self):
        # Regression: a stop by MCP without a reason reads "Stopped by user" (OrchestratorMcpService.ts:275), so
        # the text alone must not count as Sam's stop.
        for tid, by, msg in (("agent", "mcp", "Stopped by an agent: disk under 4 GiB"),
                             ("unclear", "mcp", "Stopped by user"), ("none", None, None)):
            self.db.thread(tid)
            rid = self.db.run(tid, 1, "interrupted", at(30), at(29))
            if by:
                self.db.receipt(tid, "thread.stop", at(29.01), by=by)
            if msg:
                self.db.interrupt(tid, rid, at(29), msg)
        kinds = {c["thread_id"]: c["kind"] for c in self.watcher().cycle(NOW)}
        self.assertEqual(kinds, {"agent": "stopped_by_agent", "unclear": "interrupted_unknown",
                                 "none": "interrupted_unknown"})

    def test_dead_child_card_names_its_idle_lead(self):
        self.db.thread("lead", title="Lead: CogPortal")
        self.db.run("lead", 1, "completed", at(60), at(50))
        self.db.thread("child", title="Review", parent="lead")
        rid = self.db.run("child", 1, "failed", at(40), at(20))
        self.db.failure("child", rid, at(20))
        (card,) = self.watcher().cycle(NOW)
        self.assertEqual(card["lead"], {"thread_id": "lead", "title": "Lead: CogPortal", "idle": True})
        self.assertIn("Nothing was sent to either", watch.render([card], lambda t, title: title))

    def test_open_run_with_no_activity_for_30_minutes_is_stalled(self):
        self.db.thread("a")
        rid = self.db.run("a", 1, "running", at(90), started=at(90))
        self.db.item("a", rid, "assistant_message", "completed", at(45))
        w = self.watcher()
        self.awake(w)
        (card,) = w.cycle(NOW)
        self.assertEqual(card["kind"], "stalled")

    def test_no_stall_right_after_the_mac_wakes(self):
        # Regression: after a night asleep every open run looks 8 hours idle.
        self.db.thread("a")
        rid = self.db.run("a", 1, "running", at(600), started=at(600))
        self.db.item("a", rid, "assistant_message", "completed", at(500))
        w = self.watcher()
        w.state["last_cycle"] = at(480)  # the last cycle before sleep
        self.assertEqual(w.cycle(NOW), [])
        self.assertEqual(len(w.state["gaps"]), 1)

    def test_waiting_and_recently_active_runs_are_not_stalled(self):
        self.db.thread("a")
        self.db.run("a", 1, "waiting", at(120))
        self.db.thread("b")
        rid = self.db.run("b", 1, "running", at(120))
        self.db.item("b", rid, "command_execution", "running", at(5))
        w = self.watcher()
        self.awake(w)
        self.assertEqual(w.cycle(NOW), [])

    def test_archived_thread_and_completed_runs_get_no_card(self):
        self.db.thread("a", archived=at(5))
        rid = self.db.run("a", 1, "failed", at(30), at(29))
        self.db.failure("a", rid, at(29))
        self.db.thread("b")
        self.db.run("b", 1, "completed", at(30), at(29))
        self.assertEqual(self.watcher().cycle(NOW), [])

    def test_watermark_skips_runs_before_install(self):
        self.db.thread("a")
        rid = self.db.run("a", 1, "failed", at(900), at(899))
        self.db.failure("a", rid, at(899))
        self.assertEqual(self.watcher(since_min=60).cycle(NOW), [])

    def test_run_ending_after_the_watermark_is_caught(self):
        # Regression: watermarking on requested_at alone misses a long run that fails hours after it started.
        self.db.thread("a")
        w = self.watcher(since_min=10)
        self.assertEqual(w.cycle(NOW), [])
        rid = self.db.run("a", 1, "failed", at(300), at(1))
        self.db.failure("a", rid, at(1))
        self.assertEqual(len(w.cycle(NOW + dt.timedelta(minutes=2))), 1)

    def test_changed_schema_disables_the_watcher_by_name(self):
        self.db.con.execute("ALTER TABLE orchestration_v2_projection_runs RENAME COLUMN completed_at TO ended_at")
        self.db.commit()
        con = probe.connect(self.db.path)
        with self.assertRaises(probe.SchemaChanged) as e:
            probe.check_schema(con)
        self.assertIn("orchestration_v2_projection_runs.completed_at", str(e.exception))
        con.close()

    def test_database_is_opened_read_only(self):
        with self.assertRaises(Exception):
            self.con.execute("DELETE FROM orchestration_v2_projection_runs")


class Receipts(Fleet):
    def test_executed_model_differing_from_requested_is_mismatch(self):
        # Regression: unify's run asked for Opus and ran on another model while the thread said Opus.
        self.db.thread("a")
        rid = self.db.run("a", 1, "completed", at(30), at(1), model="claude-opus-5-5", executed=["claude-fable-5-2"])
        r = receipts.observe(self.con, rid, ask="> fix the review loop")
        self.assertEqual(r["flags"], ["mismatch"])
        self.assertFalse(receipts.done({**r, "level": "verified", "exit_code": 0}))

    def test_same_model_spelled_differently_is_not_mismatch(self):
        self.db.thread("a")
        rid = self.db.run("a", 1, "completed", at(30), at(1), model="claude-opus-5-5",
                          executed=["claude-opus-5-5[1m]", "custom:cliproxy:claude-opus-5-5"])
        self.assertEqual(receipts.observe(self.con, rid, ask="x")["flags"], [])

    def test_missing_executed_model_is_unknown_not_a_match(self):
        self.db.thread("a")
        rid = self.db.run("a", 1, "completed", at(30), at(1), model="muse-wonder-full-1.0")
        r = receipts.observe(self.con, rid, ask="x")
        self.assertEqual((r["executed_models"], r["flags"]), ("model unknown", []))

    def test_done_needs_verified_exit_zero_and_no_flag(self):
        r = {"ts": at(10), "level": "observed", "flags": []}
        v = receipts.verify(r, [sys.executable, "-c", "print('ok')"], cwd=self.tmp.name)
        self.assertTrue(receipts.done(v))
        self.assertFalse(receipts.done(receipts.verify(r, [sys.executable, "-c", "raise SystemExit(3)"], self.tmp.name)))
        self.assertFalse(receipts.done(v, gaps=[[watch.iso(dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5)),
                                                 "later"]]), "a sleep after the check makes it stale")


class Envelopes(Fleet):
    def setUp(self):
        super().setUp()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        git = lambda *a: subprocess.run(["git", "-C", str(self.repo), *a], check=True, capture_output=True)
        git("init", "-q", "-b", "main")
        git("remote", "add", "origin", "git@github.com:SamGu-NRX/demo.git")
        (self.repo / ".agents").mkdir()
        (self.repo / ".agents" / "topology.json").write_text(json.dumps({"origin": "git@github.com:SamGu-NRX/demo.git",
                                                                          "merge": "on-full-send"}))
        git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
        self.routes = {"build": {"key": "build", "targets": {"t3": [
            {"provider": "claudeAgent_claude_pool", "model": "claude-opus-5-5", "effort": "high"}]}}}
        self.db.thread("sam-thread")
        self.said = "I want the sections that are like, quote, \"verbatim\" below.\n\nThe brief should still be a brief — as it is prompt optimally."
        self.mid = self.db.message("sam-thread", self.said, by="user")
        self.db.project("p-demo", str(self.repo.resolve()))

    def env(self, **over):
        base = dict(template="drafted", title="Demo", repo=str(self.repo), origin="git@github.com:SamGu-NRX/demo.git",
                    base_branch="main", route="build", provider="claudeAgent_claude_pool", model="claude-opus-5-5",
                    effort="high", round=1, brief="Do the thing.",
                    ask_verbatim=[{"text": self.said, "source_message_ids": [self.mid]}])
        return envelope.Envelope(**{**base, **over})

    def launcher(self, calls):
        def factory():
            calls.append("client")
            raise AssertionError("T3 was called")
        return Launcher(self.con, client_factory=factory, mode="full", lim={**__import__(
            "discovery_runner.fleet.launcher", fromlist=["LIMITS"]).LIMITS, "disk_floor_gb": 0})

    def test_six_planted_launches_are_refused_before_t3_is_called(self):
        # Regression: a launch with a missing field, a wrong model or text Sam never wrote reaching T3.
        bare = Path(self.tmp.name) / "no-topology"
        bare.mkdir()
        subprocess.run(["git", "-C", str(bare), "init", "-q"], check=True)
        planted = {
            "repo": self.env(repo=None),
            "repo ": self.env(repo=str(bare)),
            "model": self.env(model="gpt-6-luna"),
            "runtime_mode": self.env(runtime_mode="full-access"),
            "text_source": self.env(text_source="email"),
            "round": self.env(round=4),
        }
        calls = []
        launcher = self.launcher(calls)
        for field, env in planted.items():
            with self.subTest(field=field), self.assertRaises(envelope.Refused) as e:
                launcher.launch(env, approved_by_go=True, routes=self.routes)
            self.assertIn(field.strip(), e.exception.problems)
        self.assertEqual(calls, [])

    def test_drafted_launch_waits_for_go(self):
        calls = []
        with self.assertRaises(envelope.Refused) as e:
            self.launcher(calls).launch(self.env(), routes=self.routes)
        self.assertIn("approval", e.exception.problems)
        self.assertEqual(calls, [])

    def test_valid_envelope_passes(self):
        envelope.check(self.env(), self.con, self.routes)

    def test_verbatim_section_is_byte_for_byte_what_sam_wrote(self):
        excerpts = [self.said, "> starts with a marker\n  indented  \n\n\ttab — ünïcode [...] after the cut"]
        env = self.env(ask_verbatim=[{"text": t, "source_message_ids": [self.mid]} for t in excerpts])
        brief = envelope.render_brief(env)
        self.assertTrue(brief.startswith("Do the thing.\n\n---\n\nSam's words, verbatim:\n"))
        got = envelope.verbatim_section(brief)
        self.assertEqual([g.encode() for g in got], [e.encode() for e in excerpts])

    def test_excerpt_not_in_sams_message_is_refused(self):
        for text, src in (("I want the sections [...] something I never said", self.mid),
                          (self.said, self.db.message("sam-thread", self.said, by="agent"))):
            with self.subTest(text=text[:20]), self.assertRaises(envelope.Refused) as e:
                envelope.check(self.env(ask_verbatim=[{"text": text, "source_message_ids": [src]}]), self.con, self.routes)
            self.assertIn("ask_verbatim", e.exception.problems)

    def test_cut_excerpt_of_sams_words_passes(self):
        cut = "I want the sections [...] The brief should still be a brief"
        envelope.check(self.env(ask_verbatim=[{"text": cut, "source_message_ids": [self.mid]}]), self.con, self.routes)

    def test_cards_mode_refuses_every_launch(self):
        launcher = self.launcher([])
        launcher.mode = "cards"
        with self.assertRaises(envelope.Refused) as e:
            launcher.launch(self.env(), approved_by_go=True, routes=self.routes)
        self.assertIn("fleet_mode", e.exception.problems)


class DuplicateSends(Fleet):
    """The four ways one write could land twice. Each must leave exactly one message or thread in T3."""

    def setUp(self):
        super().setUp()
        self.db.thread("op", title="Operator", mode="auto")
        self.t3 = FakeT3(self.db)
        self.card = {"key": "run:x:failed", "kind": "failed", "cause": "error", "detail": None, "thread_id": "x",
                     "title": "X", "ordinal": 1, "mode": "full-access", "lead": None}

    def tearDown(self):
        self.t3.close()
        super().tearDown()

    def launcher(self, cls=Launcher):
        return cls(self.con, client_factory=lambda: Client(self.t3.url, "tok"), log=lambda m: None)

    def sends(self):
        return [c for c in self.t3.calls if c[0] == "t3_thread_send"]

    def test_repeated_key_sends_once(self):
        self.launcher().post_cards("op", [self.card])
        self.launcher().post_cards("op", [self.card])
        self.assertEqual((len(self.sends()), self.t3.messages_in("op")), (1, 1))

    def test_kill_after_t3_accepted_sends_once(self):
        class Killed(Launcher):
            def _after_accept(self, key, result):
                raise KeyboardInterrupt  # the runner dies before it records the accept
        with self.assertRaises(KeyboardInterrupt):
            self.launcher(Killed).post_cards("op", [self.card])
        self.launcher().post_cards("op", [self.card])
        self.assertEqual((len(self.sends()), self.t3.messages_in("op")), (1, 1))

    def test_lost_response_is_uncertain_then_recovered_without_resending(self):
        self.t3.drop_next = True
        with self.assertRaises(T3Unreachable):
            self.launcher().post_cards("op", [self.card])
        self.assertEqual([r["flags"] for r in receipts.read_all()], [["uncertain"]])
        rec = self.launcher().post_cards("op", [self.card])
        self.assertEqual((rec["state"], rec.get("recovered")), ("accepted", True))
        self.assertEqual((len(self.sends()), self.t3.messages_in("op")), (1, 1))

    def test_t3_restart_does_not_duplicate_even_without_its_replay(self):
        # T3 scopes clientRequestId replay to the sign-in session, so after a restart only the marker search
        # stands between a retry and a second message.
        self.t3.drop_next = True
        with self.assertRaises(T3Unreachable):
            self.launcher().post_cards("op", [self.card])
        self.t3.restart()
        self.launcher().post_cards("op", [self.card])
        self.assertEqual((len(self.sends()), self.t3.messages_in("op")), (1, 1))

    def test_t3_refuses_a_send_to_a_full_access_thread(self):
        # The operator holds an Auto sign-in; T3, not the runner, decides it can't touch Full access threads.
        self.db.thread("full", mode="full-access")
        with self.assertRaises(T3Error) as e:
            self.launcher().post_cards("full", [self.card])
        self.assertIn("above this caller's auto limit", str(e.exception))
        self.assertEqual(self.t3.messages_in("full"), 0)

    def test_cards_found_while_t3_is_down_are_posted_once_it_is_back(self):
        # Regression: the watcher marks a run seen when it makes the card, so a failed post must keep the card.
        from discovery_runner.fleet import cli
        self.db.thread("x", title="X")
        rid = self.db.run("x", 1, "failed", at(30), at(29))
        self.db.failure("x", rid, at(29))
        cfg = {"fleet_operator_thread": "op"}
        w, outbox = self.watcher(), cli.Outbox()
        down = Launcher(self.con, client_factory=lambda: Client("http://127.0.0.1:9/mcp", "tok"), log=lambda m: None)
        with self.assertRaises(T3Unreachable):
            cli.cycle(cfg, self.con, w, down, outbox)
        self.assertEqual([len(b) for b in outbox.load()], [1])
        cli.cycle(cfg, self.con, w, self.launcher(), outbox)
        cli.cycle(cfg, self.con, w, self.launcher(), outbox)
        self.assertEqual((outbox.load(), self.t3.messages_in("op")), ([], 1))


class Find(Fleet):
    def test_rare_word_finds_its_thread_over_a_long_busy_one(self):
        self.db.thread("busy", title="Mac disk cleanup", created="2026-09-01T00:00:00.000Z")
        for i in range(60):
            self.db.message("busy", f"review the code and the thread again, step {i}", role="assistant", by="agent")
        self.db.thread("aikido", title="Code review ideas", created="2026-09-10T00:00:00.000Z")
        self.db.message("aikido", "what if we add an aikido review pass", by="user")
        self.db.thread("asked", title="where", created="2026-09-18T00:00:00.000Z")
        got = find.search(self.con, 'Which is the thread where we discuss adding another code review that is "aikido"?',
                          before="2026-09-18T12:00:00.000Z", exclude={"asked"})
        self.assertEqual(got[0]["thread_id"], "aikido")

    def test_archived_threads_are_found_and_later_threads_are_not(self):
        self.db.thread("old", title="Anthropic API key setup", archived="2026-10-01T00:00:00.000Z",
                       created="2026-09-01T00:00:00.000Z")
        self.db.thread("new", title="Anthropic API key again", created="2026-11-01T00:00:00.000Z")
        got = find.search(self.con, "find the thread where i gave the agent an anthropic api key",
                          before="2026-10-28T00:00:00.000Z")
        self.assertEqual([g["thread_id"] for g in got], ["old"])
        self.assertTrue(got[0]["archived"])


class Charter(Fleet):
    LOG = """# Decision Log

### YYYY-MM-DD — Decision title

- **Status:** confirmed | superseded
- **Decision:**

### 2026-11-18 — Keep Claude Code transcripts until they are on Drive

- **Status:** confirmed
- **Decision:** `cleanupPeriodDays` is 36500 in ~/.claude/settings.json; transcripts are archived to Drive, never auto-deleted.

### 2026-11-01 — Older

- **Status:** confirmed
- **Decision:** Older decision.

### 2026-11-19 — Proposed only

- **Status:** proposed
- **Decision:** Not yet.
"""

    def setUp(self):
        super().setUp()
        self.log = Path(self.tmp.name) / "decision-log.md"
        self.log.write_text(self.LOG)

    def test_confirmed_decisions_newest_first_proposed_left_out(self):
        block = charter.build(self.tmp.name, global_files=[self.log], sam_mode="/nonexistent")
        lines = block.splitlines()
        self.assertIn("cleanupPeriodDays", lines[2])
        self.assertIn("Older", lines[3])
        self.assertNotIn("Not yet", block)
        self.assertNotIn("YYYY", block)

    def test_block_stays_within_the_line_budget(self):
        many = "".join(f"### 2026-10-{i:02d} — D{i}\n\n- **Status:** confirmed\n- **Decision:** d{i}\n\n" for i in range(1, 29))
        self.log.write_text(self.LOG + many)
        self.assertLessEqual(len(charter.build(self.tmp.name, global_files=[self.log], sam_mode="/x").splitlines()),
                             charter.LINE_BUDGET)

    def test_hook_output_carries_the_block_as_additional_context(self):
        out = json.loads(charter.hook_output("hello"))
        self.assertEqual(out["hookSpecificOutput"], {"hookEventName": "SessionStart", "additionalContext": "hello"})

    def test_publish_replaces_its_own_block_only(self):
        f = Path(self.tmp.name) / "AGENTS.md"
        f.write_text("# Mine\nkeep this\n")
        charter.publish("one", f)
        charter.publish("two", f)
        text = f.read_text()
        self.assertEqual((text.count(charter.BEGIN), "keep this" in text, "one" in text, "two" in text),
                         (1, True, False, True))


class Boundaries(unittest.TestCase):
    def test_only_the_launcher_imports_the_t3_write_client(self):
        # Regression: a watcher or find path that could post to T3 directly, skipping the envelope and limits.
        for f in FLEET.glob("*.py"):
            tree = ast.parse(f.read_text())
            names = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module} | \
                    {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
            if any(n and n.split(".")[-1] == "t3client" for n in names):
                self.assertIn(f.name, ("launcher.py", "t3client.py"), f"{f.name} imports t3client")

    def test_fleet_code_has_no_merge_call(self):
        # The operator never merges. A merge needs Sam's own "full send" in a thread, outside this package.
        for f in FLEET.glob("*.py"):
            tree = ast.parse(f.read_text())
            docs = {id(n.body[0].value) for n in ast.walk(tree)
                    if isinstance(n, (ast.Module, ast.FunctionDef, ast.ClassDef)) and n.body
                    and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
            for n in ast.walk(tree):
                if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docs:
                    self.assertNotRegex(n.value.lower(), r"\bmerge\b", f"{f.name}: {n.value[:60]!r}")
                if isinstance(n, (ast.Name, ast.Attribute)):
                    self.assertNotIn("merge", (getattr(n, "id", None) or getattr(n, "attr", "")).lower(), f.name)

    def test_discovery_topology_says_merge_on_full_send(self):
        topo = json.loads((Path(__file__).resolve().parents[2] / ".agents" / "topology.json").read_text())
        self.assertEqual((topo["merge"], topo["agent_branch_prefix"]), ("on-full-send", "agent/"))


if __name__ == "__main__":
    unittest.main()
