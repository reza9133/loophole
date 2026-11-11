#!/usr/bin/env bash
# One command for everything: set up, test offline, deploy to Studionet, run the live end-to-end
# lifecycle, and write a report.
#
#   bash run.sh                      full run: setup, offline tests, deploy, live e2e
#   bash run.sh --offline            setup and offline tests only (no network needed)
#   bash run.sh --skip-tests         skip the offline tests, go straight to deploy + live e2e
#   bash run.sh --address 0x...      run the live e2e against an existing deployment
#   bash run.sh --wait-final         wait until every transaction is FINALIZED (slow)
#   bash run.sh --strict             treat model deviations as failures too
#   bash run.sh --mutate             also run the mutation check on the contract (about 3 minutes)
#
# Works in a GitHub Codespace or any Linux/macOS shell with python3 (>= 3.10) and node (>= 20).
# Studionet needs no funds: the scripts generate throwaway accounts.

set -euo pipefail
cd "$(dirname "$0")"

OFFLINE=0
SKIP_TESTS=0
MUTATE=0
E2E_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --offline) OFFLINE=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --mutate) MUTATE=1 ;;
    --address) E2E_ARGS+=("--address" "${2:?--address needs a value}"); shift ;;
    --wait-final|--strict) E2E_ARGS+=("$1") ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }

need python3
need node
need npm

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then echo "node >= 20 is required (found $(node --version))" >&2; exit 1; fi
python3 - <<'PY' || { echo "python >= 3.10 is required" >&2; exit 1; }
import sys
sys.exit(0 if sys.version_info >= (3, 10) else 1)
PY

step "1/5 Setup"
if [ ! -d .venv ]; then python3 -m venv .venv; fi
# shellcheck disable=SC1091
. .venv/bin/activate
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements-dev.txt
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then npm install --no-audit --no-fund --loglevel=error; fi
export PYTHON="$PWD/.venv/bin/python"
echo "python $(python --version 2>&1 | cut -d' ' -f2), node $(node --version)"

step "2/5 Lint the contract (GenVM linter and validator)"
genvm-lint check contracts/loophole.py

if [ "$SKIP_TESTS" -eq 0 ]; then
  step "3/5 Offline tests (real contract on the real GenVM Python SDK, scripted model)"
  python -m pytest -q
  npm run --silent test:node
  if [ "$MUTATE" -eq 1 ]; then
    step "    Mutation check"
    python tools/mutate.py
  fi
else
  step "3/5 Offline tests skipped"
fi

if [ "$OFFLINE" -eq 1 ]; then
  printf '\nOffline run complete.\n'
  exit 0
fi

step "4/5 Live end-to-end on Studionet (deploys a fresh contract unless --address is given)"
echo "Each judgement runs a model on several validators; the full run takes roughly 10 to 25 minutes."
set +e
node scripts/e2e.mjs "${E2E_ARGS[@]+"${E2E_ARGS[@]}"}"
STATUS=$?
set -e

step "5/5 Reports"
ls -1t reports/e2e-*.md 2>/dev/null | head -1 | sed 's/^/latest report: /' || true
exit "$STATUS"
