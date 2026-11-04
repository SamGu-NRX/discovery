# Applies one deliberate bug at a time to src/, runs the test suite, restores
# the file, and prints which tests failed. Each mutation should fail a test.
# Run from the project root: python3 scripts/mutation-check.py

import subprocess, shutil, sys
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
 ("M9 daily cap ignored", "src/notify.ts", 'export const DAILY_CAP = 5;', 'export const DAILY_CAP = 1000;'),
 ("M10 pause ignored", "src/notify.ts", "WHEN (SELECT value FROM settings WHERE key = 'notifications_paused') = '1' THEN 'paused'", "WHEN 0 THEN 'paused'"),
 ("M11 one notification per matched item", "src/check.ts", 'const n = await notifyMatches(env, w, "item.new", matched.map((m) => m.key), matched, `new item: ${describeRule(w)}`, now);',
  'let n = null; for (const m of matched) n = await notifyMatches(env, w, "item.new", [m.key], [m], `new item: ${describeRule(w)}`, now);'),
 ("M12 fallback never used", "src/check.ts", 'if (w.fallback_url && (res === null', 'if (false && (res === null'),
]
for name, path, old, new in muts:
    if only and name.split()[0] not in only:
        continue
    src = open(path).read()
    assert old in src, name
    open(path, "w").write(src.replace(old, new))
    try:
        r = subprocess.run(["node", "--test", "test/"], capture_output=True, text=True, timeout=240)
        failed = [l.strip() for l in r.stdout.splitlines() if l.startswith("✖")]
        print(f"{name}: exit={r.returncode} failing={failed}")
    finally:
        open(path, "w").write(src)
