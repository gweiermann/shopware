#!/usr/bin/env bash
# Apply checked patches that gh-aw source frontmatter cannot express yet. Run this immediately after
# `gh aw compile .github/workflows/reproduce.md`.
#
# 1. The reproduce workflow exposes Shopware on 18080, separate from the gh-aw MCP gateway on 8080.
# 2. The trunk/report job must run from the authoritative post-agent artifacts, even when the
#    agent's feedback verifier emitted only a noop before the trusted post-agent verifier succeeded.
set -euo pipefail

LOCK=${1:-.github/workflows/reproduce.lock.yml}
PORT=${REPRO_SANDBOX_APP_PORT:-18080}

if [ ! -f "$LOCK" ]; then
  echo "::error::lock file not found: $LOCK"
  exit 1
fi

if grep -q -- '--allow-host-ports 80,443,8080' "$LOCK"; then
  perl -0pi -e "s/--allow-host-ports 80,443,8080(?!,${PORT})/--allow-host-ports 80,443,8080,${PORT}/g" "$LOCK"

  count=$(grep -c -- "--allow-host-ports 80,443,8080,${PORT}" "$LOCK")
  if [ "$count" -lt 2 ]; then
    echo "::error::expected both agent and detection AWF invocations to allow host port ${PORT}; found ${count}"
    exit 1
  fi

  echo "patched $LOCK to allow host port ${PORT}"
else
  echo "skipped host-port patch; no gh-aw sandbox host-port allowlist found in $LOCK"
fi

old_condition="if: (!cancelled()) && needs.agent.result != 'skipped' && contains(needs.agent.outputs.output_types, 'reproduce_on_trunk')"
new_condition="if: (!cancelled()) && needs.agent.result != 'skipped'"

if grep -Fq "$old_condition" "$LOCK"; then
  perl -0pi -e "s/\Q$old_condition\E/$new_condition/" "$LOCK"
elif ! grep -Fq "$new_condition" "$LOCK"; then
  echo "::error::could not find the expected reproduce_on_trunk job condition in $LOCK"
  exit 1
fi

if ! awk '
  $1 == "reproduce_on_trunk:" { in_job = 1; next }
  in_job && /^[^[:space:]][^:]*:/ { in_job = 0 }
  in_job && $0 ~ /if: \(!cancelled\(\)\) && needs\.agent\.result != '\''skipped'\''$/ { found = 1 }
  END { exit(found ? 0 : 1) }
' "$LOCK"; then
  echo "::error::reproduce_on_trunk is still gated on the agent safe-output handoff"
  exit 1
fi

echo "patched $LOCK to run reproduce_on_trunk from authoritative artifacts"
