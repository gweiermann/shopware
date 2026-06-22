# Bug-reproduction pipeline — the gh-aw variant (self-contained)

A **second**, independent reproduction approach that implements the same idea as the hand-written
[`reproduce.yml`](../../workflows/reproduce.yml) (which lives in [`../repro/`](../repro/)) but as a
**single [GitHub Agentic Workflow](https://github.com/github/gh-aw) (gh-aw)** file:
[`.github/workflows/repro-agent.md`](../../workflows/repro-agent.md).

This directory is **self-contained**: the deterministic scripts, the `provision` action, and the
agent prompt template live here (plus the new `parse-version.sh`). The agent does not read a
vendored cookbook; it reads the issue, does bounded Shopware source/test discovery, writes one
bundle, then lets deterministic verification classify it.

> **gh-aw** lets you write an agentic workflow as one Markdown file with YAML frontmatter
> (`engine`, `tools`, `permissions`, `steps`, `post-steps`, `safe-outputs`, …). The Markdown body
> is the agent prompt. `gh aw compile` turns it into a normal `.github/workflows/*.lock.yml`
> GitHub Actions workflow. Commit **both** the `.md` and the generated `.lock.yml`.

## Design principle — the agent only discovers the artifact

This variant follows the handoff's hard split:

- **The agent decides everything except the version and owns the artifact.** It picks the
  executor, decides whether to build the Admin/Storefront or generate demodata (running the helper
  scripts on the live instance), authors the bundle, and **records its choices in `reproduction-plan.json`**.
  Its job ends when its bundle self-verifies.
- **Everything else is deterministic** — version parsing, the lean provision, DB snapshot/reset,
  verification, the trunk re-run, the verdict, and the issue comment. The agent **cannot decide
  the outcome**: it never writes the verdict and never writes the comment.

The only thing known before the agent runs is the **version** (a regex over the issue). The
reported instance is provisioned **lean** (no JS build, no demodata); the agent builds/seeds
whatever its repro needs on the fly and records it in `reproduction-plan.json`, and the trunk leg then
provisions identically from that file. (Contrast `reproduce.yml`, where a separate **Analyze
agent** pre-decides layer/executor/build profile.)

## Phase map (handoff → this workflow)

| Handoff phase | Where it runs in `repro-agent.md` | Deterministic? |
|---|---|---|
| 1. Issue analysis | pre-agent `steps:` → `parse-version.sh` extracts **only the version** | ✅ |
| 2. Environment preparation | pre-agent `steps:` → `provision` (Admin + Storefront pre-built) + `db-snapshot.sh` | ✅ |
| 3. Reproduction discovery + decisions | the **agent** writes `reproduction-plan.json` (+ test + `fixtures.json`), declaring executor/build_profile/demodata | 🤖 agent |
| 4. Build + verify | agent runs `verify-reproduction.sh` ONCE; it builds Admin/Storefront/demodata per the plan, then the **script** decides + records the reported leg | ✅ (script verdict) |
| 5. Retry loop | bounded by the compact build context + `engine.max-turns` | 🤖 agent |
| 6. Trunk verification | `safe-outputs.jobs.reproduce-on-trunk` (clean runner) provisions from `reproduction-plan.json` | ✅ |
| 7. Deterministic reporting | `verdict.sh` → `report.sh` → `gh issue comment` | ✅ |

The agent does **not** call a hand-off tool. When its bundle classifies, **`verify-reproduction.sh`
itself** records the reported leg, appends the trigger to gh-aw's safe-output channel (which starts
the trunk-and-report job), and prints `STOP` — the agent's job is over and it decides nothing.

## Required scripts (handoff) → scripts in this directory

The handoff lists a set of deterministic scripts. Almost all are **vendored copies** of the
`repro/` toolkit in [`bin/`](bin/) — only `parse-version.sh` is new (it replaces the Analyze
agent's version pick with a regex).

| Handoff script | Implemented by |
|---|---|
| `provision-version.sh` + `build-environment.sh` | [`provision/action.yaml`](provision/action.yaml) (composite action: `setup-shopware` + build profile + server-ready poll). The reported instance is provisioned with the **Admin + Storefront pre-built**; demodata is generated on demand by `verify-reproduction.sh` via [`bin/execute/gen-demodata.sh`](bin/execute/gen-demodata.sh) |
| `create-db-snapshot.sh` | [`bin/prepare/db-snapshot.sh`](bin/prepare/db-snapshot.sh) |
| `restore-db-snapshot.sh` + `reset-db.sh` | inlined in [`bin/execute/build-verify.sh`](bin/execute/build-verify.sh) (resets to the clean snapshot + clears cache before each attempt) |
| **`verify-reproduction.sh`** | **new** — [`bin/agent/verify-reproduction.sh`](bin/agent/verify-reproduction.sh): the agent's verify entrypoint. Runs `build-verify.sh`; on a classified result it records the reported leg, **triggers the trunk pipeline, and stops the agent** |
| `run-reproduction.sh` | [`bin/execute/run-leg.sh`](bin/execute/run-leg.sh) → `run-http.sh` / `run-playwright.sh` / `run-direct.sh` |
| `build-report.sh` + `post-report.sh` | [`bin/report/report.sh`](bin/report/report.sh) (renders `comment.md` from templates) + `gh issue comment` |
| `http.sh` + `api-helper.sh` | [`bin/execute/run-http.sh`](bin/execute/run-http.sh) + [`bin/lib/lib-admin-api.sh`](bin/lib/lib-admin-api.sh) + [`bin/agent/shop-get.sh`](bin/agent/shop-get.sh) |
| **`parse-version.sh`** (Phase 1) | **new** — [`bin/prepare/parse-version.sh`](bin/prepare/parse-version.sh): matches the reported version (optional `v`, 2–4 segments, `.*`/`.x` wildcard). Exact 4-part is used verbatim; anything underspecified (`6.7.10` / `6.7.10.*` / `6.7.x`) resolves to the **latest available patch** via `gh` then `git ls-remote` — never `.0`; unresolvable offline → trunk |

The agent reads `build-context.md`, assembled by
[`bin/prepare/build-context.sh`](bin/prepare/build-context.sh) from the compact
[`prompts/build-context.tpl.md`](prompts/build-context.tpl.md). The verdict map lives in
`bin/report/verdict.sh`; the comment templates in `bin/report/report.sh`.

## How to enable

1. Add the `QUALITY_INITIATIVE_ANTHROPIC_API_KEY` repo secret (same as `reproduce.yml`). The
   workflow maps it to the engine's `ANTHROPIC_API_KEY` via `engine.env`, so no separate
   `ANTHROPIC_API_KEY` secret is needed (it is still honoured as a fallback). Without either, the
   workflow hard-fails before provisioning.
2. Install the extension and compile:
   ```bash
   gh extension install github/gh-aw
   gh aw compile .github/workflows/repro-agent.md   # emits repro-agent.lock.yml
   ```
3. Commit both files, then trigger by commenting `/repro-agent` on an issue, or with
   `gh aw run repro-agent` / a manual dispatch with an `issue_number`.

## Known trade-offs (vs. `reproduce.yml`)

- **Admin + Storefront are pre-built on the reported instance** (no Analyze agent to predict the
  surface). This wastes a JS build on `http`/`direct` repros, but it means the agent never waits on
  a (slow, ~10 min) build mid-run — which previously caused it to background the verify and lose the
  result. The agent still records `build_profile` so the **trunk** leg builds only what the repro
  uses. Demodata stays on-demand: the agent sets `fixtures.demodata: true` and
  `verify-reproduction.sh` generates it, then re-snapshots the clean DB so the per-attempt reset
  keeps it.
- **Trunk is a clean second runner triggered by the verify script.** gh-aw has no native "matrix
  job after the agent", so the trunk leg is a `safe-outputs.jobs` job triggered when
  `verify-reproduction.sh` appends to gh-aw's safe-output channel (on success, or on `giveup`).
  That one job is the single deterministic reporter: it provisions from `reproduction-plan.json`, re-runs
  the bundle on trunk and posts the verdict, or posts the "could not reproduce" template when there
  is no classified reported leg. The only gap is a hard agent crash before verify classifies —
  then no comment is posted (gh-aw's default status comment still links the run).
- **The agent runs on-host, not in gh-aw's AWF firewall sandbox** (`sandbox.agent: false`, which
  forces `strict: false`). This is required: the agent must reach the localhost-provisioned shop
  to self-verify (the sandbox only exposes host ports 80/443/8080, not 8000), exactly like the
  hand-written `claude-code-action` job. The trust boundary is held by other means — the agent job
  is read-only, its bash is an allow-list of read-only/verifier scripts, it has no GitHub write
  access (writes go through safe-outputs), and the instance is ephemeral. `threat-detection` is
  also off (it runs inside the sandbox). This is the single security relaxation versus a default
  gh-aw workflow and the main reason to review the compiled `.lock.yml` before enabling.
- **No dry-run / `$0` demo mode** and **no commit-attribution agent** — both exist in
  `reproduce.yml` and were left out to keep this single-file variant focused on the handoff's core
  loop. Both could be added (a `dispatch` input + the `attribute.md` prompt) later.

## Layout

```
.github/workflows/repro-agent.md        the gh-aw workflow (source)
.github/workflows/repro-agent.lock.yml  compiled output (gh aw compile) — commit alongside the .md
.github/actions/repro-agent/            ← this self-contained directory
  provision/action.yaml                 Phase 2: setup-shopware (lean) + server-ready poll
  bin/                                   deterministic scripts, grouped by intent:
    lib/        db-env.sh, lib-admin-api.sh        sourced helpers (DB url, admin API)
    prepare/    parse-version.sh, prefetch.sh,     Phase 1+2: parse version, fetch issue,
                build-context.sh, db-snapshot.sh   assemble prompt, snapshot clean DB
    agent/      verify-reproduction.sh, shop-get.sh    the only two commands the AGENT runs:
                                                       build(per plan)+verify(→ hand off → STOP), inspect
    execute/    build-verify.sh, run-leg.sh,       running the bundle: verifier + executors
                run-{http,playwright,direct}.sh,   (http/playwright/direct) + seed + PW login +
                seed.sh, login-state.mjs,          on-demand demodata (called by verify-reproduction)
                gen-demodata.sh
    report/     leg-plan.sh, leg-blocked.sh,       trunk leg params + verdict map + comment
                verdict.sh, report.sh, embed-evidence.sh
  prompts/build-context.tpl.md          the agent prompt template
  repro.playwright.config.ts            Playwright runner config
```
