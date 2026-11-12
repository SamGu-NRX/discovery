# Lenses

A lens is one X account that an agent reads for one interest, so that X's ranker learns the interest from the reading, and the feed it serves back can be measured. It has four parts:

- a one-sentence charter, such as "Agent harnesses: Claude Code, Codex, T3 Code, MCP, agent memory";
- a centroid: the mean embedding of about 50 exemplar posts that fit the charter;
- a reader in the extension, which skims the account's home feed at human pace;
- a scorecard computed by the Worker.

The first lens is "agent harnesses" on @_sgu_, Sam's test account.

## Why reading alone steers the feed

X's home ranker predicts engagement from what an account does, including signals no other account sees: how long a post stays on screen (dwell), which posts are opened, and which links are followed (github.com/xai-org/x-algorithm, the home-mixer parameters). Dwell is measured in the rendered page. So the steering pass has to be a real browser scrolling the feed at a person's pace, which is what a lens session is. A GraphQL fetch never renders anything and teaches the ranker nothing, so fetch mode only serves the open-and-read pass and the metric re-polls.

## What a lens session does

A lens session is the extension's active session, with every limit sessions already have: reservation with the Worker, the 24-hour pause after any back-off signal, request counting before a timeline appears, and minted URLs only. It runs on a browser profile whose popup names the lens.

1. It opens home and checks with the Worker that the lens belongs to the account X shows. A profile signed in to Sam's own account is never read as a lens by mistake. Captures carry `lens_id` only from this point on, and the Worker refuses a `lens_id` on any account but the lens's own. The lens reads For You only: X reopens home on the tab last used in the profile, selecting a tab would take a click, so a home that opened on Following ends the session (choose For You once by hand).
2. It takes posts in the order the home feed delivered them, 20 at a time, and asks the Worker to label each as skip, glance or open (`POST /lenses/:id/label`).
3. For each post it scrolls the post into view (`scrollToPost` in the page agent) and pauses for its label's dwell: about 1 s to skip, 4 s to glance, 20 s to open, each ±25% at random. The brief set these numbers; there is no measurement of X's dwell signal behind them. A post X has not rendered yet gets one more look 1.5 s later.
4. When it has read everything loaded, it scrolls a screen. It stops at 120 posts or 20 minutes (configurable, capped at 150 and 25), or after six screens bring nothing new.
5. It then opens the open-labeled posts with the highest taste, about one in ten of all posts read, on their permalinks for another 20 s each, where X shows them in full. That load also captures the post's first page of replies.
6. It sends its reads (`POST /lenses/:id/reads`). Its captured batches carry `lens_id`.

On a lens account the reader only reads. The page agent has no command that clicks, types, focuses or submits, so it cannot like, follow, bookmark or mark anything "Not interested", and it cannot follow a link either.

With "Next session records the baseline" ticked in the popup, the next session does the day-1 baseline instead. It scrolls home one screen every 2 to 4 s until it has the untouched For You top 100, sends those posts (`POST /lenses/:id/baseline`), and clears the tick.

## Labels

The Worker embeds each post (Workers AI `bge-base-en-v1.5`, the same model as `POST /embed`) and computes three interest parts:

- **taste**: cosine to the centroid.
- **novelty**: 0.5 if the lens has not seen the post before, plus 0.5 if the account does not follow its author. Follow state comes from X's user object (`relationship_perspectives.following`, else `legacy.following`) and is stored on each sighting as `author_followed`.
- **project**: the share of the lens's project terms the text names, with two or more counting as 1.

The action comes from a chat model when one is configured (`LENS_LABEL_URL`, an OpenAI-compatible endpoint, with `LENS_LABEL_MODEL` and an optional `LENS_LABEL_KEY` secret). Otherwise it comes from the centroid: open at or above `open_at`, glance at or above `glance_at`, skip below. The extension checks the answer again: a batch that does not label every post once with skip, glance or open ends the session with `lens_unavailable`, which pauses nothing, as does a Worker that cannot list lenses, label or take a baseline.

Both thresholds come from the exemplars. `open_at` is their median cosine to the centroid, and `glance_at` is their 10th percentile, so about nine exemplars in ten count as near. A model answer that does not name every post exactly once with a valid action is discarded, and the centroid labels the batch; the response says which labeler decided. The prompt marks post text as data, never instructions.

## Re-polls

Every open is a flag. The Worker schedules metric re-polls for it 1 h, 6 h, 24 h, 72 h and 7 d after the read. Once an hour the extension asks which posts are due (`GET /lenses/repolls/due`). If any are, it opens the fetch page in a background tab, which runs one TweetDetail per post through fetch mode with all of fetch mode's limits. The page then marks those posts done (`POST /lenses/repolls/done`) and closes. The new metrics arrive as ordinary sightings, so the Worker can compare views over time.

## Scorecard

`GET /lenses/:id/scorecard?vs=sdotgu` (runner token):

| Measure | How it is computed |
|---|---|
| purity per session | share of a session's reads with taste at or above `glance_at`, next to the baseline's share of its top 100 |
| lead ratio | for each flagged post with a sample 7 days or more after the lens account first saw it, views then over views at that first sighting; median |
| lead hours | for posts both the lens account and `vs` saw, hours between their first sightings, positive when the lens saw it first; median and the share positive |
| flag precision | share of flagged posts with a 7-day sample whose views grew 10 times or more |

## Setting one up

1. Store the exemplars as posts. They are any posts the Worker has ingested: bookmarks, captures or a fetch-mode run.
2. Create the lens (admin token). The answer reports the thresholds and any exemplar ids the Worker does not have; a lens needs at least 10.

   ```sh
   curl -X POST $WORKER/lenses -H "authorization: Bearer $ADMIN" -H "content-type: application/json" \
     -d '{"id":"harness","account":"_sgu_","charter":"Agent harnesses: Claude Code, Codex, T3 Code, MCP, agent memory.","exemplar_ids":[...],"project_terms":["T3 Code","MCP","Claude Code","Codex"]}'
   ```
3. In the lens account's own Chrome profile, open the popup's Connection section, enter the Worker URL, the token and the lens id, and tick "Next session records the baseline". Run a session. Afterwards, Active mode reads every 3 hours.

## Cross-lens signals

`GET /lenses/signals?account=&vs=sdotgu&ids=&limit=` (runner token) scores posts against every lens at once. Each row is a post any lens opened, newest read first, or a post named in `ids`. A row carries:

- each lens's taste, and whether it reaches that lens's near and open thresholds;
- which lenses opened it;
- when a lens account and `vs` first saw it, and the hours between;
- its views at the first and latest sample, which the re-polls add to.

A post near two lenses, or flagged by a lens before `vs` saw it, stands out in this table.

## Measured on captured posts (Nov 12)

No lens has run on a live account. These checks replay what fetch mode captured on @sdotgu: 10,142 posts from ten bundles, embedded locally with the same bge-base-en-v1.5 model (`scripts/local-embeddings.py`).

**Raw cosine scoring does not separate topics.** `scripts/lens-replay.mjs` and `scripts/lens-centering.py` used two test lenses.

- "harness": 38 Nov 12 saves that the archive tagged with harness topics.
- "design": 23 UI-design saves, picked by hand.

Every post's taste falls between about 0.67 and 0.84, so each lens's near threshold passes most of the corpus. All 50 top posts of each lens count as near the other lens.

Subtracting the corpus mean vector before the cosine fixes the separation:

| | Raw | Mean subtracted |
|---|---|---|
| Harness taste, 10th to 90th percentile | 0.675 to 0.786 | −0.338 to 0.349 |
| Posts near harness / near design | 54% / 80% | 5.3% / 1.6% |
| Posts near both lenses | 49.6% | 0.9% |
| Top 50 of each lens near the other | 50 / 50 | 21 / 21 |
| Held-out exemplars vs all posts, AUC (harness / design) | 0.69 / 0.64 | 0.94 / 0.97 |
| Held-out exemplars vs the other lens's, AUC | 0.64 / 0.81 | 0.85 / 0.75 |

The thresholds still come from exemplar percentiles. With the mean subtracted, they open 1% of these posts, not the 10% the reader aims for. These posts are reply threads around saves, not a For You feed, so the day-1 baseline is where the open threshold should be set. `lens.ts` does not subtract a mean yet.

**First charter, "agent harnesses".** The charter reads: "Agent harnesses: how Claude Code, Codex, T3 Code and other coding-agent harnesses are set up and run, including subagents and orchestration, model routing and effort, MCP tools, skills and instruction files, memory, sessions and long-running agents."

Its exemplars are the 32 Oct 26 saves whose archive findings carry a harness topic. Scoring therefore never sees the 170 Nov 12 saves it is checked on (`scripts/lens-score-saves.py`). Each save is scored on its post text, as the reader labels a feed post.

The gold is the archive lead's disposition of the 170 Nov 12 saves. 98 were kept as bearing on Sam's model and tool setup. 47 of the kept carry a harness topic.

| Mean subtracted | Labeled | Precision vs kept | Precision vs harness | Recall of harness |
|---|---|---|---|---|
| open (at or above open_at) | 17 | 0.94 | 0.82 | 0.30 |
| near (at or above glance_at) | 86 | 0.81 | 0.47 | 0.85 |

Without the mean subtraction, open labels 28 saves at precision 0.89 vs kept and 0.71 vs harness, and near labels 83 at 0.735 and 0.46. The AUC of harness saves against the rest is 0.83, against 0.82 raw.

Four of the seven harness saves the lens misses carry little or no post text: a bare mention, a link, a one-line reply. Their substance is in the quoted post or the linked page, which the reader does not see in the feed either.

## Not yet checked

- Nothing has run on a live account: @_sgu_ is not signed in on the Zephyrus yet. The tests use the fixture x.com and a stand-in model.
- The dwell numbers and the 10% open share come from the brief, not from measurement. Whether X's ranker responds to them, and how fast, is what the scorecard is for.
- The centroid thresholds have no calibration beyond the exemplars themselves.
