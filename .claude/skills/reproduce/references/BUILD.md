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
5. Run the deterministic executor via:
   `TARGET=builder REPRO_PLAN=repro-plan.json OUT=builder-result.json bash .github/actions/repro/bin/run-leg.sh`
6. If fixtures are needed, seed them before the executor with:
   `APP_URL="$APP_URL" PAYLOAD=fixtures.json bash .github/actions/repro/bin/seed.sh`
7. Refine the bundle only when the executor reports `blocked` or `inconclusive` for
   a fixable harness/setup reason. Stop after a bounded number of attempts.

## Success Criteria

Build Repro succeeds only when all required files exist and `builder-result.json`
status is `reproduced` or `not_reproduced`. The status only proves the bundle is
runnable and classifiable on the builder instance; reported/trunk verdicts still come
from the deterministic matrix.

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
