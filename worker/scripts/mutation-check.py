# Applies one deliberate bug at a time to src/, runs the test suite, restores
# the file, and prints which tests failed. Each mutation should fail a test.
# Run from the project root: python3 scripts/mutation-check.py

import re, subprocess, sys
only = sys.argv[1:]
muts = [
 ("M1 page normalizer keeps <script>", "src/adapters.ts", '.replace(/<(script|style|noscript|svg|template)\\b[\\s\\S]*?<\\/\\1>/gi, " ")', ''),
 ("M2 no seen_items filter", "src/check.ts", "WHERE json_extract(value, '$.id') NOT IN (SELECT item_id FROM seen_items WHERE watcher_id = ?1)", ""),
 ("M3 signature not checked", "src/websub.ts", 'const valid = await signatureMatches(env.WEBSUB_SECRET, body, req.headers.get("x-hub-signature"));', 'const valid = true;'),
 ("M4 claim ignores lease expiry", "src/index.ts", "(state = 'queued' OR (state = 'claimed' AND lease_until < ?4))", "(state = 'queued' OR state = 'claimed' OR ?4 = 0)"),
 ("M5 complete ignores owner", "src/index.ts", "WHERE id = ?1 AND owner = ?2 AND state = 'claimed' RETURNING *", "WHERE id = ?1 AND ?2 IS NOT NULL AND state = 'claimed' RETURNING *"),
 ("M6 hot ignored by scheduler", "src/check.ts", 'let interval = mode === "hot" ? w.hot_interval_s : w.interval_s;', 'let interval = w.interval_s;'),
 ("M7 rules skip seeded items", "src/check.ts", 'matched = parsed.items.filter((i) => classify(w, i.title, false).notify);', 'matched = [];'),
 ("M8 notify_all_new also fires on seed", "src/check.ts", '(isNew && w.notify_all_new === 1)', '(w.notify_all_new === 1)'),
 ("M12 fallback never used", "src/check.ts", 'if (w.fallback_url && (res === null', 'if (false && (res === null'),
 # v2, slice 1
 ("M13 watcher match makes no candidate", "src/check.ts", "WHERE json_extract(value, '$.notify') = 1", "WHERE 0"),
 ("M14 seed match makes no candidates", "src/check.ts", "rows = matched.map((i) => ({ ref: `${w.id}:${i.id}`, title: itemTitle(i), url: i.url }));", "rows = matched.slice(0, 1).map((i) => ({ ref: `${w.id}:${i.id}`, title: itemTitle(i), url: i.url }));"),
 ("M15 ingest keeps old metrics", "src/x.ts", "metrics_json = excluded.metrics_json, last_seen_at", "last_seen_at"),
 ("M16 one sighting per post per request", "src/x.ts", "seen_count = x_posts.seen_count + excluded.seen_count", "seen_count = x_posts.seen_count + 1"),
 ("M17 every surface counts as a bookmark", "src/x.ts", 'bookmarked: prev?.bookmarked || (surface === "bookmarks" ? 1 : 0)', "bookmarked: 1"),
 ("M18 seeded past saves become candidates", "src/x.ts", "WHERE NOT EXISTS (SELECT 1 FROM positives WHERE id = json_extract(value, '$.id'))", ""),
 ("M19 unscored filter ignored", "src/x.ts", "WHERE p.score IS NULL ORDER BY", "WHERE 1 ORDER BY"),
 ("M20 thread replies in D1 order", "src/x.ts", "replies: inOrder(replyIds)", "replies: rows.filter((r) => replyIds.includes(r.id)).map(presentPost)"),
 ("M21 detail queue ignores captured threads", "src/x.ts", "AND NOT EXISTS (SELECT 1 FROM x_threads t WHERE t.root_id IN (c.ref, p.conversation_id))", ""),
 ("M22 status pause ignored", "src/x.ts", "if (endedAt) return", "if (false) return"),
 ("M23 candidate claim ignores lease expiry", "src/candidates.ts", "OR (state = 'claimed' AND lease_until < ?3)", "OR state = 'claimed'"),
 ("M24 candidate complete ignores owner", "src/candidates.ts", "WHERE id = ?1 AND owner = ?2 AND state = 'claimed'", "WHERE id = ?1 AND ?2 IS NOT NULL AND state = 'claimed'"),
 ("M25 no attempt cap on candidates", "src/candidates.ts", "AND attempts >= ?2`", "AND attempts >= ?2 AND 0`"),
 ("M26 route scopes not checked", "src/index.ts", 'if (scope !== "admin" && !found.route.scopes.includes(scope))', "if (false)"),
 ("M27 admin API open to any token", "src/index.ts", '  if (scope !== "admin") throw new HttpError(403, `the ${scope} token cannot call ${req.method} ${url.pathname}`);\n', ""),
 # v2, slice 2
 ("M28 approval daily cap ignored", "src/proposals.ts", "export const APPROVAL_DAILY_CAP = 3;", "export const APPROVAL_DAILY_CAP = 1000;"),
 ("M29 pause ignored for approvals", "src/proposals.ts", "WHEN (SELECT value FROM settings WHERE key = 'notifications_paused') = '1' THEN 'paused'", "WHEN 0 THEN 'paused'"),
 ("M30 no-final-step proposal asks anyway", "src/proposals.ts", "  if (!finalStepKind) {\n    const row", "  if (false) {\n    const row"),
 ("M31 decision UPDATE not single-use", "src/proposals.ts", "WHERE id = ?1 AND state = 'awaiting_approval' AND expires_at > ?3 AND inputs_hash = ?5", "WHERE id = ?1 AND expires_at > ?3 AND inputs_hash = ?5"),
 ("M32 card inputs_hash not checked", "src/proposals.ts", "boundHash !== p.inputs_hash", "false"),
 ("M33 expiry ignored", "src/proposals.ts", '(p.state === "awaiting_approval" && p.expires_at !== null && p.expires_at <= now)', "false"),
 ("M34 card text not escaped", "src/proposals.ts", "const esc = (s: string) => s.replace(", "const esc = (s: string) => s; const unused = (s: string) => s.replace("),
 ("M35 retried proposal gets a new id", "src/proposals.ts", 'const id = "p_" + (await sha256Hex(canonicalJson({ candidate_ids: candidateIds, kind, title, inputs_hash: hash }))).slice(0, 24);', 'const id = "p_" + randomHex(12);'),
 ("M36 cron never expires proposals", "src/index.ts", "const expired = await expireProposals(env, now);", "const expired = 0;"),
 ("M37 malformed prepared URL breaks the card", "src/proposals.ts", "  } catch {\n    return null;\n  }\n}\n\nfunction preparedItem", "  } finally {\n  }\n}\n\nfunction preparedItem"),
]
for name, path, old, new in muts:
    if only and name.split()[0] not in only:
        continue
    src = open(path).read()
    assert old in src, name
    open(path, "w").write(src.replace(old, new))
    try:
        r = subprocess.run(["node", "--test", "test/"], capture_output=True, text=True, timeout=240)
        # node --test lists each failure twice (inline and in the summary).
        failed = sorted({re.sub(r" \([\d.]+ms\)$", "", l.strip()[2:]) for l in r.stdout.splitlines() if l.startswith("✖") and "failing tests:" not in l})
        print(f"{'caught' if failed else 'MISSED'}  {name}: exit={r.returncode} failing={failed}", flush=True)
    finally:
        open(path, "w").write(src)
