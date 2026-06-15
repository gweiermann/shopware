# Contract: `analysis.json` (Analyze output)

Emit JSON only in wrapper-fed / CI mode — no markdown fence, no prose. `schema_version` is `"1"`.
Produced by **Analyze**, consumed by **Build Repro** and matrix planning.

The natural-language-to-configuration transform. It classifies the issue, picks the
cheapest likely surface and build profile, and preserves the human scenario. It does
NOT create fixtures, requests, scripts, or final assertions.

```json
{
    "schema_version": "1",
    "issue": 16638,
    "layer": "service | store-api | admin-api | storefront-ui | admin-ui",
    "executor": "direct | http | playwright",
    "version": "6.6.10.0",
    "build_profile": {
        "admin_build": false,
        "storefront_build": false,
        "theme_build": false
    },
    "scenario": [
        "Given a category with at least one product visible in the Storefront sales channel",
        "When POST /store-api/product-listing/{categoryId}?p=99 (a page past the last)",
        "Then a healthy shop returns HTTP 404 with PRODUCT__LISTING_PAGE_OUT_OF_RANGE"
    ],
    "plugins": [{ "name": "SwagFoo", "activate": true }],
    "derived_from": "PR#16640 tests/.../MultiWarehouseTest.php",
    "confidence": 0.82,
    "confidence_reason": null,
    "blocked_reason": null,
    "needs_info": null
}
```

Rules:

- `layer` is the cheapest likely faithful surface. Order: `service` < `store-api` /
  `admin-api` < `storefront-ui` / `admin-ui`. Escalate only when a cheaper layer
  cannot plausibly fire the symptom.
- `executor` follows `layer`: `service` -> `direct`, `*-api` -> `http`, `*-ui` ->
  `playwright`.
- `build_profile` enables the surface the candidate `layer` needs.
  `storefront_build` / `theme_build` are `true` only for `storefront-ui`. Bias toward
  building when uncertain: a wrong-LOW profile blocks the whole pipeline (the executor
  can't run), a wrong-HIGH profile only costs a few minutes of build.
- The analyzer does NOT choose which versions to run. The workflow computes targets
  from `version`: normally reported + trunk, or trunk only when explicitly requested
  / reported equals trunk.
- `scenario` is a plain-English Given/When/Then list. It is the handoff to the
  build phase, not proof that a generated test exists.
- `confidence` measures whether the issue text is specific enough to attempt a
  faithful build, not whether the generated test works. The build phase verifies
  runnable artifacts.
- `needs_info`: when the issue is too vague/contradictory/incomplete to derive a
  faithful configuration, emit ONLY
  `{"schema_version":"1","issue":N,"needs_info":"<one specific clarifying question>"}`
  and omit the plan. The workflow posts the question and aborts.

Confidence bands:

- `confidence < 0.4` -> the run is not executed. The workflow posts the draft
  scenario + `confidence_reason` and asks a human to confirm.
- `0.4 <= confidence < 0.7` -> the build and legs may run, but the verdict is forced
  to `needs_human_review`.
