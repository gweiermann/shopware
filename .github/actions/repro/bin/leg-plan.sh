#!/usr/bin/env bash
# Derive one reproduce leg's parameters from the plan + the leg's matrix version.
#
# Env: LEG_VERSION (req, the matrix entry), BRANCH (default trunk),
#      REPRO_PLAN (default repro-plan.json; ANALYSIS compatibility fallback).
# Emits role|version|executor|admin_build|storefront_build to $GITHUB_OUTPUT (and stdout).
set -euo pipefail

: "${LEG_VERSION:?LEG_VERSION is required}"
BRANCH=${BRANCH:-trunk}
REPRO_PLAN=${REPRO_PLAN:-${ANALYSIS:-repro-plan.json}}

out () { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >> "$GITHUB_OUTPUT"; echo "$1=$2"; }

# role derived: the leg whose version is the branch is "trunk", else "reported".
if [ "$LEG_VERSION" = "$BRANCH" ]; then ROLE=trunk; else ROLE=reported; fi
out role "$ROLE"
out executor "$(jq -r .executor "$REPRO_PLAN")"
# trunk leg provisions the branch ref as-is (default trunk); reported leg pins the
# exact released tag (v-prefixed).
if [ "$ROLE" = "trunk" ]; then out version "$LEG_VERSION"; else out version "v$LEG_VERSION"; fi
out admin_build "$(jq -r .build_profile.admin_build "$REPRO_PLAN")"
out storefront_build "$(jq -r .build_profile.storefront_build "$REPRO_PLAN")"
