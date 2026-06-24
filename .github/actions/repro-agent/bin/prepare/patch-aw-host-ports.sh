#!/usr/bin/env bash
# gh-aw currently generates the sandbox host-port allowlist from its own internal service needs.
# The reproduce workflow also exposes Shopware on 18080, separate from the gh-aw MCP gateway on
# 8080. Until gh-aw source frontmatter supports custom host ports, run this immediately after
# `gh aw compile .github/workflows/reproduce.md`.
set -euo pipefail

LOCK=${1:-.github/workflows/reproduce.lock.yml}
PORT=${REPRO_SANDBOX_APP_PORT:-18080}

if [ ! -f "$LOCK" ]; then
  echo "::error::lock file not found: $LOCK"
  exit 1
fi

if ! grep -q -- '--allow-host-ports 80,443,8080' "$LOCK"; then
  echo "::error::could not find the expected gh-aw host-port allowlist in $LOCK"
  exit 1
fi

perl -0pi -e "s/--allow-host-ports 80,443,8080(?!,${PORT})/--allow-host-ports 80,443,8080,${PORT}/g" "$LOCK"

count=$(grep -c -- "--allow-host-ports 80,443,8080,${PORT}" "$LOCK")
if [ "$count" -lt 2 ]; then
  echo "::error::expected both agent and detection AWF invocations to allow host port ${PORT}; found ${count}"
  exit 1
fi

echo "patched $LOCK to allow host port ${PORT}"
