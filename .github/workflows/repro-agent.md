---
name: Reproduce Issue (gh-aw)
description: >
  Issue-driven bug reproduction expressed as a single GitHub Agentic Workflow (gh-aw).
  The agent's SOLE responsibility is discovering a reliable reproduction artifact on a
  ready-made live instance. Version parsing, provisioning, DB snapshotting, verification,
  the trunk re-run, the verdict and the issue comment are ALL deterministic scripts — the
  agent never decides the outcome. Compile with `gh aw compile` (emits the .lock.yml).

# --- Triggers ----------------------------------------------------------------
# /repro-agent in an issue (body or comment), or a manual dispatch. Only collaborators may
# trigger (`roles:` is an exact-match allowlist; dispatch already requires write access).
on:
  slash_command:
    name: repro-agent
    events: [issues, issue_comment]
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
concurrency:
  group: repro-agent-${{ github.event.issue.number || inputs.issue_number }}
  cancel-in-progress: false

# strict: false is REQUIRED to run the agent on-host (sandbox.agent: false below) so it can reach
# the localhost-provisioned Shopware to self-verify. We do not otherwise rely on the relaxation:
# the agent job is still read-only and every write still flows through safe-outputs. See
# .github/actions/repro-agent/README.md → "Known trade-offs".
strict: false

# Agent job stays READ-ONLY. All writes go through safe-outputs: the verdict comment via the
# `reproduce-on-trunk` job, and the "could not build" comment is posted by that same job.
permissions:
  contents: read
  issues: read     # prefetch.sh reads the issue body/comments + linked fix PR

engine:
  id: claude
  model: claude-sonnet-4-6
  # Bounded reproduction loop (author → verify → at most a couple of fixes). Mirrors the
  # hand-written build-repro --max-turns budget; the runbook (BUILD.md) enforces the discipline.
  max-turns: 30
  # The claude engine reads ANTHROPIC_API_KEY; this repo standardises on the
  # QUALITY_INITIATIVE_ANTHROPIC_API_KEY secret (same as reproduce.yml), so map it here.
  env:
    ANTHROPIC_API_KEY: ${{ secrets.QUALITY_INITIATIVE_ANTHROPIC_API_KEY || secrets.ANTHROPIC_API_KEY }}

timeout-minutes: 35

# Run the agent on the runner host (NOT in the AWF network sandbox): it must reach the
# localhost-provisioned Shopware instance to self-verify the reproduction (verify-reproduction.sh /
# shop-get.sh hit http://localhost:8000), exactly like the hand-written claude-code-action job.
# The trust boundary is preserved by other means — the agent job is read-only (contents: read),
# its bash is an allow-list of read-only/verifier scripts, it has no GitHub write access (writes
# go through safe-outputs), and the instance is ephemeral.
sandbox:
  agent: false
features:
  dangerously-disable-sandbox-agent: "Agent must reach the localhost-provisioned Shopware to self-verify the repro; it is read-only, runs only allow-listed scripts, and has no GitHub write access (safe-outputs only)."

# --- Tools the AGENT may use (Phase 3–5: discover, decide, self-verify) ------
# The agent authors its OWN files (declaring build_profile/demodata in the plan), inspects the shop
# read-only, runs the ONE verify command (which builds Admin/Storefront/demodata per the plan,
# verifies, hands off, and STOPS it), and does TARGETED source lookups only AFTER a failed verify.
# No github MCP (issue + fix-PR are prefetched); the build helpers are internal to verify, not
# separate agent tools (fewer turns).
tools:
  edit:                 # author/rewrite reproduction-plan.json + fixtures.json + the spec/test
  github: false         # context is prefetched to files; keep the agent off the API
  bash:
    - "bash .github/actions/repro-agent/bin/agent/verify-reproduction.sh"  # build(per plan)+verify; on success records + hands off + STOPS the agent
    - "bash .github/actions/repro-agent/bin/agent/shop-get.sh"             # read-only live-shop entity inspector
    - "jq"
    - "rg"
    - "grep"
    - "find"
    - "cat"
    - "ls"
    - "head"
    - "tail"
    - "sed"
    - "wc"
    - "git log"
    - "git show"
    - "git diff"
    - "git blame"
    - "cp"
    - "mkdir"

# --- Phase 1 + 2: DETERMINISTIC pre-agent steps (in the agent job) -----------
# checkout → guard → prefetch issue/fix-PR/screenshots → parse version (regex) → provision the
# reported version → snapshot the clean DB → assemble the agent's single context file → export
# the live-shop coordinates → install Playwright. The agent starts with a ready-to-use instance.
steps:
  - name: Checkout
    uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
    with:
      persist-credentials: false

  # Fail BEFORE the ~10-min provision if there is no key. The engine uses
  # QUALITY_INITIATIVE_ANTHROPIC_API_KEY (mapped above); this guard only checks presence (a
  # boolean), never the value.
  - name: Guard — require the Anthropic key (fail before provisioning)
    env:
      HAS_KEY: ${{ secrets.QUALITY_INITIATIVE_ANTHROPIC_API_KEY != '' || secrets.ANTHROPIC_API_KEY != '' }}
    run: |
      [ "$HAS_KEY" = "true" ] || { echo "::error::QUALITY_INITIATIVE_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) secret is required."; exit 1; }

  # Phase 1 — the ONLY pre-agent decision: prefetch the issue/fix-PR/screenshots, then extract the
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
  # found) LEAN — no admin/storefront JS build, no demodata. The agent builds whatever its repro
  # needs on the fly (build-admin/build-storefront/gen-demodata) and records the choice in
  # reproduction-plan.json so the trunk leg provisions identically. Then snapshot the clean DB.
  - name: Provision reported version (Phase 2)
    id: provision
    uses: ./.github/actions/repro-agent/provision
    with:
      version: ${{ steps.parse.outputs.is_trunk == 'true' && 'trunk' || format('v{0}', steps.parse.outputs.target_version) }}
      admin-build: "false"
      storefront-build: "false"
      demodata: "false"

  - name: Snapshot clean DB
    run: bash .github/actions/repro-agent/bin/prepare/db-snapshot.sh

  # Assemble the single context file the agent reads (BUILD.md + all three executor contracts +
  # the reported version + the issue + screenshots). The version is injected from the parse step.
  - name: Assemble agent context
    env:
      ISSUE: ${{ github.event.issue.number || inputs.issue_number }}
      VERSION: ${{ steps.parse.outputs.is_trunk == 'true' && 'trunk' || steps.parse.outputs.target_version }}
      MAX_TURNS: "30"
    run: bash .github/actions/repro-agent/bin/prepare/build-context.sh

  # Export the live-shop coordinates to the job env so the agent's bash (build-verify / shop-get)
  # and the deterministic post-steps see them.
  - name: Export shop coordinates
    run: |
      {
        echo "APP_URL=${{ steps.provision.outputs.app_url }}"
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

# --- Just upload the agent's outputs for the trunk job ----------------------
# The reported leg was already produced deterministically by verify-reproduction.sh during the
# agent run (a reset+seed+run on the reported instance → result.json). Here we only persist the
# bundle + that result so the deterministic trunk job can consume them.
post-steps:
  - name: Upload repro bundle
    if: always()
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
    if: always() && hashFiles('result.json') != ''
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
# Triggered NOT by the agent but by verify-reproduction.sh, which appends the trigger to the gh-aw
# safe-output channel the moment the bundle is classified (and tells the agent to stop). It runs on
# a FRESH runner, provisions the next version FROM reproduction-plan.json (executor/build_profile/demodata
# the agent recorded), runs the EXACT same authored bundle (no regeneration, no agent), computes
# the verdict from the two leg statuses, renders the comment from templates, and posts it.
safe-outputs:
  # Threat detection runs inside the agent sandbox (AWF), which we disable above so the agent can
  # reach the localhost shop — so it is turned off here. The agent is read-only and its output is
  # only a verified test bundle consumed by deterministic scripts.
  threat-detection: false
  jobs:
    reproduce-on-trunk:
      description: >
        INTERNAL — do NOT call this tool yourself. verify-reproduction.sh triggers it automatically
        once your bundle is classified, and it then runs the bundle on trunk and posts the verdict
        deterministically. You decide nothing here.
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
        # verify-reproduction.sh writes result.json only on a classified outcome, so its presence
        # distinguishes success from give-up/crash. Every reproduction step below is gated on this;
        # otherwise we post the deterministic "could not reproduce" note.
        - name: Detect bundle
          id: bundle
          run: |
            has=$([ -f reproduction-plan.json ] && [ -f artifacts/repro-reported/result.json ] && echo true || echo false)
            echo "has=$has" >> "$GITHUB_OUTPUT"
            echo "bundle+reported-result present: $has"

        # ---- No bundle: deterministic "could not reproduce" comment, then done. ----
        - name: Comment — could not build a reproduction (Phase 7)
          if: steps.bundle.outputs.has != 'true'
          env:
            GH_TOKEN: ${{ github.token }}
            ISSUE: ${{ github.event.issue.number || inputs.issue_number }}
            RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          run: |
            {
              echo "## Reproduction (gh-aw) — could not build a reproduction"
              echo
              echo "The workflow could not produce a reliable reproduction within its budget, so no verdict was reached."
              echo "A human can review the issue, or re-trigger with \`/repro-agent\` to retry."
              echo
              echo "[Run details]($RUN_URL)"
            } > no-repro.md
            gh issue comment "$ISSUE" --repo "${{ github.repository }}" --body-file no-repro.md

        # ---- Bundle present: Phase 6 (trunk re-run) + Phase 7 (verdict + report). ----
        - name: Derive trunk leg parameters
          id: plan
          if: steps.bundle.outputs.has == 'true'
          env:
            LEG_VERSION: trunk
            BRANCH: trunk
          run: REPRO_PLAN=reproduction-plan.json bash .github/actions/repro-agent/bin/report/leg-plan.sh

        - name: Provision trunk (Phase 6)
          id: provision
          if: steps.bundle.outputs.has == 'true'
          continue-on-error: true
          uses: ./.github/actions/repro-agent/provision
          with:
            version: trunk
            admin-build: ${{ steps.plan.outputs.admin_build }}
            storefront-build: ${{ steps.plan.outputs.storefront_build }}
            demodata: ${{ steps.plan.outputs.demodata }}

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
          if: steps.bundle.outputs.has == 'true' && steps.verdict.outputs.has_results == 'true' && steps.verdict.outputs.verdict != 'blocked'
          env:
            GH_TOKEN: ${{ github.token }}
            ISSUE: ${{ github.event.issue.number || inputs.issue_number }}
          run: gh issue comment "$ISSUE" --repo "${{ github.repository }}" --body-file comment.md
---

# Reproduce a Shopware bug — discover the reproduction artifact (Phase 3–5)

A live Shopware instance on the **reported version** is already running and ready (provisioned
**lean** — no admin/storefront JS build, no demodata). Your **only** job is to discover a reliable,
runnable reproduction of the reported bug and prove it on this instance. The version was already
parsed for you; you do **not** run the trunk comparison, decide the verdict, or write the comment —
deterministic scripts own all of that.

## You decide everything else

There is no Analyze phase. **You** choose the executor (`http` / `playwright` / `direct`), and
whether the repro needs the Admin/Storefront built or demodata generated — and you **record every
decision in the single file `reproduction-plan.json`**. You never run build commands yourself:
`verify-reproduction.sh` reads the plan and does the builds (once) before verifying, and the trunk
leg provisions to match. So just set the flags:

- Need the Admin UI? → `build_profile.admin_build: true`
- Need the Storefront? → `build_profile.storefront_build: true` (+ `theme_build: true`)
- Need a realistic catalog? → `fixtures.demodata: true`

## Your complete instructions

Read **`build-context.md`** in the workspace root **first** — the assembled brief (the BUILD
runbook, all three executor contracts, the reported version, the issue, and any screenshots).
Follow it literally. The loop: **write `reproduction-plan.json` (+ the test + `fixtures.json`) →
`bash .github/actions/repro-agent/bin/agent/verify-reproduction.sh` → read `builder-result.json` (for
Playwright, also Read the screenshot it points to) → fix the ONE thing it names → repeat.**

The live-shop coordinates (`APP_URL`, `SW_ACCESS_KEY`, `ADMIN_USER`, `ADMIN_PASS`) are already in
your environment — never echo or rediscover them. Author only your own files
(`reproduction-plan.json`, `fixtures.json`, and one of `repro.spec.ts` / `ReproTest.php`); always
rewrite the whole file. Reference pre-existing install entities by `{{PLACEHOLDER}}`, never a literal id.

## How your job ends — the verify script stops you

When `verify-reproduction.sh` classifies your bundle (`reproduced`, or `not_reproduced` after an
honest re-check), it records the reported leg, **hands the artifact to the deterministic trunk
pipeline, prints `STOP`, and your job is over** — do not continue or call any tool. While it still
says "fix and retry", iterate. If you genuinely cannot build a runnable bundle within your budget,
run `bash .github/actions/repro-agent/bin/agent/verify-reproduction.sh giveup` and stop.
