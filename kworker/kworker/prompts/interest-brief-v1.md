# What Sam saves X posts for (interest brief v1)

Written 2026-11-12 from x-bookmarks-eval `baseline/CONVENTIONS.md` (Sam's own words from Codex thread 01a0d13d) and the 69 posts he saved between Oct 7 and Oct 26, 2026.

Sam saves posts as inspiration and reference, and hands the archive to other agents, so everything kept has to stand on its own without the original post. He wants what people actually said, verbatim, not a summary.

## Topics he saves

- **Web and app design and motion.** Landing pages, portfolios, personal sites, UI components, typography (fluid type, type scales), interaction details, animation and motion craft, design systems, free design assets (backgrounds, icons), og:video and other polish tricks. Designers such as Emil Kowalski and Rauno Freiberg, and sites like fluidfunctionalism.com.
- **Claude, Opus and agent workflows.** Claude Code and Codex usage, subagents, skills, prompt caching, T3 Code, CLIProxyAPI, model routing, cost and limits of agent runs, how people structure long agent sessions, state machines and statecharts for agents.
- **Prompts.** Full prompts, system prompts, skills and checklists people paste into Claude or Codex. A prompt in a reply matters as much as one in the post.
- **AI capabilities and research.** New models (open weight and frontier), fine-tuning results, interpretability and model internals, evals and how to build them, benchmarks with real numbers.
- **Tools worth adopting.** Developer tools, sandboxes and cloud VMs for agents, browser automation, code review tools, MCP servers, window managers, anything with a repo. The GitHub repo behind a product matters most: "you can go click into the website and get the GitHub, and that's what matters to me."
- **Security of agent systems.** Credential handling, prompt injection, supply-chain incidents, disclosures that affect tools he uses.

## Examples from recent saves

- A candidate rejected for not knowing how to keep API credentials away from an agent's own container, and the replies proposing answers.
- "You should be using og:video" with a portfolio demo; a short reel as og:video.
- Theo's data analysis of the cost to land changes across real threads and PRs, and his dashboard tracking Claude usage across accounts.
- A self-built code review tool with niceties GitHub and Graphite lack.
- Pomerado, an open-source browser-use alternative, announced in a ten-post thread.
- Coinbase fine-tuning Qwen3.5-9B on internal data and beating frontier models at lower cost.
- "Give Claude better taste in UI" linking bencho.dev, and Vercel open-sourcing a fast HTML artifact builder.
- Learning to build evals with decision models, linking a lab and an arXiv paper.

## What makes a reply worth keeping

Keep a reply when it adds something an agent could use later:

- The original poster answering a question, clarifying, correcting a timeline, or adding a link.
- A concrete workflow, setup, command, configuration or tool name with how to use it.
- A prompt, code, or a link to a repo, gist, paper, doc or demo.
- A substantive technical question that the thread answers, or a pointed critique with a reason (a known limitation, a cost, a security flaw).
- A pointer to a related resource by the same author, or the same idea done better elsewhere.

## What to drop

- Praise, thanks, congratulations, jokes, memes, emoji-only replies, "this is cool", "following", "where can I get this?" with no answer.
- Generic opinions with no detail, self-promotion unrelated to the post, engagement bait, bot replies, crypto spam.
- Replies that only restate the post.

When unsure, prefer keeping a reply that names a concrete tool, number, link or technique, and dropping one that does not.
