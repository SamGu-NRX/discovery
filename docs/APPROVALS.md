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

