# X capture extension

A Manifest V3 extension for Helium (or any Chromium) that copies posts out of X's own web responses in Sam's logged-in browser and sends them to the discovery Worker (`POST /ingest/x`, see [docs/CONTRACT.md](../docs/CONTRACT.md)). It never writes anything to X.

The loadable extension is `app/`. The rest of this folder is tests and this file.

## What it captures

X's web app loads posts through GraphQL. A script in the page wraps `fetch` and `XMLHttpRequest`, copies the response of these operations, and leaves the request and response untouched:

| Operation | Surface |
| --- | --- |
| HomeTimeline | home_for_you |
| HomeLatestTimeline | home_following |
| Bookmarks | bookmarks |
| TweetDetail | detail |
| SearchTimeline | search |
| UserTweets, UserOriginalsTimeline, UserRepliesTimeline | profile (sent as op `UserTweets`) |
| ListLatestTweetsTimeline | list |

X retired `UserTweets` in August 2026 for the `User*Timeline` operations, so those are captured too and reported under the contract's `UserTweets` op.

The service worker turns each response into one contract batch:

- Every post becomes the contract's normalized post. The text comes from `note_tweet` when the post is long, and posts behind a `TweetWithVisibilityResults` wrapper are unwrapped.
- `position` counts down the whole feed on that page load, so the 30th post on the second page has position 29.
- Quoted and reposted originals go in the same batch at the position of the post that carried them. Bookmark batches are the exception, because the Worker marks every post in one as bookmarked.
- Ads, cursors, who-to-follow cards, deleted posts and visibility-limited entries without a result are skipped.
- On a permalink (TweetDetail), the batch also carries `thread`. `root_id` is the permalink's post. `op_self_thread_ids` is that post plus every post by the same author linked to it by `in_reply_to`: the earlier posts it continues and the continuations below it. `reply_ids` is every other post in the conversation, in X's order. Each later page of the permalink sends the thread so far, because the Worker overwrites the thread row.

If a response lacks a field the contract needs, or has an entry type the parser does not know, the whole response is dropped and the popup shows the error. The parser never fills in a guess. X changes these payloads without notice, and a loud failure is easier to fix than months of wrong rows.

Batches wait in `chrome.storage.local` until the Worker accepts them, so a closed browser or an offline Worker loses nothing. They are packed into requests of at most 128 KB, the contract's cap. A larger batch is split by posts, and the thread goes on its last piece.

## Modes

The popup has three modes.

- **Passive** (default). Whatever Sam scrolls himself is captured with `mode: "passive"`. All passive captures from one day share one `session_id`.
- **Active**. Passive capture, plus a read-only session at most every 3 hours with up to 20 minutes of random delay.
- **Off**. Nothing is captured and no session runs.

"Run session now" starts a session right away in Passive or Active mode.

## An active session

1. It opens an unfocused window on `https://x.com/home` and selects For You if it is not selected.
2. It scrolls about one screen every 2 to 4 seconds, for at most 40 screens or 6 minutes.
3. It opens `/i/bookmarks`. If X moves that page under `/i/history`, it selects the Bookmarks tab. It scrolls until it reaches a bookmark already sent (the newest 200 sent ids are kept locally) or for 15 screens.
4. It asks `GET /x/detail-queue` for up to 5 post ids and opens each permalink, scrolling its replies for up to 4 screens.
5. It closes the window and reports `POST /ingest/x/status`.

It checks the page after every screen. On a login wall, a rate-limit or "limited" message, a challenge or CAPTCHA, or a GraphQL 429 (or X error code 88), it stops, reports `login_wall`, `rate_limited`, `challenge` or `error`, and pauses sessions for 24 hours. It also honors the `pause_until` the Worker returns. A rate limit seen while Sam browses also pauses sessions and is reported once. Closing the session window, pressing Stop in the popup, or a service-worker restart ends the session with status `ok` and the reason in `detail`, since X did not ask anything to back off.

## Read-only guarantee

Session code can do three things to X: open a URL it built, scroll, and click one of two tabs. The code enforces this in four places.

- `app/lib/xurl.js` is the only source of URLs. `navigate()` and `openWindow()` in `app/lib/session.js` refuse any value that module did not build. The detail queue supplies ids only, and an id must be all digits before it goes into `https://x.com/i/status/<id>`.
- `app/content/page-agent.js` is the only code that runs inside a session page. Its command table has `inspect`, `scroll` and `click`, nothing else. It has no command that types, submits, focuses an input or clicks an arbitrary element.
- `click` takes the id of an entry in a frozen `CLICK_TARGETS` table, either `for_you` or `bookmarks`. The element must be a `role="tab"` inside a tablist with the right label or link, on the right page, and exactly one element may match. Then it must not be inside a post, form, button, label, link, dialog or menu, and neither it nor an ancestor may carry a like, repost, reply, bookmark, follow-menu, compose or login `data-testid`. Neither the page nor the Worker can add to that table.
- Sam's own tabs never receive the page agent. Content scripts there only copy responses.

Passive capture never acts on the page at all.

The page-to-extension channel is a detached DOM element handed over during `document_start`, before any X script runs. This differs from the brief's `window.postMessage` plus nonce: X's scripts can read every `postMessage`, and with it the nonce, which would let them forge captures. Captured text is treated as data. Nothing in the extension follows instructions found in a post.

## Install in Helium

1. Open `helium://extensions` (or `chrome://extensions`) and turn on Developer mode.
2. Click "Load unpacked" and choose `extension/app` (not `extension/`, whose `node_modules` Chromium refuses to load).
3. Pin the extension, open its popup, and under Connection paste the Worker URL (`https://discovery-watcher.<subdomain>.workers.dev`) and the ingest token from `~/.agent-secrets/discovery-ingest-token`. Press Save. The token field never shows the token again, only its last four characters.
4. Open x.com once while logged in. The popup's header shows the handle it read from X's side nav, and "posts sent today" starts counting.

Permissions are `storage`, `alarms` and `scripting`, with host access to `https://x.com/*` and `https://*.workers.dev/*`. A Worker on another host asks for access to that host when it is saved.

## Where state lives

All in `chrome.storage.local` of the browser profile, readable from the service worker console:

- `config`: `mode`, `workerUrl`, `ingestToken`, and optional overrides. `account` is the handle used when the side nav shows none. `intervalHours`, `jitterMinutes`, `homeMaxScreens`, `homeMaxMinutes`, `bookmarksMaxScreens`, `detailMaxPosts` and `detailMaxScreens` may be lowered but never raised past the limits above. `loadConfig()` clamps them.
- `outbox` holds batches not yet accepted. `stats` holds today's posts sent and parse errors.
- `lastSession`, `nextSessionAt`, `pauseUntil` and `lastProblem` back the popup.
- `sentBookmarkIds` and `lastAccount`.

Per-page feed offsets and permalink threads live in `chrome.storage.session` and clear when the browser closes.

## Pause or remove

- Choose Off in the popup to stop all capture, or Passive to stop scheduled sessions.
- Press Stop session in the popup to end a running session.
- To remove it, use Remove on the extension's card at `helium://extensions`. That also deletes its stored config, token and unsent batches.

## Tests

```sh
cd extension
npm install
npm test
```

- `test/capture.test.js` covers normalization, note tweets, the visibility wrapper, cursor and module entries, display order, quoted and reposted posts, the bookmark rule, loud failures, and self-thread versus replies across permalink pages.
- `test/batch.test.js` covers the 128 KB split.
- `test/page-agent.test.js` runs the click allowlist against real Chromium DOM. It must refuse a like button, including one dressed as the For You tab.
- `test/e2e.test.js` loads `app/` into a throwaway Chromium profile and deletes the profile afterward. Chromium resolves `x.com` to a local HTTPS server holding fixture pages and fails every other hostname, so the test cannot reach the real X. It checks passive capture through both `fetch` and XHR, a full session (pages visited, tabs clicked, thread sent, status `ok`), and that a login wall or a GraphQL 429 stops a session.

## Not yet checked against live X

The fixtures follow twitter-web-exporter's documented shapes, not a live capture. The first live run should check:

- that `/i/history` shows a `role="tab"` labeled Bookmarks (or linking to `/i/history/bookmarks`), and that its GraphQL operation is still called `Bookmarks`;
- that the unfocused session window keeps loading posts while other windows cover it. Chromium may treat a fully covered window as hidden and slow its timers;
- that the popup header shows the right handle.
