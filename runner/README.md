# Discovery runner

The runner is the Mac half of the discovery system in [docs/CONTRACT.md](../docs/CONTRACT.md). Every 10 minutes it does two things:

1. It scores the posts the extension captured against Sam's saves.
2. It takes up to 3 candidates and turns each one into finished work: a proposal with its reversible steps already done.

Only a proposal whose last step is irreversible (submit, send, post, pay, RSVP, delete, accept terms, push, open a PR) ever asks Sam anything.

It uses only the Python 3 standard library, plus the `gh`, `curl`, `codex` and `security` command-line tools. Models run through CLIProxyAPI. No Claude model runs at runtime.

## Stop it

```sh
runner/discovery-runner stop                # writes ~/.discovery/STOP; work halts at the next step
runner/discovery-runner stop --kill-preps   # also ends running codex preps now
runner/discovery-runner stop-preps          # ends running codex preps only
runner/discovery-runner resume              # removes STOP
launchctl bootout gui/$(id -u)/com.samgu.discovery-runner   # unload the daemon entirely
```

Running preps are ended only through `stop-preps`. Each `codex exec` the runner starts is recorded in `~/.discovery/state/preps.json` with its pid and process group, and the record is removed when it exits. `stop-preps` signals a recorded group only after `ps` confirms the pid is still that prep's `codex exec`, so a reused pid is never touched. Never stop preps with `pkill` or any pattern match: it would hit other sessions' processes. For an eval round, run it with that round's home: `DISCOVERY_HOME=~/.discovery-eval/round-N runner/discovery-runner stop-preps`.

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
9. **Prep.** The runner writes `PROPOSAL.md` and any application draft into `~/.discovery/work/<id>/`. When the work needs tools, it runs `codex exec` with gpt-6.1-sol there under `--sandbox workspace-write`. Network comes only from `sandbox_workspace_write.network_access`, stdin is closed, and the run stops after 10 minutes. No bypass flag is ever passed. Scratch over 200 MB loses its clones. If prep finds the premise false, the proposal is dropped.
10. `POST /proposals`, which goes to the outbox if the route isn't live. Then the candidate is completed. If the lease expired along the way, nothing is posted.

## Config: `~/.discovery/config.json`

The file is created with defaults on first run, and unknown keys are an error. The keys that matter:

| Key | Default | |
| --- | --- | --- |
| `max_deep_reads_per_day`, `max_codex_preps_per_day` | 60, 50 | Runaway guards, not budgets: a full 19-candidate round used 24 deep reads and about 14 preps (at most 2 per item), and daily inflow is about 25 candidates |
| `codex_usage_snapshot`, `pool_weekly_ceiling_pct`, `pool_min_usable_accounts` | AgentSetup snapshot, 90, 1 | Prep runs while the Codex pool has headroom. Only a measured shortage holds work back, and then applications, deadlines, security notices and value 4+ go first; the rest waits in the queue, never as a card |
| `prep_timeout_s`, `prep_scratch_mb` | 600, 200 | |
| `unbookmarked_candidates_per_day` | 15 | The Worker enforces the same cap |
| `score_threshold` | 0.75 | The contract's starting value; see Calibration |
| `claim_limit`, `claim_ttl_s`, `loop_interval_s` | 3, 2700, 600 | |
| `ai_guidance` | anthropic.com | Employer domain → AI-use guidance page |
| `coursework` | | Course codes, paths, exceptions, domains and words that are never touched |
| `models`, `judge_effort` | luna / sol / astra, low | |

Usage is counted per UTC day in `~/.discovery/state/usage.json`. A runaway guard tripping is logged as `RUNAWAY GUARD` in `runner.out.log`; it means a loop, not a busy day.

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

## Fleet

The fleet watcher finds T3 runs that ended abnormally and posts one card for each to a pinned Operator thread. It runs as a second launchd job, `fleet loop`, every 2 minutes, because the main loop sleeps 10 minutes and can block on preps. It obeys `STOP`. It makes no model calls of its own, but each card message starts one turn in the Operator thread.

**Where it reads.** It reads only T3's database, `~/.t3/userdata/statev2.sqlite`, opened read-only (`mode=ro`, `query_only`). Each cycle runs one scan query on `orchestration_v2_projection_runs`, joined to the thread table for mode, parent and archived state, then a few indexed lookups (failure, stop evidence, activity, lead) for each run that ended abnormally or is still open. The query is watermarked on `requested_at` and `completed_at`, with 2 minutes of overlap, plus the runs still open. T3 has no index on those two columns, so the query scans the run table. On 2026-11-19 that was 22,852 rows: a cycle took 9 ms warm and about 0.3 s cold, and a full 14-day poll took 38 ms. At startup, `probe.py` checks every table and column the fleet queries. If T3's schema changes, the watcher stops and logs each missing column as `WATCHER DISABLED`; it rechecks hourly.

**What gets a card.**

| Run ended | Card |
| --- | --- |
| `completed` | None. T3 already notifies Sam |
| `failed` | Yes, with T3's failure class and message |
| `interrupted`, stopped by Sam | None. The stop command must come from his app (a client UUID, a force stop, or a cascade from his stop of the lead), and the interrupt item must carry the text T3 writes for that kind of stop. With no interrupt item, his stop must have landed within a minute of the run's end |
| `interrupted` by an agent (an MCP stop) | Yes, with the agent's reason |
| `interrupted` with no clear evidence | Yes, marked unclear. Never acted on |
| `cancelled` after it started | Yes, if no later run started and T3 has been up for 10 minutes without continuing it. T3 cancels runs a restart kills and usually continues them when it starts again |
| open, nothing new for `fleet_stall_min` (30) minutes | Yes, if the watcher has been awake that whole time, so a Mac that slept does not stall every run |

A dead child's card names its lead and says whether the lead is idle. Nothing is sent to either. The Operator thread and its children never get cards. A Full access thread can only be resumed by Sam, because T3 refuses the operator's Auto sign-in there (`threadAccess.ts`). Card text that comes from other threads, such as titles, T3's error text and agents' stop reasons, is quoted and labeled as data.

**Writes.** Only `launcher.py` writes to T3, and only through `t3client.py`. A test fails if any other module imports it.

- **Stable keys.** Each write has a stable key. The key goes to T3 as `clientRequestId`, and T3 replays a repeated key within one sign-in, across T3 restarts. The key also goes into the message as a last line, `fleet-key: <key>`.
- **Journal.** `state/fleet-journal.json` records each write before the call and marks it accepted after.
- **Retries.** Before any retry, the launcher reads T3's messages table for the key line. A new sign-in drops T3's replay, so this check stops a second message even then. It reads the table directly because T3's search index leaves out messages agents write.
- **Lost answers.** A lost answer is written as an `uncertain` receipt. A refused connection is not, because that call never reached T3. Either one drops the cached client, so a T3 restart on another port is picked up at once. A post T3 refuses (an archived Operator thread, say) holds its cards and shows in the heartbeat as `post_refused`; the rest of the cycle still runs.
- **Card order.** The watcher saves a run as seen only after its card is in `state/fleet-outbox.json`. Cards T3 has not accepted stay there.

**Modes** (`fleet_mode`): `cards`, the default, only posts cards. `full` also shows each drafted launch (`fleet draft`) in the Operator thread and launches it once Sam types `go 2` there. Only text Sam typed in the app counts (`createdBy` "user" from web, mobile or his queued messages, never a scheduled task's), and only a "go" typed after the draft was shown. Drafts and notes in the Operator thread start with a line telling that thread's agent the text is data for Sam. A launch refused at that point stays queued, and the Operator thread says why. In `full` mode each cycle also counts every run in each tree the operator launched, children included. A tree still running past 20 runs is stopped the way its Stop button does, unless Sam has typed in it since, and no new launch goes out while one is over. Resuming the operator's own threads and the unattended `wrap` and `correct` launches are not built yet.

**Launch checks.** Launches run at Auto or lower. `envelope.py` refuses each of these before T3 is called, naming the field:

- a launch missing its repo, origin, route model, base branch or round;
- a model that is not one of the route's T3 targets in `routes.json`;
- a repo without `.agents/topology.json`, or one whose `origin` is missing from the file or differs from the repo's;
- round 4;
- quoted words that are not Sam's.

A drafted brief quotes Sam below a divider. Each excerpt's pieces, split at `[...]`, must appear in a message he typed, byte for byte, in order and on word edges, at least two words each. The brief above the divider is the drafter's own text; Sam reads it before he types "go".

**Limits.** They come from `~/.agent-config/operator/limits.json` when it exists, otherwise from the design's starting values: 12 launches a day, 3 open at once, and an 8 GB disk floor. A 24-a-day cap on card messages is not in the design; it stops a runaway loop.

**Receipts** (`logs/receipts.jsonl`) record what the runner checked:

- `claimed`: an agent's claim.
- `observed`: T3's run status, the requested and executed models, and the worktree head.
- `verified`: the runner ran the acceptance command and kept its exit code and last 20 lines.

`mismatch` means an executed model differed from the requested one. A provider that reports no model shows "model unknown".

**The charter** is the block a new session starts with, 40 lines at most. It holds confirmed decisions from SecondBrain's decision log, newest first, plus the repo's own decisions when the repo is Sam's (its `topology.json` lists him as owner and matches its origin).

| Command | What it does |
| --- | --- |
| `fleet probe` | Day 0: prints every field the fleet reads for an archived thread, a child and an Auto thread, with poll times |
| `fleet replay [--days 14]` | Day-1 check: replays the window through the watcher and scores it on real dead, Sam-stopped and healthy runs. Exits 1 on a fail |
| `fleet cycle` | One cycle over the last 24 hours. Prints the cards and posts nothing |
| `fleet find "<question>"`, `fleet find --eval cases.json` | Which thread was that? Searches titles, Sam's messages and answers, archived threads included |
| `fleet charter [--hook claude] [--publish FILE]` | Prints the session-start block, as Claude Code SessionStart hook JSON, or writes it between markers in a CLAUDE.md or AGENTS.md (the route that was checked for Codex) |
| `fleet observe <run_id> --ask "<Sam's words>"` | Writes an observed receipt |
| `fleet draft <envelope.json>` | Checks a drafted launch and queues it for Sam's `go` |
| `fleet login` | Signs the runner in to T3. Sam approves at Auto on T3's page. A token with scopes above Auto is refused and never saved; a good one goes to `~/.agent-secrets/discovery-t3-mcp` (mode 600) |
| `fleet loop` | The launchd job |

Install, after `fleet login` and setting `fleet_operator_thread` in the config:

```sh
cp runner/launchd/com.samgu.discovery-fleet.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.samgu.discovery-fleet.plist
```

## Tests

```sh
python3 -m unittest discover -s runner/tests
```

The tests drive the runner against `tests/mock_worker.py`, which follows the contract and copies the deployed Worker's details. Model answers come from a fake gateway, and no prompt wording is asserted. Each test names the regression it catches.

## Grading rounds

`eval/replay.py <dir>` replays real inputs through the full pipeline against the mock Worker: Sam's Nov 4 saves with their threads, and live Anthropic postings. It writes `artifacts.md`, which shows what Sam would see.
