"""Merge triage, deep-read proposals and judge verdicts into proposals.json, and compute the numbers for RESULTS.md."""
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    tri = json.loads((ROOT / "raw" / "triage.json").read_text())
    props = json.loads((ROOT / "raw" / "proposals_raw.json").read_text())
    judge = {j["id"]: j for j in json.loads((ROOT / "raw" / "judge.json").read_text())}
    rescue = {r["id"] for r in json.loads((ROOT / "raw" / "rescue.json").read_text())["rescue"]}
    top3 = json.loads((ROOT / "raw" / "prepared.json").read_text())
    items = []
    for pid, t in tri.items():
        p = props.get(pid)
        e = {"id": pid, "url": t["url"], "op": t["op"], "triage": {k: t.get(k) for k in
             ("action_type", "why_it_matters", "confidence", "gist", "already_done_or_expired", "deadline", "projects")},
             "rescued_from_no_action": pid in rescue}
        if p is None:
            e["stage_reached"] = "triage"
            e["outcome"] = "no_action"
        elif p.get("decline"):
            e["stage_reached"] = "deep_read"
            e["outcome"] = "declined"
            e["decline_reason"] = p.get("decline_reason")
        else:
            e["stage_reached"] = "deep_read"
            e["outcome"] = "proposal"
            e["proposal"] = {k: p.get(k) for k in ("action_type", "action", "key_insight", "citations", "reply_changed_reading",
                                                   "agent_steps_now", "approval_step", "approval_line", "approve_seconds",
                                                   "connects_to", "value", "value_reason", "busywork_risk", "busywork_reason",
                                                   "missing_context_that_matters")}
            e["judge"] = judge.get(pid)
            e["prepared"] = pid in top3["ids"]
        items.append(e)
    items.sort(key=lambda e: (e["outcome"] != "proposal", -(e.get("proposal") or {}).get("value", 0)))
    (ROOT / "proposals.json").write_text(json.dumps({"generated": "2026-11-04", "n_posts": len(items), "items": items},
                                                     indent=1, ensure_ascii=False))
    live = [e for e in items if e["outcome"] == "proposal"]
    cites = [c for e in live for c in e["proposal"]["citations"] or []]
    where = Counter()
    for c in cites:
        w = c.get("where", "")
        where["OP" if w.startswith("OP") else "OP follow-up (T)" if w.startswith("T") else "reply" if w.startswith("R") else "source" if w.startswith("source") else "other"] += 1
    n = {
        "posts": len(items),
        "outcomes": Counter(e["outcome"] for e in items),
        "triage_types": Counter(e["triage"]["action_type"] for e in items),
        "proposal_types": Counter(e["proposal"]["action_type"] for e in live),
        "judge_verdicts": Counter((e.get("judge") or {}).get("verdict", "unjudged") for e in live),
        "judge_busywork": sum(1 for e in live if (e.get("judge") or {}).get("busywork")),
        "sol_busywork_risk": Counter(e["proposal"]["busywork_risk"] for e in live),
        "value": Counter(e["proposal"]["value"] for e in live),
        "approve_seconds_median": sorted(e["proposal"]["approve_seconds"] for e in live)[len(live) // 2] if live else None,
        "citations": len(cites), "citations_verified": sum(1 for c in cites if c.get("verified")),
        "citation_where": where,
        "reply_or_followup_changed_reading": sum(1 for e in live if e["proposal"].get("reply_changed_reading") not in (None, "", "null")),
        "rescued": len(rescue), "rescued_to_proposal": sum(1 for e in live if e["rescued_from_no_action"]),
    }
    calls = [json.loads(l) for l in (ROOT / "calls.jsonl").read_text().splitlines()]
    ok = [c for c in calls if c["status"] == "ok"]
    by = {}
    for c in ok:
        m = by.setdefault(c["requested_model"], {"calls": 0, "in": 0, "cached": 0, "out": 0, "usd": 0.0, "latency_s": 0.0})
        m["calls"] += 1; m["in"] += c["tokens_in"]; m["cached"] += c["tokens_in_cached"]; m["out"] += c["tokens_out"]
        m["usd"] += c["list_cost_usd"]; m["latency_s"] += c["latency_s"]
    by_stage = Counter()
    for c in ok:
        by_stage[c["stage"]] += c["list_cost_usd"]
    n["calls"] = {"ok": len(ok), "errors": len(calls) - len(ok), "by_model": by, "usd_by_stage": {k: round(v, 4) for k, v in by_stage.items()},
                  "usd_total": round(sum(c["list_cost_usd"] for c in ok), 4)}
    (ROOT / "raw" / "numbers.json").write_text(json.dumps(n, indent=1, default=dict))
    print(json.dumps(n, indent=1, default=dict))


if __name__ == "__main__":
    main()
