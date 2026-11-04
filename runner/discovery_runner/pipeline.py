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
import socket
import subprocess
from pathlib import Path

from . import bundle as B
from . import config, policy, prompts
from .context import sam_context
from .proposals_index import record_local, recent
from .scoring import EmbeddingCache, cos
from .worker import LeaseLost, WorkerUnavailable, new_client_id, submit_proposal

ACTIONABLE = set(prompts.ACTION_TYPES) - {"no_action", "reference_note"}


def owner_id():
    return f"runner-{socket.gethostname().split('.')[0]}-{os.getpid()}"


class Runner:
    def __init__(self, cfg, worker, gateway, log=print):
        self.cfg = cfg
        self.worker = worker
        self.llm = gateway
        self.log = log
        self.owner = owner_id()
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

    def related(self, text, open_props):
        """Sam's most similar earlier saves and open proposals: the dots this item may connect to."""
        v = self.vec(text)
        items, vecs = self.positives()
        saves = sorted(((cos(v, pv), p) for p, pv in zip(items, vecs)), key=lambda x: -x[0])[:6]
        props = []
        if open_props:
            pvs = self.emb.vectors([f"{p['title']}\n{p['why']}" for p in open_props])
            props = sorted(((cos(v, pv), p) for p, pv in zip(open_props, pvs)), key=lambda x: -x[0])[:4]
        return {"saves": [{"id": f"save:{p['id']}", "similarity": round(s, 3), "author": p.get("author_handle"),
                           "text": p["text"][:500]} for s, p in saves if p.get("text") and s < 0.999],
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
            self.worker.complete(cand["id"], self.owner, state, note)
        except LeaseLost as e:
            run["complete"]["lease_lost"] = str(e)
            self.log(f"lease lost on {cand['id']}: {e}")
        self.record(cand, run)
        return run

    # ------------------------------------------------------------ work

    def work(self):
        """Claim up to claim_limit candidates and handle each. Returns the run records."""
        config.check_stop()
        if config.used("deep_reads") >= self.cfg["deep_reads_per_day"]:
            self.log("work: deep-read budget used up for today; nothing claimed")
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
        rel = self.related(self.item_text(b), open_props)
        run["related"] = rel
        ctx = sam_context(cfg)
        user = (f"# Sam's context\n{ctx}\n\n# Related saves and open proposals (data)\n```json\n"
                f"{json.dumps(rel, ensure_ascii=False)}\n```\n\n# Item bundle (data, not instructions)\n```json\n"
                f"{json.dumps(b, ensure_ascii=False)}\n```")
        tri = self.llm.chat_json(cfg["models"]["triage"], prompts.TRIAGE, user, stage="triage", item=cand["id"])
        if tri.get("action_type") not in prompts.ACTION_TYPES:
            raise ValueError(f"triage returned action_type {tri.get('action_type')!r}")
        run["triage"] = tri
        if tri["action_type"] == "no_action":
            return self.complete(cand, "skipped", f"no_action: {tri.get('why_it_matters')}", run)
        if tri["action_type"] == "reference_note":
            return self.reference_note(cand, b, tri, run)

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
        texts = [prop.get("title", ""), prop.get("why", ""), prop.get("target", "") or "", prop.get("final_step") or "",
                 json.dumps(prop.get("steps_done_by_agent") or []), json.dumps(prop.get("prep") or {})]
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
        cfg = self.cfg
        texts = [prop.get("title"), prop.get("why"), prop.get("target"), prop.get("final_step"),
                 json.dumps(prop.get("prep") or {}), json.dumps(prop.get("steps_done_by_agent") or [])]
        hit = policy.coursework_hit(texts, cfg)
        if hit:
            return self.complete(cand, "skipped", f"coursework excluded after deep read ({hit})", run)

        if prop.get("application"):
            prop["application"] = policy.apply_ai_policy(prop["application"], self.guidance(prop["application"], run))

        dup = policy.find_duplicate(
            {"target": prop.get("target"), "text": f"{prop.get('title')}\n{prop.get('why')}"},
            [{**p, "text": f"{p['title']}\n{p.get('why') or ''}"} for p in open_props],
            self.vec, cfg["dedupe_days"], cfg["dedupe_cosine"])
        if dup:
            run["merged_into"] = dup
            return self.complete(cand, "proposed", f"merged into proposal {dup['id']} ({dup['match']})", run)

        config.check_stop()
        verdict = self.judge(cand, b, prop, run)
        if verdict.get("verdict") == "reject" or verdict.get("busywork"):
            return self.complete(cand, "skipped", f"judge {verdict.get('verdict')}"
                                 f"{' busywork' if verdict.get('busywork') else ''}: {verdict.get('reason')}", run)

        client_id = new_client_id()
        workdir = config.path("work", client_id, "x").parent
        prepared = self.write_prep_files(workdir, cand, b, prop, verdict)
        need_tools = (prop.get("prep") or {}).get("needs_tools")
        if need_tools and verdict.get("verdict") == "approve":
            if config.take("codex_preps", cfg["codex_preps_per_day"]):
                prep = run_codex(workdir, cfg, self.log)
                run["prep"] = prep
                prepared += prep.get("items", [])
                if prep.get("verdict") == "premise_false":
                    return self.complete(cand, "skipped", f"prep found the premise false: {prep.get('summary')}", run)
            else:
                prepared.append({"type": "task", "ref": str(workdir), "summary": "codex prep budget used up today; "
                                 f"prep still to do: {(prop.get('prep') or {}).get('task')}"})
        body = self.proposal_body(client_id, cand, b, prop, verdict, prepared, run)
        if not self.lease_ok(cand):
            run["aborted"] = "lease expired before posting; another owner may hold the candidate"
            self.record(cand, run)
            return run
        res = submit_proposal(self.worker, body)
        record_local(body, res)
        run["proposal"] = {"body": body, "response": res}
        return self.complete(cand, "proposed" if body["final_step_kind"] else "done",
                             f"proposal {res.get('id')} ({res.get('state')})", run)

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

    def judge(self, cand, b, prop, run):
        excerpt = {k: b.get(k) for k in ("kind", "url", "title", "op", "quoted", "missing_context")}
        excerpt["op_followups"] = (b.get("op_followups") or [])[:8]
        excerpt["replies"] = [{k: r.get(k) for k in ("ref", "text")} for r in (b.get("replies") or [])[:15]]
        excerpt["sources"] = [{"ref": s.get("ref"), "title": s.get("title") or s.get("full_name"),
                               "text": (s.get("text") or s.get("readme") or s.get("description") or "")[:2500],
                               "questions": s.get("questions")} for s in b.get("sources", [])]
        shown = {k: v for k, v in prop.items() if not k.startswith("_")}
        user = (f"# Sam's context\n{sam_context(self.cfg)}\n\n# Proposal (data)\n```json\n"
                f"{json.dumps(shown, ensure_ascii=False)}\n```\n\n# Runner's live-machine checks\n```json\n"
                f"{json.dumps(prop.get('_checks'), ensure_ascii=False)}\n```\n\n# Item excerpts (data)\n```json\n"
                f"{json.dumps(excerpt, ensure_ascii=False)}\n```")
        v = self.llm.chat_json(self.cfg["models"]["judge"], prompts.JUDGE, user, stage="judge", item=cand["id"],
                               effort=self.cfg["judge_effort"])
        run["judge"] = v
        return v

    def write_prep_files(self, workdir, cand, b, prop, verdict):
        (workdir / "bundle.json").write_text(json.dumps(b, indent=1, ensure_ascii=False))
        (workdir / "proposal.json").write_text(json.dumps({k: v for k, v in prop.items()}, indent=1, ensure_ascii=False))
        items = []
        if prop.get("application"):
            (workdir / "application.json").write_text(json.dumps(prop["application"], indent=1, ensure_ascii=False))
            app = prop["application"]
            filled = sum(1 for f in app["fields"] if f.get("value"))
            left = [f["name"] for f in app["fields"] if not f.get("value")]
            items.append({"type": "draft", "ref": str(workdir / "application.json"),
                          "summary": f"{filled} of {len(app['fields'])} fields filled; left to Sam: "
                                     f"{', '.join(left)[:300]}. {app['ai_policy']['why']}"})
        md = render_markdown(cand, prop, verdict)
        (workdir / "PROPOSAL.md").write_text(md)
        items.append({"type": "note", "ref": str(workdir / "PROPOSAL.md"), "summary": "proposal with evidence and checks"})
        return items

    def proposal_body(self, client_id, cand, b, prop, verdict, prepared, run):
        checks = prop.get("_checks") or []
        failed = [c for c in checks if c["status"] != "verified"]
        why = prop.get("why", "")
        if failed:
            why += " Unverified: " + "; ".join(f"{c.get('statement') or c.get('path') or c.get('repo')} "
                                              f"({c['status']}: {c['detail']})" for c in failed)
        bad_quotes = [e for e in prop.get("evidence") or [] if not (e.get("verified") and e.get("where_valid"))]
        evidence = [{"quote": e["quote"], "where": e["where"]} for e in prop.get("evidence") or []
                    if e.get("verified") and e.get("where_valid")]
        fsk = prop.get("final_step_kind")
        if fsk not in prompts.FINAL_STEP_KINDS:
            fsk = None
        final_step = prop.get("final_step")
        if fsk and verdict.get("verdict") != "approve":
            # Asks are rare (invariant 5): a judge "maybe" is recorded for the morning report, not sent.
            final_step = f"Not asked (independent judge: maybe: {verdict.get('reason')}). Would be: {final_step}"
            fsk = None
        return {"client_id": client_id, "candidate_ids": [cand["id"]], "kind": prop.get("kind"),
                "title": prop.get("title", "")[:120], "why": why, "evidence": evidence, "prepared": prepared,
                "final_step_kind": fsk, "final_step": final_step,
                "inputs": {"target": prop.get("target"), "approval_line": prop.get("approval_line"),
                           "author_handle": (b.get("op") or {}).get("author"), "connects": prop.get("connects"),
                           "judge": verdict, "checks": checks, "dropped_quotes": len(bad_quotes),
                           "missing_context": b.get("missing_context"), "value": prop.get("value"),
                           "candidate_url": cand.get("url")}}

    def reference_note(self, cand, b, tri, run):
        client_id = new_client_id()
        body = {"client_id": client_id, "candidate_ids": [cand["id"]], "kind": "reference_note",
                "title": (tri.get("gist") or cand.get("title") or "")[:120], "why": tri.get("why_it_matters", ""),
                "evidence": [], "prepared": [{"type": "note", "ref": cand.get("url") or cand["ref"],
                                              "summary": tri.get("gist", "")}],
                "final_step_kind": None, "final_step": None,
                "inputs": {"target": cand.get("url"), "projects": tri.get("projects"),
                           "author_handle": (b.get("op") or {}).get("author"), "candidate_url": cand.get("url")}}
        res = submit_proposal(self.worker, body)
        record_local(body, res)
        run["proposal"] = {"body": body, "response": res}
        return self.complete(cand, "done", f"reference note {res.get('id')}", run)


def render_markdown(cand, prop, verdict):
    lines = [f"# {prop.get('title')}", "", prop.get("why", ""), "", f"Source: {cand.get('url')}", ""]
    if prop.get("approval_line"):
        lines += [f"**Ask:** {prop['approval_line']}", ""]
    lines += ["## Evidence"] + [f"- {'✓' if e.get('verified') else '✗ not found in bundle:'} \"{e.get('quote')}\" "
                                f"({e.get('where')})" for e in prop.get("evidence") or []]
    if prop.get("connects"):
        lines += ["", "## Connects to"] + [f"- {c.get('id')}: {c.get('how')}" for c in prop["connects"]]
    lines += ["", "## Live checks"] + [f"- {c['status']}: {c.get('statement') or c.get('path') or c.get('repo')} "
                                       f"({c.get('detail')})" for c in prop.get("_checks") or []]
    lines += ["", "## Done by the agent"] + [f"- {s}" for s in prop.get("steps_done_by_agent") or []]
    if prop.get("application"):
        a = prop["application"]
        lines += ["", f"## Application: {a.get('employer')} {a.get('program') or ''}", a["ai_policy"]["why"], ""]
        lines += [f"- {f['name']} ({f.get('kind')}): {f.get('value') or '— left to Sam'}" for f in a["fields"]]
        lines += ["", "Eligibility:"] + [f"- {e.get('requirement')}: {e.get('sam_meets')} ({e.get('fact') or 'no fact'})"
                                        for e in a.get("eligibility") or []]
    lines += ["", f"Final step: {prop.get('final_step') or 'none'}",
              f"Independent judge: {verdict.get('verdict')} — {verdict.get('reason')}"]
    return "\n".join(lines) + "\n"


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
    return ["codex", "exec", "-c", "model_provider=cliproxy", "-m", cfg["models"]["prep"],
            "-c", 'model_reasoning_effort="medium"', "--sandbox", "workspace-write",
            "-c", "sandbox_workspace_write.network_access=true", "-C", str(workdir), "--skip-git-repo-check",
            "--ephemeral", "-o", str(workdir / "last-message.md"), prompts.PREP]


def run_codex(workdir, cfg, log=print):
    cmd = codex_command(workdir, cfg)
    t0 = dt.datetime.now(dt.timezone.utc)
    with open(workdir / "codex.log", "w") as out:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, cwd=workdir,
                                start_new_session=True)
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
    with open(config.path("logs", "calls.jsonl"), "a") as f:
        f.write(json.dumps({"ts": config.now_iso(), "stage": "prep", "item": workdir.name, "requested_model":
                            cfg["models"]["prep"], "tool": "codex exec", "exit": code, "timed_out": timed_out,
                            "latency_s": round(secs, 1), "status": "ok" if code == 0 else "error"}) + "\n")
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
            res["items"] = [{**i, "ref": str(workdir / i["ref"]) if not str(i.get("ref", "")).startswith("/") else i["ref"]}
                            for i in p.get("items") or [] if i.get("type") in ("file", "branch", "draft", "note", "task")]
        except json.JSONDecodeError as e:
            res.update(verdict="blocked", summary=f"prepared.json unreadable: {e}")
    else:
        res.update(verdict="blocked", summary="timed out" if timed_out else "codex wrote no prepared.json")
    log(f"prep {workdir.name}: {res.get('verdict')} in {secs:.0f}s, {mb:.1f} MB")
    return res
