# Build Repro phase — runbook

Build Repro turns `analysis.json` into a verified executable repro bundle. This phase
has a live Shopware instance, so it may iterate on fixtures and test code until the
deterministic executor can run and classify the result.

## Inputs

- `analysis.json` — config-only output from Analyze.
- `issue.md` and optional `fixpr.diff` — already prefetched issue context.
- Live shop coordinates in the environment: `APP_URL`, and when available
  `SW_ACCESS_KEY`, `ADMIN_USER`, `ADMIN_PASS`.
- The working directory contains the reproduce helper scripts and executor contracts.
- To INSPECT live-shop state (entity ids, fields, whether a fixture took), use the
  pre-approved getter — never hand-roll curl/python/OAuth (it handles auth and returns flat
  JSON, no JSON:API `.attributes` nesting):
  ```
  bash .github/actions/repro/bin/shop-get.sh <entity> <id>            # GET by id
  bash .github/actions/repro/bin/shop-get.sh <entity> --filter field=value
  ```
  e.g. `shop-get.sh category --filter type=page`, `shop-get.sh sales-channel`. Read-only.

## Procedure

> **Batch reads.** Pull the fixed inputs in ONE turn (`analysis.json`, `issue.md`,
> `SCHEMA.md`, and — once you have picked the executor — its one contract file). Reading
> them one per turn just burns budget.

1. Read `analysis.json`, `references/SCHEMA.md`, and the issue context.
2. Choose the final executor. Start from `analysis.executor`, but change it if the
   live shop proves the candidate layer cannot exercise the symptom. **Switching executor
   is a real switch:** read the new contract, rewrite `layer`/`executor`/`build_profile`
   together, and remember this shop was provisioned for `analysis.build_profile` — if you
   escalate to a surface that needs assets this instance did not build (e.g. `http` →
   `playwright` with no storefront/admin build), self-verification will "prove" a broken
   bundle. That is a `blocked` builder-result (profile escalation needed), NOT something to
   paper over with a weaker assertion.
3. Read only the matching executor contract:
   - `references/executors/http.md`
   - `references/executors/playwright.md`
   - `references/executors/direct.md`
4. Write `repro-plan.json` with executable fields:
   - HTTP: `request` or `requests`, `assertion`.
   - Playwright: `script_path: "repro.spec.ts"` and the spec file.
   - Direct: `script_path: "ReproTest.php"` and the PHPUnit file.
   - Fixtures: `fixtures.sync_payload_path: "fixtures.json"` and `fixtures.json`
     when seeded entities are needed.
5. Self-verify inside this agent turn. Run EXACTLY this one command — no env-var prefix,
   it is pre-approved and seeds `fixtures.json` (when present) then runs the executor as the
   `builder` leg:
   ```
   bash .github/actions/repro/bin/build-verify.sh
   ```
   Do NOT call `seed.sh` / `run-leg.sh` yourself and do NOT prefix any command with
   `VAR=value`: the live-shop coordinates (`APP_URL`, `SW_ACCESS_KEY`, `ADMIN_USER`,
   `ADMIN_PASS`) are already in your environment, and a `VAR=value …` prefix is what trips
   the approval prompt this unattended run cannot grant (it wastes the whole budget).

   **Stop, don't hack.** If a command keeps needing approval or won't run, do NOT try to work
   around it — no wrapper scripts, no env-var prefixes, no hand-rolled curl/python to hit the
   API (use `shop-get.sh` to inspect state), no editing anything under
   `.github/actions/repro/`. STOP and end your turn with a plain-text explanation in the chat
   (not a JSON file) of which command failed and how, so a human can fix the harness. A clear
   stop beats a clever workaround. Then:
   - Read `builder-result.json` and decide whether the result proves the repro bundle's
     assumption:
     - `reproduced`: the generated healthy assertion fails on the builder instance, so
       the bundle can detect the reported symptom on that version.
     - `not_reproduced`: the generated healthy assertion passes on the builder instance,
       so the bundle is runnable and classifies the builder version as healthy.
     - `blocked` or `inconclusive`: the bundle is not verified. Inspect the reason and
       refine fixtures/test code only if the failure is a fixable harness/setup problem.
6. You may re-run `build-verify.sh` multiple times while building (≈3 cycles max). Keep each
   attempt idempotent:
   - Prefer deterministic 32-char IDs and sync `upsert` fixtures so reseeding updates
     the same entities instead of accumulating duplicates.
   - If an attempted fixture/test created bad state, reset by overwriting those same IDs
     or by issuing a targeted cleanup through the Admin API/sync API before the next
     attempt.
   - Do not depend on a database transaction rollback around the full attempt: the
     generic workflow does not provide one for HTTP/Playwright/admin sync side effects.
     Treat fixture rollback as explicit cleanup or idempotent overwrite.
   - Limit retries to a small bounded number; repeated `blocked`/`inconclusive` for the
     same reason must become the final `builder-result.json`.

## Success Criteria

Build Repro succeeds only when the agent has seeded any required fixtures, run the
deterministic executor itself, read `builder-result.json`, and concluded that the result
supports the bundle assumption. The final `builder-result.json` must have status
`reproduced` or `not_reproduced`. The workflow validates the files afterward, but it does
not seed or run the executor again. The status only proves the bundle is runnable and
classifiable on the builder instance; reported/trunk verdicts still come from the
deterministic matrix.

### The builder runs the REPORTED (buggy) version — so `reproduced` is the expected result

The builder instance is provisioned on the version the reporter says is broken. A
`not_reproduced` here is therefore a RED FLAG, not a clean pass: by far the likeliest
explanation is that the bundle does not actually exercise the symptom (wrong surface, a
silently-absent precondition, an assertion too loose to detect the defect) — not that the
reporter is wrong. Before you accept a `not_reproduced` builder result:

1. Re-check faithfulness ONCE — does the scenario truly hit the reported code path? Is
   every precondition present (not skipped/absent)? Is the healthy assertion strict enough
   that the buggy behaviour would fail it?
2. If it still does not reproduce, you MAY accept it, but you must lower `confidence` and
   record the faithfulness obstacle in `confidence_reason` (so the verdict is routed to a
   human rather than posted as a confident `not_reproducible`).

Keep the seed+run loop to a small bounded number of cycles (≈3). Do not grind: repeated
`blocked`/`inconclusive` for the same reason becomes the final `builder-result.json`.

If the bundle cannot be made runnable, write `builder-result.json` with `blocked` or
`inconclusive` and a specific `blocked_reason`. The workflow must stop before spending
reported/trunk matrix capacity.

## Output

Emit these files in the workspace root:

- `repro-plan.json`
- `builder-result.json`
- Optional `fixtures.json`
- Optional `repro.spec.ts`
- Optional `ReproTest.php`
