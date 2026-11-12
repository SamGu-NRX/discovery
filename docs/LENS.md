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

1. It opens home and checks with the Worker that the lens belongs to the account X shows. A profile signed in to Sam's own account is never read as a lens by mistake.
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

The action comes from a chat model when one is configured (`LENS_LABEL_URL`, an OpenAI-compatible endpoint, with `LENS_LABEL_MODEL` and an optional `LENS_LABEL_KEY` secret). Otherwise it comes from the centroid: open at or above `open_at`, glance at or above `glance_at`, skip below.

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

## Not yet checked

- Nothing has run on a live account: @_sgu_ is not signed in on the Zephyrus yet. The tests use the fixture x.com and a stand-in model.
- The dwell numbers and the 10% open share come from the brief, not from measurement. Whether X's ranker responds to them, and how fast, is what the scorecard is for.
- The centroid thresholds have no calibration beyond the exemplars themselves.
