# discovery

Turns what Sam's X accounts see into finished work, asking him only before an irreversible step.

- `worker/`: Cloudflare Worker and D1. Watchers, X ingest, scoring, candidates, proposals, device-signed approvals, the agent mailbox, Sam's inbox and brief, and the agent bridge. Deployed as `discovery-watcher`.
- `extension/`: browser extension that captures posts from X's own web responses in Sam's logged-in browser.
- `runner/`: Mac process that reads each candidate's full context, decides one action, does the reversible steps and records a proposal.

Interfaces are in [docs/CONTRACT.md](docs/CONTRACT.md). The iPhone app's contract with the Worker (device-signed approvals, the inbox, the brief and voice notes) is [docs/APPROVALS.md](docs/APPROVALS.md).
