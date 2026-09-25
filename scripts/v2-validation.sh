#!/usr/bin/env bash
# Runs the "V2 validation" workflow locally, step for step, plus the README
# plugin-list check from update-readme.yml. Keep the steps in sync with
# .github/workflows/v2-validation.yml when either changes.
#
# Requirements: the core checkout next to this repository as ../TeleBox-Core
# (a real directory, not a symlink), and Node.js 24. Three tests inject
# failures through file permissions; they skip themselves under root, so run
# as an ordinary user to cover them.
set -euo pipefail

plugins="$(cd "$(dirname "$0")/.." && pwd)"
core="$(dirname "$plugins")/TeleBox-Core"

if [ -L "$core" ] || [ ! -d "$core" ]; then
  echo "Core checkout not found at $core (it must be a real directory, not a symlink)" >&2
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]; then
  echo "Node.js 24 is required, but this is $(node --version)" >&2
  exit 1
fi

step() {
  echo
  echo "== $1"
}

step "Check formatting"
(cd "$plugins" && npx --yes prettier@3.9.9 --check "*/v2.ts" "*/v2/**/*.ts" "scripts/*.test.js")

step "Install core dependencies"
(cd "$core" && npm ci)

step "Build and type-check core"
(cd "$core" && npm run build:v2 && npm run typecheck:v2 && npm run check:v2)

step "Type-check plugins"
(cd "$plugins" && ../TeleBox-Core/node_modules/.bin/tsc -p tsconfig.v2.json --noEmit)

step "Load every plugin artifact"
(cd "$core" && npm run test:plugins:v2)

step "Run plugin behavior tests"
(cd "$plugins" && node --test --test-timeout=120000 scripts/*.test.js)

step "Check the README plugin list"
(cd "$plugins" && node scripts/update-readme.js --check)

echo
echo "All steps passed"
