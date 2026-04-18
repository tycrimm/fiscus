#!/usr/bin/env bash
# Push the contents of .dev.vars to Workers Secrets in production.
# Reads CLOUDFLARE_API_TOKEN from .env so wrangler authenticates to Tyler's
# personal account (not the SHV OAuth session).
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .dev.vars ]]; then
  echo "no .dev.vars file in repo root — copy .dev.vars.example and fill in values"
  exit 1
fi

set -a
[[ -f .env ]] && source .env
set +a

while IFS='=' read -r key value; do
  # skip blank lines and comments
  [[ -z "$key" ]] && continue
  [[ "${key:0:1}" == "#" ]] && continue
  if [[ -z "$value" ]]; then
    echo "skipping $key (empty value)"
    continue
  fi
  echo "→ pushing $key"
  printf '%s' "$value" | bunx wrangler secret put "$key"
done < .dev.vars

echo "done."
