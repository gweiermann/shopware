# Executor: `http` (store-/admin-API)

Use when the symptom surfaces on a store-api or admin-api **response**. Cheapest faithful
layer for most API bugs. Builds neither storefront nor theme.

## What you author
Put the request(s) in `reproduction-plan.json` — there is **no** separate script file (the executor
generates `repro.sh` from the plan and runs it). Use:

- `request` — a single object: `{ method, path, headers, body }`, OR
- `requests` — an array for a multi-step flow (e.g. create context → add to cart → read).
  The assertion runs on the **FINAL** response.

The executor authenticates each request **by its path** — admin API (`/api/...`) gets an
admin OAuth **Bearer** token, store API (`/store-api/...`) gets `sw-access-key` — and
captures/carries `sw-context-token` across the sequence. **Do NOT** put any auth header
(`sw-access-key`, `Authorization`) or `sw-context-token` in the plan: the executor injects
the right credential for the surface and drops any you add. Just give the correct `path`
(an admin-api bug → `/api/...`; a store-api bug → `/store-api/...`).

## Install-specific ids → placeholders
Reference pre-existing install ids via the placeholders the executor resolves against the
running shop (see BUILD.md "Fixtures rules" for the full catalog):
`{{SC}} {{NAV_CAT}} {{COUNTRY}} {{SALUTATION}} {{SALUTATION2}} {{TAX}} {{CURRENCY}}
{{LANGUAGE}} {{STOREFRONT_URL}}` — also valid inside `assertion.expect`.
Entities you create yourself go in `fixtures.json` with known 32-char hex UUIDs.

## Assertion
- `assertion.kind`: `http_status` | `response_field` | `exception`.
- `assertion.expect` is the **healthy** value (what a FIXED shop returns). Leg is
  `reproduced` when `actual != expect`, `not_reproduced` when `actual == expect`.
- `assertion.field` is a jq path, used only by `response_field`.
- `assertion.locator` is a human reference to the endpoint.
- Send `Accept: application/json` when you need the flat (non-JSON:API) response shape.

## Request ordering (multi-step)
`requests` run **in array order**. Every request except the LAST is **setup** and must
return 2xx (a non-2xx setup request → `blocked`). The `assertion` always runs on the
**final** response — so the call that surfaces the symptom must be **last**. Putting the
asserted call in the middle is the most common authoring error: its result is discarded and
a later setup response gets asserted instead.

## Worked example — multi-step store-api flow
A cart-total bug: create a context, add two products, read the cart; assert the healthy
total on the final response.

```json
{
  "requests": [
    {
      "// 1 (setup): open a store-api context; the executor captures sw-context-token from the response and carries it.": "",
      "method": "POST", "path": "/store-api/context", "headers": { "Accept": "application/json" }, "body": "{}"
    },
    {
      "// 2 (setup): add product A to the cart (id seeded in fixtures.json).": "",
      "method": "POST", "path": "/store-api/checkout/cart/line-item", "headers": { "Accept": "application/json" },
      "body": "{\"items\":[{\"type\":\"product\",\"referencedId\":\"0192f3c4a5b67890abcdef0123456789\",\"quantity\":2}]}"
    },
    {
      "// 3 (FINAL, asserted): read the cart — a healthy shop returns price.totalPrice 23.80.": "",
      "method": "GET", "path": "/store-api/checkout/cart", "headers": { "Accept": "application/json" }
    }
  ],
  "assertion": { "kind": "response_field", "field": ".price.totalPrice", "expect": "23.8", "locator": "/store-api/checkout/cart" }
}
```

Note: no `sw-access-key`, `Authorization`, or `sw-context-token` anywhere — the executor
injects auth by path and carries the context token. `expect` is the HEALTHY total, so a
buggy shop returning a different total scores `reproduced`.

## Failure semantics (no false positives)
- A non-2xx on a **non-final** request → `blocked` (setup broke; body shown).
- A **missing field** on a non-2xx **final** response → `inconclusive`, never a bogus
  `reproduced` (the symptom couldn't be evaluated).

## Comment every step
Comment each request explaining what it does and what the final assertion checks. (Inline
`"// ...": ""` keys like the example above are a convenient JSON-safe way to do this.)
