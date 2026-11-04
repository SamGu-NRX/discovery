# Evidence: the watcher layer against real sources

Everything ran locally on 2026-11-04 (UTC) in `wrangler dev` 4.19.1, which runs the Worker in workerd with local D1 and local Durable Objects. Nothing was deployed and no Cloudflare account was used.

Raw material, all in `evidence/`:

| Path | What it is |
| --- | --- |
| `2026-11-04T04-38-01-574Z/` | The evidence run this file reports. `wrangler.log` is the full Worker output, `results.json` holds every API response the script used. |
| `2026-11-04T04-34-12-192Z/` | The first evidence run. It found the YouTube feed outage, which is why the second run adds `yt-theo-page`. Otherwise it matches the second run. |
| `websub-2026-11-04T04-39-50-851Z/` | The live WebSub subscribe and unsubscribe through a quick tunnel. |
| `tests.txt`, `mutation-check.txt` | Test output, and the output of breaking the code on purpose to confirm each test fails. |

Reproduce with `npm run evidence` and `node scripts/websub-live.mjs 60`.

## a. Run 1 against live sources

Each watcher was registered with its first alarm due immediately, so the Durable Object alarm, not a manual call, made these fetches.

| Watcher | Source | HTTP | Bytes | Latency | Items seeded | Validators sent back by source |
| --- | --- | --- | --- | --- | --- | --- |
| `yt-theo` | YouTube channel Atom feed | **404** | 0 | 295 ms | 0 | none |
| `yt-theo-page` | `youtube.com/@t3dotgg/videos` (fallback) | 200 | 1,313,393 | 483 ms | 30 | none |
| `gh-claude-code` | `anthropics/claude-code/releases.atom` | 200 | 122,343 | 548 ms | 10 | ETag |
| `greenhouse-anthropic` | Greenhouse board JSON | 200 | 487,698 | 327 ms | 681 | ETag |
| `hn-anthropic` | HN Algolia `search_by_date` | 200 | 27,174 | 291 ms | 20 | none |
| `page-anthropic-careers` | `anthropic.com/careers` HTML | 200 | 227,050 | 238 ms | page fingerprint | none |

Seeding wrote 741 rows to `seen_items` and 0 rows to `events`.

```
[greenhouse-anthropic] check trigger=alarm status=200 bytes=487698 latency=327ms conditional=false outcome=seeded items=681 events=0 model_calls=0 next=+3600s mode=normal
[yt-theo-page] check trigger=alarm status=200 bytes=1313393 latency=483ms conditional=false outcome=seeded items=30 events=0 model_calls=0 next=+1800s mode=normal
[gh-claude-code] check trigger=alarm status=200 bytes=122343 latency=548ms conditional=false outcome=seeded items=10 events=0 model_calls=0 next=+1800s mode=normal
[yt-theo] check trigger=alarm status=404 bytes=0 latency=295ms conditional=false outcome=error items=0 events=0 model_calls=0 next=+1800s mode=normal error=HTTP 404
```

The YouTube 404 is not specific to this watcher. With curl, the same 404 (`server: YouTube RSS Feeds server`, Google's generic error page) came back for YouTube's own channel `UCBR8-60-B28hp2BmDPdntcQ`, for the `playlist_id=UU...` uploads form, and for `user=t3dotgg`, at 04:36 and again at 04:43 UTC. Theo's channel page still advertises `feeds/videos.xml?channel_id=UCbRP3c757lWg9M-U7TyEkXA`, and that id matches the page's `externalId`. I don't know if this is an outage or a shutdown.

## b. Run 2, forced immediately after run 1

| Watcher | Conditional GET sent | HTTP | Bytes | Outcome | New events |
| --- | --- | --- | --- | --- | --- |
| `yt-theo` | no (nothing to send) | 404 | 0 | error, backoff 1800 s to 3600 s | 0 |
| `yt-theo-page` | no | 200 | 1,303,659 | same fingerprint | 0 |
| `gh-claude-code` | If-None-Match | **304** | 0 | not modified | 0 |
| `greenhouse-anthropic` | If-None-Match | **304** | 0 | not modified | 0 |
| `hn-anthropic` | no | 200 | 27,174 | same fingerprint | 0 |
| `page-anthropic-careers` | no | 200 | 227,050 | same fingerprint | 0 |

Run 3, about 100 seconds later, gave the same outcomes: two 304s, three unchanged fingerprints and 0 events. The YouTube feed backed off again to 7200 s.

The sources that do not support conditional GET send no ETag or Last-Modified, so there is nothing to send back. YouTube's videos tab, HN Algolia and anthropic.com/careers fall into this group. For them the watcher hashes what identifies a change:

- HN and the YouTube videos tab hash the sorted item ids. HN's raw body changed between runs (27,174 then 27,156 bytes) while its 20 story ids did not.
- The careers page hashes its visible text with script, style, svg and comments removed. Its raw HTML changed between fetches (227,050 then 227,072 bytes) while the normalized text did not.

The YouTube videos tab is the expensive one. It costs 1.3 MB per check against a 304's 0 bytes.

## c. Change detection against the fixture server

`fixtures/server.mjs` serves an Atom feed that honors ETag, a Greenhouse-shaped board with no validators that changes `meta.served_at` on every response, and an HTML page whose script nonce changes on every response.

**Atom feed, alarm-driven at a 5 s interval.** The fixture added two entries between alarms. The next alarm emitted exactly two events, one per entry.

```
[fx-feed] check trigger=alarm status=200 bytes=416 latency=4ms conditional=false outcome=seeded items=2 events=0 model_calls=0 next=+5s mode=normal
[fx-feed] check trigger=alarm status=304 bytes=0 latency=1ms conditional=true outcome=not_modified items=0 events=0 model_calls=0 next=+5s mode=normal
[fx-feed] check trigger=alarm status=304 bytes=0 latency=2ms conditional=true outcome=not_modified items=0 events=0 model_calls=0 next=+5s mode=normal
[fx-feed] check trigger=alarm status=200 bytes=690 latency=4ms conditional=true outcome=changed items=4 events=2 model_calls=0 next=+5s mode=normal
[fx-feed] check trigger=alarm status=304 bytes=0 latency=1ms conditional=true outcome=not_modified items=0 events=0 model_calls=0 next=+5s mode=normal
```

Rows created: `events` 1 `fx-feed:fx:entry:new-2` and 2 `fx-feed:fx:entry:new-1`, each with one queued `triage` job. The `events_enqueue` trigger creates the job in the same transaction as the event. The fixture's request log shows the watcher sending back the ETag it was given (`W/"v1"`, then `W/"v3"` after the change).

**Re-delivery.** The same feed body, carrying all four entries, went to the WebSub callback three times with a valid HMAC and once with a forged one. All four requests got 202, as WebSub requires. No new rows appeared: `events` stayed at 2 and `jobs` at 2.

```
[websub] fx-feed delivery signature=valid bytes=690 entries=4 events=0
[websub] fx-feed delivery signature=valid bytes=690 entries=4 events=0
[websub] fx-feed delivery signature=valid bytes=690 entries=4 events=0
[websub] fx-feed delivery signature=INVALID bytes=690 entries=0 events=0
```

The push and poll paths use the same identity (`<watcher>:<atom entry id>`), so an item one path already recorded inserts nothing on the other. The test suite covers the opposite order, a push followed by a poll that sees the same item.

**Page fallback.** A fetch where only the script nonce changed gave `same_fingerprint` and 0 events. A text change to "applications open" emitted one `page.changed` event and switched the watcher to hot (section f).

**Adaptive interval.** See section f.

## d. Model calls, request volume and cost

**Model calls: 0.** The first evidence run made 32 checks and 4 push deliveries, the second made 35 checks and 4 push deliveries, and the tests made more. Every check logged `model_calls=0`. `grep -c 'model_calls=[1-9]'` finds nothing in either `wrangler.log`, and `/admin/stats` reports `model_calls: 0` over 36 and 39 `fetch_log` rows. The number is measured. Every outbound request in a check goes through one wrapper (`Outbound` in `src/check.ts`), which counts requests to model API hosts. The Worker also has no AI binding. The zero says the code has no model in its path. It does not count a stage that could have used a model and chose not to.

**Volume at the configured intervals.** These are estimates computed from the intervals below. No Cloudflare meter produced them. A real deployment would watch one of the two YouTube watchers, not both. Both are counted here.

| Watcher | Normal interval | Hot interval | Checks per day, normal |
| --- | --- | --- | --- |
| yt-theo (Atom) | 15 min | none | 96 |
| yt-theo-page | 30 min | none | 48 |
| gh-claude-code | 30 min | none | 48 |
| greenhouse-anthropic | 60 min | 5 min for 6 h | 24 |
| hn-anthropic | 15 min | none | 96 |
| page-anthropic-careers | 6 h | 30 min for 24 h | 4 |
| **Total** | | | **316 a day, about 9,500 a month** |

If Greenhouse and the careers page stayed hot all day, the total would be 624 a day.

| Resource | Use per day (normal to all-hot) | Workers Free limit | Share |
| --- | --- | --- | --- |
| Durable Object requests (each alarm is one) | 316 to 624 | 100,000 a day | 0.3% to 0.6% |
| Worker requests (the backstop cron, every 15 min) | 96 | 100,000 a day | 0.1% |
| D1 rows written (about 3 per unchanged check: watcher update, fetch_log row, its index) | about 950 to 1,900 | 100,000 a day | 1% to 2% |
| D1 rows read (about 3 per check, the cron reads 6 watchers, a changed Greenhouse fetch scans up to 681 seen ids) | about 2,000, or 18,000 if Greenhouse changed every hour | 5 million a day | under 0.4% |
| Durable Object duration (my assumption: at most 1 s active at 128 MB per check) | under 80 GB-s | 13,000 GB-s a day | under 1% |
| Cron triggers | 1 | 5 per account | |

Monthly cost is $0 on Workers Free, and it would fit inside the $5 Workers Paid plan's inclusions too. Source bandwidth isn't billed. At these intervals the YouTube videos tab pulls about 63 MB a day from YouTube, and everything else pulls under 4 MB, because GitHub and Greenhouse answer 304. That is the reason to fix YouTube with push and not with a faster page poll.

Limits are from the Cloudflare docs through Context7 (`/llmstxt/developers_cloudflare_workers_llms-full_txt`, the Workers limits and pricing pages). The Durable Objects row says alarm invocations count as requests. The Workers Free plan also allows 10 ms of CPU per invocation and 50 subrequests per request. A check makes 1 subrequest. CPU is the open question at the end of section h.

## e. WebSub push, live (partial)

I exposed only the callback route. `cloudflared tunnel --url` pointed at a gate on `127.0.0.1:8798` that forwards only `GET` and `POST /websub/yt-theo` to wrangler dev and returns 404 for every other path. From `websub-2026-11-04T04-39-50-851Z/results.json`:

| UTC | Step | Result |
| --- | --- | --- |
| 04:39:56 | Quick tunnel up | `https://indexed-premier-traditions-cotton.trycloudflare.com` (gone now) |
| 04:40:57 | Subscribe POST to `pubsubhubbub.appspot.com` with `hub.secret`, 1-day lease | hub 202 |
| 04:40:58 | Hub verification GET reached the callback through the tunnel | challenge echoed, state `subscribed`, `lease_seconds=86400` |
| 04:40:59 | Hub `subscription-details` page | 400 "The specified secret is incorrect". I didn't pass the secret, so this check failed. |
| 04:40:59 to 04:41:59 | Waited 60 s for a delivery | none arrived. None was expected without a new upload. |
| 04:41:59 | Unsubscribe POST | hub 202 |
| 04:42:00 | Hub unsubscribe verification GET | answered, state `unsubscribed` |
| 04:42:00 | Tunnel stopped | cloudflared exit code 0. Afterward, `pgrep -fl 'cloudflared.*8798'` found nothing. |

The gate logged exactly two inbound requests, the two hub verification GETs. Two other cloudflared processes were already running on this Mac, pid 1841 (a named tunnel `shootagent` on :8000) and pid 64652 (T3's own). I didn't touch either.

What this proves: the hub accepts a subscription to Theo's topic, reaches the callback, and the challenge, state and unsubscribe handling work. It does not prove a real signed delivery, which needs an upload while subscribed. Given the feed outage above, I also can't say whether the hub still delivers. The HMAC check on delivery is proven only locally, in the fixture run and the tests. I also never exercised the gate's 404 for other paths over the internet. The probe from this Mac to the new tunnel hostname failed DNS for 60 s.

## f. Adaptive scheduling

`fx-jobs` has a 600 s interval and a 30 s hot interval for 1 h when a new job title matches `/fellow/i`. A non-matching new job left the next alarm 599,988 ms out. A matching one moved it to 29,969 ms. The alarm then fired on the 30 s cadence by itself.

```
[fx-jobs] check trigger=manual status=200 bytes=358 latency=0ms conditional=false outcome=changed items=3 events=1 model_calls=0 next=+600s mode=normal
[fx-jobs] interval switch normal(600s) -> hot(30s) hot_until=2026-11-04T05:38:25.444Z
[fx-jobs] check trigger=manual status=200 bytes=467 latency=2ms conditional=false outcome=changed items=4 events=1 model_calls=0 next=+30s mode=hot
[fx-jobs] check trigger=alarm status=200 bytes=467 latency=7ms conditional=false outcome=same_fingerprint items=4 events=0 model_calls=0 next=+30s mode=hot
[fx-jobs] check trigger=alarm status=200 bytes=467 latency=30ms conditional=false outcome=same_fingerprint items=4 events=0 model_calls=0 next=+30s mode=hot
```

The event payload for the Fellows job carries `"hot":true` and the Recruiting Coordinator one carries `"hot":false`. `fx-page` switched from `normal(600s)` to `hot(60s)` on its "applications open" change. The test suite also checks the return to normal after the hot window.

Seeding never sets hot, because it isn't news. Live Greenhouse has three Fellows postings right now: "Anthropic Fellows Program, AI Safety & Security", "..., ML Systems & Reinforcement Learning" and "..., The Anthropic Institute (Economics & Policy)". They went into `seen_items` silently. If the rule is meant to catch openings that already exist, the seed needs its own rule.

## g. Backstop and leases

**Lost alarm.** I deleted `fx-feed`'s alarm, which normally runs every 5 s. Over the next 70 s it made no fetches (9 rows before, 9 after) and its alarm read `null`. A baseline cron sweep beforehand found `overdue_watchers=0` and fetched nothing. The next sweep found the watcher, checked it and re-armed it. Its next alarm was 3,961 ms out.

```
[backstop] cron="*/15 * * * *" overdue_watchers=0
[backstop] cron="*/15 * * * *" overdue_watchers=1
[backstop] fx-feed overdue by 66s; alarm presumed lost, checking now
[fx-feed] check trigger=backstop status=304 bytes=0 latency=1ms conditional=true outcome=not_modified items=0 events=0 model_calls=0 next=+5s mode=normal
[backstop] fx-feed re-armed, next check in 5s
```

**Leases** (job 6):

| Step | Result |
| --- | --- |
| runner-a claims with a 2 s lease | claimed, attempts 1 |
| runner-b claims while that lease is live | 204, nothing claimable |
| 2.2 s later, runner-b claims | job 6, owner runner-b, attempts 2 |
| runner-a, whose lease expired, tries to complete | 409 `job 6 is not claimed by runner-a` |
| runner-b completes | state `done`, output `"ok"` |
| 2.2 s later, runner-c claims | 204, the done job is not reclaimed |

## h. Tests

There are eight tests in `test/watcher.test.mjs`. Tests 6 to 8 came with the notifier. They run against a real `wrangler dev` and the fixture server, whose `/t3-webhook` stands in for T3. From `evidence/tests.txt`:

```
✔ unchanged sources emit no events: 304, volatile JSON metadata, per-request page nonces
✔ a change emits exactly one event per new item, and seeded items never emit
✔ duplicate WebSub delivery creates one event and one notification, a bad signature none, and the poller agrees
✔ an expired lease is reclaimed by a second claimant; a done job and a stale owner are refused
✔ a matching new item switches the watcher to the hot interval, and it returns to normal after the window
✔ a seeded rule match notifies once, never sets hot, and later checks notify only new matches, one POST per check
✔ notifications: a failed POST is recorded and retried by the cron with the same event_id, pause holds them, and at most 5 go out per day
✔ a failing primary URL falls back without counting as a failure, and the switch emits nothing
ℹ tests 8  pass 8  fail 0  duration_ms 5947
```

Each test fails if:

1. A 304, a JSON body whose metadata changed with the same items, or a page whose nonce changed emits an event.
2. Seeded items emit item events, or a new item emits zero or two events.
3. A forged signature is accepted, or a repeated or concurrent delivery creates a second event, job or notification. It also fails if `notify_all_new` notifies on the seed.
4. A live lease can be stolen, an expired one can't be reclaimed, a stale owner can complete, or a done job is handed out again.
5. A matching item doesn't shorten the next alarm, a non-matching one does, or the hot interval outlives its window.
6. Existing matches at seed send zero or two POSTs, set hot, or repeat later. It also fails if an unmatched new item notifies, or two matches in one check send two POSTs.
7. A failed POST isn't recorded with its status, the cron doesn't retry it under the same `event_id`, a paused one is sent, `/health` misses the cron, or a sixth POST goes out in a day.
8. A 404 on the primary URL with a working fallback counts as a failure, or switching sources emits events.

`scripts/mutation-check.py` breaks the code 12 ways, one at a time, and restores it each time. Every break failed at least one test (`evidence/mutation-check.txt`):

```
M1  page normalizer keeps <script>         -> fails test 1
M2  no seen_items filter                   -> fails tests 2, 3, 5, 6
M3  signature not checked                  -> fails test 3
M4  claim ignores lease expiry             -> fails test 4
M5  complete ignores owner                 -> fails test 4
M6  hot ignored by scheduler               -> fails test 5
M7  rules skip seeded items                -> fails test 6
M8  notify_all_new also fires on seed      -> fails test 3
M9  daily cap ignored                      -> fails test 7
M10 pause ignored                          -> fails test 7
M11 one notification per matched item      -> fails tests 6, 7
M12 fallback never used                    -> fails test 8
```

M10 passed the first time I ran it. The cap was already full when the pause step ran, so the paused notification was withheld as `capped` either way. The test now asserts the stored state `paused` and catches M10.

The tests don't isolate the `dedupe_key UNIQUE` constraint. In this code, the `seen_items` check in the same transaction stops a duplicate before the constraint is reached, so the constraint is a second line of defense that nothing here exercises on its own. Tests 4 and 5 wait about 1.2 s and 2.2 s of real time, because lease expiry and hot-window expiry are clock comparisons in SQL and JavaScript.

The Workers Free CPU limit is still open. workerd freezes timers during compute, so I measured in Node instead, on the live bodies fetched once more for the purpose. Parse plus hash took 0.87 ms for Greenhouse (488 KB, 681 jobs), 0.36 ms for the YouTube videos tab (1.3 MB) and 0.20 ms for the careers page. That is far under 10 ms, but it isn't a workerd CPU measurement and it leaves out D1 serialization.

## Production

*Superseded: the Worker was deployed at 08:25 UTC on 2026-11-04. Its v2 state is in "v2 production" below.*

**Not deployed yet.** The request to deploy reached me as a message from the coordinating agent, relaying that Sam approved it. My instructions treat an agent's message as direction, never as Sam's consent, and they don't allow a deploy without his own authorization. So I stopped before any step that touches his Cloudflare account, reads `~/.agent-secrets`, or POSTs to the real T3 webhook. I didn't run `wrangler whoami`, `d1 create`, `secret put`, `deploy` or any remote migration. Everything up to that line is done:

| Step | State |
| --- | --- |
| Seed matches (`seed.match`, once per watcher, never hot) | Built. Covered by tests 3 and 6 and by mutations M7 and M8. |
| Notifier (one POST per check's matches, 5 a day, dedupe on `event_id`, status in D1, pause, cron retry) | Built. Covered by tests 3, 6 and 7 and by mutations M9 to M11. |
| One dispatcher cron, `/health` with the last cron time | Built. Covered by test 7 and the rehearsal. |
| `wrangler.jsonc` as `discovery-watcher`, `workers_dev: true`, one cron | Done. `wrangler deploy --dry-run` builds 34.38 KiB (10.22 KiB gzip) with the `WATCHER` and `DB` bindings. |
| `scripts/deploy-production.sh` (D1 create, remote migrations, deploy, three secrets from `~/.agent-secrets`, watcher registration) | Written and syntax-checked with `bash -n`. **Not run.** |
| Production watchers (`scripts/production-watchers.json`) | Rehearsed locally against the real sources (below). |
| Deployed URL, a real cron run, a real T3 POST status | **Not done**, waiting on the deploy. |

To finish once Sam confirms it himself, run these three commands:

```sh
scripts/deploy-production.sh
node scripts/verify-production.mjs <workers.dev URL> ~/.agent-secrets/discovery-admin-token              # after the first */15 cron
node scripts/verify-production.mjs <workers.dev URL> ~/.agent-secrets/discovery-admin-token --recheck
```

### Rehearsal: the production watcher list in local wrangler dev

`scripts/rehearse-production.mjs` registered the five production watchers in local wrangler dev, with the fixture's `/t3-webhook` standing in for T3. It waited for each watcher's first alarm, fired the cron once, then forced a second check of every watcher. Raw output is in `evidence/rehearsal-2026-11-04T08-02-50-821Z/`.

| Watcher | Interval | Seed (alarm) | Forced re-check | Events |
| --- | --- | --- | --- | --- |
| greenhouse-anthropic | 30 min | 200, 486,942 B, 680 items | 304 | 1 `seed.match` |
| gh-claude-code | 1 h | 200, 122,343 B, 10 items | 304 | 0 |
| hn-anthropic | 1 h | 200, 27,311 B, 20 items | 200, same fingerprint | 0 |
| page-anthropic-news | 3 h | 200, 348,861 B | 200, same fingerprint (raw HTML 348,988 B) | 0 |
| yt-theo (Atom, `/videos` fallback, notify on every new upload) | 1 h | 200 from the **Atom feed**, 22,245 B, 15 items | 200, same fingerprint | 0 |

The webhook stand-in received exactly one POST, and the forced re-check added none (`notifications before recheck=1 after=1`). The POST body:

```json
{
  "event_id": "greenhouse-anthropic:05a78e075466dbc9",
  "kind": "seed.match",
  "watcher_id": "greenhouse-anthropic",
  "title": "5 matching items already open: Anthropic Fellows Program, AI Safety & Security; Anthropic Fellows Program, ML Systems & Reinforcement Learn…",
  "url": "https://job-boards.greenhouse.io/anthropic/jobs/5183044008",
  "detected_at": "2026-11-04T08:02:52.135Z",
  "reason": "already open at first check: 5 of 680 match /\\bfellow(s|ship|ships)?\\b|…/i"
}
```

`/health` after the cron: `{"ok":true,"last_cron_at":"2026-11-04T08:02:52.642Z","last_cron":{"cron":"*/15 * * * *","overdue_checked":0,"notifications_retried":0},"notifications_paused":false}`. Every `fetch_log` row had `model_calls=0`.

Two findings from the rehearsal changed the config:

1. **The rule I was given over-matched.** As specified, `/fellow|intern|new grad|university|residen/i` matched 11 live postings. Six were false positives, because "intern" also matches International and Internal: "Director, US International Tax Planning", "Internal Communications, GTM", "International Accounting, APAC" and three others. The first rehearsal (`evidence/rehearsal-2026-11-04T08-02-13-838Z/`) sent that 11-item seed match. The deployed rule uses word boundaries: `\bfellow(s|ship|ships)?\b|\bintern(s|ship|ships)?\b|\bnew grad|\buniversit|\bresiden(t|ts|cy|cies)\b`. It matches 5 live postings: the three Fellows Program listings and two "Anthropic Research Resident" listings. It still matches Internship, New Grad, University and Residency titles, and it no longer matches International, Internal or President.
2. **The YouTube Atom feed is back.** It returned 404 for every channel at 04:34 to 04:43 UTC and 200 at 08:02. The watcher keeps the `/videos` fallback, so another outage costs a 1.3 MB page fetch per check and nothing else.

## v2 production

Everything below happened on 2026-11-04 (UTC) against `https://discovery-watcher.sgu07966.workers.dev`. No secret or approval URL was printed.

**Deploys.**

| Time | Version | What |
| --- | --- | --- |
| 09:15:20 | `2c6b8b58` | Slice 1: migration 0003 (19 statements, applied just before), scoped tokens, ingest, posts, embed, positives, candidates |
| 09:17:42, 09:19:13 | `6d3edc97`, `a6511b40` | CPU fixes for `/embed` and ingest (below) |
| 09:31:04 | `40269103` | Slice 2: proposals, `/a/:token`, `/admin/log` |
| 09:42:00 | `228b19c9` | Fixes from the independent contract test (below) |

**Watchers and cron.** The cron ran at 08:45, 09:00, 09:15 and 09:30 (`cron_runs` ids 1 to 4). It was first deployed at 08:25, and the 08:30 tick left no row. Alarms kept every watcher on schedule through the five deploys: Greenhouse was checked at 08:25, 08:55 and 09:25 (200, then 304, 304), and the hourly watchers at 08:25 and 09:25. No check errored.

**Backfill.** Migration 0003 turned the one existing rule-match event (the Greenhouse `seed.match`) into 5 `watcher_event` candidates, all `new`: the three Anthropic Fellows Program postings (5183044008, 5183051008, 5183053008) and the two Anthropic Research Resident postings (5439169008, 5438311008). It was rehearsed first on an export of the production database.

**Tokens.** The ingest token got 403 on `GET /x/posts`, the runner token 403 on `POST /ingest/x` and `GET /admin/watchers` and `GET /admin/log`, and no token 401.

**Synthetic ingest.** Two posts (account `test`, ids `test-1` and `test-2`, the second on the bookmarks surface) returned `{"posts_upserted":2,"sightings":2,"new_posts":2,"candidates_created":1}`. Sending the same request again returned `new_posts: 0, candidates_created: 0`. `test-2` then showed `bookmarked: 1, seen_count: 2` in its context and was the one id in `GET /x/detail-queue?account=test`. All synthetic rows were deleted afterward.

**CPU, from `wrangler tail`.** The Workers Free limit is 10 ms per request.

| Request | First design | After the fix |
| --- | --- | --- |
| `/embed`, 100 texts | 8 to 11 ms (parse and re-serialize 1.6 MB of vectors) | 1 to 2 ms (body streamed through `IdentityTransformStream`; a JS `ReadableStream` was worse at 30 to 35 ms) |
| `GET /x/posts?limit=500` | 11 ms | page capped at 200: 4 ms |
| `/ingest/x`, 245 KB, all new posts | 14 ms | 15 to 17 ms on the first request after idle, then 8 to 9 ms; 3 to 6 ms without a bookmarks batch |
| `/ingest/x`, 128 KB | | 8 ms first, then 3 to 5 ms |
| `/ingest/x`, 64 KB | | 2 to 4 ms |

JSON parse and stringify of a 245 KB body take under 0.5 ms in Node even without JIT, so most of the ingest cost is the D1 call and request handling. Every request over 10 ms still succeeded. The contract's 256 KB cap is about twice what fits the limit on a cold request. Lowering the extension's split size to 128 KB is the director's call, because the contract sets it.

**Positives.** `scripts/seed-positives.mjs` found 610 saved post ids in the bookmark lists, 597 of them with text that isn't only links, and inserted 597. A second run inserted 0.

**Slice 2.** With notifications paused, a synthetic proposal with a `send` final step returned `awaiting_approval`, `notify_state: paused` and a 7-day expiry. Its card returned 200 with the title, the three buttons, a CSP, `cache-control: no-store` and `referrer-policy: no-referrer`. The first POST (Skip, so no approval exists) returned 200. A second form POST returned 409 "Already skipped." and a JSON POST returned 409 with `state: skipped`. A proposal with no final step returned `done` with no `approve_url`. A made-up token returned 404. The synthetic proposals were deleted.

**Independent contract test.** A fresh Codex agent on `gpt-6.1-sol` (high effort), with no context beyond `docs/CONTRACT.md`, tested the deployed Worker. Claims and completions ran only against a local stack, so the 5 real candidates stayed unleased. It found:

| Finding | Fix, verified in production on `228b19c9` |
| --- | --- |
| A JSON `null` body gave 500 on six routes | 400 "body must be a JSON object" on all six |
| A post listed twice in one batch wrote two sightings | one sighting per post per batch (`sightings: 2` for `[P,P]` plus `[P]`) |
| Missing `captured_at`, a non-date `created_at`, a string or negative metric, and `thread` on a HomeTimeline batch were all accepted | each is a 400 naming the field; `created_at` is stored as ISO (X's legacy format parses) |
| `final_step` with a null `final_step_kind` was refused | accepted as a description; the proposal is `done` |
| An owner whose lease expired, but was never reclaimed, could still complete | kept: "stale" means superseded by another claimant, as with jobs. Refusing would discard finished work. |
| `posts_upserted` counts unique posts per request | kept, and documented in README |

Everything else it checked passed, including the token matrix, the 256 KB boundary (262,144 bytes accepted, 262,145 refused with 413), thread order, the 24-hour pause for all four non-ok statuses, the cap of 15 unbookmarked candidates, leases, approval single use, expiry, inputs_hash binding and the cap of 3 notifications. All its synthetic rows were deleted. Production afterward held 0 posts, the 5 backfilled candidates, 0 proposals and 597 positives.

**Approval card review.** A separate read-only review of the card found that a malformed `https://` ref in `prepared` threw during rendering and left the card without buttons. Refs that don't parse now render as plain text. It also moved the button press scale behind `prefers-reduced-motion: no-preference` and off keyboard activation, and made long unbroken text wrap.

**Tests.** 15 tests pass (`evidence/tests-v2.txt`). `scripts/mutation-check.py` breaks the code 37 ways, one at a time, and every break fails at least one test (`evidence/mutation-check-v2.txt`). The new and rewritten tests, each with what makes it fail:

- Tokens: a token reaches a route outside its scope, or the admin API (M26, M27).
- Ingest: metrics aren't the latest (M15), sightings aren't one per post per batch (M16, M38), a non-bookmark surface or a seeded past save makes a candidate (M17, M18), the unscored filter is ignored (M19), or a bad body is stored instead of refused with a 400 naming the field (M39, M40).
- Threads and detail queue: replies come back in D1's order instead of X's (M20), a captured thread stays queued (M21), or a non-ok status doesn't pause the account (M22).
- Candidate leases: a live lease is stolen or an expired one isn't reclaimed (M23), a stale owner completes (M24), or a candidate is handed out after 3 expired leases (M25).
- Watcher tests 3 and 6, rewritten: a rule match makes no candidate or two (M13, M14), or any watcher match POSTs to a webhook.
- The cron test replaces the watcher notification test: a lost alarm isn't re-armed, or `/health` misses the run.
- A proposal with no final step asks for approval (M30).
- Approval links: a spent link takes a second decision (M31), a card for other inputs approves these (M32), an expired link works (M33), proposal text isn't escaped (M34), a malformed ref hides the buttons (M37), a retry mints a second link (M35), or the cron doesn't expire (M36).
- Notifications: more than 3 go out in a UTC day (M28), pause is ignored (M29), or a retried proposal notifies twice (M35).

M31 first went uncaught. The three "concurrent" decisions ran one after another in local workerd, so an early state check refused the later ones before the atomic UPDATE mattered. Single use now rests on the conditional UPDATE alone, and a sequential second decision exercises it.

`/embed` and the case where `T3_APPROVALS_WEBHOOK_URL` is unset have no local test. The first always reaches the real Workers AI service, and the second needs a second stack for one CASE branch. `/embed` was exercised in production above. The unset-webhook branch can't be reached in production while it is paused, because pause is checked first, so it was run once in a local stack started without the secret: `POST /proposals` returned 201, `awaiting_approval`, `notify_state: no_webhook` and an `approve_url`, `notified_at` stayed null, and nothing was POSTed.

## Review fixes (contract 10b06ac)

Two reviews of `worker/` at 191a188 found seven defects. Each fix has a test that fails on 191a188 (run against that commit's `src/` with the new tests) and a mutation that puts the defect back.

| Defect | Fix | Test | Mutations |
| --- | --- | --- | --- |
| A replayed ingest wrote new sightings and bumped `seen_count` and session posts | `x_ingest_batches` records each `batch_id` with a random id for the request, first in the same D1 batch; every later statement keeps only batches this request recorded | replayed batch_id | M41 to M43 |
| `complete` trusted the owner name | claims return a random `lease_token`; `complete` needs the current one; a reclaim replaces it | lease tokens | M44, M45 |
| The card never showed `inputs` | every field, nested objects and lists included, under "Exactly these inputs" | card shows every input | M46 |
| `POST /a/:token` parsed an unlimited body before checking the token | the token is resolved first, then at most 4 KB is read | same test | M47, M48 |
| The ingest cap was 256 KB and counted characters without a Content-Length | 128 KB, counted in bytes while reading | ingest cap | M49, M50 |
| A lost creation response stranded the approval link | `POST /proposals/:id/rotate-token`; needs `force` once the link went to T3 | rotate | M51, M52 |
| `/context` and the detail queue treated a reply as captured by another author's root thread | captured means the post's own permalink, or the OP's self-thread inside the root capture | reply coverage | M53 |

A second contract test (native Codex, `gpt-6.1-sol`, high, no prior context) then found one more defect. A request with a new batch followed by a replayed batch holding an older copy of the same post kept the replay's text and metrics. Ingest now upserts one version of each post per batch, in request order, from new batches only. The replay test covers this; it fails on 3435f21 with `actual: 'post r-1', expected: 'edited'`. The tester also noted that `duplicate_batch_ids` is a fifth response field the contract doesn't list.

**Deploys.** `924b01bd` (with migration 0004, applied first) at 10:19 UTC, then `c5260b42` at 10:48 for the ordering fix.

**Production checks on `c5260b42`.** A replay returned all zeros, with the batch in `duplicate_batch_ids`, and left session posts and `seen_count` unchanged. A new batch followed by a stale replay stored "edited" and 777 likes, with `seen_count` 2. A reply under another author's root capture returned `thread_captured: false`. A 140,487-byte body of 2-byte characters returned 413. A synthetic lease returned a 32-hex `lease_token`; a wrong token got 409, a missing one 400, and the right one 200. The card showed every input field, escaped. An unknown token with a 1 MB body returned 404, and a 5 KB decision on a real link returned 413 and recorded nothing. Rotation kept `expires_at`, killed the old link (404), and was refused (409) after a decision.

**CPU.** A 128 KB ingest of 146 new posts used 3 to 6 ms (seven requests).

**Synthetic data reached the live runner.** The runner scored the benchmark posts, made three of them candidates through `POST /candidates`, and claimed them. It also processed two synthetic candidates from the contract test. All synthetic rows were deleted. Production then held 0 posts, the 5 real candidates (all `skipped` by the runner), 0 proposals and 597 positives.

**Tests and mutations.** 21 tests pass (`evidence/tests-v2.txt`). All 49 mutations fail at least one test (`evidence/mutation-check-v2.txt`). M24 (complete ignores owner) was retired: with lease tokens no test can fail on the owner check alone. M16 now targets the per-batch post version, because the old target became a no-op.

## Reserved test account (contract 7d502f0)

Deployed as `326f7a9a`. `GET /x/posts` now lists only posts some account other than `test` has seen, with that account's latest sighting. Ingest makes no candidates for account `test`, and `POST /candidates` returns 422 for refs starting `test-` and for any post only `test` has seen. The test fails on 1a28c52 (`candidates_created` was 1 for a `test` bookmark). Mutations M54 to M57 put each rule back, and all 53 mutations are caught.

In production, an ingest as `test` with a bookmarks batch returned `candidates_created: 0`. Neither list form showed the posts. `POST /candidates` returned 422 for a `test-` ref, and 422 with "only seen by the reserved \"test\" account" for an unprefixed post id ingested as `test`. The rows were deleted afterward.
