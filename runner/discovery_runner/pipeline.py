"""`work`: claim candidates and turn each into a recorded proposal, a merge, a deferral or a skip.

Per candidate: bundle -> related saves -> triage (Luna) -> deep read (Sol) -> live-state checks, with one
revision when a premise is false -> coursework, AI-policy and duplicate checks -> independent judge
(Astra, low effort) -> prep files, and `codex exec` when the work needs tools -> POST /proposals -> complete.
Every step's output is kept in runs/<date>/<candidate>.json.
"""
import datetime as dt
import json
import os
import re
import shutil
import signal
import subprocess
import uuid
from pathlib import Path

from . import bundle as B
from . import config, policy, prompts
from .context import sam_context
from .proposals_index import record_local, recent
from .scoring import EmbeddingCache, cos
from .worker import LeaseLost, WorkerError, WorkerUnavailable, new_client_id, submit_proposal

ACTIONABLE = set(prompts.ACTION_TYPES) - {"no_action", "reference_note"}


# The lease owner. Random per process start, because hostname+PID collides when a restarted runner gets a
# reused PID and could complete a lease its dead predecessor held (contract 10b06ac).
INSTANCE_ID = f"runner-{uuid.uuid4().hex}"


class Runner:
    def __init__(self, cfg, worker, gateway, log=print):
        self.cfg = cfg
        self.worker = worker
        self.llm = gateway
        self.log = log
        self.owner = INSTANCE_ID
        self._emb = None
        self._positives = None

    # ------------------------------------------------------------ helpers

    @property
    def emb(self):
        if self._emb is None:
            self._emb = EmbeddingCache(self.worker)
        return self._emb

    def positives(self):
        if self._positives is None:
            try:
                items = [p for p in self.worker.positives() if p.get("text")]
            except WorkerUnavailable:
                items = []
            self._positives = (items, self.emb.vectors([p["text"] for p in items]) if items else [])
        return self._positives

    def vec(self, text):
        return self.emb.vectors([text[:4000]])[0]

    def related(self, text, open_props, self_id=None):
        """Sam's most similar earlier saves and open proposals: the dots this item may connect to.

        A bookmarked post is itself a positive, so its own id is left out."""
        v = self.vec(text)
        items, vecs = self.positives()
        saves = sorted(((cos(v, pv), p) for p, pv in zip(items, vecs) if p["id"] != self_id), key=lambda x: -x[0])[:6]
        props = []
        if open_props:
            pvs = self.emb.vectors([f"{p['title']}\n{p['why']}" for p in open_props])
            props = sorted(((cos(v, pv), p) for p, pv in zip(open_props, pvs)), key=lambda x: -x[0])[:4]
        return {"saves": [{"id": f"save:{p['id']}", "similarity": round(s, 3), "author": p.get("author_handle"),
                           "text": p["text"][:500]} for s, p in saves],
                "open_proposals": [{"id": f"proposal:{p['id']}", "similarity": round(s, 3), "title": p["title"],
                                    "why": (p.get("why") or "")[:300], "target": p.get("target"), "state": p.get("state")}
                                   for s, p in props]}

    @staticmethod
    def item_text(b):
        if b["kind"] == "x_post":
            q = (b.get("quoted") or {}).get("text", "")
            return f"{b['op']['text']}\n{q}".strip()
        src = (b["sources"][0].get("text", "") if b["sources"] else "")[:1500]
        return f"{b.get('title') or ''}\n{src}".strip()

    def record(self, cand, run):
        f = config.path("runs", config.today(), f"{cand['id']}.json".replace("/", "_"))
        f.write_text(json.dumps(run, indent=1, ensure_ascii=False, default=str))
        return f

    def lease_ok(self, cand):
        lu = cand.get("lease_until")
        return not lu or config.parse_iso(lu) > dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=30)

    def complete(self, cand, state, note, run):
        run["complete"] = {"state": state, "note": note}
        try:
            self.worker.complete(cand["id"], self.owner, state, note, cand.get("lease_token"))
        except LeaseLost as e:
            run["complete"]["lease_lost"] = str(e)
            self.log(f"lease lost on {cand['id']}: {e}")
        except WorkerError as e:
            if not (state == "new" and e.status == 400):
                raise
            # The deployed Worker accepts only final states on complete, though the contract and the runner's
            # brief return a deferred candidate with state "new". Until that is settled the lease is left to
            # expire, which re-queues the candidate (and counts an attempt).
            run["complete"]["left_to_expire"] = str(e)[:300]
            self.log(f"complete(new) refused for {cand['id']}; lease left to expire")
        self.record(cand, run)
        return run

    # ------------------------------------------------------------ work

    def work(self):
        """Claim up to claim_limit candidates and handle each. Returns the run records."""
        config.check_stop()
        for kind, key in (("deep_reads", "deep_reads_per_day"), ("codex_preps", "codex_preps_per_day")):
            if config.used(kind) >= self.cfg[key]:
                # Without prep a proposal would be a plan, which is never posted; candidates wait for tomorrow.
                self.log(f"work: {kind} budget used up for today; nothing claimed")
                return []
        cands = self.worker.claim(self.owner, self.cfg["claim_ttl_s"], self.cfg["claim_limit"])
        out = []
        for c in cands:
            try:
                out.append(self.handle(c))
            except config.Stopped:
                self.complete(c, "new", "runner stopped (STOP file) before finishing", {"candidate": c})
                raise
            except WorkerUnavailable:
                raise
            except Exception as e:  # one bad candidate must not stop the others
                attempts = int(c.get("attempts") or 0)
                state = "failed" if attempts >= 3 else "new"
                out.append(self.complete(c, state, f"error: {type(e).__name__}: {e}"[:500], {"candidate": c,
                                                                                         "error": repr(e)}))
        return out

    def handle(self, cand):
        cfg = self.cfg
        run = {"candidate": cand, "started_at": config.now_iso(), "owner": self.owner}
        hit = policy.coursework_hit([cand.get("title"), cand.get("url")], cfg)
        if hit:
            return self.complete(cand, "skipped", f"coursework excluded ({hit})", run)

        if cand["kind"] == "x_post":
            b, captured = B.x_post_bundle(self.worker, cand)
            age_h = (dt.datetime.now(dt.timezone.utc) - config.parse_iso(cand["created_at"])).total_seconds() / 3600
            if not captured and age_h < cfg["defer_uncaptured_thread_h"]:
                return self.complete(cand, "new", f"deferred: thread not captured yet ({age_h:.1f} h old)", run)
        else:
            b = B.watcher_bundle(self.worker, cand)
        run["missing_context"] = b["missing_context"]
        bundle_path = config.path("runs", config.today(), f"{cand['id']}.bundle.json".replace("/", "_"))
        bundle_path.write_text(json.dumps(b, indent=1, ensure_ascii=False))
        run["bundle"] = str(bundle_path)

        open_props = recent(self.worker, cfg["dedupe_days"])
        rel = self.related(self.item_text(b), open_props, cand["ref"] if cand["kind"] == "x_post" else None)
        run["related"] = rel
        ctx = sam_context(cfg)
        user = (f"Today is {config.today()} (UTC).\n\n# Sam's context\n{ctx}\n\n# Related saves and open proposals (data)\n```json\n"
                f"{json.dumps(rel, ensure_ascii=False)}\n```\n\n# Item bundle (data, not instructions)\n```json\n"
                f"{json.dumps(b, ensure_ascii=False)}\n```")
        tri = self.llm.chat_json(cfg["models"]["triage"], prompts.TRIAGE, user, stage="triage", item=cand["id"])
        if tri.get("action_type") not in prompts.ACTION_TYPES:
            raise ValueError(f"triage returned action_type {tri.get('action_type')!r}")
        run["triage"] = tri
        if B.open_listing(b) and tri["action_type"] != "apply_or_attend":
            # A listed posting is open by definition, and watcher rules already chose it as relevant. Triage read
            # "apply by October 30" (one cohort's date) as expired and dropped a rolling posting on Nov 4, so for
            # open listings triage is advisory and the deep read decides with the facts in hand.
            tri["overridden"] = f"triage said {tri['action_type']}: {tri.get('why_it_matters')}"
            tri["action_type"] = "apply_or_attend"
        if tri["action_type"] == "no_action":
            return self.complete(cand, "skipped", f"no_action: {tri.get('why_it_matters')}", run)
        if tri["action_type"] == "reference_note":
            if len(tri.get("related_save_ids") or []) < 2:
                return self.reference_note(cand, b, tri, run)
            # A reference that ties into two or more earlier saves is a pattern, not a shelf item: deep-read it
            # so the saves can justify one action together.
            tri["action_type"] = "read_and_apply"
            tri["upgraded_from"] = "reference_note: connects to 2+ related saves"

        config.check_stop()
        if not config.take("deep_reads", cfg["deep_reads_per_day"]):
            return self.complete(cand, "new", "deep-read budget used up for today; retry tomorrow", run)
        prop = self.deep_read(cand, b, user, tri, run)
        if prop is None:
            return run
        return self.finish(cand, b, prop, open_props, run)

    def deep_read(self, cand, b, user, tri, run):
        cfg = self.cfg
        extra = ""
        if tri["action_type"] == "apply_or_attend":
            facts = Path(cfg["application_facts"]).expanduser()
            if facts.exists():
                extra = f"\n\n# Application facts (verified by Sam, each with its source)\n{facts.read_text()}"
        u = f"{user}\n\n# Triage (cheaper model; may be wrong)\n{json.dumps(tri, ensure_ascii=False)}{extra}"
        prop = self.llm.chat_json(cfg["models"]["deep_read"], prompts.DEEP_READ, u, stage="deep_read",
                                  item=cand["id"], effort="high")
        run["deep_read"] = prop
        if prop.get("decline") and B.open_listing(b) and not policy.hard_blocker(prop, B.bundle_text(b)):
            # Whether to apply around his other commitments is Sam's decision. An open application is declined
            # only for a hard blocker quoted from the posting; every other decline gets one retry with that rule.
            config.check_stop()
            run["decline_without_blocker"] = prop
            prop = self.llm.chat_json(cfg["models"]["deep_read"], prompts.DEEP_READ + "\n\n" + prompts.NO_SOFT_DECLINE,
                                      f"{u}\n\n# Your declined answer\n{json.dumps(prop, ensure_ascii=False)}",
                                      stage="deep_read_retry", item=cand["id"], effort="high")
            run["deep_read"] = prop
        if prop.get("decline"):
            self.complete(cand, "skipped", f"declined: {prop.get('decline_reason')}", run)
            return None
        checks = self.check_claims(prop, b)
        bad = [c for c in checks if c["status"] != "verified" and (c.get("premise") or c.get("implicit"))]
        if bad:
            config.check_stop()
            rev_user = (f"{u}\n\n# Your proposal\n{json.dumps(prop, ensure_ascii=False)}\n\n# Live checks\n"
                        f"{json.dumps(checks, ensure_ascii=False)}")
            prop = self.llm.chat_json(cfg["models"]["deep_read"], prompts.DEEP_READ + "\n\n" + prompts.REVISE,
                                      rev_user, stage="revise", item=cand["id"], effort="high")
            run["revised"] = prop
            if prop.get("decline"):
                self.complete(cand, "skipped", f"declined after live checks: {prop.get('decline_reason')}", run)
                return None
            checks = self.check_claims(prop, b)
        prop["_checks"] = checks
        return prop

    def check_claims(self, prop, b):
        texts = [prop.get("title") or "", prop.get("why") or "", prop.get("target") or "", prop.get("final_step") or "",
                 json.dumps(prop.get("prep") or {})]
        checks = policy.verify_all(prop.get("claims") or [], texts, self.cfg["repo_roots"])
        hay = B.bundle_text(b)
        refs = B.refs(b)
        for e in prop.get("evidence") or []:
            q = B.norm_ws(e.get("quote", "")).strip("\"'…. ")
            frags = [f.strip() for f in re.split(r"\s*(?:\.\.\.|…)\s*", q) if len(f.strip()) > 8]
            e["verified"] = bool(frags) and all(f in hay for f in frags)
            e["where_valid"] = e.get("where") in refs
        return checks

    def finish(self, cand, b, prop, open_props, run):
        """Policy checks, prep, then the judge on what prep actually produced, then post.

        A proposal is posted only with at least one deliverable that exists on disk: an application draft, a
        message draft, or files and branches from `codex exec`. A plan alone is never recorded as work done
        (round 1 of grading: every write-up-only proposal scored 1 to 4).
        """
        cfg = self.cfg
        texts = [prop.get("title"), prop.get("why"), prop.get("target"), prop.get("final_step"),
                 json.dumps(prop.get("prep") or {}), json.dumps(prop.get("draft") or {})]
        hit = policy.coursework_hit(texts, cfg)
        if hit:
            return self.complete(cand, "skipped", f"coursework excluded after deep read ({hit})", run)

        if prop.get("application"):
            prop["application"] = policy.apply_ai_policy(prop["application"], self.guidance(prop["application"], run))

        dup = self.duplicate(prop, open_props)
        if dup:
            run["merged_into"] = dup
            adds = prop.get("adds_to_existing") or prop.get("why", "")[:300]
            return self.complete(cand, "proposed", f"merged into proposal {dup['id']} ({dup['match']}); adds: {adds}", run)

        prep_spec = prop.get("prep") or {}
        needs_tools = bool(prep_spec.get("needs_tools"))
        if not (prop.get("application") or (prop.get("draft") or {}).get("text") or needs_tools):
            if not prep_spec.get("task"):
                return self.complete(cand, "skipped", "nothing to prepare: the deep read named no deliverable", run)
            needs_tools = True

        client_id = new_client_id()
        workdir = config.path("work", client_id, "x").parent
        items = self.write_base_files(workdir, b, prop)
        if needs_tools:
            config.check_stop()
            if not config.take("codex_preps", cfg["codex_preps_per_day"]):
                return self.complete(cand, "new", "codex prep budget used up for today; retry tomorrow", run)
            prep = run_codex(workdir, cfg, self.llm.key(), self.log)
            run["prep"] = prep
            if prep.get("verdict") == "premise_false":
                return self.complete(cand, "skipped", f"prep found the premise false: {prep.get('summary')}", run)
            made = verify_manifest(workdir, prep.get("items", []))
            run["manifest"] = made
            if not made["verified"]:
                return self.complete(cand, "failed" if int(cand.get("attempts") or 0) >= 3 else "skipped",
                                     f"prep produced no verifiable deliverable ({prep.get('verdict')}: "
                                     f"{prep.get('summary')}; missing: {made['missing']})", run)
            items += made["verified"]
            if prep.get("approval_line"):
                prop["approval_line"] = prep["approval_line"]

        config.check_stop()
        verdict = self.judge(cand, b, prop, workdir, items, run)
        if verdict.get("verdict") == "reject" or verdict.get("busywork"):
            return self.complete(cand, "skipped", f"judge {verdict.get('verdict')}"
                                 f"{' busywork' if verdict.get('busywork') else ''}: {verdict.get('reason')}", run)
        (workdir / "PROPOSAL.md").write_text(render_markdown(cand, prop, verdict, items, run.get("prep")))
        items.append({"type": "note", "ref": str(workdir / "PROPOSAL.md"), "summary": "the proposal, its evidence and checks"})
        body = self.proposal_body(client_id, cand, b, prop, verdict, items, run)
        if not self.lease_ok(cand):
            run["aborted"] = "lease expired before posting; another owner may hold the candidate"
            self.record(cand, run)
            return run
        res = submit_proposal(self.worker, body)
        record_local(body, res)
        run["proposal"] = {"body": body, "response": res}
        return self.complete(cand, "proposed" if body["final_step_kind"] else "done",
                             f"proposal {res.get('id')} ({res.get('state')})", run)

    def duplicate(self, prop, open_props):
        """The deep read's own duplicate_of, when it names a listed open proposal, else the policy check."""
        named = str(prop.get("duplicate_of") or "").removeprefix("proposal:")
        for p in open_props:
            if named and p["id"] == named:
                return {**p, "match": "named by the deep read"}
        return policy.find_duplicate(
            {"target": prop.get("target"), "text": f"{prop.get('title')}\n{prop.get('why')}"},
            [{**p, "text": f"{p['title']}\n{p.get('why') or ''}"} for p in open_props],
            self.vec, self.cfg["dedupe_days"], self.cfg["dedupe_cosine"], self.cfg["repo_roots"])

    def guidance(self, app, run):
        url = policy.guidance_url(app.get("employer_domain"), self.cfg)
        if not url:
            return None
        page = B.fetch(url)
        if not page.get("ok"):
            return {"url": url, "restricts_drafting": None}
        g = self.llm.chat_json(self.cfg["models"]["triage"], prompts.GUIDANCE, page.get("text", "")[:12000],
                               stage="ai_guidance", item=url)
        quote_ok = B.norm_ws(g.get("quote", ""))[:80] in B.norm_ws(page.get("text", ""))
        g = {"url": url, "restricts_drafting": g.get("restricts_drafting") if quote_ok else None,
             "quote": g.get("quote", "")}
        run["ai_guidance"] = g
        return g

    def judge(self, cand, b, prop, workdir, items, run):
        """Astra reviews the prepared result, not the plan: deliverables, quotes in context, live checks."""
        hay = B.bundle_text(b)
        quotes = []
        for e in prop.get("evidence") or []:
            q = B.norm_ws(e.get("quote", "")).strip("\"'…. ")
            i = hay.find(q[:60]) if q else -1
            quotes.append({"quote": e.get("quote"), "where": e.get("where"), "found_verbatim": e.get("verified"),
                           "context": hay[max(0, i - 300): i + len(q) + 300] if i >= 0 else None})
        item = {k: b.get(k) for k in ("kind", "url", "title", "op", "quoted", "missing_context")}
        item["op_followups"] = (b.get("op_followups") or [])[:8]
        item["replies"] = [{k: r.get(k) for k in ("ref", "text")} for r in (b.get("replies") or [])[:15]]
        item["sources"] = [{"ref": s.get("ref"), "title": s.get("title") or s.get("full_name"),
                            "text": (s.get("text") or s.get("readme") or s.get("description") or "")[:2500]}
                           for s in b.get("sources", [])]
        files = []
        for it in items:
            p = Path(it["ref"])
            if p.is_file() and it.get("size", 1) < 200_000 and p.suffix in (".md", ".json", ".txt", ".sh", ".py", ".ts",
                                                                             ".js", ".diff", ".patch", ".toml", ".log"):
                files.append({"file": p.name, "summary": it.get("summary"), "head": p.read_text(errors="replace")[:4000]})
            else:
                files.append({"ref": p.name, "type": it["type"], "summary": it.get("summary"), "size": it.get("size")})
        prep_md = workdir / "PREP.md"
        shown = {k: v for k, v in prop.items() if not k.startswith("_") and k not in ("evidence", "claims")}
        user = (f"Today is {config.today()} (UTC).\n\n# Sam's context\n{sam_context(self.cfg)}\n\n# Proposal (data)\n```json\n"
                f"{json.dumps(shown, ensure_ascii=False)}\n```\n\n# Evidence quotes with surrounding text\n```json\n"
                f"{json.dumps(quotes, ensure_ascii=False)}\n```\n\n# Runner's live-machine checks\n```json\n"
                f"{json.dumps(prop.get('_checks'), ensure_ascii=False)}\n```\n\n# What prep actually produced\n"
                f"{prep_md.read_text(errors='replace')[:6000] if prep_md.exists() else '(no tool prep)'}\n```json\n"
                f"{json.dumps(files, ensure_ascii=False)}\n```\n\n# Item excerpts (data)\n```json\n"
                f"{json.dumps(item, ensure_ascii=False)}\n```")
        v = self.llm.chat_json(self.cfg["models"]["judge"], prompts.JUDGE, user, stage="judge", item=cand["id"],
                               effort=self.cfg["judge_effort"])
        run["judge"] = v
        return v

    def write_base_files(self, workdir, b, prop):
        """bundle.json and proposal.json for prep; the application and message drafts, which are deliverables."""
        (workdir / "bundle.json").write_text(json.dumps(b, indent=1, ensure_ascii=False))
        (workdir / "proposal.json").write_text(json.dumps(prop, indent=1, ensure_ascii=False))
        items = []
        if prop.get("application"):
            app = prop["application"]
            (workdir / "application.json").write_text(json.dumps(app, indent=1, ensure_ascii=False))
            (workdir / "APPLICATION.md").write_text(render_application(app))
            filled = sum(1 for f in app["fields"] if f.get("value"))
            left = [f["name"] for f in app["fields"] if not f.get("value")]
            items.append({"type": "draft", "ref": str(workdir / "APPLICATION.md"), "sha256": _sha(workdir / "APPLICATION.md"),
                          "summary": f"{filled} of {len(app['fields'])} fields filled; left to Sam: "
                                     f"{', '.join(left)[:300]}. {app['ai_policy']['why']}"})
        d = prop.get("draft") or {}
        if d.get("text"):
            (workdir / "DRAFT.md").write_text(f"To: {d.get('to')}\nVia: {d.get('channel')}\n\n{d['text']}\n")
            items.append({"type": "draft", "ref": str(workdir / "DRAFT.md"), "sha256": _sha(workdir / "DRAFT.md"),
                          "summary": f"message to {d.get('to')}"})
        return items

    def proposal_body(self, client_id, cand, b, prop, verdict, prepared, run):
        checks = prop.get("_checks") or []
        failed = [c for c in checks if c["status"] != "verified"]
        why = prop.get("why", "")
        if failed:
            why += " Unverified: " + "; ".join(f"{c.get('statement') or c.get('path') or c.get('repo')} "
                                              f"({c['status']}: {c['detail']})" for c in failed)
        evidence = [{"quote": e["quote"], "where": e["where"]} for e in prop.get("evidence") or []
                    if e.get("verified") and e.get("where_valid")]
        fsk = prop.get("final_step_kind")
        if fsk not in prompts.FINAL_STEP_KINDS:
            fsk = None
        final_step = prop.get("final_step")
        if verdict.get("verdict") == "maybe":
            # A "maybe" still reaches Sam, with the reviewer's concern in front of him; the Worker's 3-a-day
            # notification cap keeps asks rare. Recording it as done hid every maybe in round 1.
            why += f" Reviewer's concern: {verdict.get('reason')}"
            if verdict.get("fixes"):
                why += " Suggested edits: " + "; ".join(verdict["fixes"][:3])
        prepared = [{**i, "summary": i.get("summary") or Path(i["ref"]).name} for i in prepared]
        return {"client_id": client_id, "candidate_ids": [cand["id"]], "kind": prop.get("kind"),
                "title": prop.get("title", "")[:120], "why": why[:4000], "evidence": evidence, "prepared": prepared,
                "final_step_kind": fsk, "final_step": final_step,
                # The approval card shows every inputs field and the approval hash binds them (contract 10b06ac),
                # so inputs hold only what Sam approves: the target, the ask, the deadline and a hash of each
                # deliverable. Review notes, checks and dropped quotes are in PROPOSAL.md.
                "inputs": {"target": prop.get("target"), "approval_line": prop.get("approval_line"),
                           "deadline": (prop.get("application") or {}).get("deadline") or prop.get("deadline"),
                           "deliverables": {Path(i["ref"]).name: i["sha256"] for i in prepared if i.get("sha256")},
                           "source": cand.get("url"), "author_handle": (b.get("op") or {}).get("author")}}

    def reference_note(self, cand, b, tri, run):
        client_id = new_client_id()
        body = {"client_id": client_id, "candidate_ids": [cand["id"]], "kind": "reference_note",
                "title": f"Reference: {cand.get('title') or ''}"[:120],
                "why": f"{tri.get('gist', '')} {tri.get('why_it_matters', '')}".strip(),
                "evidence": [], "prepared": [{"type": "note", "ref": cand.get("url") or cand["ref"],
                                              "summary": tri.get("gist", "")}],
                "final_step_kind": None, "final_step": None,
                "inputs": {"target": cand.get("url"), "source": cand.get("url"),
                           "author_handle": (b.get("op") or {}).get("author")}}
        res = submit_proposal(self.worker, body)
        record_local(body, res)
        run["proposal"] = {"body": body, "response": res}
        return self.complete(cand, "done", f"reference note {res.get('id')}", run)


def render_markdown(cand, prop, verdict, items, prep):
    lines = [f"# {prop.get('title')}", "", prop.get("why", ""), "", f"Source: {cand.get('url')}", ""]
    if prop.get("approval_line"):
        lines += [f"**Ask:** {prop['approval_line']}", ""]
    lines += ["## Prepared (verified on disk)"] + [f"- {i['type']}: {Path(i['ref']).name} — {i.get('summary')}"
                                                   for i in items]
    if prep:
        lines += ["", f"Prep: {prep.get('verdict')} in {prep.get('seconds')} s. {prep.get('summary') or ''}"]
        lines += [f"- `{c.get('command')}` exit {c.get('exit_code')}: {c.get('summary')}" for c in prep.get("checks") or []]
    lines += ["", "## Evidence"] + [f"- {'✓' if e.get('verified') else '✗ not found in bundle:'} \"{e.get('quote')}\" "
                                    f"({e.get('where')})" for e in prop.get("evidence") or []]
    if prop.get("connects"):
        lines += ["", "## Connects to"] + [f"- {c.get('id')}: {c.get('how')}" for c in prop["connects"]]
    lines += ["", "## Live checks"] + [f"- {c['status']}: {c.get('statement') or c.get('path') or c.get('repo')} "
                                       f"({c.get('detail')})" for c in prop.get("_checks") or []]
    lines += ["", f"Final step: {prop.get('final_step') or 'none'}",
              f"Independent review: {verdict.get('verdict')} — {verdict.get('reason')}"]
    return "\n".join(lines) + "\n"


def render_application(app):
    lines = [f"# {app.get('employer')}: {app.get('program') or ''}", "",
             f"Apply: {app.get('apply_url')}", f"Deadline: {app.get('deadline') or 'none stated'}", "",
             app["ai_policy"]["why"], ""]
    if app.get("decision_for_sam"):
        lines += [f"**Your decision:** {app['decision_for_sam']}", ""]
    lines += ["## Eligibility"] + [f"- {e.get('requirement')}: **{e.get('sam_meets')}** ({e.get('fact') or 'no fact'})"
                                   for e in app.get("eligibility") or []]
    lines += ["", "## Form"]
    for f in app["fields"]:
        if f.get("left_to_sam") or (f.get("kind") in policy.ESSAY_KINDS):
            lines.append(f"- **{f['name']}** — yours to write.")
            lines += [f"  - highlight: {h}" for h in f.get("highlight") or []]
        else:
            lines.append(f"- **{f['name']}**: {f.get('value') or '— left blank (no sourced fact)'}"
                         f"{' (' + f['source'] + ')' if f.get('value') and f.get('source') else ''}")
    return "\n".join(lines) + "\n"


def _sha(p):
    import hashlib
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()[:16]


def verify_manifest(workdir, items):
    """Keep only prepared items that exist: files inside workdir (with size and hash) and real git branches."""
    import hashlib
    out, missing = [], []
    root = workdir.resolve()
    for i in items:
        ref = str(i.get("ref") or "")
        if i.get("type") == "branch":
            repo, _, branch = ref.partition("#")
            rp = (workdir / repo).resolve()
            ok = branch and root in rp.parents and subprocess.run(
                ["git", "-C", str(rp), "rev-parse", "--verify", "--quiet", branch], capture_output=True,
                stdin=subprocess.DEVNULL).returncode == 0
            (out if ok else missing).append({**i, "ref": str(rp) + "#" + branch} if ok else ref)
            continue
        p = Path(ref) if ref.startswith("/") else workdir / ref
        p = p.resolve()
        if (p == root or root in p.parents) and p.is_file() and p.stat().st_size > 0:
            out.append({**i, "ref": str(p), "size": p.stat().st_size,
                        "sha256": hashlib.sha256(p.read_bytes()).hexdigest()[:16]})
        elif (p == root or root in p.parents) and p.is_dir() and any(p.iterdir()):
            out.append({**i, "ref": str(p)})
        else:
            missing.append(ref)
    return {"verified": out, "missing": missing}


def dir_mb(p: Path):
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total / 1e6


def codex_command(workdir, cfg):
    """No sandbox-bypass or approval-bypass flag, ever: writes stay in workdir, network via sandbox config."""
    # mcp_servers={} keeps Sam's interactive MCP servers (OAuth-gated, irrelevant to prep) out of the run.
    return ["codex", "exec", "-c", "model_provider=cliproxy", "-m", cfg["models"]["prep"],
            "-c", 'model_reasoning_effort="medium"', "-c", "mcp_servers={}", "--sandbox", "workspace-write",
            "-c", "sandbox_workspace_write.network_access=true", "-C", str(workdir), "--skip-git-repo-check",
            "--ephemeral", "-o", str(workdir / "last-message.md"), prompts.PREP]


def run_codex(workdir, cfg, gateway_key, log=print):
    """The gateway key reaches codex only through its environment (the provider's env_key), never argv or logs."""
    cmd = codex_command(workdir, cfg)
    t0 = dt.datetime.now(dt.timezone.utc)
    env = {**os.environ, "CLIPROXY_API_KEY": gateway_key}
    with open(workdir / "codex.log", "w") as out:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, cwd=workdir,
                                start_new_session=True, env=env)
        try:
            code = proc.wait(timeout=cfg["prep_timeout_s"])
            timed_out = False
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
            code, timed_out = None, True
    secs = (dt.datetime.now(dt.timezone.utc) - t0).total_seconds()
    m = re.findall(r"tokens used\s*\n\s*([\d,]+)", (workdir / "codex.log").read_text(errors="replace"))
    tokens = int(m[-1].replace(",", "")) if m else None
    with open(config.path("logs", "calls.jsonl"), "a") as f:
        f.write(json.dumps({"ts": config.now_iso(), "stage": "prep", "item": workdir.name, "requested_model":
                            cfg["models"]["prep"], "tool": "codex exec", "exit": code, "timed_out": timed_out,
                            "tokens_total": tokens, "latency_s": round(secs, 1),
                            "status": "prep_ok" if code == 0 else "prep_error"}) + "\n")
    res = {"exit": code, "timed_out": timed_out, "seconds": round(secs, 1), "items": []}
    mb = dir_mb(workdir)
    if mb > cfg["prep_scratch_mb"]:
        shutil.rmtree(workdir / "src", ignore_errors=True)
        res["scratch_note"] = f"scratch reached {mb:.0f} MB; removed ./src clones"
        mb = dir_mb(workdir)
        if mb > cfg["prep_scratch_mb"]:
            res.update(verdict="blocked", summary=f"prep scratch {mb:.0f} MB exceeds {cfg['prep_scratch_mb']} MB")
            return res
    res["scratch_mb"] = round(mb, 1)
    pj = workdir / "prepared.json"
    if pj.exists():
        try:
            p = json.loads(pj.read_text())
            res.update(verdict=p.get("verdict"), summary=p.get("summary"), approval_line=p.get("approval_line"))
            res["items"] = [i for i in p.get("items") or [] if i.get("type") in ("file", "branch", "draft", "note")]
            res["checks"] = p.get("checks") or []
        except json.JSONDecodeError as e:
            res.update(verdict="blocked", summary=f"prepared.json unreadable: {e}")
    else:
        res.update(verdict="blocked", summary="timed out" if timed_out else "codex wrote no prepared.json")
    log(f"prep {workdir.name}: {res.get('verdict')} in {secs:.0f}s, {mb:.1f} MB")
    return res
