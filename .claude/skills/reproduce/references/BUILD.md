# Build Repro

You author a runnable repro bundle against a LIVE Shopware shop, then self-verify it once.
This document, plus the contracts / executor / issue that follow it, is your COMPLETE context —
read it; do not go looking for other files.

## Environment — already set, do NOT probe

A live shop on the **reported (buggy) version** is running. These are exported in your shell:
`APP_URL`, `SW_ACCESS_KEY`, `ADMIN_USER` (`admin`), `ADMIN_PASS` (`shopware`). Never echo /
printenv / discover them.

## Commands — everything else is auto-DENIED (and only wastes a turn)

| Need | Use |
| --- | --- |
| author / edit files | `Read`, `Write`, `Edit` |
| find an exact selector / field / config shape | `Glob`, `Grep`, `rg`, `grep`, `find` — **targeted lookups only**, never open-ended investigation |
| self-verify the bundle | `bash .github/actions/repro/bin/build-verify.sh` — seeds `fixtures.json` + runs the executor as the `builder` leg → writes `builder-result.json` |
| query live shop state | `bash .github/actions/repro/bin/shop-get.sh <entity> [<id> \| --filter field=value]` — auth handled, returns flat JSON |
| parse / transform JSON | `jq` |
| other read-only shell | `cat` `ls` `head` `tail` `sed` `wc` `git log\|show\|diff\|blame` |
| official docs | `WebSearch` (scope every query `site:developer.shopware.com`), then `WebFetch` (locked to that domain) |

**BLOCKED — never attempt (each only burns a turn):** `python3`/`node`, raw `curl`/`wget`,
inline scripts / here-docs, any `VAR=value`-prefixed command, sub-agents (`Task`/`Agent`), and
editing anything under `.github/actions/repro/`. If you genuinely cannot proceed within the
allowed set, **STOP** and explain in plain text (not a JSON file) — never hand-roll a workaround.

## Scope & discipline

- **Reproduce, don't root-cause.** Make the symptom *occur and be detected*; do not explain
  *why* it happens.
- **Targeted lookups: yes. Investigation: no.** Finding one exact selector/field/config shape
  (e.g. grep the Twig that renders the symptom) is fine — 1–3 lookups. Reading the
  resolver/service chain to understand *why*, or spelunking the entity graph with `shop-get`,
  is the spiral that burns the budget. A failed verify is NOT a cue to investigate.
- **Author in ONE pass, verify ONCE.** After a non-`reproduced` result: at most ONE targeted
  fix + one re-verify, then accept or STOP. Never loop.
- **A plausible bundle beats a never-finished one.** If you stop unverified, keep the files,
  lower `confidence`, and say why in `confidence_reason` — the reported/trunk legs re-seed and
  re-run it, so they are the real check.
- **Don't over-build.** A large interdependent fixture graph that keeps failing means the
  layer is too expensive — pick a cheaper one that shows the same symptom, or stop.

## Procedure

1. **Pick the executor** (start from `analysis.executor`). Switching is a real switch: read the
   other contract and rewrite `layer`/`executor`/`build_profile` together. This shop was built
   for `analysis.build_profile`; escalating to a surface it did not build (e.g. `http` →
   `playwright` with no storefront) makes self-verify "prove" a broken bundle — that is a
   `blocked` result (profile escalation needed), not a reason to weaken the assertion.
2. **Write `repro-plan.json` + the executor's artifact:**
   - `http`: `request`/`requests` + `assertion`.
   - `playwright`: `script_path: "repro.spec.ts"` + the spec.
   - `direct`: `script_path: "ReproTest.php"` + the PHPUnit test.
   - fixtures: `fixtures.sync_payload_path: "fixtures.json"` + the file, when seeded data is needed.
3. **Fixtures rules:**
   - Reference pre-existing install entities by `{{PLACEHOLDER}}` (`{{SC}}` `{{NAV_CAT}}`
     `{{TAX}}` `{{CURRENCY}}` `{{COUNTRY}}` `{{SALUTATION}}` `{{LANGUAGE}}`) — NEVER a literal id
     read off this shop; every provisioned instance has different UUIDs (`seed.sh` rejects
     hardcoded install ids, because a literal seeds here but FK-fails on the reported/trunk legs).
   - Entities you create: deterministic 32-hex UUIDs, sync `upsert` (idempotent on re-seed; no
     DB-rollback is provided, so reseeding must overwrite the same ids).
   - **Nested graphs** (e.g. a CMS page → sections → blocks → slots): write the WHOLE graph as
     ONE nested payload, not separate flat ops — the DAL then assigns the live version
     automatically. Flat writes / hand-set `cmsPageVersionId` are the usual cause of "seeded but
     renders empty". CMS model + JSON examples (WebFetch for details):
     <https://developer.shopware.com/docs/concepts/commerce/content/shopping-experiences-cms.html>
   - No protected/computed fields (`autoIncrement`, `createdAt`/`updatedAt`, `versionId`, …).
   - The sync payload is a MAP of operations — each key an `{entity, action, payload:[…]}`
     envelope, NOT a bare entity→array:
     ```json
     { "product": { "entity": "product", "action": "upsert", "payload": [{ "id": "0192f3c4a5b67890abcdef0123456789", "name": "Repro" }] } }
     ```
4. **`repro-plan.json` shape** (you emit this; it inherits `issue`/`version`/`scenario`/confidence
   and the candidate `layer`/`build_profile` from `analysis.json` — adjust those if you switched):
   ```json
   {
       "schema_version": "1", "issue": 16638, "layer": "store-api", "executor": "http",
       "version": "6.6.10.0",
       "build_profile": { "admin_build": false, "storefront_build": false, "theme_build": false },
       "fixtures": { "demodata": false, "sync_payload_path": "fixtures.json" },
       "scenario": ["Given …", "When …", "Then …"],
       "request": { "method": "POST", "path": "/store-api/checkout/cart", "headers": {}, "body": "{}" },
       "script_path": "repro.spec.ts",
       "assertion": { "kind": "http_status | response_field | exception | ui_state", "expect": "400", "field": ".errors[0].code", "locator": "/store-api/checkout/cart" },
       "confidence": 0.82, "confidence_reason": null, "blocked_reason": null
   }
   ```
   - `assertion.expect` is the HEALTHY value: a leg is `reproduced` when `actual != expect`,
     `not_reproduced` when `actual == expect`.
   - `assertion.symptom_pattern` (optional; `direct` + `kind: exception`) — a distinctive
     extended-regex; if PHPUnit errors and the output matches, the leg counts as `reproduced`.
   - `script_path` names the spec/test for `playwright`/`direct`; omit for `http`.
   - Comment every generated request/step (what it does + what it asserts).
5. **Self-verify:** run `bash .github/actions/repro/bin/build-verify.sh`, then Read
   `builder-result.json`:
   - `reproduced` → the bundle detects the symptom on this (buggy) version. **Expected — see below.**
   - `not_reproduced` → runnable, classifies this version healthy.
   - `blocked`/`inconclusive` → not verified; one targeted fix if it is a fixable setup problem,
     else stop with a specific `blocked_reason`.

## The builder runs the REPORTED (buggy) version → `reproduced` is expected

A `not_reproduced` here is a RED FLAG: most likely the bundle does not exercise the symptom
(wrong surface, an absent precondition, an assertion too loose to detect the defect) — not that
the reporter is wrong. Re-check faithfulness once; if you still accept it, lower `confidence`
and record the obstacle in `confidence_reason` (so the verdict routes to a human instead of a
confident `not_reproducible`).

## Output (workspace root)

`repro-plan.json`; `builder-result.json` (`reproduced`|`not_reproduced`, or
`blocked`/`inconclusive` + `blocked_reason` if unrunnable); optional `fixtures.json` /
`repro.spec.ts` / `ReproTest.php`.
