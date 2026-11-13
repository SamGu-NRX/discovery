#!/usr/bin/env bash
# Deploys discovery-watcher to the Cloudflare account wrangler is logged in to.
#
# Creates three cloud resources if they are missing (the D1 database
# "discovery-watcher" and the R2 buckets "discovery-voice" and "x-knowledge"), applies migrations
# remotely, deploys the Worker with its one cron, the Workers AI binding, the
# R2 binding and the bridge Durable Object, sets the secrets and registers the
# production watchers.
# Watcher matches become candidates; nothing here POSTs to T3.
#
# Secrets are read from ~/.agent-secrets and piped to wrangler; none is
# printed. The five tokens and BRIDGE_TOKEN are generated on the first run.
# APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC, GITHUB_PR_TOKEN and
# GEMINI_API_KEY are set only from files that exist (see worker/README.md,
# "Turn on device approvals"); each one missing is named.
# T3_APPROVALS_WEBHOOK_URL is set only if
# ~/.agent-secrets/discovery-t3-approvals-webhook-url exists; without it,
# proposals wait unnotified.
#
# Usage: scripts/deploy-production.sh     (re-running is safe; each step checks first)

set -euo pipefail
cd "$(dirname "$0")/.."
W=node_modules/.bin/wrangler
S="$HOME/.agent-secrets"
export CI=1 WRANGLER_SEND_METRICS=false

"$W" whoami | grep -E 'logged in|Account' | head -3

umask 077
for name in discovery-admin-token discovery-websub-secret discovery-ingest-token discovery-runner-token discovery-inbox-token discovery-bridge-token discovery-knowledge discovery-knowledge-intake; do
  [ -s "$S/$name" ] || openssl rand -hex 32 > "$S/$name"
  chmod 600 "$S/$name"
done

if grep -q '00000000-0000-0000-0000-000000000000' wrangler.jsonc; then
  if ! "$W" d1 list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0));process.exit(l.some(d=>d.name==="discovery-watcher")?0:1)'; then
    "$W" d1 create discovery-watcher
  fi
  id=$("$W" d1 list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0));console.log(l.find(d=>d.name==="discovery-watcher").uuid)')
  sed -i '' "s/00000000-0000-0000-0000-000000000000/$id/" wrangler.jsonc
  echo "D1 database discovery-watcher: $id"
fi

# The R2 binding must exist before the deploy.
"$W" r2 bucket list | grep -q 'discovery-voice' || "$W" r2 bucket create discovery-voice
"$W" r2 bucket list | grep -q 'x-knowledge' || "$W" r2 bucket create x-knowledge

"$W" d1 migrations apply DB --remote
# The apply above has exited after printing only its banner, leaving a
# migration pending (0005 and 0006 on 2026-11-04). Deploying code that needs
# the new columns would then fail every request that uses them.
"$W" d1 migrations list DB --remote | grep -q "No migrations to apply" || { echo "migrations still pending; not deploying" >&2; exit 1; }
# A fresh checkout has no .wrangler/; without it tee fails and pipefail stops the script
# after the deploy but before any secret is set (2026-11-12).
mkdir -p .wrangler
"$W" deploy | tee .wrangler/deploy-output.txt
url=$(grep -oE 'https://discovery-watcher\.[a-z0-9-]+\.workers\.dev' .wrangler/deploy-output.txt | head -1)
[ -n "$url" ] || { echo "no workers.dev URL in deploy output" >&2; exit 1; }

"$W" secret put ADMIN_TOKEN < "$S/discovery-admin-token"
"$W" secret put WEBSUB_SECRET < "$S/discovery-websub-secret"
"$W" secret put INGEST_TOKEN < "$S/discovery-ingest-token"
"$W" secret put RUNNER_TOKEN < "$S/discovery-runner-token"
"$W" secret put INBOX_TOKEN < "$S/discovery-inbox-token"
"$W" secret put BRIDGE_TOKEN < "$S/discovery-bridge-token"
"$W" secret put KNOWLEDGE_TOKEN < "$S/discovery-knowledge"
"$W" secret put KNOWLEDGE_INTAKE_TOKEN < "$S/discovery-knowledge-intake"
for pair in APNS_KEY_P8:discovery-apns-key-p8 APNS_KEY_ID:discovery-apns-key-id APNS_TEAM_ID:discovery-apns-team-id             APNS_TOPIC:discovery-apns-topic GITHUB_PR_TOKEN:discovery-github-pr-token GEMINI_API_KEY:discovery-gemini-api-key; do
  if [ -s "$S/${pair#*:}" ]; then
    "$W" secret put "${pair%%:*}" < "$S/${pair#*:}"
  else
    echo "${pair%%:*} not set: no $S/${pair#*:}"
  fi
done
if [ -s "$S/discovery-t3-approvals-webhook-url" ]; then
  "$W" secret put T3_APPROVALS_WEBHOOK_URL < "$S/discovery-t3-approvals-webhook-url"
else
  echo "T3_APPROVALS_WEBHOOK_URL not set: no $S/discovery-t3-approvals-webhook-url"
fi

# Secrets reach a new deployment within seconds; wait until the token works.
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H @<(printf 'authorization: Bearer %s' "$(cat "$S/discovery-admin-token")") "$url/admin/watchers")
  [ "$code" = 200 ] && break
  sleep 2
done
node scripts/register-watchers.mjs "$url" "$S/discovery-admin-token"
echo "deployed: $url"
