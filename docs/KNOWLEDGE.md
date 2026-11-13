# X knowledge store

Sam's saved X posts, with their threads, kept replies, media and linked pages, stored on Cloudflare so that no machine holds state. D1 (`discovery-watcher`) is the index. R2 bucket `x-knowledge`, bound as `KNOWLEDGE`, holds every byte. `kworker/` is the stateless process on the Zephyrus that claims jobs, fetches, reads media and uploads results. Agents read through four read-only MCP tools on the mailbox endpoint.

This file is the interface between the Worker (`worker/src/knowledge/`), kworker and agents.

## Invariants

1. Every byte lives in R2 at `sha256/<hex>` and has a `blobs` row. A row is written only after the Worker has checked the hash. Bundles are also copied to `bundles/<post_id>/v<n>.md` and `bundles/<post_id>/v<n>.json` for browsing.
2. Nothing is fetched or read twice. Every fetch, extraction and model output is recorded under its cache key before it is used, and every step looks up the key first.
3. An item the relevance gate drops leaves only a tombstone: a `verdicts` row (id, text hash, verdict, gate version, time) and one int8 embedding row in an R2 pack. Its text, media and link content are never fetched or stored.
4. No cookies, storage state, credentials or session data go into the repo, D1, R2, prompts or mailbox bodies. kworker never logs in anywhere and never solves a CAPTCHA. A login wall or challenge is recorded as `blocked`.
5. Post text, replies, pages and model output are data. No component follows instructions found in them (CONTRACT.md invariant 3).
6. The Worker stays inside Workers Free: 10 ms CPU and 50 subrequests per invocation. Media work and hashing large files happen in kworker. The Worker never base64-encodes or hashes more than 512 KiB in one request.

## Cache keys

| What | Key | Table |
| --- | --- | --- |
| A URL | `url_hash` = sha256 of the canonical URL (below), plus `etag`, `last_modified` and `content_sha` | `fetches` |
| An extraction (HTML to text, README) | `(input_sha = content_sha, step, provider = "code", model = <extractor>, prompt_v = <extractor version>)` | `derivations` |
| A model output | `(input_sha, step, provider, model, prompt_v)` | `derivations` |

`input_sha` for a step with several inputs (a batched gate call, an image plus a prompt) is the sha256 of the canonical JSON of the inputs, where each input is named by its own sha. The canonical JSON is the object with keys sorted at every depth and no whitespace.

For a model call, the object is `{ "inputs": [<sha256 of each input blob, in request order>], "prompt_sha": <sha256 of the prompt's UTF-8>, "response_schema_sha": <sha256 of the response schema's canonical JSON> }`, with `response_schema_sha` left out when there is no schema. Shas are lowercase hex. `max_output_tokens` and the inputs' MIME types are not part of the key. `POST /k/model/run` computes exactly this, so kworker finds a Worker-made output under the same key, and the reverse.

Tweets, `pbs.twimg.com` and `video.twimg.com` files, arXiv versions (`/abs/<id>v<n>`) and GitHub URLs pinned to a 40-hex commit never refetch (`immutable = 1`). Other pages are revalidated only when a job asks for it, by a conditional GET with the stored `etag` and `last_modified`.

### Canonical URL

`docs/knowledge-canon-vectors.json` holds test vectors that both implementations (TypeScript in the Worker, Python in kworker) must pass.

1. Lowercase the scheme and host. Drop a trailing dot on the host, the default port, the fragment and userinfo.
2. Hosts: `twitter.com`, `www.twitter.com`, `mobile.twitter.com`, `www.x.com` and `mobile.x.com` become `x.com`. `m.youtube.com` and `youtube.com` become `www.youtube.com`; `youtu.be/<id>` becomes `https://www.youtube.com/watch?v=<id>`. `www.github.com` becomes `github.com`.
3. Drop the query parameters `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `igshid`, `ref_src`, `ref_url`; on `x.com` also `s`, `t`, `ref`; on `www.youtube.com` also `si`, `feature`, `pp`. Sort the remaining parameters by name, keeping the order of repeated names. Keep their encoding as given.
4. An empty path becomes `/`. On `x.com`, `/<user>/status/<id>/<anything>` becomes `/<user>/status/<id>` and the user part is lowercased. On `github.com` the owner and repo segments are lowercased and a `.git` suffix on the repo is dropped. `arxiv.org/pdf/<id>[.pdf]` becomes `arxiv.org/abs/<id>`.
5. Nothing else changes. `http` stays `http`: whether a site redirects is the fetch's business, and the redirect target is recorded as `final_url`.
6. Parsing, where the rules above leave room: anything but an absolute `http` or `https` URL with a host is not canonicalized (the Worker reports it as not a URL). The query is split on `&` and empty parts are dropped. A parameter's name is the text before its first `=`, compared as written (case-sensitive, not percent-decoded), and names sort by Unicode code point. On `youtu.be` the id is the first path segment, and `v=<id>` joins the other parameters before they are filtered and sorted. On `github.com` only the first two path segments change.

## D1 tables (`worker/migrations/0020_knowledge.sql`)

Migration numbers start at 0020 because the `hub` branch takes 0009 onward. The job queue is `knowledge_jobs`, because `jobs` already exists (the watcher queue, 0001).

- `blobs(sha256 PK, size, mime, r2_key, cold_ref, created_at)`. `cold_ref` is a later Drive copy of a video master; nothing reads it.
- `fetches(url_hash PK, canonical_url, final_url, etag, last_modified, content_sha, mime, http_status, rung, status, immutable, note, fetched_at)`. `status` is `ok`, `not_found`, `blocked` or `error`. `rung` is the ladder rung that produced the row.
- `derivations(input_sha, step, provider, model, prompt_v, output_sha, input_tokens, output_tokens, ms, created_at)`, primary key the first five.
- `verdicts(item_kind, item_id, save_id, verdict, reason, stage, score, text_sha, gate_v, pack_sha, pack_row, created_at)`, primary key `(item_kind, item_id, gate_v)`. `item_kind` is `reply`, `quote`, `upstream`, `linking` or `link`; `verdict` is `keep` or `drop`; `stage` is `rule`, `embed` or `model`.
- `knowledge_jobs(id PK, kind, key, payload, deps, state, owner, lease_token, lease_until, attempts, expired_leases, runs, result, error, created_at, updated_at)`, unique `(kind, key)`.
- `bundles(post_id, version, r2_key, json_key, md_sha, json_sha, completeness, missing_json, saved_by, created_at)`, primary key `(post_id, version)`; plus the FTS5 table `bundle_search(post_id UNINDEXED, author, body)`.
- `capabilities(step, rank, provider, model, runs_on, quota_per_day, prompt_v, enabled, note)`, primary key `(step, rank)`.
- `domain_policy(host PK, start_rung, notes, updated_at)`.

## Routes

All routes take `Authorization: Bearer <KNOWLEDGE_TOKEN>` (scope `kworker`); `ADMIN_TOKEN` may call them too. Bodies are JSON unless stated. Every 4xx body on `/k/`, and every 502, 503 and 504 the Worker raises on purpose, is `{ "error": "<machine_code>", "message": "<one sentence naming the field>" }`, including 401 `unauthorized`, 403 `forbidden` and 405 `method_not_allowed` from the shared router; an unexpected error is `{ "error": "internal error", "request_id" }` as on every route. A bad field is 400 `invalid_request`, an over-limit body 413 `too_large`, and a row naming a blob that does not exist 422 `blob_missing`. Each JSON body has a byte limit sized for its batch: 4 KiB for claims, heartbeats, commits and domain policy; 16 KiB for `has` and fetch lookups; 32 KiB for derivation lookups; 48 KiB for job creation and completion (payload and result at most 32 KiB each); 64 KiB for derivations; 128 KiB for verdict lookups and model runs (prompt at most 64 KiB, response schema 16 KiB); 160 KiB for bundles; 512 KiB for fetches and verdicts.

### Blobs

- `PUT /k/blobs/:sha256` with the raw bytes, `Content-Type` and `Content-Length` (at most 95 MiB). The Worker streams the body into R2 with R2's own SHA-256 check, so it never hashes the bytes itself, then inserts the row. 201 `{ sha256, size, mime, r2_key, created: true }`; 200 with `created: false` if the blob exists (the body is not read). A hash mismatch is 422 `hash_mismatch` and nothing is stored. A missing Content-Length is 411 `length_required`, because R2 refuses a stream of unknown length.
- `POST /k/blobs/commit { sha256, mime }` after kworker uploaded `sha256/<hex>` through R2's S3 API with `x-amz-checksum-sha256`. The Worker reads the object's metadata and inserts the row only if R2 recorded that SHA-256 checksum. 409 `checksum_missing` if R2 has no checksum, 422 `hash_mismatch` if it differs, 404 `object_missing` if there is no object.
- `POST /k/blobs/has { sha256s: [≤100] }` → `{ present: [sha256…] }`.
- `GET /k/blobs/:sha256` streams the bytes with the stored `Content-Type`; `Range: bytes=a-b` (or `a-`, or `-n`) gives 206, and a range outside the blob 416. An object with no `blobs` row (an S3 upload not yet committed) is not served.

kworker sends blobs up to 8 MiB through `PUT`, and larger ones through the S3 API when `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are set. Without them it refuses a large blob, unless `KWORKER_LARGE_VIA_WORKER=1`, which is for local `wrangler dev` (no S3 API there).

### Fetches, derivations, verdicts

- `POST /k/fetches/lookup { url_hashes: [≤100] }` → `{ fetches: [row…] }`.
- `POST /k/fetches { rows: [≤50] }` upserts by `url_hash`. Each row needs `url_hash` (64 hex, and equal to sha256 of `canonical_url`), `canonical_url`, `rung` (0–7), `status`; `content_sha`, when given, must name an existing blob. `fetched_at` defaults to now. → `{ upserted }`.
- `POST /k/derivations/lookup { keys: [{ input_sha, step }…≤100] }` → `{ derivations: [row…] }`, every provider and version for each pair; kworker picks the one its capability order wants.
- `POST /k/derivations { rows: [≤50] }` inserts, ignoring duplicates. `output_sha` must name an existing blob. → `{ inserted }`. The Worker sets `created_at`, since `used_today` counts by it.
- `POST /k/verdicts { rows: [≤200] }` inserts, ignoring duplicates (→ `{ inserted }`, `created_at` set by the Worker); `POST /k/verdicts/lookup { gate_v, items: [{ item_kind, item_id }…≤200] }` → `{ verdicts: [row…] }`.

### Jobs

Kinds: `save`, `link`, `image`, `video`, `bundle`. The lease pattern is the one in `worker/src/candidates.ts`: a claim leases with a fresh random `lease_token`, an expired lease can be claimed again with a new token, completing needs the current token, and the third expired lease fails the job.

- `POST /k/jobs { kind, key, payload, deps?, again? }` creates a job (201), or returns the existing `(kind, key)` row (200, `created: false`). Both answer `{ created, requeued, replaced, deferred, job }`. `deps` lists job ids that must be `done` or `failed` before this one can be claimed; an id that names no job is 422 `unknown_dep`. `runs` starts at 1. `again: true` on a `done` or `failed` job puts it back to `queued` with the new payload and deps, adds one to `runs`, clears `result`, `error` and `expired_leases`, and answers `requeued: true`. On a queued job it replaces the payload and deps in place (`replaced: true`). On a claimed job it keeps them as `pending` (`deferred: true`), and completing that attempt queues the job again with them in the same batch, so a save that ran again never leaves its bundle on old children.
- `POST /k/jobs/claim { owner, kinds: [], ttl_s ≤ 3600, limit ≤ 10 }` → `{ jobs: [{ id, kind, key, payload, lease_token, lease_until, attempts, runs }] }`.
- `POST /k/jobs/:id/heartbeat { owner, lease_token, ttl_s }` sets the lease to end `ttl_s` from now while `lease_token` is the current one, which includes an expired lease nobody has claimed again. → `{ id, lease_until }`.
- `POST /k/jobs/:id/complete { owner, lease_token, state: "done"|"failed"|"queued", result?, error? }`. → the job row. `queued` hands the job back without a final state, clearing the owner and keeping `attempts`. Heartbeat and complete answer 409 `lease_lost` when the token is not the current lease, and 404 `job_missing` for an unknown id.
- `GET /k/jobs?kind=&state=&key=` lists up to 200 rows, newest first, without lease tokens.

### Bundles

- `POST /k/bundles { post_id, md_sha, json_sha, completeness: "complete"|"partial", missing: [], saved_by: [], author, search_text }`. Both shas must name blobs. If `json_sha` equals the latest version's, nothing changes (200, `created: false`). Otherwise the Worker assigns the next version, copies the two blobs to `bundles/<post_id>/v<n>.md` and `.json`, and replaces the post's `bundle_search` row with `search_text` (at most 64 KiB). 201 `{ created: true, post_id, version, r2_key, json_key }`. `post_id` is the numeric post id as a string; it is also the search row's rowid. If another registration for the same post takes the version first, the answer is 409 `version_conflict` and the caller sends again.
- `GET /k/bundles/:post_id` → the latest version's row.

### Capabilities, model calls, domain policy

- `GET /k/capabilities?step=` → `{ capabilities: [row…] }` in rank order, each with `available` (for `runs_on = "worker"`, whether the Worker has the provider's secret) and `used_today` (derivations created this UTC day for that provider and model).
- `POST /k/model/run { step, provider, model, prompt_v, prompt, inputs: [{ sha256, mime }], response_schema?, max_output_tokens? }` runs a Worker-side adapter (Gemini) on blobs already in R2. It first looks up the derivation; on a miss it calls the model, stores the output text as an `application/json` blob and records the derivation. → `{ output_sha, output, cached, usage: { input_tokens, output_tokens } }`. A cached answer needs no key. 422 `capability_unknown` unless `(step, provider, model)` is a `runs_on = "worker"` capability; 503 `capability_unavailable` when the secret is unset or the row is disabled; 429 `quota_exhausted` at `quota_per_day`, or when Gemini itself answers 429; 502 `model_error` for any other Gemini failure, including a `finishReason` other than `STOP`, which is not cached.
  - Gemini was written from Google's API docs and tested only against the stand-in in `worker/fixtures/server.mjs`, never the real API. At most 8 inputs. Inputs go inline as base64, in order, while their running total stays within 512 KiB; the rest go through the Files API resumable upload, streamed from R2, and are deleted afterwards. At most 2 inputs may need the Files API, and each waits at most 20 status checks 2 s apart for `ACTIVE` (504 `model_timeout`), which keeps a call under the 50 subrequests of Workers Free.
- `POST /embed` (existing, Workers AI `bge-base-en-v1.5`) and `GET /positives` are also open to the `kworker` scope.
- `GET /k/domain-policy?host=` → `{ policy: row|null }`; `POST /k/domain-policy { host, start_rung, notes }` upserts.

## Pipeline per save

A save is a post Sam bookmarked. It is always kept, with its self-thread, its media and its links. Jobs:

1. `save` (key = post id). Expands the post: self-thread, replies in both orders, the upstream post, quotes and posts linking it. In step 1 the expansion comes from the archive in `x-bookmarks-eval/archive/2026-10-26` and its judged reply pool; live capture is a later step. Then runs the gate and creates one `link` job per kept link, one `image` or `video` job per media item, and a `bundle` job that depends on all of them.
2. Gate, on text only, before any media download or link fetch:
   1. Code rules: a reply by the original poster is kept; a reply carrying a repo, code or a prompt skips the embedding stage and goes to the model.
   2. Embedding score against `positives`: the mean of the top 5 cosine similarities. At or above `keep_at` it is kept, at or below `drop_at` dropped.
   3. Everything between goes to one batched model call per save, with the interest brief (`kworker/kworker/prompts/interest-brief-v1.md`).
3. `link`: canonicalize, look up `fetches`, and climb the ladder from the host's `domain_policy.start_rung`, recording the rung: 0 site adapters (GitHub API for a repo with README, stars and last commit; arXiv; YouTube captions; X syndication JSON), 1 plain fetch from the Zephyrus, 2 Cloudflare Browser Rendering markdown then `r.jina.ai`, 3 Wayback then archive.today, 4 Playwright on the headed Chrome profile `pipeline`, 7 `blocked`. A rung that is skipped (no credentials, not applicable) is recorded as skipped in the job result. The repo behind a product site is looked for in its fetched HTML before any model sees it.
4. `image`: the original goes to R2. One vision call returns verbatim text, a kind and a description. When the kind is a screenshot of text, a second reader with a different model reads it too; if the two texts disagree the item is marked `ocr_uncertain`.
5. `video`: download (yt-dlp for pages, plain GET for `video.twimg.com`), `ffprobe`, a transcript from faster-whisper on the GPU (YouTube captions first for YouTube links), key frames cut by `ffmpeg`, and a vision read of the file (or, when only the frame-based reader is available, of the key frames plus the transcript) for scenes, on-screen text and key timestamps.
6. `bundle`: code, no model, writes `bundle.json` and `bundle.md` from the cached outputs and registers them.

### `bundle.json` (schema `kbundle/1`)

```json
{
  "schema": "kbundle/1",
  "post_id": "…", "url": "https://x.com/<user>/status/<id>",
  "author": { "handle": "…", "name": "…" }, "created_at": "ISO",
  "saved_by": ["sdotgu"],
  "completeness": "complete|partial",
  "missing": [{ "what": "link|media|reply_view|upstream|linking", "ref": "…", "reason": "…" }],
  "expansion": { "source": "…", "reply_views": ["…"], "gate_v": "…", "kept": 0, "dropped": 0 },
  "post": { "text": "verbatim" },
  "thread": [{ "id": "…", "url": "…", "created_at": "…", "text": "verbatim", "is_save": true, "media": ["m0"] }],
  "quoted": { "id": "…", "url": "…", "author_handle": "…", "text": "verbatim" },
  "replies": [{ "id": "…|null", "author_handle": "…", "text": "verbatim", "kept_because": "…", "stage": "rule|embed|model", "by": { "provider": "…", "model": "…", "prompt_v": "…" } }],
  "media": [{
    "id": "m0", "post_id": "…", "kind": "photo|video|gif", "source_url": "…", "sha256": "…", "r2_key": "sha256/…", "bytes": 0, "mime": "…",
    "image": { "text": "verbatim", "kind": "…", "description": "…", "ocr_uncertain": false, "by": {}, "second_reader": {} },
    "video": { "duration_s": 0, "width": 0, "height": 0,
               "transcript": { "language": "en", "segments": [{ "start": 0, "end": 0, "text": "…" }], "by": {} },
               "read": { "description": "…", "scenes": [{ "t": 0, "description": "…", "on_screen_text": "…" }], "by": {} },
               "key_frames": [{ "t": 0, "sha256": "…", "r2_key": "…" }] }
  }],
  "links": [{ "url": "…", "canonical_url": "…", "final_url": "…", "from": "post|thread:<id>|reply:<id>", "title": "…", "rung": 0, "status": "ok|blocked|not_found|error", "text": "…", "text_sha": "…", "repo": "https://github.com/o/r|null" }],
  "repos": [{ "url": "https://github.com/o/r", "description": "…", "stars": 0, "last_commit_at": "…", "readme_sha": "…", "readme_excerpt": "…", "found_via": "link|site_html|reply" }]
}
```

Every generated block carries `by: { provider, model, prompt_v }`. Code-produced fields carry none.

## Daily loop

Each morning Sam reads one brief about the posts he saved in the last 24 hours. The extension's daily job (07:00 America/Chicago, @sdotgu's Chrome on the Zephyrus) posts each new save to `POST /k/intake`. kworker, on a schedule on the Zephyrus, reads each save in full and writes its bundle and a card. A scheduled T3 task on the Mac (08:00) reads `GET /k/digest` and writes the brief.

### `POST /k/intake` (token `KNOWLEDGE_INTAKE_TOKEN`, scope `kintake`)

One save per request, at most 192 KiB of JSON. The `kintake` token may call this route and nothing else, so the extension can file saves but not read the store. Posting the same body again changes nothing. A different body for the same post (more context, say) runs the save again: at once if it is finished or waiting, and after the current attempt if it is running, so a newer body is never acknowledged and then dropped.

```json
{
  "schema": "kintake/1",
  "run_id": "daily-2026-11-13",
  "account": "sdotgu",
  "captured_at": "2026-11-13T13:02:11Z",
  "post": {
    "id": "2119124661443457189",
    "url": "https://x.com/corbtt/status/2119124661443457189",
    "author_handle": "corbtt",
    "author_name": "Kyle Corbitt",
    "created_at": "2026-11-07T17:47:45Z",
    "text": "verbatim, with t.co links expanded where known",
    "media": [{ "kind": "photo|video|gif", "url": "https://pbs.twimg.com/media/…?name=orig" }],
    "links": [{ "url": "https://t.co/…", "expanded": "https://example.com/page", "title": "optional" }],
    "quoted": null,
    "reply_to": null
  },
  "thread": [],
  "upstream": [],
  "context": [
    { "id": "2119125016797479391", "author_handle": "corbtt", "text": "…", "reply_to": "2119124661443457189",
      "quoted_id": null, "view": "relevant", "created_at": "2026-11-07T17:49:10Z", "links": ["https://example.com"] }
  ],
  "context_capped": false,
  "views_read": [{ "view": "relevant", "reached_end": true, "count": 23 }]
}
```

- `post`, `thread[]`, `upstream[]` and `post.quoted` are post objects. Required in each: `id` (numeric string), `url`, `author_handle`, and `text` (a string, `""` when the post has none). `media` (at most 20) and `links` (at most 50) are optional.
- `thread`: the author's self-thread in order, the save included, when the job walked it. `upstream`: the posts the save replies to, nearest first (the reply-parent walk).
- `context`: at most 120 posts around the save: replies, quotes, posts linking it. Each needs `id`, `author_handle`, `text`; `reply_to`, `quoted_id`, `view`, `created_at` and `links` (URL strings or `{ url, expanded }`) are optional. kworker's relevance gate decides which to keep, so send them unfiltered. Set `context_capped: true` when the job's 80-post cap cut the context short.
- `run_id`, `account` and `schema` are required; `captured_at` and `views_read` are optional.
- Answers: 201 `{ post_id, intake_sha, job: { id, state, created: true, requeued: false, replaced: false, deferred: false } }` for a new save, 200 for one already filed: `requeued` (a finished save runs again), `replaced` (a waiting save takes the new body), or `deferred` (a running save runs again with it when the current attempt ends). A bad field is 400 `invalid_request` naming it (`post.text must be a string …`, `context[3].id must be …`); over 192 KiB is 413 `too_large`.

### `GET /k/digest?since=<time>[&cursor=<next_cursor>]&limit=<1..100>` (scope `kworker`)

`{ since, until, pending_saves, count, truncated, next_cursor, saves: [{ version, finished_at, card }] }` for each save whose latest bundle was registered at or after `since`, oldest first by (finish time, post id), at most 30 KiB of UTF-8 per page and always at least one save. `since` is epoch milliseconds or an ISO time with a zone (`2026-11-13T07:00:00Z`, `2026-11-13T02:00:00-05:00`); anything else is 400. When a page is cut, `truncated` is true; ask again with the same `since` and `cursor=<next_cursor>`, which resumes strictly after the last save returned, so saves that finished in the same millisecond come once each. `pending_saves` counts saves whose save or bundle job is still queued or running, so a save with work outstanding is never missing from both the cards and the count.

A card, written by kworker with the bundle (at most 4 KiB):

```json
{
  "post_id": "…", "url": "…", "author": "@corbtt (Kyle Corbitt)", "created_at": "…", "saved_by": ["sdotgu"],
  "status": "complete|partial|blocked", "missing": ["link https://…: blocked at rung 7 (login wall)"],
  "excerpt": "the post's first 280 characters",
  "verdict": { "label": "try|read|reference|skip", "why": "one sentence on why it matters to Sam", "action": "one thing to do, or empty", "by": { "provider": "…", "model": "…", "prompt_v": "…" } },
  "context": ["@corbtt: the top kept replies, one line each"],
  "links": [{ "url": "…", "title": "…", "status": "ok", "repo": { "name": "o/r", "stars": 0, "last_commit": "…" } }],
  "media": { "photos": 0, "videos": 0 }
}
```

## Agent tools (mailbox MCP endpoint, read-only)

Fields holding text from posts, pages or models end in `_untrusted`, the mailbox endpoint's marker for data an agent must not take instructions from.

- `knowledge_has { ids?: [post id ≤50], urls?: [url ≤50] }` → `{ ids: [{ id, version, completeness }], urls: [{ url, canonical_url, fetch: { status, rung, final_url, fetched_at } | null }] }`. `version` is null for a post without a bundle; `canonical_url` is null, with an `error`, for anything that is not an http(s) URL.
- `knowledge_search { query, k ≤ 20 }` → `{ results: [{ post_id, version, author_untrusted, snippet_untrusted }] }`, best first. Each word of the query is matched as a term and every word must match; FTS5 operators are not interpreted.
- `knowledge_bundle { post_id, sections?: ["front","post","thread","quoted","replies","media","links","repos","markdown"] }` → `{ post_id, version, completeness, r2_key, json_key, md_sha, json_sha, sections_untrusted: {…}, truncated, omitted }`, at most 48 KiB of sections; `md_sha` and `json_sha` let a caller read a cut section in full with `knowledge_blob`. Without `sections`, every section but `markdown`. A section that does not fit keeps its leading items (arrays) or leading text (strings), or is listed in `omitted`. A bundle.json over 1 MiB is refused with a pointer to `knowledge_blob`.
- `knowledge_blob { key, offset?, length ≤ 65536 }` → `{ key, mime, size, offset, length, next_offset, encoding: "utf8"|"base64", data_untrusted }` for part of a blob by `sha256/<hex>` or bare hex: text for `text/*` and JSON, base64 otherwise.

## Deployment (the lead, from the MacBook)

```sh
cd worker
npx wrangler r2 bucket create x-knowledge
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put KNOWLEDGE_TOKEN      # random 32-byte hex, also in ~/.agent-secrets/discovery-knowledge
npx wrangler secret put KNOWLEDGE_INTAKE_TOKEN   # random 32-byte hex; the extension's daily job holds it
npx wrangler secret put GEMINI_API_KEY       # free-tier key; optional
npx wrangler deploy
```

For kworker's S3 path, create an R2 API token scoped to Object Read & Write on `x-knowledge` only (dashboard, R2, Manage API tokens).

### Credentials on the Zephyrus

kworker reads two generic credentials from Windows Credential Manager when the matching environment variable is unset. They never enter the repo, D1, R2, a log or a message.

| Target name | User name | Password | Replaces |
| --- | --- | --- | --- |
| `discovery-knowledge-token` | anything (`kworker`) | the production `KNOWLEDGE_TOKEN` | `KNOWLEDGE_TOKEN` |
| `discovery-r2-s3` | the R2 API token's access key id | its secret access key | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |

Add one in Control Panel, Credential Manager, Windows Credentials, "Add a generic credential", or from a terminal with `cmdkey /generic:discovery-knowledge-token /user:kworker /pass` (it prompts for the password, so the token never sits in shell history). `R2_S3_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`) is not secret and stays an environment variable.
