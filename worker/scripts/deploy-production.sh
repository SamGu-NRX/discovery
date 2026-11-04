#!/usr/bin/env bash
# Deploys discovery-watcher to the Cloudflare account wrangler is logged in to.
#
# Creates exactly one cloud resource (the D1 database "discovery-watcher"),
# applies migrations remotely, deploys the Worker with its one cron, sets three
# secrets and registers the production watchers. The first checks run right
# after registration, and the Greenhouse seed sends one POST to the T3 webhook.
#
# Secrets are read from ~/.agent-secrets and piped to wrangler; none is
# printed. ADMIN_TOKEN and WEBSUB_SECRET are generated on the first run.
#
# Usage: scripts/deploy-production.sh     (re-running is safe; each step checks first)

set -euo pipefail
cd "$(dirname "$0")/.."
W=node_modules/.bin/wrangler
S="$HOME/.agent-secrets"
export CI=1 WRANGLER_SEND_METRICS=false

[ -s "$S/discovery-t3-webhook-url" ] || { echo "missing $S/discovery-t3-webhook-url" >&2; exit 1; }
"$W" whoami | grep -E 'logged in|Account' | head -3

umask 077
for name in discovery-admin-token discovery-websub-secret; do
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

"$W" d1 migrations apply DB --remote
"$W" deploy | tee .wrangler/deploy-output.txt
url=$(grep -oE 'https://discovery-watcher\.[a-z0-9-]+\.workers\.dev' .wrangler/deploy-output.txt | head -1)
[ -n "$url" ] || { echo "no workers.dev URL in deploy output" >&2; exit 1; }

"$W" secret put ADMIN_TOKEN < "$S/discovery-admin-token"
"$W" secret put WEBSUB_SECRET < "$S/discovery-websub-secret"
"$W" secret put T3_WEBHOOK_URL < "$S/discovery-t3-webhook-url"

# Secrets reach a new deployment within seconds; wait until the token works.
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H @<(printf 'authorization: Bearer %s' "$(cat "$S/discovery-admin-token")") "$url/admin/watchers")
  [ "$code" = 200 ] && break
  sleep 2
done
node scripts/register-watchers.mjs "$url" "$S/discovery-admin-token"
echo "deployed: $url"
