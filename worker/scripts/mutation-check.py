# Applies one deliberate bug at a time to src/, runs the test suite, restores
# the file, and prints which tests failed. Each mutation should fail a test.
# Run from the project root: python3 scripts/mutation-check.py

import os, re, subprocess, sys
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
 ("M16 one post version per occurrence, not per batch", "src/x.ts", "batchVersions.set(p.id, {", "batchVersions.set(p.id + ':' + pi, {"),
 ("M17 every surface counts as a bookmark", "src/x.ts", 'const bookmark = surface === "bookmarks";', "const bookmark = true;"),
 ("M18 seeded past saves become candidates", "src/x.ts", "\n           AND NOT EXISTS (SELECT 1 FROM positives WHERE id = json_extract(value, '$.id'))", ""),
 ("M19 unscored filter ignored", "src/x.ts", "WHERE p.score IS NULL ORDER BY", "WHERE 1 ORDER BY"),
 ("M20 thread replies in D1 order", "src/x.ts", "replies: inOrder(replyIds)", "replies: rows.filter((r) => replyIds.includes(r.id)).map(presentPost)"),
 ("M21 detail queue ignores captured threads", "src/x.ts", 'AND NOT EXISTS (SELECT 1 FROM x_threads t WHERE ${capturedFor("c.ref", "p.conversation_id")})', ""),
 ("M22 status pause ignored", "src/x.ts", "if (pausedAt) return { post_ids: []", "if (false) return { post_ids: []"),
 ("M23 candidate claim ignores lease expiry", "src/candidates.ts", "OR (state = 'claimed' AND lease_until < ?3)", "OR state = 'claimed'"),
 # M24 (complete ignores owner) was retired in 10b06ac: lease_token now carries that guarantee (M44).
 ("M25 no expired-lease cap on candidates", "src/candidates.ts", "AND expired_leases + 1 >= ?2`", "AND expired_leases + 1 >= ?2 AND 0`"),
 ("M26 route scopes not checked", "src/index.ts", "    if (!allowed) throw", "    if (false) throw"),
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
 ("M38 one sighting per occurrence, not per batch", "src/x.ts", "      if (seen) {\n        seen.metrics = p.metrics;\n      } else {\n        inBatch.set(p.id,", "      if (false) {\n      } else {\n        inBatch.set(p.id + ':' + pi,"),
 ("M39 non-object JSON body reaches handlers", "src/http.ts", 'if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw', "if (false) throw"),
 ("M40 thread accepted on any batch", "src/x.ts", 'if (op !== "TweetDetail") fail(', "if (false) fail("),
 # contract 10b06ac and the 191a188 reviews
 ("M41 replayed batch writes sightings", "src/x.ts", "         WHERE ${fresh(\"json_extract(value, '$.batch_id')\", \"?6\")}`", "`"),
 ("M42 replayed batch rewrites posts", "src/x.ts", "         WHERE ${fresh(\"json_extract(value, '$.batch_id')\", \"?3\")}\n         ORDER BY key", "         WHERE true\n         ORDER BY key"),
 ("M43 replayed batch bumps session posts", "src/x.ts", "(SELECT count(*) FROM json_each(?5) WHERE ${fresh(\"value\", \"?6\")})", "(SELECT count(*) FROM json_each(?5))"),
 ("M44 complete ignores lease_token", "src/candidates.ts", "WHERE id = ?1 AND owner = ?2 AND lease_token = ?6 AND state = 'claimed'", "WHERE id = ?1 AND owner = ?2 AND ?6 IS NOT NULL AND state = 'claimed'"),
 ("M45 reclaim keeps the old lease_token", "src/candidates.ts", "lease_token = lower(hex(randomblob(16)))", "lease_token = coalesce(lease_token, lower(hex(randomblob(16))))"),
 ("M46 card omits inputs", "src/proposals.ts", 'inputValue(JSON.parse(p.inputs_json), 0)}', '""}'),
 ("M47 decision body limit not enforced", "src/proposals.ts", "export const DECISION_MAX_BYTES = 4 * 1024;", "export const DECISION_MAX_BYTES = 64 * 1024 * 1024;"),
 # The token lookup and the device check that needs its row move together.
 ("M48 decision body read before the token", "src/proposals.ts",
  ['  const p = await byToken(env, token);\n  if (!p) return reply(404, "Link not found.", "This approval link is not valid.");\n  // Every proposal with a link has an irreversible final step. Once a device\n  // has been enrolled (even one later revoked), only its signature decides.\n  if (await anyDeviceEver(env)) {\n    return reply(403, "Device signature required.", "Approve or deny this on your iPhone.", p.title, { error: "device signature required" });\n  }\n\n  let decisionRaw', '  const decision = decisionRaw as Decision;\n  const now = Date.now();'],
  ['  let decisionRaw', '  const decision = decisionRaw as Decision;\n  const p = await byToken(env, token);\n  if (!p) return reply(404, "Link not found.", "This approval link is not valid.");\n  // Every proposal with a link has an irreversible final step. Once a device\n  // has been enrolled (even one later revoked), only its signature decides.\n  if (await anyDeviceEver(env)) {\n    return reply(403, "Device signature required.", "Approve or deny this on your iPhone.", p.title, { error: "device signature required" });\n  }\n  const now = Date.now();']),
 ("M49 ingest cap back at 256 KB", "src/x.ts", "export const INGEST_MAX_BYTES = 128 * 1024;", "export const INGEST_MAX_BYTES = 256 * 1024;"),
 ("M50 body limit counts characters", "src/http.ts", "    total += value.byteLength;", "    total += new TextDecoder().decode(value).length;"),
 ("M51 rotate ignores a sent notification", "src/proposals.ts", 'if (!force && (p.notify_state === "sent" || p.notify_state === "pending"))', "if (false)"),
 ("M52 rotate revives a spent link", "src/proposals.ts",
  ['  if (p.state !== "awaiting_approval") throw new HttpError(409, `proposal ${id} is ${p.state}; only an unspent approval link can be rotated`);', "     WHERE id = ?1 AND state = 'awaiting_approval' AND expires_at > ?3 AND approval_token_hash = ?4"],
  ["", "     WHERE id = ?1 AND expires_at > ?3 AND approval_token_hash = ?4"]),
 ("M53 a root capture covers its replies", "src/x.ts", "`(t.root_id = ${postId} OR (t.root_id = ${conversationId} AND EXISTS (SELECT 1 FROM json_each(t.op_self_thread_ids_json) WHERE value = ${postId})))`", "`(t.root_id IN (${postId}, ${conversationId}))`"),
 # contract 7d502f0: account test is synthetic
 ("M54 GET /x/posts lists test posts", "src/x.ts", "FROM x_sightings WHERE post_id = p.id AND account != '${TEST_ACCOUNT}')`;", "FROM x_sightings WHERE post_id = p.id)`;"),
 ("M55 test bookmarks become candidates", "src/x.ts", "(account === TEST_ACCOUNT ? [] : postList)", "(postList)"),
 ("M56 test- refs accepted", "src/candidates.ts", 'if (ref.startsWith("test-")) throw', "if (false) throw"),
 ("M57 test-only posts accepted as candidates", "src/candidates.ts", "if (!post.real) throw", "if (false) throw"),
 # deferral by completing with state "new"
 ("M58 deferral keeps the owner", "src/candidates.ts", "owner = CASE WHEN ?3 = 'new' THEN NULL ELSE ?2 END", "owner = ?2"),
 ("M59 claims ignore attempts", "src/candidates.ts", "ORDER BY attempts, score IS NOT NULL", "ORDER BY score IS NOT NULL"),
 ("M60 the crash guard counts deferrals", "src/candidates.ts", "AND expired_leases + 1 >= ?2`", "AND attempts >= ?2`"),
 # session reservations, contract 36fbd71
 ("M61 a replayed status overwrites the first", "src/x.ts", "const takes = `(x_sessions.status IS NULL OR (x_sessions.status IN ('ok', 'crash') AND excluded.status != 'ok'))`;", "const takes = `(1)`;"),
 ("M62 unreported reservations never count as crashes", "src/x.ts", "WHERE account = ?1 AND reserved_at IS NOT NULL AND status IS NULL AND reserved_at < ?3`", "WHERE account = ?1 AND reserved_at IS NOT NULL AND status IS NULL AND reserved_at < ?3 AND 0`"),
 ("M63 a refused start still reserves", "src/x.ts", "       WHERE NOT EXISTS (SELECT 1 FROM x_sessions WHERE account = ?2 AND status IS NOT NULL AND status != 'ok' AND ended_at > ?4)\n", ""),
 ("M64 crash pause runs from the reservation", "src/x.ts", "SET status = 'crash', ended_at = ?2,", "SET status = 'crash', ended_at = reserved_at,"),
 ("M65 a crash is never replaced by a later status", "src/x.ts", "x_sessions.status IN ('ok', 'crash') AND", "x_sessions.status IN ('ok') AND"),
 ("M66 a second session while one is open", "src/x.ts", "         AND (${openElsewhere}) IS NULL\n", ""),
 ("M67 an open reservation blocks its own retry", "src/x.ts", "AND status IS NULL AND session_id != ?1`;", "AND status IS NULL`;"),
 # POST /inbox/x and the admin exports (migration 0007)
 ("M68 a repeated (run_id, part) writes items again", "src/inbox.ts", "         WHERE EXISTS (SELECT 1 FROM inbox_x_parts WHERE run_id = ?2 AND part = ?3 AND request_id = ?4)\n", ""),
 ("M69 the inbox token reaches every route", "src/auth.ts", '    ["inbox", env.INBOX_TOKEN],', '    ["admin", env.INBOX_TOKEN],'),
 ("M70 inbox cap not enforced", "src/inbox.ts", "export const INBOX_MAX_BYTES = 256 * 1024;", "export const INBOX_MAX_BYTES = 64 * 1024 * 1024;"),
 ("M71 a refused inbox body is not recorded", "src/inbox.ts", "    await recordReject(env, { status: 400, error, ...claimedKey(parsed), bytes, total });\n", ""),
 ("M72 a JSON number post id is accepted", "src/inbox.ts", '  if (typeof v === "number") bad(', '  if (false) bad('),
 ("M73 sightings export reads the post's latest metrics", "src/inbox.ts", "s.seen_at, s.metrics_json, s.batch_id,", "s.seen_at, p.metrics_json, s.batch_id,"),
 ("M75 the admin token writes to the inbox", "src/index.ts", '(scope === "admin" && !found.route.exclusive)', '(scope === "admin")'),
 ("M76 a reject body is cut mid-character", "src/inbox.ts", "    if (end - lead < need) end = lead;\n", ""),
 ("M77 error text stringifies nested values", "src/inbox.ts", '  if (Array.isArray(v)) return `an array of ${v.length}`;\n  if (typeof v === "object" && v !== null) return', '  if (typeof v === "object" && v !== null) return JSON.stringify(v).slice(0, 80) ||'),
 ("M74 sightings pages overlap", "src/inbox.ts", "AND s.id > ?3 AND", "AND s.id >= ?3 AND"),
 ("M37 malformed prepared URL breaks the card", "src/proposals.ts", "  } catch {\n    return null;\n  }\n}\n\nfunction preparedItem", "  } finally {\n  }\n}\n\nfunction preparedItem"),
 # device-signed approvals, the executor, inbox, brief, voice and the bridge (migration 0009)
 ("M78 a revoked device still decides", "src/approvals.ts", '  if (device.revoked_at !== null) return refuse(403, "device_revoked"', '  if (false) return refuse(403, "device_revoked"'),
 ("M111 a device token revokes another device", "src/devices.ts", '  if (caller.scope === "device" && caller.deviceId !== id) throw', '  if (false) throw'),
 ("M96 another device changes this device's push token", "src/devices.ts", '  if (callerDevice !== id) throw new HttpError(403, `this device token belongs to another device than ${id}`);\n  const b = await readJson<Record<string, unknown>>(req, 4096);\n  onlyFields(b, ["apns_token", "apns_env"]);', '  const b = await readJson<Record<string, unknown>>(req, 4096);\n  onlyFields(b, ["apns_token", "apns_env"]);'),
 ("M112 another device stores this device's push-to-start token", "src/devices.ts", '  if (callerDevice !== id) throw new HttpError(403, `this device token belongs to another device than ${id}`);\n  const b = await readJson<Record<string, unknown>>(req, 4096);\n  onlyFields(b, ["push_to_start_token", "apns_env"]);', '  const b = await readJson<Record<string, unknown>>(req, 4096);\n  onlyFields(b, ["push_to_start_token", "apns_env"]);'),
 ("M113 times keep fractional seconds", "src/http.ts", '.toISOString().replace(".000Z", "Z");', '.toISOString();'),
 ("M114 a decided proposal still takes a signature", "src/approvals.ts", '  if (!p || p.state !== "awaiting_approval") return refuse(409,', '  if (!p) return refuse(409,'),
 ("M79 signed_at not checked", "src/approvals.ts", "export const SIGNATURE_SKEW_S = 300;", "export const SIGNATURE_SKEW_S = 1e12;"),
 ("M80 signature not verified", "src/approvals.ts", "if (!key || !(await verifyDer(key, der, message)))", "if (!key)"),
 ("M81 the signed message leaves out the nonce", "src/approvals.ts", '["discovery-approval-v1", requestId, inputsHashHex, decision, nonce, String(signedAt)]', '["discovery-approval-v1", requestId, inputsHashHex, decision, String(signedAt)]'),
 ("M82 a decided request decides again", "src/approvals.ts", "       WHERE id = ?1 AND state = 'pending' AND expires_at > ?3 AND nonce = ?7 AND inputs_hash = ?8", "       WHERE id = ?1 AND expires_at > ?3 AND nonce = ?7 AND inputs_hash = ?8"),
 ("M83 non-minimal DER accepted", "src/p256.ts", "      if (len === 1 || !(v[1] & 0x80)) return null;", "      if (len === 1) return null;"),
 ("M84 the bearer link still decides after enrollment", "src/proposals.ts", "  if (await anyDeviceEver(env)) {\n    return reply(403", "  if (false) {\n    return reply(403"),
 ("M85 head_branch need not start with agent/", "src/executor.ts", '  if (!head.startsWith("agent/") || head.length === "agent/".length) fail(', '  if (false) fail('),
 ("M86 allowlist not checked at execution", "src/executor.ts", "  if (!allowed(await repoAllowlist(env), spec.repo)) throw new ExecError(false,", "  if (false) throw new ExecError(false,"),
 ("M87 files under .github/ allowed", "src/executor.ts", '  if (segs[0].toLowerCase() === ".github") return', '  if (false) return'),
 ("M88 a moved head_sha still opens the PR", "src/executor.ts", "    if (at !== spec.head_sha) throw new ExecError(false,", "    if (false) throw new ExecError(false,"),
 ("M89 changed stored inputs still execute", "src/approvals.ts", " || (await inputsHash(p.final_step_kind, p.final_step, JSON.parse(p.inputs_json))) !== r.inputs_hash) {", ") {"),
 ("M90 an enrollment code works twice", "src/devices.ts", "       WHERE code_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING code_hash`,", "       WHERE code_hash = ?1 AND expires_at > ?2 RETURNING code_hash`,"),
 ("M91 an expired enrollment code works", "src/devices.ts", "       WHERE code_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING code_hash`,", "       WHERE code_hash = ?1 AND used_at IS NULL RETURNING code_hash`,"),
 ("M92 a revoked device's token still works", "src/auth.ts", '"SELECT id FROM devices WHERE device_token_hash = ? AND revoked_at IS NULL"', '"SELECT id FROM devices WHERE device_token_hash = ?"'),
 ("M93 a non-P-256 key enrolls", "src/p256.ts", "  if (!der || der.length !== 91 || SPKI_P256_PREFIX.some((b, i) => der[i] !== b)) return null;", "  if (!der) return null;"),
 ("M94 APNs host ignores apns_env", "src/apns.ts", 'const HOSTS = { development: "api.sandbox.push.apple.com", production: "api.push.apple.com" } as const;', 'const HOSTS = { development: "api.push.apple.com", production: "api.push.apple.com" } as const;'),
 ("M95 a dead push token is pushed to again", "src/approvals.ts", '"SELECT id, apns_token, apns_env FROM devices WHERE revoked_at IS NULL AND apns_invalid_at IS NULL ORDER BY enrolled_at"', '"SELECT id, apns_token, apns_env FROM devices WHERE revoked_at IS NULL ORDER BY enrolled_at"'),
 ("M97 the inbox takes the source from the body", "src/hub.ts", "  return insertInbox(env, { kind, text: b.text, source, claimedSource:", "  return insertInbox(env, { kind, text: b.text, source: (b.source as string | undefined) ?? source, claimedSource:"),
 ("M98 an agent posts a direction", "src/hub.ts", 'const AGENT_KINDS: readonly Kind[] = ["reply", "agent_push"];', 'const AGENT_KINDS: readonly Kind[] = KINDS;'),
 ("M99 the brief lists every ask", "src/hub.ts", "const MAX_ASKS = 3;", "const MAX_ASKS = 50;"),
 ("M100 an answered thought is still the question", "src/hub.ts", "           AND NOT EXISTS (SELECT 1 FROM inbox_items r WHERE r.reply_to = t.id)\n         ORDER BY t.created_at LIMIT 1`,", "         ORDER BY t.created_at LIMIT 1`,"),
 ("M101 voice size not capped", "src/voice.ts", "export const VOICE_MAX_BYTES = 25 * 1024 * 1024;", "export const VOICE_MAX_BYTES = 64 * 1024 * 1024;"),
 ("M102 voice retried forever", "src/voice.ts", "const MAX_ATTEMPTS = 3;", "const MAX_ATTEMPTS = 30;"),
 ("M103 the bridge forwards the system prompt", "src/bridge.ts", '    if (m?.role !== "user") continue;', '    if (m?.role === "assistant") continue;'),
 ("M104 system-reminder blocks reach the agent", "src/bridge.ts", '  return s.replace(HARNESS_BLOCKS, "")', '  return s.replace(/(?!)/g, "")'),
 ("M105 a re-send files a new task", "src/bridge.ts", "idempotency_key: `bridge-${await sha256Hex(`${model}\\n${brief}`)}`", "idempotency_key: `bridge-${Date.now()}`"),
 ("M106 side calls wake the agent", "src/bridge.ts", "  if (tools.length > 0) return false;\n", "  return false;\n"),
 ("M107 the result ignores the hand-back tool", "src/bridge.ts", '  if (toolChoice === "none") return null;', '  return null;'),
 ("M108 no keepalive while waiting", "src/bridge.ts", "const KEEPALIVE_MS = 10_000;", "const KEEPALIVE_MS = 60_000;"),
 ("M109 mailbox_complete doesn't wake the waiter", "src/mailbox.ts", '    if (row.from_agent === "bridge") ctx.waitUntil(notifyBridge(env, id));', ""),
 ("M110 the dot's tell posts as another source", "src/mailbox.ts", 'structured = await postInbox(env, "dot", { kind: "agent_push", ...args });', 'structured = await postInbox(env, "admin", { kind: "agent_push", ...args });'),
 ('M116 a second dispatch also succeeds', 'src/routing.ts', 'WHERE id = ?1 AND dispatched_at IS NULL RETURNING dispatched_at', 'WHERE id = ?1 RETURNING dispatched_at'),
 ('M117 a correction may pair any agent with any model', 'src/routing.ts', '  const model = agent.models.find((x) => x.id === b.model);', '  const model = table.agents.flatMap((a) => a.models).find((x) => x.id === b.model);'),
 ('M118 a dispatched item can be corrected', 'src/routing.ts', '  if (row.dispatched_at !== null) throw refuse(409,', '  if (false) throw refuse(409,'),
 ("M119 an agent's post can be routed", 'src/routing.ts', '  if (!row.source.startsWith("device:")) throw refuse(409,', '  if (false) throw refuse(409,'),
 ('M120 a numeric amount reaches the stake', 'src/approvals.ts', 'if (finalStepKind === "pay" && typeof i.amount === "string" && /^\\d{1,12}(\\.\\d{1,2})?$/.test(i.amount)) stake.amount = i.amount;', 'if (finalStepKind === "pay" && i.amount !== undefined) stake.amount = i.amount as string;'),
 ('M121 the push leaves out the stake', 'src/approvals.ts', '    ...(r.stake_json ? { stake: JSON.parse(r.stake_json) as Stake } : {}),\n  });', '  });'),
 ('M122 a finished voice note has no routing', 'src/voice.ts', '{ inbox_id: v.inbox_id, ...(routing ? { routing, classification: presentClassification(v.classification_json) } : {}) }', '{ inbox_id: v.inbox_id }'),
 ('M123 app routes answer sentence errors', 'src/index.ts', 'if (e instanceof HttpError && app) return', 'if (e instanceof HttpError && false) return'),
 ('M125 a model name inside a word counts', 'src/routing.ts', "/[A-Za-z0-9]+(?:['’][sS]\\b)?/g", "/sol|[A-Za-z0-9]+(?:['’][sS]\\b)?/g"),
 ('M126 a possessive names a model', 'src/routing.ts', '    if (!hit || t[i].possessive) continue;', '    if (!hit) continue;'),
 ('M127 ordinary-word models need no context', 'src/routing.ts', '    if (hit.model.common_word && !directed && !effortAt(t, i + 1) && t[i + 1]?.w !== "model") continue;', ''),
 ("M128 a pointed-at model doesn't beat the first one", 'src/routing.ts', '  const chosen = mentions.find((x) => x.directed) ?? mentions[0];', '  const chosen = mentions[0];'),
 ('M129 an effort word anywhere counts', 'src/routing.ts', '    if (t[i].w === "xhigh" || EFFORT_KEYWORDS.has(t[i + e.len]?.w ?? "") || EFFORT_KEYWORDS.has(t[i - 1]?.w ?? "")) out.effort = e.effort;', '    out.effort = e.effort;'),
 ('M130 "low priority" is an effort', 'src/routing.ts', '  if (!e || NOT_EFFORT_BEFORE.has(t[i + 1]?.w ?? "")) return null;', '  if (!e) return null;'),
 ("M131 the classifier's target routes", 'src/routing.ts', '  if (ex.model) {\n    const mm = ex.model.model;', '  if (!ex.model && c?.target?.model) ex.model = table.agents.flatMap((a) => a.models.map((model) => ({ agent: a.id, model }))).find((x) => x.model.id === c.target!.model);\n  if (ex.model) {\n    const mm = ex.model.model;'),
 ("M132 the classifier's project beats the words", 'src/routing.ts', '  const project = ex.project ?? c?.project ?? null;', '  const project = c?.project ?? ex.project ?? null;'),
 ('M133 the policy ignores the work type', 'src/routing.ts', '  const base = table.policy[work_type];', '  const base = table.policy.general_engineering;'),
 ('M134 a project outside the list is kept', 'src/routing.ts', '    project: table.projects.some((p) => p.name === x.project) ? (x.project as string) : null,', '    project: typeof x.project === "string" ? x.project : null,'),
 ("M135 the title isn't cut to 8 words", 'src/routing.ts', '.split(" ").slice(0, 8).join(" ")', '.split(" ").join(" ")'),
 ("M136 t3's task has no model line", 'src/routing.ts', '  const header = routing.agent === "t3" ?', '  const header = false ?'),
 ('M137 a voice note is filed as a thought whatever the classifier said', 'src/voice.ts', '{ kind: c.kind ?? "thought",', '{ kind: "thought",'),
]
# MUTATION_TESTS narrows the run to the suites that own the mutated code,
# such as "test/hub.test.mjs test/bridge.test.mjs".
tests = os.environ.get("MUTATION_TESTS", "test/").split()
for name, path, old, new in muts:
    if only and name.split()[0] not in only:
        continue
    # old and new may be lists, for a break that needs several edits at once.
    pairs = list(zip(old, new)) if isinstance(old, list) else [(old, new)]
    # Compared with LF line endings whatever the checkout uses (Windows
    # checkouts have CRLF); the original bytes are written back afterwards.
    raw = open(path, "rb").read()
    src = raw.decode("utf-8").replace("\r\n", "\n")
    mutated = src
    for o, n in pairs:
        assert o in mutated, name
        mutated = mutated.replace(o, n)
    open(path, "w", encoding="utf-8", newline="").write(mutated)
    try:
        # The spec reporter prints the ✖ lines read below; piped, node
        # otherwise picks TAP on some versions.
        proc = subprocess.Popen(["node", "--test", "--test-reporter=spec", *tests], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        try:
            stdout, _ = proc.communicate(timeout=240)
        except subprocess.TimeoutExpired:
            # A break that hangs the Worker (M77 overflows its stack) is caught too: the suite never passes.
            # Only the processes this run started: other worktrees run their own test stacks.
            if os.name == "nt":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
            else:
                subprocess.run(["pkill", "-f", os.path.join(os.getcwd(), "node_modules", ".bin", "wrangler") + " dev"])
                proc.kill()
            proc.communicate()
            print(f"caught  {name}: the suite hung past 240 s", flush=True)
            continue
        # node --test lists each failure twice (inline and in the summary).
        failed = sorted({re.sub(r" \([\d.]+ms\)$", "", l.strip()[2:]) for l in stdout.splitlines() if l.startswith("✖") and "failing tests:" not in l})
        print(f"{'caught' if failed else 'MISSED'}  {name}: exit={proc.returncode} failing={failed}", flush=True)
    finally:
        open(path, "wb").write(raw)
