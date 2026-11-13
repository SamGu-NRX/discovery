# discovery-watcher

This Worker is the stored half of the discovery system in `../docs/CONTRACT.md`. It is a Cloudflare Worker with D1 and one Durable Object per watcher, and it does three jobs:

- **Watchers.** Each watcher fetches its source cheaply and compares the result with stored state. Only a real change writes an event. Every check sets the watcher's Durable Object alarm for the next check, so the interval can shorten when something hot appears. One 15-minute cron picks up watchers whose alarm was lost and expires stale proposals.
- **X ingest.** The extension posts the X posts Sam's browser receives. The Worker stores them, records where each was seen, and queues every newly bookmarked post as a candidate.
- **Candidates, proposals and approvals.** The runner leases candidates, reads their context, and records proposals. A proposal whose last step is irreversible gets a single-use approval link, and at most 3 of those reach Sam a day.

A watcher rule match no longer POSTs to T3. It becomes a `watcher_event` candidate in the same transaction as its event, and the runner decides what to do with it.

Results and raw logs are in [EVIDENCE.md](EVIDENCE.md).

## Run it locally

```sh
npm install
npm test                         # 25 tests against two real wrangler dev stacks and the fixture server, about 12 s
python3 scripts/mutation-check.py # breaks the code 63 ways, one at a time; every break must fail a test, about 8 min
npm run evidence                 # live sources plus the fixture phases, about 2 min; writes evidence/<timestamp>/
```

If `.dev.vars` lacks any of `ADMIN_TOKEN`, `WEBSUB_SECRET`, `INGEST_TOKEN` or `RUNNER_TOKEN`, the harness adds it with a random local value. The harness points `T3_APPROVALS_WEBHOOK_URL` at the fixture server, so no test reaches T3. No test calls `/embed`, because the `AI` binding always reaches the real Workers AI service, even in `wrangler dev`.

`node scripts/rehearse-production.mjs` runs the production watcher list (`scripts/production-watchers.json`) against the real sources in local wrangler dev. It makes about two requests per source.

`node scripts/websub-live.mjs 60` runs the live YouTube WebSub check. It opens a cloudflared quick tunnel for about two minutes. Run it only when you mean to expose the callback route publicly.

## Deploy

`scripts/deploy-production.sh` performs the whole deploy, and it is safe to re-run:

1. Creates the D1 database `discovery-watcher` if it doesn't exist and writes its id into `wrangler.jsonc`.
2. Applies the migrations remotely. `0003_discovery_v2.sql` only adds tables and backfills candidates from existing rule-match events.
3. Deploys the Worker with its cron and the `AI` binding.
4. Generates `ADMIN_TOKEN`, `WEBSUB_SECRET`, `INGEST_TOKEN` and `RUNNER_TOKEN` into `~/.agent-secrets/discovery-*` (mode 600) if they don't exist, and sets them as secrets.
5. Sets `T3_APPROVALS_WEBHOOK_URL` only if `~/.agent-secrets/discovery-t3-approvals-webhook-url` exists.
6. Registers the production watchers.

No secret is printed. Then `node scripts/verify-production.mjs <base-url> ~/.agent-secrets/discovery-admin-token` prints `/health`, each watcher's fetch log and events, and the watcher candidates. With `--recheck` it forces one check of every watcher first, which shows that a second run adds no duplicate candidate.

`node scripts/seed-positives.mjs` posts Sam's past saves to `/positives` with the runner token. It reads only bookmark lists to decide which posts are saves (see the comment at its top), so replies captured as thread context don't count as his taste. `--dry-run` prints counts and a sample without posting. Re-running inserts nothing new.

## Operating

`$BASE` is `https://discovery-watcher.sgu07966.workers.dev`. Send tokens from their files so they stay out of shell history, for example `-H @<(printf 'authorization: Bearer %s' "$(cat ~/.agent-secrets/discovery-admin-token)")`.

**Tokens.** Each route declares which tokens may call it (`ROUTES` in `src/index.ts`). Any other token gets 403, and a missing or wrong token gets 401.

| Token file in `~/.agent-secrets/` | Secret | Holder | May call |
| --- | --- | --- | --- |
| `discovery-admin-token` | `ADMIN_TOKEN` | director | every route |
| `discovery-ingest-token` | `INGEST_TOKEN` | extension | `POST /ingest/x`, `POST /ingest/x/status`, `GET /x/detail-queue` |
| `discovery-runner-token` | `RUNNER_TOKEN` | runner | `/x/posts*`, `/embed`, `/positives`, `/candidates*`, `/proposals` |
| none, minted per proposal | none | approval link | `GET` and `POST /a/:token` |

**Routes.** All bodies are JSON. Times the Worker sets are epoch milliseconds; `since` parameters take ISO or milliseconds.

| Route | Notes |
| --- | --- |
| `POST /ingest/x` | At most 128 KB, counted in bytes as the body arrives, with or without a Content-Length. Every batch needs a `batch_id`. A `batch_id` the Worker has already recorded is skipped whole: no sightings, no counter changes. Returns `posts_upserted` (unique posts written), `sightings`, `new_posts`, `candidates_created`, and `duplicate_batch_ids` (the skipped ones). Fails with 400 naming the first bad field, such as `batches[0].posts[3].author_handle`. |
| `POST /ingest/x/status` | Closes the session's reservation. A status other than `ok` pauses that account's sessions and detail queue for 24 hours. A session's first status wins: a replay changes nothing, and `ok` never clears a non-ok status. A non-ok status after `ok`, or a real status after a detected crash, replaces it and restarts the 24 hours. Returns the stored status and the account's `pause_until`. |
| `POST /x/sessions/start` | `{account, session_id}`. The extension needs 200 here before it opens any X window. 423 `{pause_until}` when the account reported a status other than `ok` in the last 24 hours, or when an earlier reservation is over 30 minutes old with no status: that one is recorded as status `crash`, and the 24 hours run from when the crash is detected. Also 423 while another reservation for the account is open (under 30 minutes, no status), with `pause_until` at that reservation's `reserved_at` plus 30 minutes; the same `session_id` again gets 200, for a lost-response retry. A refused start reserves nothing. 409 for a session id that is already closed or belongs to another account. |
| `GET /x/detail-queue?account=` | Up to 5 candidate post ids this account has seen whose thread isn't captured yet. |
| `GET /x/posts?unscored=1&limit=` | At most 200 per page, oldest first, each with its latest `account`, `surface` and `session_id`. Without `unscored=1`, newest first. |
| `POST /x/posts/scores` | Up to 1000 `{id, score, parts}`. |
| `GET /x/posts/:id/context` | The post, its quoted post, and the captured thread in X's server order, plus `missing_ids` for thread ids never ingested. A thread counts as captured for a post only when it was captured on that post's permalink, or when the post is one of the conversation root's own self-thread posts. A reply listed under someone else's root is not captured, and it stays in the detail queue. |
| `POST /embed` | Up to 100 texts, each cut to 4000 characters. Returns `vectors` plus Workers AI's `shape`, `pooling` and `usage`. |
| `POST /positives`, `GET /positives?limit=&offset=` | Insert is deduplicated by id. A list page is at most 5000. |
| `POST /candidates` | Idempotent on `(kind, ref)`: 201 when created, 200 with `created: false` when it exists. An `x_post` ref must be an ingested post. 429 after 15 unbookmarked `x_post` candidates in a UTC day. |
| `GET /candidates?state=&kind=` | The newest 500. |
| `POST /candidates/claim` | `{owner, ttl_s, limit}`, with `ttl_s` up to 3600 and `limit` up to 10. Each returned candidate carries a random `lease_token`, which appears only in this response. Least-attempted first, so a deferred candidate goes behind ones never tried; then unscored candidates (bookmarks, watcher matches), then by score. |
| `POST /candidates/:id/complete` | `{owner, lease_token, state, note}`. Succeeds only with the current claim's token; a reclaim replaces it, so the earlier claimant gets 409 even under the same owner name. An owner whose lease expired but was never reclaimed still completes. `state` is `proposed`, `done`, `skipped` or `failed`, or `new` to defer: that releases the lease, clears the owner, keeps `attempts` and stores the note. |
| `POST /proposals`, `GET /proposals?state=&since=` | See below. |
| `POST /proposals/:id/rotate-token` | Re-mints the approval link of an unspent proposal, keeping `expires_at` and `inputs_hash`; the old link stops working. Refused with 409 once the notification went to T3 unless the body is `{"force": true}`, because the old link is the one in Sam's question card. Not in the contract. |
| `GET /admin/log?since=` | Admin only. Counts and rows since a time (default 24 h): sessions, candidates, proposals, watcher events, the last cron run. |

**Candidates.** A candidate is `new`, then `claimed` under a lease, then `proposed`, `done`, `skipped` or `failed`, or back to `new` when the runner defers it. An expired lease can be claimed again. A candidate whose lease has expired 3 times (`expired_leases`) is set to `failed` instead of being handed out a fourth time, so one input that crashes the runner can't loop forever. Deferrals raise `attempts` but not `expired_leases`. `origin` records who made it: `bookmark` (ingest), `watcher` (a rule match) or `runner`.

**Proposals and approvals.**

- A proposal with `final_step_kind: null` is stored as `done` and never notifies.
- Otherwise the Worker mints a random approval token, stores only its SHA-256, and returns `approve_url` once. Sending the same proposal again returns the same `id` with `duplicate: true`, and mints no new link and sends no new notification. A runner that lost the first response recovers the link with `rotate-token`.
- `inputs_hash` is the SHA-256 of the canonical JSON of `{final_step_kind, final_step, inputs}`. The card shows every field of `inputs` under "Exactly these inputs", nested objects and lists included, and carries the hash in its form. A decision whose `inputs_hash` doesn't match is refused with 409, and so is one whose stored inputs no longer hash to it.
- `POST /a/:token` resolves the token before reading any of the body, then reads at most 4 KB (413 over that). It takes a form or JSON body.
- A link is single-use: the first decision wins and later ones get 409. After `expires_at` (7 days by default, or `expires_in_s`), the link returns 410, and the next cron sets the proposal to `expired`.
- `notify_state` records what happened to the notification, checked in this order: `paused`, `no_webhook` (secret unset), `capped` (3 already went out that UTC day), else a POST to `T3_APPROVALS_WEBHOOK_URL` with `{event_id, title, why, final_step, approve_url}`, ending `sent` or `failed`. A failed POST counts toward the cap and is not retried, because a resend would need the token the Worker no longer has. The proposal still waits, and its link came back in the `POST /proposals` response.

**Pause approvals.** `POST /admin/notifications/pause` with `{"paused":true}` or `{"paused":false}`. Production is paused. `GET /admin/notifications` shows today's count against the cap, recent approval notifications, and the watcher notifications from before v2.

**Turn on approval notifications.** Write the webhook URL to `~/.agent-secrets/discovery-t3-approvals-webhook-url` (mode 600), run `npx wrangler secret put T3_APPROVALS_WEBHOOK_URL < ~/.agent-secrets/discovery-t3-approvals-webhook-url`, then unpause.

**Watchers.** POST a JSON object to `/admin/watchers`. Its first check runs immediately and seeds state. Seeded items that already match a rule become candidates, one per item.

```sh
curl -X POST "$BASE/admin/watchers" -H @<(printf 'authorization: Bearer %s' "$(cat ~/.agent-secrets/discovery-admin-token)") \
  -H 'content-type: application/json' \
  -d '{"id":"example-careers","kind":"page","url":"https://example.com/careers","interval_s":10800,"notify_rule":"\\bfellow"}'
```

- `kind` is one of `atom`, `greenhouse`, `hn`, `page` or `youtube_page`. `interval_s` is the normal interval.
- `hot_rule`, `hot_interval_s` and `hot_window_s` shorten the interval after a match. A `hot_rule` match is also a candidate.
- `notify_rule` makes a matching item a candidate, including items in the seed. `notify_all_new: true` makes every new item a candidate, but not seeded ones.
- `fallback_url` and `fallback_kind` give a second source to try when the first fails. `first_check_in_s` delays the first check.

Rules are case-insensitive JavaScript regexes tested against item titles or page text. Use word boundaries: the Greenhouse rule first used plain `intern`, and 6 of its 11 matches were International and Internal postings. To change a watcher, add a new id. There's no update route.

**See what happened.** `GET /admin/log?since=`, `GET /admin/events?limit=50`, `GET /admin/watchers/<id>` (the watcher, its alarm, fetch log, events and jobs), and `GET /health`, which needs no token and returns the last cron run.

**Synthetic checks.** Account `test` is reserved for them (contract 7d502f0). `GET /x/posts` lists only posts some other account has seen, with that account's latest sighting; ingest makes no candidates for account `test`; `POST /candidates` returns 422 for a ref starting `test-` and for a post only `test` has seen. Use ids starting `test-` anyway, and delete the rows afterward.

**Remove synthetic X data.** Test ingests use account `test` and ids starting `test-`:

```sh
npx wrangler d1 execute DB --remote --command "DELETE FROM proposals WHERE title LIKE 'test:%' AND candidate_ids_json LIKE '[\"test-%'; DELETE FROM candidates WHERE ref LIKE 'test-%'; DELETE FROM positives WHERE id LIKE 'test-%'; DELETE FROM x_sightings WHERE account = 'test' OR post_id LIKE 'test-%'; DELETE FROM x_threads WHERE account = 'test' OR root_id LIKE 'test-%'; DELETE FROM x_sessions WHERE account = 'test'; DELETE FROM x_ingest_batches WHERE account = 'test'; DELETE FROM x_posts WHERE id LIKE 'test-%';"
```

## Layout

| Path | Purpose |
| --- | --- |
| `migrations/0001_init.sql` | `watchers`, `seen_items`, `events` (`dedupe_key UNIQUE`), `jobs`, `fetch_log`, `websub_subscriptions`, and the trigger that adds one triage job per event |
| `migrations/0002_notify.sql` | Notify rules, fallback URL, `notifications` (unused since v2), `settings`, `cron_runs` |
| `migrations/0003_discovery_v2.sql` | `x_posts`, `x_sightings`, `x_threads`, `x_sessions`, `positives`, `candidates`, `proposals`, and the candidate backfill |
| `src/adapters.ts` | Atom, Greenhouse, HN Algolia, HTML page, YouTube videos tab. They produce item ids or normalized page text. |
| `src/check.ts` | One check: conditional GET, the fallback, parse, compare, write events and candidates, compute the next interval |
| `src/watcher.ts` | `WatcherDO`, whose alarm is the watcher's schedule |
| `src/websub.ts` | Hub subscribe and unsubscribe, challenge verification, HMAC-checked delivery |
| `src/auth.ts` | Which token a request carries, compared in constant time |
| `src/x.ts` | Ingest, ingest status, detail queue, post reads and scores, context, embed, positives |
| `src/candidates.ts` | Candidate create, claim, complete, list |
| `src/proposals.ts` | Proposals, approval notifications, and the approval card |
| `src/index.ts` | The route table with each route's tokens, admin and job routes, `/health`, `/admin/log`, the cron |
| `fixtures/server.mjs` | A local feed, board, page, a 404 feed, and a stand-in webhook |
| `scripts/harness.mjs` | Starts the fixture server and `wrangler dev` on a fresh state directory |
| `scripts/evidence.mjs`, `scripts/websub-live.mjs`, `scripts/rehearse-production.mjs` | The evidence runs |
| `scripts/deploy-production.sh`, `scripts/register-watchers.mjs`, `scripts/verify-production.mjs`, `scripts/production-watchers.json` | Deploy and check production |
| `scripts/seed-positives.mjs` | Seeds `/positives` from Sam's past saves |
| `scripts/mutation-check.py` | Breaks the code one way at a time and confirms each break fails a test |

## How a check decides "changed"

1. The check sends back the source's ETag or Last-Modified. A 304 ends it with no parse. GitHub releases and Greenhouse answer 304.
2. If the URL fails and the watcher has a `fallback_url`, the check fetches that instead, without counting a failure. YouTube uses this. The channel Atom feed returned 404 for every channel from at least 04:34 to 04:43 UTC on 2026-11-04 and was back by 08:02.
3. On a 200, the adapter computes a fingerprint. Feeds hash their sorted item ids. Pages hash their visible text after removing scripts, styles, svg and comments. A fingerprint equal to the stored one counts as no change.
4. The first successful fetch seeds `seen_items`. If seeded items match `notify_rule` or `hot_rule`, it writes one `seed.match` event and one candidate per matching item. The event's key is fixed per watcher, so the seed match can never happen twice. A seed never sets hot.
5. Later, one transaction inserts an event for each id the watcher hasn't seen, a candidate for each of those that matches a rule, then marks every id as seen. The event key and the candidate ref are both `<watcher>:<item id>` for poll and push, so a WebSub delivery of an item the poller already recorded inserts nothing.
6. A `hot_rule` match also sets `hot_until`, and until then the watcher uses `hot_interval_s`. A failed fetch doubles the interval, up to 6 hours.

`fetch_log.model_calls` counts outbound requests to model API hosts at the one fetch wrapper a source check uses. It is 0 in every run so far.

## What is proven

The watcher layer was observed locally and then in production on 2026-11-04; v2 was tested locally and verified in production the same day. Details are in EVIDENCE.md.

- The watchers poll real endpoints: the GitHub releases Atom feed, the Anthropic Greenhouse board, HN Algolia, anthropic.com/news, and Theo's YouTube channel through both the Atom feed and the videos tab. A second run makes no events.
- Production alarms fire on schedule and the cron runs every 15 minutes.
- A changed feed emits exactly one event per new item, and a rule-matched item becomes exactly one candidate. Duplicate and concurrent deliveries add nothing. A forged HMAC is dropped.
- The 5 Fellows and Resident postings from the production seed match are `watcher_event` candidates.
- X ingest stores the latest metrics, writes one sighting per post per batch, and makes one candidate per newly bookmarked post. Threads read back in X's server order.
- Candidate and job leases: an expired lease is reclaimed, a stale owner gets 409, a done item is never handed out again, and a candidate fails after 3 expired leases.
- Tokens refuse every route outside their scope.
- Approval links are single-use under concurrent decisions, bound to `inputs_hash`, escaped, and dead after expiry. At most 3 approval notifications go out a day, and a retried proposal never notifies twice.

## What is not proven

- **No real approval notification yet.** `T3_APPROVALS_WEBHOOK_URL` is not set and notifications are paused, so no T3 thread has received an approval.
- **Ingest CPU at the cap.** The cap is 128 KB because a 245 KB ingest used 15 to 17 ms of CPU on a cold request in production, over the Workers Free limit of 10 ms. 128 KB used 8 ms cold and 3 to 5 ms warm, measured before `batch_id` added a lookup per statement; see EVIDENCE.md for the current numbers.
- **No real WebSub delivery.** HMAC verification is proven only with locally signed bodies. Lease renewal by cron isn't built.
- **Not built:** MCP, a watcher update route, a candidate lease renewal, and retries for a failed approval notification. `x_ingest_batches` grows by one row per batch and is never pruned.
- **Known edge cases, left alone:**
  - YouTube videos-tab items have no titles, so their candidate title is the video URL.
  - When the Atom feed comes back after the fallback was in use, Shorts that the videos tab never listed can emit once.
  - A story that drops out of HN's 20-result window and later returns would emit once.
  - A page that changes from A to B, back to A, then to B again emits nothing for the second A-to-B change.
  - Jobs have no attempt cap. Every event still enqueues a `triage` job that nothing claims.
  - Daily caps count UTC days.
