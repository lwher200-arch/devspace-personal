#!/bin/sh
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js is required. See package.json and https://nodejs.org/.' 'Then run this script again; see docs/setup.md.'
  exit 1
fi
exec node "$(dirname "$0")/scripts/deploy.mjs" "$@"
