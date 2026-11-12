# Collecting X saves and their context: direct fetch, computer use, GrokBot

Sam asked whether X saves and their context can be collected more efficiently than by a model driving Chrome. This compares the three ways on what ran on @sdotgu on Nov 12, 2026: fetch mode (the extension issuing X's own GraphQL reads from the signed-in tab, [X-DIRECT.md](../X-DIRECT.md)), computer use (Codex driving Chrome: the archive's Phase 1 bookmark capture and its Phase 2 pilot), and GrokBot, which has not run. Data is a snapshot at 20:30 UTC; the archive lead's fetch queue is still running and is not counted past context-03b.

## Results

| | Direct fetch | Computer use | GrokBot |
|---|---|---|---|
| Bookmark list, 89 posts | 89 of 89, same order, 13.7 s, 5 requests | the reference list: 3 passes of about 3 min 51 s each | no data |
| Context, 7 saves both read: judged keeps found | 113 of 138 (82%) | 115 of 138 (83%) | no data |
| Context, 53 more saves | 776 of 790 keeps; the other 14 are posts quoted inside replies, which the judge added | not run | no data |
| Time per save (context) | median 38 s, 90th percentile 162 s, max 584 s (65 save runs) | 175 to 865 s; 68 min for 7 saves | no data |
| Posts per minute of wall time | 70 across the queue, rate waits included (8,665 posts in 123 min) | about 17 (about 1,180 posts in 68 min) | no data |
| Model tokens | 0 | 25.7 M input for the 7 pilot saves; 20.1 M for Phase 1 (list, post detail and media) | quota, unmeasured |
| X back-off signals (429, code 88, login wall, challenge) | 0 in 2,234 requests | 0 | no data |
| Waits the collector imposed on itself | 8 waits, 60 min, to keep 30% of X's TweetDetail budget free | none needed | no data |
| Interventions | 0 on X; 3 around the fetch page's file saving (below) | Phase 1: 0, the agent recovered 3 UI faults itself | no data |

"Judged keeps" are the posts the archive's judge kept as worth having (`archive/2026-11-12/context/judged/<save>.json` on `x-bookmarks-eval` branch `x-archive-2026-11-12`, at `5a25d5a`). A collector "found" a keep when the post is in its output for that save. Only the 7 pilot saves were read by both methods. On the other 53, fetch mode was the only collector, so its 776 of 790 is not an independent check.

### Where each method missed on the 7 shared saves

Together the two found all 138 keeps. Each missed about a sixth that the other found.

- **Computer use missed 23**, mostly quote posts. X's `/quotes` page showed "this page doesn't exist" for every save the pilot opened. Fetch mode finds quotes through a `quoted_tweet_id:` search (Kino 9, shadcn 5, Mia 3, paradite 3, Mollick 2, corbtt 1).
- **Fetch mode missed 25**, and 16 of those are on one save. Emil's post (`2120252783953871317`) is a reply, and the pilot read the whole conversation of the post it replies to (86 replies). Fetch mode fetches that parent but not its replies. Mollick's essay lost 7. Four were replies and branches that run 2 didn't reach under its limits of 30 requests and 6 branches per post. Three came from the pilot's link and mention searches, which read past the first page of results; fetch mode can't load a second page because X refuses replayed searches. shadcn lost 2 keeps from the pilot's link search.

Run 2 used the 30-request cap. The queue later ran with 80, which 1 of 60 saves reached.

### Context at scale (fetch mode only)

Files context-01, 01b, 02, 03a and 03b, plus gap-branches-01, covered 60 saves in 1,889 requests over 123 minutes, 60 of them rate waits. The Relevance and Recency orders both reached their end on all 60 saves. 13 saves had more reply branches than the 15-per-post limit, 284 in all. The archive lead's gap-branches files fetch those: gap-branches-01 read 105 of them in 235 requests and 15 minutes.

On 48 of 60 saves, fetch mode collected at least as many reply ids as X's reply count (median ratio 1.14, since nested replies count too). The other 12 have both orders exhausted and are still short, 1,016 ids in all, mostly on four posts with 588 to 1,085 replies. X's count includes replies its views don't show this account (deleted, protected, withheld). No page check was made, so whether X's page shows any of the missing ones is open.

### Interventions and failures

- **Fetch mode, on X:** none. Two non-200 answers in the whole day, both run 2's replayed `SearchTimeline` (HTTP 404), which is why search now loads X's own search page instead. Gaps between requests were never under 1,503 ms.
- **Fetch mode, around it:** the fetch page has no scheduler; a person or a script presses Start and saves the bundle. I drove it with a UI driver (`cua-driver`). Three events came from that, none from X:
  - Chrome's Save As once ignored the file name, so Windows asked to overwrite. I answered No and downloaded again.
  - A duplicate download was cancelled.
  - The driver's daemon stopped at the harness's 2-hour limit for background commands. The archive lead took the queue over with a PowerShell UI Automation runner.

  A daily run that posts to the Worker needs none of this, since it never shows a Save As dialog.
- **Computer use:** Phase 1 recovered by itself from an unavailable Codex Chrome backend, a scroll that didn't return to the top, and a click with no geometry (`capture-report.md`). The pilot read 7 of its 10 saves before Chrome was handed over. On Oct 26, on the same Zephyrus, round 1's computer use needed 4 lead interventions and lost about 25 of 49 minutes to a screensaver, a Snipaste pin and a passkey dialog (`results/RESULTS.md`, main branch).

## GrokBot: not measured

There is no GrokBot data: it has not been bought, and its routine has never run. Round 2 (`x-bookmarks-eval/round2/EVAL-SPEC.md` on the MacBook) measures it over a week against the extension for daily bookmarks and the home feed. That week answers the daily question. It doesn't say whether GrokBot's public X tools reach the same context as the two collectors above. Once Sam has GrokBot:

1. Do round 2's `SETUP.md` steps 2 and 3: connect the X connector with every write permission off, buy X API credits if he chooses, paste `round2/grokbot-routine.md` as a daily routine with the inbox key, and record the day-0 bookmark boundary.
2. Once, in a new GrokBot chat, send the text below with the same key. It reads the 7 shared saves the way the pilot did, in the inbox format the daily routine uses, and it names no comparison, following round 2's blinding rule.

   ```text
   Once, now: file the conversation around these 7 X posts into my reading inbox, the same way and in the same format as my daily X routine, with run_id "2026-11-12-context-once".
   Posts: 2119124661443457189, 2120252783953871317, 2119879610724720702, 2119930229661503893, 2120494222516339134, 2119870150845599972, 2115876931749200320.
   For each post, using your built-in public X tools: its self-thread; every reply X shows, in the order X shows them, including replies to replies (up to 500); every post that quotes it (up to 150); and posts that contain a link to it or to the links in it (up to 100). If the post is itself a reply, also collect the replies to the post it answers, as relation "reply" under the same thread_root_id.
   Read only: never post, reply, like, repost, follow, bookmark or message. Every item is a "thread" item with thread_root_id set to the post above it belongs to.
   ```
3. Export what reached the Worker (`GET /admin/inbox/x`, or `round2/harness/export.py`) and score it against the same judged keeps:

   ```sh
   node extension/tools/x-direct-score-judged.mjs \
     --judged <x-bookmarks-eval>/archive/2026-11-12/context/judged \
     --bundle <run2-bundle.json> --bundle <run3-bundle.json> \
     --grokbot <grokbot-export.json>
   ```

   Also record GrokBot's quota share for the run and the X credits spent.

## Recommendation for the daily pipeline

1. **Collect with fetch mode, posting to the Worker.** About 3 new bookmarks a day on @sdotgu (48 between Oct 26 and Nov 12) need 1 or 2 Bookmarks requests, about 50 to 170 TweetDetail requests at today's median of 17 and 90th percentile of 57 per save, and one quote-search page each. That fits inside one 15-minute window (X allows 300 TweetDetail requests; the run keeps 30% free) and takes 2 to 8 minutes with no model. The equivalent computer-use work is about 10 minutes and 3.7 M input tokens per save.
2. **Close fetch mode's two gaps first.** Walk the conversation of the post a save replies to (16 of fetch mode's 25 misses on the shared saves), and keep the per-post cap at 80 or more (1 of 60 saves reached 80).
3. **Give it a trigger.** The fetch page runs only when someone presses Start. lens-v1's hourly re-poll already opens the fetch page in a background tab from an alarm (`extension/app/background.js` on `lens-v1`). A daily job with the last bookmark as its boundary can use the same path. That isn't built.
4. **Keep computer use as the fallback** for when fetch mode stops on a query-id or header change, which it reports and doesn't work around. Also use it for pages fetch mode can't load, such as second pages of searches, if those matter for a save.
5. **Decide on GrokBot after the steps above.** It is the only option that runs while Sam's Chrome is closed, and its bookmarks come through X's official API (X API credits), which fetch mode's GraphQL reads don't. Fetch mode carries the terms-of-service exposure described in [X-DIRECT.md](../X-DIRECT.md#risks); there is no evidence either way on how X treats it at this volume.

## Rerun

```sh
# Pilot saves, both collectors, against the judged keeps
node extension/tools/x-direct-score-judged.mjs \
  --judged <x-bookmarks-eval>/archive/2026-11-12/context/judged \
  --bundle run1-bundle.json --bundle run2-bundle.json --bundle run3-bundle.json
```

The bundles are in `C:\Users\sgu07\.xbe-session\xdirect\` on the Zephyrus. Per-run figures (requests, waits, statuses, gaps) come from each bundle's `ledger` and `rateWaits`. Per-save time and requests come from `context.<id>.wallMs` and `detailRequests`.
