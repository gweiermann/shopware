---
name: reproduce
description: >
  Reproduce a Shopware 6 GitHub bug issue in CI. Read the issue, derive a
  config-only analysis, build a self-verified repro bundle on one live instance,
  reproduce on the reported version and on trunk, and emit evidence (the verbatim
  script plus Playwright/HTTP output). Use when the user asks to reproduce a bug,
  verify whether an issue still occurs, check if a defect is fixed on trunk, or
  references an issue by number (e.g. "#16638") in a reproduction context.
license: MIT
allowed-tools: Bash(rg:*) Bash(git log:*) Bash(git show:*) Bash(git diff:*) Bash(git blame:*) Bash(gh issue view:*) Bash(gh issue list:*) Bash(gh pr view:*) Bash(gh pr diff:*) Bash(gh pr list:*) Bash(gh api repos/*/issues/*:*) Bash(gh api repos/*/pulls/*:*) Bash(find:*) Bash(ls:*) Read Glob Grep
---

# Shopware Issue Reproduction

## Context

You operate inside the `shopware/shopware` monorepo with read access to the codebase
and to GitHub. This skill turns a reported bug into a config-only analysis, then a
self-verified **repro plan** for deterministic CI jobs. You do **not** label, comment,
or push — the structured output is the deliverable.

This skill drives the **interactive** path (Claude Code / opencode / Codex CLI in the
repo). The **unattended CI path** is a hand-written multi-job workflow at
`.github/workflows/reproduce.yml` — Analyze and Build Repro agent jobs followed by a
parallel reported‖trunk deterministic matrix. Both surfaces share this rubric and
the `references/SCHEMA.*.md` contracts so they cannot drift.

## Phases

```
Analyze  ──▶  Build Repro  ──▶  Reproduce (matrix: reported ‖ trunk, parallel)  ──▶  Report
```

Analyze stays cheap and non-executable. Build Repro is the only agentic phase that
creates fixtures/scripts/requests because it has a live Shopware instance and must
self-verify the bundle before the deterministic version comparison runs.

1. **Analyze** — emit config-only `analysis.json` (see `references/SCHEMA.analysis.md`). Pick
   the likely cheapest faithful `layer`, minimal `build_profile`, and scenario. Do not
   create fixtures or tests.
2. **Build Repro** — provision one shop, create `repro-plan.json` plus fixtures/scripts
   or requests, then run the selected deterministic executor once as `builder` until the
   bundle is runnable and classified.
3. **Reproduce** — one deterministic leg per `target`. The leg's `executor` is chosen
   by `repro-plan.json`:
   `direct` (instantiate the service), `http` (input → output, HAR evidence), or
   `playwright` (UI only; screenshot/video/trace). Build only the surface the bug lives on.
4. **Report** — merge legs into `repro-output.json`, apply the verdict map, render a
   self-contained GitHub comment that embeds each leg's **verbatim script** and trimmed
   reporter output, and links the (ephemeral) artifacts.

## Discipline

- **Match env to surface.** `direct` / `http` legs build neither storefront nor theme.
- **Reuse over rebuild.** Pin the exact reported version; collapse to one leg when
  reported == trunk or on manual rerun.
- **Fail fast.** `not_reproduced` after one bounded re-check; `blocked` when the env is
  dead after one rebuild. Never grind, never yield mid-build (one-shot provision, poll
  until READY).

## Reference files

- `references/ANALYZE.md` — the Analyze-phase runbook (inputs, needs_info protocol,
  economy budget, confidence rules, outputs).
- `references/BUILD.md` — the Build Repro runbook (live-instance artifact creation and
  self-verification).
- `references/SCHEMA.analysis.md` — the `analysis.json` contract (Analyze).
- `references/SCHEMA.repro.md` — the `repro-plan.json` + `result.json` contracts (Build Repro).
- `references/SCHEMA.report.md` — the `repro-output.json` contract + verdict map (report/verdict; not loaded by an agent).
- `references/executors/{http,playwright,direct}.md` — the per-executor authoring
  contract. After choosing the `layer`, read ONLY the file for its executor.

## Output format

- Wrapper-fed / CI: schema-compatible JSON only (`analysis.json`, `repro-plan.json`,
  `result.json`, or `repro-output.json` depending on phase).
- Interactive: compact Markdown — verdict, the layer chosen, and the verbatim repro
  script. No JSON, no telemetry.
