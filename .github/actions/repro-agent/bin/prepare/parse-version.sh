#!/usr/bin/env bash
# Phase 1 — DETERMINISTIC, no agent. The ONLY thing that must be known before the agent runs is the
# reported Shopware VERSION (it decides the provision target). Everything else — executor, build
# profile, demodata, fixtures, the test — the AGENT decides on the fly and records into
# reproduction-plan.json, the single source of truth the trunk leg then provisions from.
#
# What the matcher accepts (first match wins; `v` optional; 2–4 numeric segments; `.*`/`.x`
# wildcard tail), and how each normalises to a real 4-part tag (Shopware tags are `v6.6.10.3`):
#   v6.7.2.0 / 6.7.2.0   exact 4-part           -> 6.7.2.0          (used as-is — a specific patch)
#   6.7.10               3-part (missing build) -> LATEST v6.7.10.*
#   6.7.10.*  / 6.7.10.x patch wildcard         -> LATEST v6.7.10.*
#   6.7  / 6.7.*  / 6.7.x minor only/wildcard   -> LATEST v6.7.*
#   (none found)                                -> trunk
# "16.7.10" / "8.4" etc. do NOT match — the `6` must be at a boundary and the line must start a 6.x.
#
# Underspecified versions resolve to the LATEST available patch — never `.0` (that's the FIRST
# patch). Resolution tries `gh api .../git/matching-refs/tags/<prefix>` then `git ls-remote --tags`
# (no auth needed), picking the highest via `sort -V`.
#
# Reads issue.md when present (prefetch.sh already wrote it); otherwise fetches the body via gh.
# Writes NO file — the version is a step output, injected into the prompt by build-context.sh; the
# agent authors reproduction-plan.json itself.
#
# Env: ISSUE (req); REPO (issue repo, fallback fetch); UPSTREAM (tag repo, default shopware/shopware);
#      GH_TOKEN (resolution + fallback fetch).
# Emits target_version + is_trunk to $GITHUB_OUTPUT (and stdout).
set -euo pipefail

: "${ISSUE:?ISSUE is required}"
UPSTREAM=${UPSTREAM:-shopware/shopware}

out () { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >> "$GITHUB_OUTPUT"; echo "$1=$2"; }
nseg () { printf '%s' "$1" | awk -F. '{print NF}'; }

# Resolve a (partial) version BASE to the newest existing upstream tag underneath it. The trailing
# dot ("v6.7." not "v6.7") keeps "6.7" from matching "6.70". Tries gh first, then unauthenticated
# git ls-remote; echoes the newest version (no leading v), or empty if neither could reach a tag.
resolve_latest () {
  local base="$1" out=""
  if command -v gh >/dev/null 2>&1; then
    out=$(gh api "repos/${UPSTREAM}/git/matching-refs/tags/v${base}." --jq '.[].ref' 2>/dev/null \
            | sed 's#refs/tags/##; s/^v//' | sort -V | tail -1 || true)
  fi
  if [ -z "$out" ] && command -v git >/dev/null 2>&1; then
    out=$(git ls-remote --tags --refs "https://github.com/${UPSTREAM}.git" "v${base}.*" 2>/dev/null \
            | sed 's#.*refs/tags/##; s/^v//' | sort -V | tail -1 || true)
  fi
  printf '%s' "$out"
}

# Prefer the already-prefetched issue body; fall back to a direct fetch so the script is usable
# stand-alone. Never fail the run on a fetch miss — an unreadable issue just means "no version".
BODY=""
if [ -f issue.md ]; then
  BODY=$(cat issue.md)
elif command -v gh >/dev/null 2>&1; then
  BODY=$(gh issue view "$ISSUE" --repo "${REPO:-${GITHUB_REPOSITORY:-}}" --json title,body \
           --jq '.title + "\n" + (.body // "")' 2>/dev/null || echo "")
fi

# Match a Shopware-looking version: a boundary (line start or non-digit/non-dot) so "16.7" / "8.6"
# can't false-match, then optional v, "6", 1–3 dotted numbers, and an optional `.*`/`.x` tail.
# Re-grep isolates the version from the captured boundary char. ERE only (portable; no -P/\b).
RAW=$(printf '%s' "$BODY" | grep -oiE '(^|[^0-9.])v?6(\.[0-9]+){1,3}(\.(\*|[xX]))?' | head -1 || true)
RAW=$(printf '%s' "$RAW"  | grep -oiE 'v?6(\.[0-9]+){1,3}(\.(\*|[xX]))?' || true)

VERSION=""; IS_TRUNK=true
if [ -n "$RAW" ]; then
  IS_TRUNK=false
  WILDCARD=0; case "$RAW" in *'.*'|*.[xX]) WILDCARD=1 ;; esac
  BASE=$(printf '%s' "$RAW" | sed -E 's/^[vV]//; s/\.(\*|[xX])$//')   # strip v + wildcard tail

  if [ "$WILDCARD" = 0 ] && [ "$(nseg "$BASE")" -eq 4 ]; then
    # Precise 4-part: a specific patch was reported — reproduce on exactly that one (verbatim).
    VERSION="$BASE"
  else
    # Underspecified (3-part / wildcard / minor): take the LATEST available patch, never `.0`.
    VERSION=$(resolve_latest "$BASE")
    if [ -z "$VERSION" ]; then
      # Could not reach the tag list (offline). Don't invent `.0`; degrade to trunk so the run uses
      # a real, current ref instead of a guessed-wrong patch.
      echo "::warning::could not resolve the latest patch for '${RAW}' against ${UPSTREAM} (offline?) — falling back to trunk"
      IS_TRUNK=true
    fi
  fi
fi

out target_version "${VERSION:-trunk}"
out is_trunk "$IS_TRUNK"
echo "== parse-version: matched='${RAW:-<none>}' -> target='${VERSION:-trunk}' (is_trunk=$IS_TRUNK) =="
