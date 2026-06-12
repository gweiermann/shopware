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

## Procedure

1. Read `analysis.json`, `references/SCHEMA.md`, and the issue context.
2. Choose the final executor. Start from `analysis.executor`, but change it if the
   live shop proves the candidate layer cannot exercise the symptom.
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
5. Self-verify inside this agent turn. The exact loop is:
   - If `fixtures.json` exists, seed it first with
     `APP_URL="$APP_URL" PAYLOAD=fixtures.json bash .github/actions/repro/bin/seed.sh`.
   - Then run the deterministic executor with
     `TARGET=builder REPRO_PLAN=repro-plan.json OUT=builder-result.json bash .github/actions/repro/bin/run-leg.sh`.
   - Read `builder-result.json` and decide whether the result proves the repro bundle's
     assumption:
     - `reproduced`: the generated healthy assertion fails on the builder instance, so
       the bundle can detect the reported symptom on that version.
     - `not_reproduced`: the generated healthy assertion passes on the builder instance,
       so the bundle is runnable and classifies the builder version as healthy.
     - `blocked` or `inconclusive`: the bundle is not verified. Inspect the reason and
       refine fixtures/test code only if the failure is a fixable harness/setup problem.
6. You may run this seed + executor loop multiple times while building. Keep each
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
