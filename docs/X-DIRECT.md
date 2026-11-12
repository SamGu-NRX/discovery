# Direct fetch vs computer-use scraping (Nov 12, 2026)

Question: can the extension collect bookmarks and their context by issuing X's own GraphQL reads from the logged-in tab, instead of a model driving Chrome, and is that as complete and faster? The comparison uses the archive job's computer-use runs on @sdotgu the same day as ground truth (repository `SamGu-NRX/x-bookmarks-eval`, branch `x-archive-2026-11-12`). How fetch mode works is in [extension/README.md](../extension/README.md#fetch-mode).

## Results

### Bookmarks

Ground truth: Phase 1's list `archive/2026-11-12/lists/sdotgu.json`, 48 new bookmarks above boundary `2114348461835637076` plus 40 below it, verified PASS by a blind verifier. Fetch job: `bookmarks_until` boundary + 40.

| | Computer use (Phase 1) | Fetch mode (run 1) |
|---|---|---|
| Posts in window | 89 | 89 |
| Recall / precision | reference | 100% / 100% |
| Order | reference | identical (0 discordant pairs, boundary at 48 in both) |
| Wall time for the list | 3 min 51 s per pass, 3 passes (07:55–08:13 UTC) | 13.7 s, 5 requests |
| Model tokens | 20.1 M input (19.3 M cached), 46 K output for the Phase 1 thread, which also did post detail and media | 0 |

### Replies and Discover more

Pilot: the Phase 2 pilot collected 7 of its 10 saves by scrolling each conversation in Relevant and Recent order, opening reply branches, and clicking every "show more" row (`archive/2026-11-12/context/raw/<id>/views.json` at `e8dd46e`, ids only). Fetch: run 2, TweetDetail in Relevance and Recency order, every cursor followed, up to 6 branches per post, capped at 30 TweetDetail requests per post, plus run 3's `conversation_id:` search where a result's reply chain reaches the saved post. "Fetch" and "pilot" count distinct reply ids below the saved post; "missed" counts pilot ids fetch mode did not get. The paradite_ pilot row leaves out one branch the pilot opened on a Discover-more post (235 ids), which the pilot flagged itself.

| Save | X's reply count | Fetch | Pilot | Pilot ids fetch missed | Fetch requests | Wall, fetch / pilot |
|---|---|---|---|---|---|---|
| MiaAI_lab 2119930229661503893 | 160 | 184 | 188 | 4 | 30 | 61 s / 865 s |
| paradite_ 2120494222516339134 | 21 | 24 | 16 | 0 | 9 | 19 s / 465 s |
| emollick 2119870150845599972 | 252 | 180 | 213 | 35 | 30, capped | 63 s / 592 s |
| shadcn 2119879610724720702 | 72 | 75 | 65 | 0 | 9 | 22 s / 483 s |
| corbtt 2119124661443457189 | 15 | 15 | 15 | 0 | 6 | 11 s / 175 s |
| emilkowalski 2120252783953871317 | 3 | 3 | 3 | 0 | 4 | 7 s / 237 s |
| lukeigel 2115876931749200320 | 418 | 490 | 486 | 0 | 30, capped | 343 s / not recorded |

Counts can exceed X's own reply count because X counts direct replies only, and both methods also collect nested replies and the author's self-thread. Fetch mode missed nothing the pilot found on five of seven saves. On MiaAI_lab it missed 4 of 188: replies inside branches the pilot opened and fetch mode skipped, since it opens at most 6 branches per post and 13 more qualified. On emollick it hit the 30-request cap while still paging the Recency order and missed 35; a higher cap should close that gap, but there is no run with one yet. The three saves the pilot never reached: abderrahmen_g 2 of 1 (X's count), tobiadonadon_ 213 of 1,494 (capped), Voxyz_ai 35 of 37.

Discover more: fetch mode keeps X's recommendations apart in `related_ids`. They agree on corbtt (4 of 4). On paradite_ fetch mode has 4, the pilot 8, and 3 are shared. The other saves show none or one on either side.

The pilot used 25.7 M input tokens (25.3 M cached) and 34 K output over 68 minutes for its 7 saves, from its Codex session log. Fetch mode used none.

### Quotes, mentions and links

Fetch: run 3, one search page per query, first page of results only (X shows at most 20). Pilot: the `/quotes` page and `url:` searches in Latest and Top, read to the end or 100 results. Counts are distinct post ids; "both" is the overlap.

| Save | X's quote count | Quotes, fetch / pilot | Mentions and links, fetch / pilot / both |
|---|---|---|---|
| MiaAI_lab | 35 | 20 / 0 | 21 / 25 / 19 |
| paradite_ | 2 | 2 / 0 | 4 / 0 / 0 |
| emollick | 120 | 20 / 0 | 23 / 88 / 16 |
| shadcn | 14 | 12 / 0 | 52 / 76 / 28 |
| corbtt | 2 | 2 / 0 | 3 / 0 / 0 |
| emilkowalski | 0 | 0 / 0 | 4 / 1 / 1 |
| lukeigel | 139 | 20 / 0 | 7 / 0 / 0 |

- Quotes: every `/quotes` page the pilot opened rendered "this page doesn't exist", so the pilot has none; `quoted_tweet_id:` search through fetch mode found quotes on every save that has any, up to the first page of 20.
- Mentions and links: where the pilot read past the first page (emollick 88, shadcn 76) it found more than fetch mode's first page. Fetch mode has no second page because only replayed requests can follow a cursor, and X refuses replayed searches.
- Run 3 made 50 search page loads and 10 TweetDetail requests in 20 minutes, 11.5 of them waiting for the 30-loads-per-15-minutes budget. A page load took 4 to 32 s, median 6.7 s.

## What failed, and what was changed because of it

Each was found on the live run and has a test that fails on the old code.

- **The hook threw at load in Sam's Chrome** and captured nothing, passive capture included: another installed extension had already replaced `XMLHttpRequest` or `Request` with a subclass, whose prototype has no own `status` getter. The fixture tests never ran beside other extensions. The hook now looks the getters up the prototype chain (`extension/test/hook-foreign.test.js`).
- **Empty Top cursors.** X hands out a new Top cursor with every TweetDetail page, and following one returns only another. In run 1 that was 50 of 120 requests, and it used up the per-post cap. Top is now followed from a walk's first page only, and an empty page ends its line of cursors.
- **Replayed SearchTimeline answers 404.** Same query id, method (GET) and header names as the page's own search request, twice, while replayed TweetDetail kept working. Most likely X checks the `x-client-transaction-id` header per request on search; generating that header would mean reimplementing X's anti-automation signature, which fetch mode does not do. Searches now open the search page and take the first page of results X's own page loads (`searchVia: "page"`, at most 30 page loads per 15 minutes). Replay stays available as `searchVia: "replay"` in case X relaxes it.
- **The fetch page needed a passive capture first** to know the account. It now reads the handle from its own tab.

## Rate limits observed

X reports a per-endpoint budget per 15-minute window in `x-rate-limit-*` headers: TweetDetail 300, SearchTimeline 50. Run 2 waited 4.4 minutes at 90 of 300 remaining rather than spend the reserve, then continued. Across four runs on @sdotgu (348 requests: bookmarks and a stopped first context run, the context run, a 3-request search diagnostic, and the search run) there was no HTTP 429, no error code 88, no login wall, challenge or error page, and the extension never paused. Gaps between consecutive requests, outside rate waits, were at least 1.5 s, median 2.2 s.

## Risks

- **X's terms.** X's terms forbid accessing the service by automated means other than its published interfaces. Fetch mode is automation: it reads only Sam's own account's views, through his own session, at a human-scale rate, but it is not the official API, and a ToS-clean path for bookmarks exists (below).
- **Query-id and header churn.** Nothing is hardcoded, so a query-id change costs one page load. A stricter transaction-id check, as already happened for search, ends replay for that operation; the run then stops with a 404 rather than collecting bad data.
- **Rate limits.** The budgets above are per account and shared with Sam's own browsing. The run keeps 30% of each window and 20 of 50 searches free, but a long run still competes with the archive job's own Chrome work on the same account.
- **Account flags.** A pattern of hundreds of TweetDetail calls with no scrolling is visibly different from a person. Nothing flagged the account today, and there is no evidence either way about what X does at larger volume. Every X back-off signal stops the run and pauses the extension for 24 hours.

## Recommendation

- **Bookmarks: switch to fetch mode, or to the official X API.** Fetch mode reproduced the verified list exactly in 14 s with no model. The official API's bookmarks endpoint is the ToS-clean alternative; third-party summaries of X's pay-per-use pricing put own-data reads at $0.001 per post, so 100 bookmarks a day is about $0.10 ([twitterapis.com](https://www.twitterapis.com/twitter-api-pricing), [opentweet.io](https://opentweet.io/how-to/x-api-pay-per-use-explained); not checked against X's own pricing page). Choose the API if any ToS exposure on Sam's account is unacceptable.
- **Replies, threads and Discover more: switch to fetch mode.** It matched or beat the pilot on five of seven saves and missed 4 of 188 on a sixth, at 7 to 61 s a save (343 s for the 418-reply post) instead of 3 to 14 minutes, with no model tokens. Raise `detailCapPerPost` and `branchesPerPost` for big conversations; the binding limit is X's 300 TweetDetail requests per 15 minutes.
- **Quotes: fetch mode** (first 20). Computer use got none, because the quotes page did not render.
- **Mentions and links past the first page: not fetch mode.** Use GrokBot's built-in X search, or the official API's search at about $0.005 per post read (same sources), when a save needs more than 20. Recent search covers about 7 days, so older saves need full-archive search; how pay-per-use prices that is not established here.
- **Models only judge and synthesize.** Collection needs none: run 2 collected 1,250 posts with 0 tokens, where the pilot spent 25.7 M input tokens on 7 saves.
- **For the archive job's ~160 remaining saves**, the budgets set the pace, not the pacing gap: about 15 TweetDetail requests per save is about 2,400 requests, roughly 2 hours at 300 per 15 minutes with the 30% reserve; 7 searches per save at 30 per 15 minutes is about 9 hours, or about 4 hours with only quotes and the post-URL mentions. Run it in separate sittings, keep Sam's own browsing in mind, and stop at the first back-off signal, which the extension already does.
- **Discovery's passive capture needs the hook fix regardless.** In Sam's Chrome it captured nothing before it.

## Rerun

```sh
# Tests (Windows: npm test's glob does not expand, so name the files)
cd extension && node --test --test-timeout=240000 test/*.test.js
cd worker && npm test   # needs a POSIX shell; ran in WSL

# Live run: load extension/app unpacked in the signed-in Chrome profile,
# open the popup's "Fetch mode…", load a job file and press Start.
#   extension/jobs/x-direct-nov12.json          bookmarks + context, as run 1
#   extension/jobs/x-direct-nov12-context.json  context only, as run 2
#   extension/jobs/x-direct-nov12-search.json   searches, as run 3
# The bundle downloads when the run ends. Compare it:
node extension/tools/x-direct-compare.mjs --bundle <bundle.json> \
  --list <x-bookmarks-eval>/archive/2026-11-12/lists/sdotgu.json \
  --pilot <x-bookmarks-eval>/archive/2026-11-12/context/raw
```
