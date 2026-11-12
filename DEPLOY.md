# Deploying `deploy/2026-11-12`

This branch is the Worker that goes to production tonight. It merges four reviewed PRs and is never merged into `main`:

| PR | Branch | Head merged | What it adds to the Worker |
| --- | --- | --- | --- |
| #4 | `hub` (the base of this branch) | `7fc59d3` | device-signed approvals, the draft-PR executor, inbox, brief, voice, routing, the agent bridge |
| #7 | `knowledge` | `c04ce4b` | the knowledge store (`/k/*`, R2 `x-knowledge`, MCP knowledge tools) |
| #6 | `lens-v1`, with #5 `x-direct` under it | `ec85b64` | lenses, reads, re-polls and baselines |

`x-direct` and `lens-v1` also change `extension/` and `runner/`. Those files come along in the merge and are not deployed by anything below.

PR #5's head has since moved to `518176e`; its two newer commits change only `extension/` and `docs/x-direct/`, so this branch has every Worker change in #5.

The lead runs every command from the MacBook, where wrangler is signed in. Nothing here was run against the Cloudflare account from the Zephyrus.

## Tests

Run on the Zephyrus (Windows 11) in `worker/`: `npx tsc --noEmit` is clean, and `node --test test/` passes 97 of 97 at `1d67540` (291 s). One earlier run lost a knowledge request to "Your worker restarted mid-request" (503) while files in this worktree were being edited during the run. The next run, with nothing edited, passed.

Three test changes came with the merges, in `1d67540`:

- The dot's MCP tool list now includes knowledge's four read-only tools.
- Knowledge's request helper opens a new connection per call, as the hub harness already does. With Node's pooled `fetch`, a socket `wrangler dev` had closed during a 2-second d1 or r2 helper call failed the next request, one test per run.
- The mailbox suite moved to ports 8961/8962/9461, because a WSL listener (`wslrelay.exe`, not started by these tests) held 8861, 8862 and 9361 and hung the suite.

The knowledge lead reported 5 tests failing on Windows. Running `origin/knowledge` (`c04ce4b`) here, the failures are 3 mailbox tests and 2 session-reservation tests, each `fetch failed`:

- a wake carries only ids and an expiry: T3's is HMAC-signed over the raw body, grok's carries its bearer key
- the cron puts a lapsed lease back in the queue with a new wake, capped when the receiver's day is full
- subscribe: only listed callback origins are contacted, the handshake must echo a signed challenge, and an agent holds at most 3
- session reservations: a non-ok status or an unreported reservation pauses the account for 24 h, and replays neither extend nor clear it
- a browser restart mid-session gets no new reservation until the open one reports or turns into a crash

The lead's own run had 4 mailbox and 1 session failure, so the set varies, as a timing race would. They do not fail the same way on `hub` alone: at `origin/hub` (`7fc59d3`) the same two files pass 31 of 31, because hub's harness opens a fresh connection per call and retries a local d1 command that failed to start. Both runs used the moved mailbox ports.

## Migrations

One additive sequence: `0001`–`0008` (already in production), `0009_hub`, `0010_routing`, `0020_knowledge`, `0030_lenses`. None drops, renames or rewrites a table. `0030` adds two columns to `x_sightings`; the others add tables, columns, mailbox agents and routes. `0003`–`0008` are unchanged.

## Bindings (`worker/wrangler.jsonc`)

| Binding | Kind | Name |
| --- | --- | --- |
| `DB` | D1 | `discovery-watcher` |
| `AI` | Workers AI | — |
| `KNOWLEDGE` | R2 | `x-knowledge` |
| `VOICE` | R2 | `discovery-voice` |
| `WATCHER` | Durable Object, SQLite (migration tag `v1`) | `WatcherDO` |
| `BRIDGE_WAIT` | Durable Object, SQLite (migration tag `v2`, new) | `BridgeWaitDO` |
| cron | trigger | `*/15 * * * *` |

## Secrets

Names only. "Script" means `worker/scripts/deploy-production.sh` sets it from a file in `~/.agent-secrets/`, generating the file first when it says so.

| Secret | Set by | Without it |
| --- | --- | --- |
| `ADMIN_TOKEN`, `WEBSUB_SECRET`, `INGEST_TOKEN`, `RUNNER_TOKEN`, `INBOX_TOKEN` | script (generated if missing) | already in production |
| `BRIDGE_TOKEN` | script (generated: `discovery-bridge-token`) | `/v1/*` answers 401 |
| `KNOWLEDGE_TOKEN` | script (generated: `discovery-knowledge`) | kworker can't reach `/k/*` |
| `T3_APPROVALS_WEBHOOK_URL` | script, if `discovery-t3-approvals-webhook-url` exists | approval links wait unnotified (only until a device enrolls) |
| `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` | script, if `discovery-apns-key-p8`, `-key-id`, `-team-id`, `-topic` exist | inert: see below |
| `GITHUB_PR_TOKEN` | script, if `discovery-github-pr-token` exists | inert: see below |
| `GEMINI_API_KEY` | script, if `discovery-gemini-api-key` exists | inert: see below |
| `MAIL_DOT_TOKEN`, `MAIL_T3_TOKEN`, `MAIL_GROK_TOKEN`, `MAIL_ROOM_TOKEN`, `MAIL_T3_WAKE_URL`, `MAIL_T3_WAKE_SECRET`, `MAIL_GROK_WAKE_URL`, `MAIL_GROK_WAKE_KEY`, `MAIL_CALLBACK_ORIGINS` | by hand (`worker/README.md`, "Turn on the mailbox") | that agent can't reach the mailbox, or its wakes fail and retry |
| `LENS_EMBED_URL`, `LENS_LABEL_URL`, `LENS_LABEL_MODEL`, `LENS_LABEL_KEY` | by hand, optional | lens embeddings use Workers AI, and labels come from the centroid |

`APNS_ORIGIN`, `GITHUB_API_ORIGIN`, `GEMINI_API_ORIGIN` and `GEMINI_BASE_URL` exist only for the local tests. Leave them unset in production.

kworker's R2 S3 keys (`R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) are not Worker secrets. They live in Windows Credential Manager on the Zephyrus (`docs/KNOWLEDGE.md`, "Deployment").

## What stays off after the deploy

Inert until a secret exists:

- **APNs** (`APNS_*`). Before any device enrolls, approvals keep using the bearer link and the T3 webhook. After one enrolls, the link refuses and requests are created, but each push is recorded `no_apns` and Sam sees requests only in the app's queue.
- **Gemini** (`GEMINI_API_KEY`). A voice note fails at once with "GEMINI_API_KEY is not set". Typed thoughts are still routed, from the words and the table, with no title. The knowledge store's Gemini capability answers 503 `capability_unavailable`; cached derivations still return.
- **The PR executor** (`GITHUB_PR_TOKEN`, and the `pr_repo_allowlist` setting, empty after the migration). An `open_pr` proposal is refused when filed (403) until a repository is allowlisted. An approved one without the token records `failed` and writes nothing.
- **kworker's large blobs** (the R2 S3 keys, on the Zephyrus). kworker refuses blobs over 8 MiB; smaller ones go through `PUT /k/blobs`.

Paused by the seed data:

- **The mailbox.** `0008_mailbox.sql` seeds `mailbox_paused = 1`, and nothing since changes it. While paused, sends, claims, wakes, subscriptions, bridge tasks (`/v1/chat/completions` answers 423 `paused`) and inbox dispatch (423 `paused`) are refused. Unpause with `POST /admin/mailbox/pause {"paused": false}`.
- **Approval notifications** stay as production has them (paused, per `worker/README.md`). The deploy doesn't change the `notifications_paused` setting.

## Command order

From the repository root on the MacBook:

```sh
git fetch origin && git checkout deploy/2026-11-12 && git pull --ff-only
cd worker && npm ci
npx tsc --noEmit

# Optional secrets, each as one file (mode 600), before the script runs:
#   ~/.agent-secrets/discovery-apns-key-p8      the .p8 file's text
#   ~/.agent-secrets/discovery-apns-key-id
#   ~/.agent-secrets/discovery-apns-team-id     DWGXWVUR2B
#   ~/.agent-secrets/discovery-apns-topic       com.samgu.nod
#   ~/.agent-secrets/discovery-github-pr-token  fine-grained: SamGu-NRX, contents + pull requests write
#   ~/.agent-secrets/discovery-gemini-api-key

scripts/deploy-production.sh
```

The script, in order:

1. Creates the D1 database if missing (it exists).
2. Creates the R2 buckets `discovery-voice` and `x-knowledge` if missing.
3. Applies `0009`, `0010`, `0020` and `0030` remotely, and stops if any migration is still pending.
4. Deploys the Worker, which also creates the `BridgeWaitDO` class.
5. Sets every secret it finds a file for (table above).
6. Waits until the admin token works, then re-registers the production watchers, which is idempotent.

Then:

```sh
BASE=https://discovery-watcher.sgu07966.workers.dev
adm() { curl -s -H @<(printf 'authorization: Bearer %s' "$(cat ~/.agent-secrets/discovery-admin-token)") -H 'content-type: application/json' "$@"; }

curl -s "$BASE/health"                                                       # last cron run
node scripts/verify-production.mjs "$BASE" ~/.agent-secrets/discovery-admin-token
adm "$BASE/admin/mailbox" | jq '{paused, agents: [.agents[].name]}'          # paused: true; sam, dot, t3, grok, bridge
adm "$BASE/routing/models" | jq '.policy'                                   # Sam's model policy, the routing default
adm -X POST "$BASE/admin/pr-allowlist" -d '{"repos":["SamGu-NRX/discovery"]}' # only when the PR executor should run
```

Set the mailbox secrets by hand only when the agents are ready, then unpause (`worker/README.md`, "Turn on the mailbox" and its probe runbook). Enroll Sam's iPhone last: `adm -X POST "$BASE/devices/enroll-codes"`, and type the code into Nod within 10 minutes. From then on, approval links answer 403.

## Rolling back

`npx wrangler rollback` returns the code to the previous deployment. The migrations stay applied; they only add, so the previous code runs on the new schema. Nobody has checked how a rollback treats the `BridgeWaitDO` class that this deploy adds.
