---
name: Reproduce Issue
description: >
  Issue-driven bug reproduction expressed as a single GitHub Agentic Workflow (gh-aw).
  The agent's SOLE responsibility is discovering a reliable reproduction artifact on a
  ready-made live instance. Version parsing, provisioning, DB snapshotting, verification,
  the trunk re-run, the verdict and the issue comment are ALL deterministic scripts — the
  agent never decides the outcome. Compile with `gh aw compile` (emits the .lock.yml).

# --- Triggers ----------------------------------------------------------------
# /reproduce in an issue (body or comment), the one-shot ci:reproduce label, or a manual dispatch.
# Only collaborators may trigger (`roles:` is an exact-match allowlist; dispatch already requires
# write access).
on:
  slash_command:
    name: reproduce
    events: [issues, issue_comment]
  label_command:
    name: ci:reproduce
    events: [issues]
  workflow_dispatch:
    inputs:
      issue_number:
        description: "Issue number to reproduce (required for manual dispatch)"
        required: false
        type: number
  roles: [admin, maintainer, write]
# NOTE: there are intentionally NO executor / build / demodata inputs — the agent decides those on
# the fly and records them in reproduction-plan.json (which the trunk leg then provisions from).

# One run per issue; never cancel an in-flight reproduction.
run-name: "Reproduce #${{ github.event.issue.number || inputs.issue_number }}"
concurrency:
  group: reproduce-${{ github.event.issue.number || inputs.issue_number }}
  cancel-in-progress: false

# Agent job stays READ-ONLY. All writes go through safe-outputs: the verdict comment via the
# `reproduce-on-trunk` job, and the "could not build" comment is posted by that same job.
permissions:
  contents: read
  issues: read     # prefetch.sh reads the issue body/comments + attached screenshots

# The agent reaches the provisioned Shopware proxy through host.docker.internal:18080.
# gh-aw source frontmatter does not yet expose a custom host-port field, so compile the lock
# file and then run the checked lock patch script to append 18080 to the generated AWF command.
network:
  allowed:
    - defaults
    - local

engine:
  id: claude
  model: claude-sonnet-4-6

# Per-run gh-aw AI Credits cap. This keeps the workflow optimized around cost/token efficiency
# instead of trying to consume the whole turn budget.
max-ai-credits: 400

# Headroom for the agent step: authoring + ONE synchronous verify that may build the Admin/
# Storefront (slow) and run the executor. Builds can take ~10 min, so give the step room.
timeout-minutes: 40

# --- Tools the AGENT may use (Phase 3–5: discover, decide, self-verify) ------
# The agent authors its OWN files (declaring build_profile/demodata in the plan), uses normal
# read/search commands for source discovery, uses reproctl only for repro-specific live feedback,
# and should use Shopware MCP for live data introspection once available. The authoritative
# reported-version verification and artifact publication happen in deterministic post-agent steps.
# No github MCP (issue context is prefetched).
tools:
  # CRITICAL: gh-aw defaults the Bash tool to a 60s timeout, which would kill the long
  # reproctl verify (builds + verify run for many minutes) — so the agent backgrounds it and
  # the result is lost. Raise the per-call timeout to 30 min so verify runs SYNCHRONOUSLY to
  # completion (drives BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS).
  timeout: 1800
  edit:                 # author/rewrite reproduction-plan.json + fixtures.json + the spec/test
  github: false         # context is prefetched to files; no GitHub MCP/API is needed in the agent
  bash:
    - "node /tmp/reproctl/reproctl.mjs:*"
    - "rg:*"
    - "find:*"
    - "sed:*"
    - "cat:*"
    - "ls:*"
    - "head:*"
    - "tail:*"
    - "grep:*"
    - "sort:*"
    - "wc:*"
    - "pwd"
    - "jq:*"
    - "git log:*"
    - "git show:*"
    - "git blame:*"

mcp-servers:
  shopware:
    type: http
    url: "http://127.0.0.1:18765/mcp"

# --- Phase 1 + 2: DETERMINISTIC pre-agent steps (in the agent job) -----------
# checkout → prefetch issue/screenshots → parse version (regex) → provision the
# reported version → snapshot the clean DB → assemble the agent's single context file → export
# the live-shop coordinates → install Playwright. The agent starts with a ready-to-use instance.
steps:
  - name: Checkout
    uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
    with:
      persist-credentials: false

  # Phase 1 — the ONLY pre-agent decision: prefetch the issue/screenshots, then extract the
  # reported version by regex (first valid wins; none → trunk) and emit it as a step output. The
  # agent authors reproduction-plan.json (executor/build_profile/demodata/version). NO agent here.
  - name: Prefetch issue context
    env:
      ISSUE: ${{ github.event.issue.number || inputs.issue_number }}
      GH_TOKEN: ${{ github.token }}
    run: bash .github/actions/repro-agent/bin/prepare/prefetch.sh

  - name: Parse reported version (Phase 1)
    id: parse
    env:
      ISSUE: ${{ github.event.issue.number || inputs.issue_number }}
      GH_TOKEN: ${{ github.token }}   # resolves 3-part / wildcard / minor versions to the newest real tag
    run: bash .github/actions/repro-agent/bin/prepare/parse-version.sh

  # Phase 2 — Environment Preparation: provision the reported version (or trunk when none was
  # found) with the Admin + Storefront ALREADY BUILT, so the agent never waits on a (slow) JS build
  # mid-run — any executor works immediately. The agent still records which builds its repro needs
  # in reproduction-plan.json's build_profile so the TRUNK leg builds only those. demodata stays off
  # (it's cheap + conditional; reproctl verify generates it on demand). Then snapshot.
  - name: Register legacy Shopware 6.6 conflicts package alias
    if: steps.parse.outputs.legacy_conflicts_alias == 'true'
    run: bash .github/actions/repro-agent/bin/prepare/provision-legacy-alias.sh

  - name: Setup reported Shopware (Phase 2)
    uses: shopware/setup-shopware@e12701e21d8a6003103426969ba544cdc91bf41c # v2.0.12
    with:
      shopware-version: ${{ steps.parse.outputs.provision_version }}
      shopware-repository: shopware/shopware
      path: shop
      php-version: "8.4"
      composer-root-version: ${{ steps.parse.outputs.composer_root_version }}
      mysql-version: "builtin"
      install: "true"
      install-admin: "true"
      install-storefront: "true"
      skip-js-build: "false"
      allow-insecure-versions: "true"
      env: prod

  - name: Finalize reported provision (Phase 2)
    id: provision
    env:
      SHOP_DIR: shop
      DEMODATA: "false"
    run: bash .github/actions/repro-agent/bin/prepare/provision-finalize.sh

  - name: Expose Shopware on sandbox host port
    env:
      TARGET_URL: ${{ steps.provision.outputs.app_url }}
      SANDBOX_APP_PORT: "18080"
    run: bash .github/actions/repro-agent/bin/prepare/expose-sandbox-port.sh

  - name: Snapshot clean DB
    run: bash .github/actions/repro-agent/bin/prepare/db-snapshot.sh

  # Assemble the single context file the agent reads. The version is injected from the parse step.
  - name: Assemble agent context
    env:
      ISSUE: ${{ github.event.issue.number || inputs.issue_number }}
      VERSION: ${{ steps.parse.outputs.is_trunk == 'true' && 'trunk' || steps.parse.outputs.target_version }}
    run: bash .github/actions/repro-agent/bin/prepare/build-context.sh

  # Export the live-shop credentials. APP_URL was pinned to the sandbox-visible proxy above.
  - name: Export shop coordinates
    run: |
      {
        echo "SW_ACCESS_KEY=${{ steps.provision.outputs.access_key }}"
        echo "ADMIN_USER=admin"
        echo "ADMIN_PASS=shopware"
      } >> "$GITHUB_ENV"

  - name: Setup Node + Playwright
    uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
    with:
      node-version: 22
  - name: Install Playwright
    run: |
      npm init -y >/dev/null
      npm i -D @playwright/test
      npx playwright install --with-deps chromium

  - name: Install immutable reproctl
    run: |
      set -euo pipefail
      rm -rf /tmp/reproctl /tmp/repro-playwright
      mkdir -p /tmp/reproctl
      cp -R .github/actions/repro-agent/bin /tmp/reproctl/bin
      cp .github/actions/repro-agent/bin/agent/reproctl.mjs /tmp/reproctl/reproctl.mjs
      cp .github/actions/repro-agent/repro.playwright.config.ts /tmp/reproctl/repro.playwright.config.ts
      cp .github/actions/repro-agent/repro-video.js /tmp/reproctl/repro-video.js
      ln -s "$PWD/node_modules" /tmp/reproctl/node_modules
      chmod -R a-w /tmp/reproctl
      echo "REPROCTL_ROOT=/tmp/reproctl" >> "$GITHUB_ENV"
      echo "REPRO_AGENT_ROOT=/tmp/reproctl" >> "$GITHUB_ENV"
      echo "REPRO_AGENT_BIN=/tmp/reproctl/bin" >> "$GITHUB_ENV"

  - name: Start Shopware MCP bridge
    env:
      SHOPWARE_MCP_AVAILABLE: ${{ steps.provision.outputs.mcp_available }}
      SHOPWARE_MCP_URL: "http://127.0.0.1:18080/api/_mcp"
      SHOPWARE_MCP_ACCESS_KEY: ${{ steps.provision.outputs.mcp_access_key }}
      SHOPWARE_MCP_SECRET_ACCESS_KEY: ${{ steps.provision.outputs.mcp_secret_access_key }}
      SHOPWARE_MCP_BRIDGE_PORT: "18765"
    run: |
      set -euo pipefail
      nohup node /tmp/reproctl/bin/agent/shopware-mcp-bridge.mjs --http >/tmp/shopware-mcp-bridge.log 2>&1 &
      echo "$!" > /tmp/shopware-mcp-bridge.pid
      for i in $(seq 1 20); do
        if curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:18765/mcp | grep -q '^405$'; then
          echo "Shopware MCP bridge listening on 127.0.0.1:18765"
          exit 0
        fi
        sleep 0.5
      done
      cat /tmp/shopware-mcp-bridge.log || true
      echo "::error::Shopware MCP bridge did not start."
      exit 1

  - name: Record pre-agent workspace baseline
    run: git status --porcelain > /tmp/repro-agent-pre-status.txt

# gh-aw builds prompt.txt in the activation job and downloads it into /tmp/gh-aw later in the agent
# job. Finalize the prompt here, after that artifact is restored and before MCP/engine setup, so the
# activation artifact cannot overwrite the run-specific task/context.
pre-agent-steps:
  - name: Finalize explicit agent task prompt
    env:
      ISSUE: ${{ github.event.issue.number || inputs.issue_number }}
      GH_AW_PROMPT: /tmp/gh-aw/aw-prompts/prompt.txt
    run: bash .github/actions/repro-agent/bin/prepare/agent-task-prompt.sh

# --- Validate + publish only deterministic post-agent outputs ----------------
# The agent can run reproctl verify for feedback, but that path does not publish result.json.
# After the agent stops, trusted steps reject workspace tampering, validate the generated bundle as
# hostile input, rerun the reported-version verification from the immutable tool copy, and only then
# upload result.json for the trunk/verdict job.
post-steps:
  - name: Reject protected workflow/helper edits
    id: protected_guard
    if: always()
    run: |
      set -euo pipefail
      protected_status=$(git status --porcelain -- \
        .github/actions/repro-agent/bin \
        .github/actions/repro-agent/prompts \
        .github/actions/repro-agent/README.md \
        .github/actions/repro-agent/repro.playwright.config.ts \
        .github/actions/repro-agent/repro-video.js \
        .github/workflows/reproduce.md \
        .github/workflows/reproduce.lock.yml)
      if [ -n "$protected_status" ]; then
        echo "::error::Agent modified protected workflow/helper files; refusing to publish reproduction artifacts."
        printf '%s\n' "$protected_status"
        exit 1
      fi

  - name: Reject non-bundle workspace edits
    id: bundle_guard
    if: always()
    run: |
      set -euo pipefail
      git status --porcelain > /tmp/repro-agent-post-status.txt
      new_status=$(comm -13 <(sort /tmp/repro-agent-pre-status.txt) <(sort /tmp/repro-agent-post-status.txt) || true)
      blocked=""
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        path=${line:3}
        path=${path#\"}
        path=${path%\"}
        case "$path" in
          reproduction-plan.json|fixtures.json|repro.sh|repro.spec.ts|ReproTest.php|\
          builder-result.json|result.json|seed-error.txt|phpunit-output.txt|admin-state.json|\
          pw-*.txt|pw-*.json|.repro-*|test-results/*|playwright-report/*)
            ;;
          *)
            blocked="${blocked}${line}"$'\n'
            ;;
        esac
      done <<< "$new_status"
      if [ -n "$blocked" ]; then
        echo "::error::Agent created or modified files outside the generated reproduction bundle/artifacts."
        printf '%s\n' "$blocked"
        exit 1
      fi

  - name: Authoritative reported-version verification
    id: reported_verify
    if: always() && steps.protected_guard.outcome == 'success' && steps.bundle_guard.outcome == 'success' && hashFiles('reproduction-plan.json') != ''
    continue-on-error: true
    env:
      REPROCTL_ALLOW_AUTHORITATIVE: "1"
    run: |
      set -euo pipefail
      export APP_URL="${REPRO_HOST_APP_URL:?REPRO_HOST_APP_URL is not set}"
      node /tmp/reproctl/reproctl.mjs validate
      node /tmp/reproctl/reproctl.mjs verify-authoritative

  - name: Upload repro bundle
    if: always() && steps.protected_guard.outcome == 'success' && steps.bundle_guard.outcome == 'success'
    uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
    with:
      name: repro-plan
      path: |
        reproduction-plan.json
        fixtures.json
        repro.sh
        repro.spec.ts
        ReproTest.php
      if-no-files-found: ignore
      retention-days: 7

  - name: Upload reported leg
    if: always() && steps.protected_guard.outcome == 'success' && steps.bundle_guard.outcome == 'success' && hashFiles('result.json') != ''
    uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
    with:
      name: repro-reported
      path: |
        result.json
        seed-error.txt
        repro.sh
        repro.spec.ts
        ReproTest.php
        phpunit-output.txt
        test-results/
        playwright-report/
      if-no-files-found: ignore
      retention-days: 7

  # NOTE: the deterministic "could not build" comment is posted by the reproduce-on-trunk job
  # (it handles the no-bundle case too) — not here. A post-step cannot emit a safe output: gh-aw
  # ingests $GH_AW_SAFE_OUTPUTS BEFORE post-steps run, so anything appended here is never read.

# --- Phase 6 + 7: DETERMINISTIC trunk re-run + verdict + report (clean runner) ---
# Triggered by the agent-facing reproctl verify command only as a downstream pipeline request. The
# trusted reported leg is NOT the agent's feedback run: post-agent steps rerun validation and
# reported-version verification from the immutable tool copy, upload result.json only on success,
# and this safe-output job refuses to continue when that authoritative artifact is missing. It runs
# on a FRESH runner, provisions the next version FROM reproduction-plan.json
# (executor/build_profile/demodata the agent recorded), runs the EXACT same authored bundle
# (no regeneration, no agent), computes the verdict from the two leg statuses, renders the comment
# from templates, and posts it.
#
# NOTE: gh-aw does not currently expose a source-level final/conclusion hook. After compiling this
# file, keep the generated lock-file host-port patch above and the conclusion patch that renders
# bin/report/status-comment.mjs and posts the concise final status comment for crash/noop/skipped
# handoff/giveup cases.
safe-outputs:
  # The agent is sandboxed again; keep gh-aw threat detection enabled for the tiny safe-output
  # request that only asks the deterministic trunk job to inspect post-agent artifacts.
  threat-detection: true
  jobs:
    reproduce-on-trunk:
      description: >
        INTERNAL — do NOT call this tool yourself. reproctl verify requests it automatically once
        your candidate bundle is classified. The deterministic post-agent steps rerun the reported
        leg before this job can use the bundle, then this job runs trunk and posts the verdict.
        You decide nothing here.
      runs-on: ubuntu-latest
      permissions:
        contents: write   # embed-evidence pushes screenshots to the orphan evidence branch
        issues: write      # post the verdict comment
      output: "Trunk reproduction complete; verdict comment posted."
      env:
        FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"
      # Informational only — the job reads reproduction-plan.json itself and decides nothing from these.
      inputs:
        executor:
          description: "The executor of the verified bundle (http | playwright | direct), or 'none' on give-up"
          required: false
          type: string
        status:
          description: "verify-reproduction outcome: reproduced | not_reproduced | giveup"
          required: false
          type: string
      steps:
        - name: Checkout
          uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
          with:
            persist-credentials: false

        - name: Download repro bundle
          continue-on-error: true
          uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
          with:
            name: repro-plan
        - name: Download reported leg
          continue-on-error: true
          uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
          with:
            name: repro-reported
            path: artifacts/repro-reported

        # One source of truth: did the agent produce a runnable plan AND a classified reported leg?
        # The authoritative post-agent reported verification writes result.json only on a
        # classified outcome, so its presence
        # distinguishes success from give-up/crash. Every reproduction step below is gated on this;
        # otherwise we post the deterministic "could not reproduce" note.
        - name: Detect bundle
          id: bundle
          run: |
            has=$([ -f reproduction-plan.json ] && [ -f artifacts/repro-reported/result.json ] && echo true || echo false)
            echo "has=$has" >> "$GITHUB_OUTPUT"
            echo "bundle+reported-result present: $has"

        # ---- No bundle: leave the final issue comment to the conclusion job. ----
        - name: Record missing reproduction bundle (Phase 7)
          if: steps.bundle.outputs.has != 'true'
          env:
            RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          run: |
            {
              echo "## Reproduction (gh-aw): Pipeline failed"
              echo
              echo "No classified reported-version result was uploaded. The conclusion job will post the final status comment with the agent summary."
              echo
              echo "[Run details]($RUN_URL)"
            } > no-repro.md
            cat no-repro.md >> "$GITHUB_STEP_SUMMARY"

        # ---- Bundle present: Phase 6 (trunk re-run) + Phase 7 (verdict + report). ----
        - name: Derive trunk leg parameters
          id: plan
          if: steps.bundle.outputs.has == 'true'
          env:
            LEG_VERSION: trunk
            BRANCH: trunk
          run: REPRO_PLAN=reproduction-plan.json bash .github/actions/repro-agent/bin/report/leg-plan.sh

        - name: Provision trunk (Phase 6)
          if: steps.bundle.outputs.has == 'true'
          id: provision-setup
          continue-on-error: true
          uses: shopware/setup-shopware@e12701e21d8a6003103426969ba544cdc91bf41c # v2.0.12
          with:
            shopware-version: trunk
            shopware-repository: shopware/shopware
            path: shop
            php-version: "8.4"
            composer-root-version: ".auto"
            mysql-version: "builtin"
            install: "true"
            install-admin: ${{ steps.plan.outputs.admin_build }}
            install-storefront: ${{ steps.plan.outputs.storefront_build }}
            skip-js-build: ${{ (steps.plan.outputs.admin_build == 'false' && steps.plan.outputs.storefront_build == 'false') && 'true' || 'false' }}
            allow-insecure-versions: "true"
            env: prod

        - name: Finalize trunk provision (Phase 6)
          id: provision
          if: steps.bundle.outputs.has == 'true'
          continue-on-error: true
          env:
            PREVIOUS_OUTCOME: ${{ steps.provision-setup.outcome }}
            SHOP_DIR: shop
            DEMODATA: ${{ steps.plan.outputs.demodata }}
          run: bash .github/actions/repro-agent/bin/prepare/provision-finalize.sh

        - name: Seed fixtures
          id: seed
          if: steps.bundle.outputs.has == 'true' && steps.provision.outcome == 'success'
          continue-on-error: true
          env:
            APP_URL: ${{ steps.provision.outputs.app_url }}
          run: PAYLOAD=fixtures.json bash .github/actions/repro-agent/bin/execute/seed.sh

        - name: Setup Node + Playwright
          if: steps.bundle.outputs.has == 'true' && steps.plan.outputs.executor == 'playwright' && steps.provision.outcome == 'success' && steps.seed.outcome == 'success'
          uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
          with:
            node-version: 22
        - name: Install Playwright
          if: steps.bundle.outputs.has == 'true' && steps.plan.outputs.executor == 'playwright' && steps.provision.outcome == 'success' && steps.seed.outcome == 'success'
          run: |
            npm init -y >/dev/null
            npm i -D @playwright/test
            npx playwright install --with-deps chromium

        - name: Mark trunk leg blocked (dead env)
          if: steps.bundle.outputs.has == 'true' && (steps.provision.outcome == 'failure' || steps.seed.outcome == 'failure')
          env:
            TARGET: trunk
            FAILED: ${{ steps.seed.outcome == 'failure' && 'seed' || 'provision' }}
            REPRO_PLAN: reproduction-plan.json
          run: bash .github/actions/repro-agent/bin/report/leg-blocked.sh

        - name: Run executor on trunk (Phase 6)
          if: steps.bundle.outputs.has == 'true' && steps.provision.outcome != 'failure' && steps.seed.outcome != 'failure'
          env:
            TARGET: trunk
            EXECUTOR: ${{ steps.plan.outputs.executor }}
            REPRO_PLAN: reproduction-plan.json
            APP_URL: ${{ steps.provision.outputs.app_url }}
            SW_ACCESS_KEY: ${{ steps.provision.outputs.access_key }}
          run: bash .github/actions/repro-agent/bin/execute/run-leg.sh

        - name: Generate narrated trunk video evidence
          if: steps.bundle.outputs.has == 'true' && steps.plan.outputs.executor == 'playwright' && steps.provision.outcome != 'failure' && steps.seed.outcome != 'failure'
          continue-on-error: true
          env:
            TARGET: trunk
            REPRO_PLAN: reproduction-plan.json
            LEG_RESULT: result.json
            APP_URL: ${{ steps.provision.outputs.app_url }}
          run: bash .github/actions/repro-agent/bin/execute/run-narrated-video.sh

        # Arrange the two legs + the plan the way verdict.sh / report.sh expect.
        - name: Collect artifacts
          if: steps.bundle.outputs.has == 'true'
          run: |
            set -euo pipefail
            mkdir -p artifacts/repro-plan artifacts/repro-trunk
            cp reproduction-plan.json artifacts/repro-plan/ 2>/dev/null || true
            cp fixtures.json artifacts/repro-plan/ 2>/dev/null || true
            cp result.json artifacts/repro-trunk/ 2>/dev/null || true
            cp -r test-results playwright-report artifacts/repro-trunk/ 2>/dev/null || true
            cp -r narrated-result.json pw-report-narrated.json pw-stdout-narrated.txt pw-stderr-narrated.txt test-results-narrated playwright-report-narrated narrated-video artifacts/repro-trunk/ 2>/dev/null || true

        # Phase 7 — deterministic verdict (no agent) from the two leg statuses + the plan.
        - name: Compute verdict (Phase 7)
          id: verdict
          if: steps.bundle.outputs.has == 'true'
          run: MODE=reproduce ART=artifacts bash .github/actions/repro-agent/bin/report/verdict.sh

        # Phase 7 — render the comment from templates (no agent-generated prose).
        - name: Render comment (Phase 7)
          if: steps.bundle.outputs.has == 'true' && steps.verdict.outputs.has_results == 'true'
          env:
            MODE: reproduce
            ISSUE: ${{ github.event.issue.number || inputs.issue_number }}
            VERDICT: ${{ steps.verdict.outputs.verdict }}
            FIX: ${{ steps.verdict.outputs.fix_candidate }}
            UNSURE: ${{ steps.verdict.outputs.unsure_reason }}
            RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
            OMIT_BUNDLE_DETAILS: ${{ (steps.verdict.outputs.verdict == 'needs_human_review' || steps.verdict.outputs.verdict == 'blocked') && 'true' || 'false' }}
          run: bash .github/actions/repro-agent/bin/report/report.sh

        - name: Embed inline evidence
          if: steps.bundle.outputs.has == 'true' && steps.verdict.outputs.has_results == 'true' && steps.verdict.outputs.verdict != 'blocked'
          continue-on-error: true
          env:
            BRANCH: ${{ vars.REPRO_EVIDENCE_BRANCH || 'ci/repro-evidence' }}
            REPO: ${{ github.repository }}
            RUN_ID: ${{ github.run_id }}
            TOKEN: ${{ github.token }}
          run: bash .github/actions/repro-agent/bin/report/embed-evidence.sh

        - name: Post comment (Phase 7)
          if: steps.bundle.outputs.has == 'true' && steps.verdict.outputs.has_results == 'true'
          env:
            GH_TOKEN: ${{ github.token }}
            ISSUE: ${{ github.event.issue.number || inputs.issue_number }}
          run: gh issue comment "$ISSUE" --repo "${{ github.repository }}" --body-file comment.md
---

# Reproduce a Shopware bug — produce ONE verified reproduction, then stop

A live shop on the **reported version** is up (Admin + Storefront already built). Your only job is to
reproduce the reported bug on it and prove it. You do **not** parse the version, run the trunk
comparison, decide the verdict, or write the issue comment — deterministic scripts own all of that.

**Start by reading `build-context.md`** in the workspace root and following it — the compact brief
for this run (classification, issue inputs, bounded Shopware source/test discovery, and the output
contract). Author only your own files: `reproduction-plan.json`, `fixtures.json`, and one of
`repro.spec.ts` / `ReproTest.php`.

**Your terminal action is `node /tmp/reproctl/reproctl.mjs verify`.** When your candidate bundle
classifies, it requests the deterministic pipeline and prints **STOP** — your job is then over. Run
it in the **FOREGROUND and WAIT** (it can take minutes; never `&` / `run_in_background` / poll). The
trusted reported leg is rerun after you stop, from an immutable copy of the verifier, before any
artifact is published. If you genuinely cannot reproduce, run `node /tmp/reproctl/reproctl.mjs
giveup`. Do not call the `reproduce-on-trunk` tool yourself; you decide nothing about the verdict.
