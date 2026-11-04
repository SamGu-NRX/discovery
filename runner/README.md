# Discovery runner

The runner is the Mac half of the discovery system in [docs/CONTRACT.md](../docs/CONTRACT.md). Every 10 minutes it does two things:

1. It scores the posts the extension captured against Sam's saves.
2. It takes up to 3 candidates and turns each one into finished work: a proposal with its reversible steps already done.

Only a proposal whose last step is irreversible (submit, send, post, pay, RSVP, delete, accept terms, push, open a PR) ever asks Sam anything.

It uses only the Python 3 standard library, plus the `gh`, `curl`, `codex` and `security` command-line tools. Models run through CLIProxyAPI. No Claude model runs at runtime.

## Stop it

```sh
runner/discovery-runner stop      # writes ~/.discovery/STOP; work halts at the next step
runner/discovery-runner resume    # removes it
launchctl bootout gui/$(id -u)/com.samgu.discovery-runner   # unload the daemon entirely
```

The runner checks STOP before it claims work and between steps (each model call, each prep). If STOP appears in the middle of a candidate, that candidate goes back to the queue. An in-flight model call or `codex exec` is allowed to finish. While STOP exists, the loop writes `stopped` to its heartbeat once a minute and does nothing else.

## Commands

| Command | What it does |
| --- | --- |
| `score` | Pulls unscored posts and embeds them through `POST /embed` (cached in `~/.discovery/cache/embeddings.sqlite`). Scores them, writes the scores back, and creates candidates for each session's top 2% and anything at or above `score_threshold`. At most 15 unbookmarked candidates a day. Bookmarks are skipped here, because the Worker queues them itself. |
| `work` | Claims up to 3 candidates and handles each one. See below. |
| `loop` | Runs flush, `score` and `work` every 10 minutes. It doubles its wait (up to an hour) while the Worker answers 404 or 5xx, and writes `~/.discovery/logs/heartbeat`. |
| `flush` | Sends proposals queued in `~/.discovery/outbox/` while `POST /proposals` was not live. |
| `calibrate [--apply]` | Measures the threshold on Sam's saves (below). `--apply` writes the suggestion to the config. |
| `status` | Prints STOP state, the heartbeat, today's budget use, the outbox size and today's model calls. |

## What `work` does with a candidate

1. **Coursework gate.** Anything naming his courses (GOV 310L, CS 311), `~/UT` (except the resume sources in `~/UT/Internship_Job_Hunt`), Canvas or homework is skipped before any model call. The same check runs again on the proposal. Coursework thread titles are also kept out of the context models see.
2. **Bundle.** For an X post, the bundle holds the post, its quoted post, the OP's follow-ups and the replies in X's order, from `GET /x/posts/:id/context`. It adds up to 8 linked sources fetched directly: GitHub through `gh api`, arXiv abstracts, Greenhouse jobs with their application questions, and pages through curl. If the thread isn't captured and the candidate is under 6 hours old, the runner defers it. After 6 hours it proceeds and records what was missing. For a watcher event, the bundle is the fetched URL. Each piece carries a ref (`op`, `op_followup`, `reply:@handle`, `link:<url>`) that citations must use.
3. **Related saves.** The 6 saves most similar to the item, plus similar open proposals. This is how one item connects to earlier ones.
4. **Triage** with gpt-6-luna into one of the contract's action types. `no_action` is skipped, and `reference_note` is recorded as a done note with no ask.
5. **Deep read and proposal** with gpt-6.1-sol, which costs one deep read from the daily budget. Every quote is checked verbatim against the bundle, and a misquote is dropped from the evidence. Every claim the action depends on is checked against this machine, read-only: paths, file contents, config values, repos. So is every path the prose mentions. If a premise is false, Sol revises once, or declines. Claims that stay unverified are labeled in the proposal's `why`.
6. **Employer AI-use guidance.** For applications, essay fields are always left blank unless the employer's guidance page explicitly allows AI drafting. The pages are listed in `ai_guidance` in the config. Anthropic's page asks candidates to write their own first draft. Other fields are filled only from the verified facts in the application-letters skill.
7. **Duplicates** merge into the existing proposal when they act on the same target, or when they fall within 14 days at cosine 0.85 or above.
8. **Independent judge**, gpt-6-astra at low effort, a different model from the proposer. If it rejects the proposal or flags it as busywork, the candidate is skipped. If it says "maybe", the proposal is recorded as done without asking.
9. **Prep.** The runner writes `PROPOSAL.md` and any application draft into `~/.discovery/work/<id>/`. When the work needs tools and the judge approved it, it runs `codex exec` with gpt-6.1-sol there under `--sandbox workspace-write`. Network comes only from `sandbox_workspace_write.network_access`, stdin is closed, and the run stops after 10 minutes. No bypass flag is ever passed. Scratch over 200 MB loses its clones. If prep finds the premise false, the proposal is dropped.
10. `POST /proposals`, which goes to the outbox if the route isn't live. Then the candidate is completed. If the lease expired along the way, nothing is posted.

## Config: `~/.discovery/config.json`

The file is created with defaults on first run, and unknown keys are an error. The keys that matter:

| Key | Default | |
| --- | --- | --- |
| `deep_reads_per_day` | 20 | `work` claims nothing once the budget is used up |
| `codex_preps_per_day` | 5 | |
| `prep_timeout_s`, `prep_scratch_mb` | 600, 200 | |
| `unbookmarked_candidates_per_day` | 15 | The Worker enforces the same cap |
| `score_threshold` | 0.75 | The contract's starting value; see Calibration |
| `claim_limit`, `claim_ttl_s`, `loop_interval_s` | 3, 2700, 600 | |
| `ai_guidance` | anthropic.com | Employer domain → AI-use guidance page |
| `coursework` | | Course codes, paths, exceptions, domains and words that are never touched |
| `models`, `judge_effort` | luna / sol / astra, low | |

Budgets are counted per UTC day in `~/.discovery/state/usage.json`.

## Logs and state

| Path | |
| --- | --- |
| `logs/calls.jsonl` | Every model call and every `codex exec`: stage, item, model, tokens, latency, status, list cost |
| `logs/heartbeat` | The last loop cycle's status and summary |
| `logs/runner.{out,err}.log` | launchd stdout and stderr |
| `runs/<date>/<candidate>.json` | Everything the runner decided for one candidate, with its bundle beside it |
| `work/<id>/` | Prepared files: `PROPOSAL.md`, `application.json`, codex's `PREP.md`, `prepared.json`, `codex.log` |
| `outbox/` | Proposals waiting for `POST /proposals` |
| `state/proposals.jsonl` | Every proposal the runner made, for duplicate checks |
| `state/scores.sqlite`, `cache/` | Scores by session, embeddings, and fetched pages (kept for a day) |

## launchd

```sh
cp runner/launchd/com.samgu.discovery-runner.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.samgu.discovery-runner.plist
launchctl print gui/$(id -u)/com.samgu.discovery-runner | grep -E 'state|pid'
```

`KeepAlive` restarts the loop if it exits. A failing cycle is logged and retried next cycle, so it does not cause a restart loop.

## Tests

```sh
python3 -m unittest discover -s runner/tests
```

The tests drive the runner against `tests/mock_worker.py`, which follows the contract and copies the deployed Worker's details. Model answers come from a fake gateway, and no prompt wording is asserted. Each test names the regression it catches.

## Grading rounds

`eval/replay.py <dir>` replays real inputs through the full pipeline against the mock Worker: Sam's Nov 4 saves with their threads, and live Anthropic postings. It writes `artifacts.md`, which shows what Sam would see.
