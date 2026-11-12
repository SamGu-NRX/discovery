# kworker

The stateless job worker of the X knowledge store ([docs/KNOWLEDGE.md](../docs/KNOWLEDGE.md)). It claims jobs from the Worker's `/k/jobs/claim`, does the fetching and media work the Worker can't do inside Workers Free (10 ms CPU, 50 subrequests), uploads every result to R2 through the Worker, and completes the job. Nothing it needs later is kept on disk: delete this folder, check it out again, and a rerun finds every fetch and model output in D1 and R2.

Python, because the media steps are Python libraries (faster-whisper, yt-dlp, Playwright, trafilatura) and the rest is HTTP glue; a Node worker would shell out to Python for transcription anyway.

## Run

```powershell
cd kworker
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m playwright install chrome   # once per machine; uses the installed Chrome if present

$env:KNOWLEDGE_URL = "https://discovery-watcher.<account>.workers.dev"
$env:KNOWLEDGE_TOKEN = "<from ~/.agent-secrets/discovery-knowledge>"
.venv\Scripts\python -m kworker enqueue-archive --archive "$HOME\Programming Projects\x-bookmarks-eval" --acceptance
.venv\Scripts\python -m kworker run            # until the queue is empty; --forever to keep polling
```

`ffmpeg` and `ffprobe` must be on `PATH` (scoop on the Zephyrus).

## Environment

| Variable | Needed | What for |
| --- | --- | --- |
| `KNOWLEDGE_URL`, `KNOWLEDGE_TOKEN` | yes | the Worker and the `kworker` token |
| `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (`R2_BUCKET`, default `x-knowledge`) | for blobs over 8 MiB | direct upload to R2's S3 API with `x-amz-checksum-sha256`, then `POST /k/blobs/commit` |
| `KWORKER_LARGE_VIA_WORKER=1` | local dev only | sends large blobs through the Worker instead, because `wrangler dev` has no S3 API |
| `CLIPROXY_URL`, `CLIPROXY_KEY` | for kworker-side models | the CLIProxyAPI gateway; defaults to `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, which Claude Code on the Zephyrus already has |
| `CF_ACCOUNT_ID`, `CF_BROWSER_TOKEN` | optional | ladder rung 2's Cloudflare Browser Rendering; without them rung 2 goes straight to r.jina.ai |
| `GITHUB_TOKEN` | optional | raises the GitHub API limit from 60 requests an hour |
| `KWORKER_CHROME_PROFILE` | optional | rung 4's Chrome profile, default `%LOCALAPPDATA%\kworker\chrome-profiles\pipeline`. It holds no logins, and kworker never types into a page |
| `KWORKER_MODEL_CACHE` | optional | where whisper and embedding weights are downloaded, default `~/.cache/kworker`. Model weights only, never pipeline state |

## What each job does

- `save`: gates the expansion (code rules, embedding score, one batched model call for the band; `kworker/gate.py`), records verdicts and tombstones, then queues one job per media item and kept link and a `bundle` job that waits for them.
- `link`: the ladder in `kworker/links.py`, recording the rung, the attempts and what each skipped rung lacked.
- `image`: download once, one vision read, a second reader on text screenshots, `ocr_uncertain` when they disagree.
- `video`: download once, ffprobe, faster-whisper on the GPU (CPU fallback), ffmpeg key frames, a vision read.
- `bundle`: code only; writes `bundle.json` and `bundle.md`.

Each job's result records its counters: external fetches by host, model calls by model, tokens by step, cache hits and bytes uploaded. `acceptance/run.py` reads them.

## Tests

```powershell
.venv\Scripts\python -m pytest -q tests
```

The end-to-end check is `acceptance/run.py` (the ten step-1 saves against `wrangler dev`).
