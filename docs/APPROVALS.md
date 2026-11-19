# Contract: device-signed approvals, the inbox and voice (Worker ↔ iPhone app)

Both the Worker (`discovery`, Cloudflare Worker + D1) and the iPhone app implement exactly this. Change it only through the lead.

## Why

Today an approval is a bearer link (`/a/:token`): whoever holds the URL can approve, including an agent that created the proposal. From now on an irreversible step needs a signature from a P-256 key that lives in the Secure Enclave of Sam's iPhone and is usable only after the phone is unlocked (Face ID, Touch ID or passcode). No agent can produce that signature, however much other authority it has.

## Enrollment (once per device)

1. Admin mints a one-time enrollment code: `POST /devices/enroll-codes` (ADMIN_TOKEN) → `{ code, expires_at }` (10 minutes, single use, stored as a SHA-256 hash). The app accepts the code typed or pasted; no QR in v1.
2. The app creates a Secure Enclave P-256 key with access control `.privateKeyUsage` + `.userPresence` (the private key never leaves the device), and calls `POST /devices/enroll` with `{ code, name, public_key_spki_b64, apns_token, apns_env: "development"|"production" }`.
3. The Worker stores the device `{ id, name, public_key_spki_b64, apns_token, apns_env, enrolled_at, revoked_at }` and returns `{ device_id, device_token }`. `device_token` is a random 32-byte hex bearer used only for low-risk calls (inbox posts, voice uploads, reading the queue); approvals always need a signature.
4. `POST /devices/:id/apns-token` (device_token) updates the push token when iOS rotates it. `POST /devices/:id/revoke` (ADMIN_TOKEN).

## Approval requests

When a proposal's next step is irreversible, the Worker creates an approval request `{ id, proposal_id, inputs_hash, title, body (≤ 3 short lines), action_label, nonce (16 random bytes, hex), created_at, expires_at }` and sends an APNs alert to every enrolled device:
- `aps.alert { title, body }`, `aps.category = "APPROVAL"`, `aps.interruption-level = "time-sensitive"`, `aps.mutable-content = 1`, custom `{ request_id, inputs_hash, nonce, expires_at }`.
- APNs auth: token-based (ES256 JWT signed with the `.p8` key via WebCrypto), secrets `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` (the app's bundle id). Host by `apns_env`: `api.sandbox.push.apple.com` or `api.push.apple.com`.

`GET /approvals?state=pending` (device_token) lists pending requests for the app's queue.

## Deciding

The app registers notification category `APPROVAL` with actions `APPROVE` and `DENY`, both `.authenticationRequired`. Neither is `.destructive`: denying is the safe choice. On a tap, without opening the app UI:

1. Build the message, UTF-8, fields joined by `\n`, no trailing newline:
   ```
   discovery-approval-v1
   <request_id>
   <inputs_hash>
   <decision: approve|deny>
   <nonce>
   <signed_at: unix seconds>
   ```
2. Sign with the Secure Enclave key: ECDSA P-256 over SHA-256 (`SecKeyCreateSignature`, `.ecdsaSignatureMessageX962SHA256`). That returns DER; send it base64.
3. `POST /approvals/:request_id/decide` with `{ device_id, decision, signed_at, signature_der_b64 }`.

The Worker verifies, in this order, and answers 4xx naming the failed check:
- device exists and is not revoked;
- request exists, is pending and not expired;
- `|now − signed_at| ≤ 300 s`;
- signature valid over the exact message with the stored public key (WebCrypto `ECDSA`/`P-256`/`SHA-256`; convert DER to the raw r‖s form WebCrypto expects);
- then atomically: mark the request decided and the nonce used (one UPDATE with `WHERE state = 'pending'`), so a replay or a second device gets 409.

On `approve` the Worker runs the proposal's executor (first executor: "open a PR", below). On `deny` it records the decision. Either way it returns `{ state, result_url? }`, and the app shows that state in a local notification only after the Worker confirms.

The old `/a/:token` link stays working for proposals with no irreversible step. Once at least one device is enrolled, irreversible proposals refuse the bearer link with 403 `device signature required`.

## First executor: open a PR

Secret `GITHUB_PR_TOKEN` (fine-grained, owner SamGu-NRX, contents + pull requests write). A proposal of kind `open_pr` carries `{ repo, base, head_branch, title, body, files: [{ path, content_b64 }] }` or a reference to a branch an agent already pushed. Rules enforced in code: `head_branch` must start with `agent/`; never write to the default branch or `base`; refuse repos outside an allowlist setting; create the branch from `base`'s head through the Git Data API, commit, then open the PR as a draft. Return the PR URL.

## Inbox and brief

- `POST /inbox` (device_token, agent tokens, ADMIN_TOKEN) `{ kind: "thought"|"direction"|"task"|"reply"|"agent_push", text, source, refs?: [url], audio_id? }` → stored verbatim with provenance (`source` is derived from the token, not the body).
- `GET /brief` (device_token, `agent:dot`, ADMIN_TOKEN) → `{ text (≤ 90 words), asks: [{ request_id, line }], returns: [...], question?, counts }` built from pending approvals, recent results and unanswered thoughts. Quiet days return `{ text: "" }`.

## Voice

- `POST /voice` (device_token), body = the audio file (`audio/mp4`, AAC, 48 kHz mono, ≤ 25 MB), header `x-recorded-at`. The Worker stores it in R2 (`VOICE` bucket binding) and returns `{ audio_id }` at once, then transcribes in `ctx.waitUntil` with Gemini (`GEMINI_API_KEY`; model per the current Gemini transcription docs) and files the transcript to the inbox as `kind: "thought"` with `audio_id`. `GET /voice/:audio_id` (device_token) returns `{ state, transcript? }`.
- The app also offers the transcript for SuperWhisper-compatible export later; not in v1.

## Wire details

Amended by the lead on 2026-11-12. The iPhone app is built against these.

1. Times: every timestamp the Worker returns to the app (`expires_at`, `created_at`, `enrolled_at`, `decided_at`, `revoked_at`, …) is an ISO 8601 UTC string with whole seconds, such as `2026-11-12T09:30:00Z`. `signed_at` in the decide body stays Unix seconds, because it is inside the signed message.
2. `GET /approvals?state=pending` returns `{ "approvals": [ … ] }`, not a bare array.
3. `POST /devices/:id/apns-token` body: `{ "apns_token": "<hex>", "apns_env": "development"|"production" }`. Both fields are required.
4. `POST /approvals/:id/decide` success returns `{ "state": "approved"|"denied", "result_url"?: string }`. Every 4xx/5xx body is `{ "error": "<machine_code>", "message": "<one sentence>" }`, where `error` names the failed check. The codes, in the order the checks run:

   | `error` | Status | When |
   | --- | --- | --- |
   | `bad_request` | 400 | The body is not JSON, has an unknown field, or a field is malformed; `message` names the field. |
   | `body_too_large` | 413 | The body is over 4 KB. |
   | `device_unknown` | 403 | No device has that `device_id`. |
   | `device_revoked` | 403 | The device was revoked. |
   | `request_not_found` | 404 | No approval request has that id. |
   | `already_decided` | 409 | The request was approved or denied already, or another call won the final UPDATE. The body also carries `state`, `outcome` and `result_url` when there is one, so an app whose first answer was lost can show the outcome. |
   | `request_expired` | 410 | The request expired. |
   | `clock_skew` | 401 | `signed_at` is more than 300 s from the Worker's clock. |
   | `bad_signature` | 401 | The signature does not verify over the exact message with the device's key. |
   | `request_not_pending` | 409 | The proposal behind the request is no longer waiting (it expired, or was decided another way). |
   | `inputs_changed` | 409 | The proposal's stored inputs no longer hash to the request's `inputs_hash`. |
   | `internal_error` | 500 | The Worker failed; `request_id` is in the body. |

   An approve's answer also carries `outcome`: `executed` (with `result_url`, the PR), `no_executor` (the step has no executor yet and waits), `failed` (nothing was written; `outcome_error` says why) or `outcome_unknown` (a write may have happened). `GET /approvals/:id` (device_token) returns the request with the same `outcome` and `result_url`.
5. `GET /voice/:audio_id` returns `{ "state": "queued"|"transcribing"|"done"|"failed", "transcript"?: string, "error"?: string }`.
6. APNs payload: the custom keys `request_id`, `inputs_hash`, `nonce`, `expires_at` sit at the top level next to `aps`.
7. The `x-recorded-at` header is ISO 8601 with seconds and a zone (`2026-11-12T09:30:00Z`; fractional seconds and offsets are accepted).
8. For v1.1 remote Live Activity starts: `POST /devices/:id/live-activity-token` (that device's device_token) with `{ "push_to_start_token": "<hex>", "apns_env": "development"|"production" }`. The Worker stores it and sends no Live Activity pushes yet.
9. Self-revoke: `POST /devices/:id/revoke` also accepts that device's own `device_token`, which may revoke only itself. ADMIN_TOKEN can revoke any device.
10. Stake: every approval request (`GET /approvals`, `GET /approvals/:id`) and its push carry `stake`, a top-level custom key in the push like the four above: `{ "kind": "pr"|"pay"|"send"|"other", "repo"?, "additions"?, "deletions"?, "files"?, "head"?, "base"?, "amount"?, "currency"?, "recipient"?: { "name", "handle"?, "avatar_url"? } }`. Every value comes from the proposal's inputs, which `inputs_hash` binds; a value not in its exact shape is left out, never repaired.
    - `pr` (final step `open_pr`): `repo`, `head` (the `agent/` branch), `base`, and `files` (the number of files) when the Worker writes the branch itself. `additions` and `deletions` are not sent: the Worker doesn't know the diff against `base` before the branch exists.
    - `pay`: `amount` from `inputs.amount`, a decimal string such as `"1240.50"` (a JSON number is left out); `currency` from `inputs.currency`, three capital letters such as `USD`; `recipient` from `inputs.recipient`.
    - `send`: `recipient` from `inputs.recipient`.
    - `recipient`: `name` (1 to 80 characters) is required; `handle` (`@?` then letters, digits, `_`, `.`, `-`, up to 64) and `avatar_url` (https, up to 500 characters) are kept only when valid.
    - Any other final step: `{ "kind": "other" }`.
    - The whole push stays under APNs' 4096 bytes. Title, body and stake fields are capped well under that; if a push would still pass it, the avatar is dropped, then the stake, and the queue keeps the full request.
11. Routing: Part 3 of the hub, from Sam: "state a model and have whatever input be correctly classified into the right model and effort level, into structured outputs, just via speech inside the app." A thought, direction or task a device posts to `POST /inbox`, and every voice note, is routed when it is filed. `POST /inbox` answers `{ "id", "kind", "source", "created_at", "routing", "classification" }`; `routing` is `{ "agent": "t3"|"grok"|"dot", "model", "effort": "low"|"medium"|"high"|"xhigh"|"max", "project": string|null, "kind", "source": "spoken"|"table" }` and `classification` is `{ "title", "work_type", "confidence" }` (each null when the classifier didn't answer). A reply, and anything an agent posts, is filed without either.
    - First, a deterministic parse of the words. Explicit mentions always win.
      - Models, anywhere in the text, as whole words: Opus, Sonnet, Haiku, Fable, Sol, Astra, Luna, Terra (agent `t3`), Grok or GrokBot (`grok`), dot (`dot`). "console" and "solution" don't name Sol. A possessive ("Luna's answer") names nothing. Sonnet, Haiku, Fable and dot are also ordinary words, so they count only right after use, using, with, via, ask, have, let, tell, send, give, assign, route, put or to ("the" between is allowed: "ask the dot"), or right before an effort or "model": "write a haiku" and "dot the i's" name nothing.
      - Several models: the first one after one of those words wins ("compare Opus and Sonnet, then use Sol" is Sol), otherwise the first mentioned ("Opus versus Astra" is Opus).
      - Effort: low, medium, high, xhigh, max, maximum, and "extra high" for xhigh. A phrase with effort, thinking or reasoning ("max effort", "extra high effort") counts anywhere; otherwise an effort word counts within 3 words of the chosen model ("Opus high", "Sonnet at max"). An effort word before priority, quality, level, time, risk and similar nouns is ordinary English ("low priority"), and so is one with no model and no "effort" ("this bug is high on my list").
      - A named model without an effort takes that model's `default_effort` from the table. A named effort without a model keeps the policy's model.
      - Project: the earliest keyword of a project in the table's list.
    - Then one Gemini call with a JSON schema classifies the rest: for a voice note it is the same call that transcribes the audio; for text, a text-only call that waits at most 6 s. Its answer is `{ transcript (voice only), kind, title (≤ 8 words), project, target: { agent, model, effort } | null, work_type, confidence }`, checked field by field: a value outside its set is dropped, and the title is cut to 8 words.
    - `work_type` is one of `ui_engineering`, `general_engineering`, `clear_cut_tested`, `investigation`, `hard_reasoning`, `x_context`, `quick_lookup`, `note`, and picks the row of the routing table's `policy` when Sam named no model. The default policy is Sam's: UI and general engineering on `opus` high; clear-cut non-UI work with tests and investigation on `sol` medium; hard reasoning on `astra` medium; X context on `grok`; quick lookups on `luna` max; a note (not work) to the `dot`. Without a classification, a task or direction counts as general engineering and the rest as notes. The table is a D1 setting (`POST /admin/routing`), so it changes without a deploy.
    - The classifier's `target` is stored as a hint and never routes: only Sam's own words name a model. The classifier's `project` counts only when the words named none and it is in the table's list. The kind is what the app sent for text, and the classifier's for a voice note (`thought` when it couldn't tell); the transcript is filed verbatim.
    - `source` is `spoken` when the words named a model or an effort, `table` otherwise.
    - `POST /inbox/:id/route` (device_token) with `{ "agent", "model", "effort", "project", "kind" }`, all required, `project` being `null` or a project the table lists; each is checked against `GET /routing/models` (the model must be one of that agent's, the effort one that model offers). It answers `{ "routing" }` as stored, with `source: "spoken"`, because the app's `source` has no value for a correction.
    - `POST /inbox/:id/dispatch` (device_token), no body, files the item in the mailbox from `sam` to the routing's agent: for `t3` a first line naming the item, kind, project, model and effort; for `grok` and `dot` the item, kind and project; then Sam's text unchanged. Dispatching starts work and decides nothing irreversible, so it needs no signature; anything irreversible the work produces still goes through a device-signed approval. It answers `{ "inbox_id", "task_id", "agent", "dispatched_at" }`. A repeat, or a second call racing the first, gets 409 `already_dispatched`, and so does a correction after dispatch. The mailbox's own refusals keep their rule as the code (423 `paused`, 429 `wake_cap`, 422 `capability_leak`, …).
    - Refusals on these routes: 404 `inbox_item_not_found`; 409 `not_routable` (not posted from a device) and `not_routed` (no routing yet).
12. `GET /voice/:audio_id` in state `done` also returns `inbox_id`, that item's current `routing` and its `classification`, so a correction made after the note was filed shows there too.
13. `GET /routing/models` (device_token) returns `{ "efforts", "kinds", "work_types", "agents": [{ "id", "label", "models": [{ "id", "label", "aliases", "common_word", "efforts", "default_effort" }] }], "projects": [{ "name", "keywords" }], "policy": { <work_type>: { "agent", "model", "effort" } } }`. Model ids are the short names the app shows. ADMIN_TOKEN replaces the table with `POST /admin/routing` (the same object without `efforts`, `kinds` and `work_types`). The model and effort reach `t3` in the task text; the Worker can't switch a host's model itself.
14. Every 4xx/5xx body on the routes the app calls (`/devices*`, `/approvals*`, `/inbox`, `/inbox/:id/*`, `/brief`, `/voice*`, `/routing*`) is `{ "error": "<code>", "message" }`. Besides the codes above: `bad_request` (400, `message` names the field), `unauthorized` (401), `forbidden` (403), `not_found` (404), `length_required` (411), `body_too_large` (413), `unsupported_media_type` (415), `internal_error` (500, with `request_id`).
