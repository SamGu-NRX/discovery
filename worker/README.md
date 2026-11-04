# discovery-watcher

This is the watcher layer from `../GROKBOT.md` (sections 3, 6 and 13). It's a Cloudflare Worker with D1 and one Durable Object per watcher. Each watcher fetches its source cheaply and compares the result with stored state. Only a real change writes an event. Every check sets the watcher's Durable Object alarm for the next check, so the interval can shorten when something hot appears. One 15-minute cron picks up watchers whose alarm was lost and retries failed notifications.

Most events are only rows in D1. A rule match is the one thing that reaches Sam. Each check that produces a match sends a single POST to a T3 webhook, and each POST starts a T3 thread that asks one Approve/Skip/Later question. Several matches from one check go into that one POST. At most 5 POSTs go out per UTC day.

Results and raw logs are in [EVIDENCE.md](EVIDENCE.md). The project directory is still called `watcher-proto`. The Worker is named `discovery-watcher`.

## Run it locally

```sh
npm install
npm test               # 8 tests against a real wrangler dev and the fixture server, about 10 s
npm run evidence       # live sources plus the fixture phases, about 2 min; writes evidence/<timestamp>/
```

`npm run evidence` makes three requests to each live source. If `.dev.vars` doesn't exist, both commands create it with a random `ADMIN_TOKEN` and `WEBSUB_SECRET`. The test harness points `T3_WEBHOOK_URL` at the fixture server, so no test reaches T3.

`node scripts/rehearse-production.mjs` runs the production watcher list (`scripts/production-watchers.json`) against the real sources in local wrangler dev. The fixture stands in for the T3 webhook. It makes about two requests per source.

`node scripts/websub-live.mjs 60` runs the live YouTube WebSub check. It opens a cloudflared quick tunnel for about two minutes, subscribes, waits 60 s for a delivery, then unsubscribes and closes the tunnel. Run it only when you mean to expose the callback route publicly.

## Deploy

`scripts/deploy-production.sh` performs the whole deploy, and it is safe to re-run. It does the following:

1. Creates the D1 database `discovery-watcher` and writes its id into `wrangler.jsonc`.
2. Applies the migrations remotely.
3. Deploys the Worker.
4. Generates `ADMIN_TOKEN` and `WEBSUB_SECRET` into `~/.agent-secrets/discovery-admin-token` and `discovery-websub-secret`, mode 600, if they don't exist yet.
5. Sets those two secrets plus `T3_WEBHOOK_URL`. The webhook URL is piped from `~/.agent-secrets/discovery-t3-webhook-url`.
6. Registers the production watchers.

No secret is printed. Then:

```sh
node scripts/verify-production.mjs https://discovery-watcher.<subdomain>.workers.dev ~/.agent-secrets/discovery-admin-token
node scripts/verify-production.mjs https://discovery-watcher.<subdomain>.workers.dev ~/.agent-secrets/discovery-admin-token --recheck
```

The first command is read-only. It prints `/health`, each watcher's `fetch_log` and events, and each notification with its POST status. `--recheck` forces one check of every watcher first, which shows that a second run sends no duplicate POST.

## Operating

All admin routes need `Authorization: Bearer <ADMIN_TOKEN>`. Read the token from its file, for example with `-H @<(printf 'authorization: Bearer %s' "$(cat ~/.agent-secrets/discovery-admin-token)")`, so it stays out of your shell history. `$BASE` below is the workers.dev URL.

**Add a watcher.** POST a JSON object to `/admin/watchers`. Its first check runs immediately, seeds state, and sends a `seed.match` notification only if seeded items already match a rule.

```sh
curl -X POST "$BASE/admin/watchers" -H @<(printf 'authorization: Bearer %s' "$(cat ~/.agent-secrets/discovery-admin-token)") \
  -H 'content-type: application/json' \
  -d '{"id":"example-careers","kind":"page","url":"https://example.com/careers","interval_s":10800,"notify_rule":"\\bfellow"}'
```

Fields:

- `kind` is one of `atom`, `greenhouse`, `hn`, `page` or `youtube_page`.
- `interval_s` is the normal interval.
- `hot_rule`, `hot_interval_s` and `hot_window_s` shorten the interval after a match.
- `notify_rule` notifies on a match, including matches in the seed.
- `notify_all_new: true` notifies on every new item, but not on seeded ones.
- `fallback_url` and `fallback_kind` give a second source to try when the first fails.
- `first_check_in_s` delays the first check.

Rules are case-insensitive JavaScript regexes tested against item titles or page text. Use word boundaries. The Greenhouse rule first used plain `intern` and matched 6 International and Internal postings out of 11 matches. To change a watcher today, add a new id. There's no update route yet.

**See events.** These routes return what the watchers found:

- `GET /admin/events?limit=50`, optionally with `&watcher_id=…`, returns the newest events.
- `GET /admin/watchers/<id>` returns one watcher's row, its alarm time, its whole `fetch_log`, its events and their triage jobs.
- `GET /admin/notifications` returns the last 100 notifications with `state` and `last_status`, plus `used_today` against the cap of 5.
- `GET /health` needs no token. It returns the last cron run.

**Pause notifications.** `POST /admin/notifications/pause` with `{"paused":true}` stops POSTs. Matches still become events, and their notifications are stored as `paused` and never sent later. `{"paused":false}` resumes. To cut T3 off entirely, run `npx wrangler secret delete T3_WEBHOOK_URL`. Notifications then fail with `T3_WEBHOOK_URL is not set` and the cron retries each at most three times.

**Notification states.** A notification is in one of these states:

- `sent` means the POST returned 2xx.
- `failed` means it got a non-2xx response or a network error. The cron retries it with the same `event_id` until it has had 3 attempts.
- `capped` means it was over the daily cap of 5 and was not sent.
- `paused` means it was created while notifications were paused and was not sent.

## Layout

| Path | Purpose |
| --- | --- |
| `migrations/0001_init.sql` | `watchers`, `seen_items`, `events` (`dedupe_key UNIQUE`), `jobs`, `fetch_log`, `websub_subscriptions`, and the trigger that adds one triage job per event |
| `migrations/0002_notify.sql` | Notify rules, fallback URL, `notifications`, `settings`, `cron_runs` |
| `src/adapters.ts` | Atom, Greenhouse, HN Algolia, HTML page, YouTube videos tab. They produce item ids or normalized page text. |
| `src/check.ts` | One check: conditional GET, the fallback, parse, compare, write events, seed matches, compute the next interval |
| `src/notify.ts` | One POST per check's matches, the daily cap, pause, retries |
| `src/watcher.ts` | `WatcherDO`, whose alarm is the watcher's schedule |
| `src/websub.ts` | Hub subscribe and unsubscribe, challenge verification, HMAC-checked delivery |
| `src/index.ts` | Admin and job routes, `/health`, lease claims, the dispatcher cron |
| `fixtures/server.mjs` | A local feed, board, page, a 404 feed, and a stand-in T3 webhook |
| `scripts/harness.mjs` | Starts the fixture server and `wrangler dev` on a fresh state directory |
| `scripts/evidence.mjs`, `scripts/websub-live.mjs`, `scripts/rehearse-production.mjs` | The evidence runs |
| `scripts/deploy-production.sh`, `scripts/register-watchers.mjs`, `scripts/verify-production.mjs`, `scripts/production-watchers.json` | Deploy and check production |
| `scripts/mutation-check.py` | Breaks the code 12 ways, one at a time, and confirms each break fails a test |

## How a check decides "changed"

1. The check sends back the source's ETag or Last-Modified. A 304 ends it with no parse. GitHub releases and Greenhouse answer 304.
2. If the URL fails and the watcher has a `fallback_url`, the check fetches that instead, without counting a failure. YouTube uses this. The channel Atom feed returned 404 for every channel from at least 04:34 to 04:43 UTC on 2026-11-04 and was back by 08:02.
3. On a 200, the adapter computes a fingerprint. Feeds hash their sorted item ids. Pages hash their visible text after removing scripts, styles, svg and comments. A fingerprint equal to the stored one counts as no change.
4. The first successful fetch seeds `seen_items`. If seeded items match `notify_rule` or `hot_rule`, it writes one `seed.match` event and sends one notification. The event's key is fixed per watcher, so the seed match can never happen twice. A seed never sets hot.
5. Later, one transaction inserts an event for each id the watcher hasn't seen, then marks every id as seen. The event key is `<watcher>:<item id>` for both poll and push, so a WebSub delivery of an item the poller already recorded inserts nothing.
6. New items that match a rule, or any new item under `notify_all_new`, become one notification for the check. A `hot_rule` match also sets `hot_until`, and until then the watcher uses `hot_interval_s`. A failed fetch doubles the interval, up to 6 hours.

`fetch_log.model_calls` counts outbound requests to model API hosts at the one fetch wrapper a source check uses. It is 0 in every run so far.

## What is proven

These were all observed locally on 2026-11-04. The details are in EVIDENCE.md.

- The watchers poll real endpoints:
  - the GitHub releases Atom feed
  - the Anthropic Greenhouse board
  - HN Algolia
  - anthropic.com/careers and anthropic.com/news
  - Theo's YouTube channel, through both the Atom feed and the videos tab
- A second run made no events. GitHub and Greenhouse returned 304s, and the rest matched their stored fingerprints.
- Durable Object alarms fire in `wrangler dev` and each check sets the next one.
- A changed feed emits exactly one event per new item. Duplicate and concurrent deliveries add no row, no second job and no second notification. A forged HMAC is dropped.
- In the production rehearsal, the 5 Fellows and Resident postings already open on Greenhouse produced exactly one `seed.match` POST. A forced second run sent none. Unmatched new items notify nothing.
- A failed POST is recorded with its status and retried by the cron under the same `event_id`. Pause holds notifications back. The sixth notification in a day is stored as `capped` and not sent.
- The interval switches to hot on a matching item and back after the window.
- The cron re-arms a watcher whose alarm was deleted, and `/health` reports the last cron run.
- A job's expired lease is reclaimed by a second claimant. The original owner then can't complete it, and a done job is never handed out again.
- The public WebSub hub accepted a subscription to Theo's channel, reached the callback through a quick tunnel, and verified both the subscribe and the unsubscribe.
- Model calls: 0 across every check.

## What is not proven

- **Not deployed.** The deploy script, `wrangler deploy --dry-run` and the local rehearsal are ready. The real deploy waits on Sam's own go-ahead (see EVIDENCE.md, Production). The following are all unmeasured until it runs:
  - real cron firing and alarm reliability
  - D1 and Durable Object metering
  - the Workers Free 10 ms CPU limit. In Node, parsing took under 1 ms per source.
  - the real T3 webhook's response
- **No real WebSub delivery.** HMAC verification is proven only with locally signed bodies. Lease renewal by cron isn't built.
- **No auth-walled sources.** Gmail, Canvas ICS, X and Instagram aren't covered. There's no Pomerado, Lever or Ashby adapter yet.
- **The admin routes use one bearer token.** The scoped per-client tokens from the design aren't built, and neither are MCP, a watcher update route, or triage beyond enqueuing a `triage` job.
- **The edge cases below are known and left alone.**
  - A crash between an event insert and its notification insert loses that notification. The event stays.
  - Capped and paused notifications are never sent later.
  - YouTube videos-tab items have no titles, so their notification title is the video URL.
  - When the Atom feed comes back after the fallback was in use, Shorts that the videos tab never listed can emit once.
  - A story that drops out of HN's 20-result window and later returns would emit once.
  - A page that changes from A to B, back to A, then to B again emits nothing for the second A-to-B change.
  - Jobs have no attempt cap.
  - The daily cap counts UTC days.
