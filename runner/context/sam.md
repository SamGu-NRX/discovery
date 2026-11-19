# Sam Gu: standing context for the discovery runner

Sources: GROKBOT.md sections 2, 13 and 16 (settled decisions, Nov 2 to 4, 2026) and the Nov 4 action-loop
context. Live signals (repos, recent T3 threads, confirmed Second Brain notes) are appended by the runner
at run time and outrank this file when they disagree.

## Who he is and what is on his plate (Nov 2026 to Apr 2027)
- UT Austin CS student, taking classes all year. Coursework is out of scope for this runner: homework is a
  separate engine with its own rules, and GOV 310L prohibits generative AI.
- Base Power internship, Jan 11 to Apr 30, 2027 (signed Oct 30). Related project: house-scanning, an iPhone
  app that surveys the wall by a home's electric meter to see if a Base Power battery fits.
- Curate Technologies LLC with Aiden. Main product Reel Studio (AGPL): raw talking-head takes to a finished
  9:16 Reel. Thesis: "A bookmark is a bet. Curate keeps score and turns the winners into posts." Also fast-cut.
- Applications and hackathons are constant: internship letters (PDT, Together AI, Tower, Radix, Stripe,
  Vercel, Figma, Cloudflare, SpaceX), TreeHacks, AFE, Penn, recent hackathons (8VC ATX, Grok Bot, Spurs).
- Building a proactive personal system (the "ledger" / discovery system): Cloudflare Worker + D1, watchers,
  this Mac runner, approvals in T3. Policy (Nov 2): agents take every non-destructive step; the final
  irreversible step (submit, send, post, pay, RSVP, push, open a PR) waits for his one tap.
- Agent setup is a big recurring workload: CLIProxyAPI pooling Claude and Codex accounts, T3 Code as the main
  harness, the AgentSetup repo, model routing (model-selection.md), routing checks after model releases.
- Other projects: Caret (native Mac copilot), ShootAgent (real-estate photo QA), kgu.one (personal site),
  beru-openinstinct, CogPortal, x-bookmarks-eval, sg-voice, FORM3D and assay (agent evals), wheelchair-fsd.

## What he repeats (GROKBOT section 2), and what would help
| Workflow | What finished work looks like |
| --- | --- |
| Model and tool setup changes (backups Sep 1, 24, 30, Oct 8; ~20 routing-check threads) | A proposed config change with evidence, tested in isolation, waiting as a PR |
| CLIProxyAPI quota management ("You keep doing one-time manual fixes") | Structural fixes that survive resets, not one-off patches |
| Applications, resumes, hackathons | Eligibility checked, answers drafted from sourced facts, form prefilled, one tap from him |
| X bookmarks | Saves turned into done work, frequent authors proposed as sources |
| Theo videos to setup changes | Claims with timestamps, diff against model-selection.md, proposed edit |
| Thread recovery, long-run kickoffs, PR caretaking | Mostly handled elsewhere; record outcomes only |

## What he saves for and how he judges
"Inspiration and reference: web/app design and motion, Claude Opus and agent workflows, prompts, AI
capabilities, tools worth adopting." He wants the whole thread understood, OP follow-ups and replies
included, and the GitHub repo behind a site. He wants action, not a digest: "Without me even having to
prompt it." "As low resistance as possible for me to submit." He rejects one-time fixes, busywork, vague
"consider X" items, and robotic writing.

## Reported in place as of Nov 4 (verify against the machine before relying on any of these)
- Skills from saves: poteto-mode, poteto-help, no-comments, setup-pstack, swarm, arena, interrogate,
  make-bot-ui (Codex); create-verification-skill, ketchup, emil-design-eng, ask-emil, brag, deslop,
  unslop-code, mermaid-diagrams, prototype, interface-review, claude-api, application-letters (Claude).
- CLIProxyAPI pools accounts; a usage-rate table and quota tooling exist in T3 userdata.
- Claude Code prompt caching at 1h (`ENABLE_PROMPT_CACHING_1H=1`, kept on purpose after an Aug 6 audit).
