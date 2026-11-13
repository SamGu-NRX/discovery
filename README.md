# discovery

- `worker/`: Cloudflare Worker and D1. Watchers, X ingest, scoring, candidates, proposals and approval links. Deployed as `discovery-watcher`.
- `extension/`: browser extension that captures posts from X's own web responses in Sam's logged-in browser.
- `runner/`: Mac process that reads each candidate's full context, decides one action, does the reversible steps and records a proposal.

Interfaces are in [docs/CONTRACT.md](docs/CONTRACT.md).
