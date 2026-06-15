# Contracts: `repro-plan.json` (Build Repro output) + `result.json` (leg output)

Emit JSON only in wrapper-fed / CI mode — no markdown fence, no prose. `schema_version` is `"1"`.

## Repro Plan (`repro-plan.json`)

The executable repro bundle. It is produced by the Build Repro phase after creating
fixtures/scripts/requests and self-verifying them on a live Shopware instance.

```json
{
    "schema_version": "1",
    "issue": 16638,
    "layer": "store-api",
    "executor": "http",
    "version": "6.6.10.0",
    "build_profile": {
        "admin_build": false,
        "storefront_build": false,
        "theme_build": false
    },
    "fixtures": {
        "demodata": false,
        "sync_payload_path": "fixtures.json"
    },
    "scenario": [
        "Given a category with at least one product visible in the Storefront sales channel",
        "When POST /store-api/product-listing/{categoryId}?p=99 (a page past the last)",
        "Then a healthy shop returns HTTP 404 with PRODUCT__LISTING_PAGE_OUT_OF_RANGE"
    ],
    "request": {
        "method": "POST",
        "path": "/store-api/checkout/cart",
        "headers": { "Content-Type": "application/json" },
        "body": "{}"
    },
    "script_path": "repro.spec.ts",
    "assertion": {
        "kind": "http_status | response_field | exception | ui_state",
        "expect": "400",
        "field": ".errors[0].code",
        "locator": "/store-api/checkout/cart"
    },
    "plugins": [{ "name": "SwagFoo", "activate": true }],
    "derived_from": "PR#16640 tests/.../MultiWarehouseTest.php",
    "confidence": 0.82,
    "confidence_reason": null,
    "blocked_reason": null
}
```

Rules:

- `repro-plan.json` inherits `issue`, `version`, `scenario`, confidence metadata,
  and the candidate layer/build profile from `analysis.json`, but the build agent may
  adjust `layer`, `executor`, and `build_profile` when live verification proves the
  analyzed candidate cannot exercise the symptom.
- Build Repro reads exactly one executor contract after choosing the final executor:
  - `executors/http.md` — `request`/`requests`, final-response assertion, auth and
    placeholder rules. No separate script file.
  - `executors/playwright.md` — `repro.spec.ts`, stable locators, precondition-vs-
    symptom structure.
  - `executors/direct.md` — `ReproTest.php`, PHPUnit integration-test mapping.
- `fixtures.sync_payload_path` points to the generated admin sync payload, normally
  `fixtures.json`. Omit the file when no fixtures are needed.
- The sync payload is a map of sync OPERATIONS — each key carries an
  `{entity, action, payload}` envelope, NOT a bare entity->array:

  ```json
  {
      "product": {
          "entity": "product",
          "action": "upsert",
          "payload": [{ "id": "0192f3c4a5b67890abcdef0123456789", "name": "Repro Product" }]
      }
  }
  ```

- Fixture payloads may contain plain writable fields only. Never write protected or
  computed fields such as `autoIncrement`, `createdAt`/`updatedAt`, `versionId`,
  `childCount`, `ratingAverage`, `sales`, token/access-key fields.
- Entity ids created by fixtures MUST be 32-char lowercase-hex Shopware UUIDs. Use
  `{{SC}}`, `{{NAV_CAT}}`, `{{TAX}}`, `{{CURRENCY}}`, etc. placeholders for install-
  specific ids; `seed.sh` resolves them.
- `script_path` names the generated script for `playwright` and `direct`; omit for
  `http`.
- `assertion.expect` is the HEALTHY value. A leg is `reproduced` when `actual !=
  expect` and `not_reproduced` when `actual == expect`.
- `assertion.symptom_pattern` (optional, direct executor, `kind: exception`) is a
  distinctive extended-regex for a symptom exception. When PHPUnit errors and the
  output matches, the leg is classified `reproduced`.
- The generated script or request comments every step (what it does + asserts).
- Build Repro MUST self-verify inside the agent turn: seed `fixtures.json` when present,
  run the selected deterministic executor on the live shop, read `builder-result.json`,
  and conclude whether the result supports the generated bundle. The workflow only
  validates the output files afterward; it does not rerun seed/executor for the builder.
  `blocked` or `inconclusive` builder results stop the pipeline before reported/trunk
  reproduction.

## Repro Result (`result.json`)

One object per deterministic Reproduce leg (the executor emits it; you only READ
`builder-result.json` during self-verify and check its `status`).

```json
{
    "schema_version": "1",
    "issue": 16638,
    "target": "reported | trunk",
    "version": "6.6.10.0",
    "executor": "playwright",
    "status": "reproduced | not_reproduced | blocked | inconclusive",
    "assertion": { "expect": "400", "actual": "200", "matched": false },
    "duration_s": 47,
    "evidence": {
        "script": "import { test, expect } from '@playwright/test';\n...",
        "script_lang": "ts | php | sh",
        "reporter_output": "checkout cart returns 400; expected 400, received 200",
        "http": [{ "method": "POST", "path": "/store-api/checkout/cart", "status": 200 }],
        "artifacts": [
            { "kind": "trace | video | screenshot | html_report | har", "name": "trace.zip", "run_artifact": "repro-reported" }
        ],
        "truncated": false
    },
    "blocked_reason": null
}
```

Rules:

- `status` is one-shot and bounded. `blocked` means the env/seed/executor could not
  run; `inconclusive` means the env was ready but the symptom could not be judged.
- `evidence.script` is the full generated repro source, verbatim, always inline.
- Redact secrets, tokens, and instance hostnames to `[REDACTED_KEY]`,
  `[REDACTED_TOKEN]`, `[REDACTED_URL]` before emit.
