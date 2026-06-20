# Executor: `http` (store-/admin-API)

Use when the symptom surfaces on a store-api or admin-api **response**. Cheapest faithful
layer for most API bugs.

> **Not for visual bugs.** If the symptom is what the page *renders* (something missing, blank,
> mis-laid-out, wrong text/color on screen), `http` is **not faithful** — the API response can be
> correct while the template renders wrong, and vice versa. Use `playwright`. Do **not** fall back
> to `http` because the Playwright setup is hard; fix the fixture or stop. (See BUILD.md step 1.)

## What you author
Put the request(s) in `reproduction-plan.json` — there is **no** separate script file (the executor
generates `repro.sh` from the plan and runs it). Use:

- `request` — a single object: `{ method, path, headers, body }`, OR
- `requests` — an array for a multi-step flow (e.g. create context → add to cart → read).
  The assertions run on the **FINAL** response.

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
{{LANGUAGE}} {{CUSTOMER_GROUP}} {{PAYMENT_METHOD}} {{SHIPPING_METHOD}} {{ORDER_STATE_OPEN}}
{{ORDER_DELIVERY_STATE_OPEN}} {{STOREFRONT_URL}}` — also valid inside
an assertion's `expect`.
Entities you create yourself go in `fixtures.json` with known 32-char hex UUIDs.

## Assertions
Author a LIST of checks in `assertions: [ … ]` (a single `assertion: { … }` is also accepted).
**All checks run on the FINAL response**, and:

- **`not_reproduced`** (healthy) ⟺ **every** assertion passes;
- **`reproduced`** (buggy) ⟺ **any** assertion fails.

Each entry is `{ role?, kind?, field?, expect?, op? }`:
- `role` (default `assert`): `precondition` | `assert` — see below.
- `kind`: `http_status` (asserts the response code) or `response_field` (default when `field` is set).
- `field`: a jq path/expression evaluated on the final body (e.g. `.price.totalPrice`,
  `.errors[0].code`, `.elements | length`).
- `expect`: the **healthy** value (what a FIXED shop returns) — placeholders like `{{SALUTATION}}` allowed.
- `op` (default `equals`) — how `expect` is compared. The report renders one keyword per op
  (`require*` for preconditions, `assert*` for the symptom):

  | `op` | passes when | renders (symptom) |
  |---|---|---|
  | `equals` | actual == expect | `assertEquals(subject, expect)` |
  | `contains` | actual contains expect | `assertContains(subject, expect)` |
  | `matches` | actual matches regex expect | `assertMatches(subject, expect)` |
  | `present` | field exists & non-null | `assertPresent(subject)` |
  | `absent` | field missing/null | `assertAbsent(subject)` |
  | `gt` / `lt` | actual >/< expect (numeric) | `assertGreaterThan` / `assertLessThan` |

### Preconditions vs the symptom (avoiding false `reproduced`)
Split your checks by intent:
- **`role: "precondition"`** — "the scenario is set up correctly" (the cart has 2 items, the user
  is logged in, the call returned 200). If a precondition **fails**, the leg is **`inconclusive`**
  (a human looks) — the state was wrong, so the symptom can't be judged. These render as `require*`.
- **`role: "assert"`** (default) — "the healthy behaviour holds". This is the actual symptom; a
  failure means **`reproduced`**.

Decision order: `blocked` (setup/transport) → **any precondition fails ⇒ `inconclusive`** →
all preconditions hold ⇒ symptom asserts decide (all pass ⇒ `not_reproduced`, any fails ⇒
`reproduced`).

> **⚠️ Be mindful of false `reproduced`.** Anything you mark `assert` flips the leg to `reproduced`
> when it fails. Assert **only the field(s) that define the symptom**. Put state-validity checks
> under `role: "precondition"` instead, and never `assert` volatile/incidental values (timestamps,
> generated UUIDs, demodata-dependent counts, non-guaranteed ordering) — a healthy shop would
> "fail" those and you'd wrongly report a bug. When in doubt: fewer asserts, more preconditions.

Send `Accept: application/json` when you need the flat (non-JSON:API) response shape.

## Request ordering (multi-step)
`requests` run **in array order**. Every request except the LAST is **setup** and must
return 2xx (a non-2xx setup request → `blocked`). The assertions always run on the
**final** response — so the call that surfaces the symptom must be **last**. Putting the
asserted call in the middle is the most common authoring error: its result is discarded and
a later setup response gets asserted instead.

## Account address follow-up requests
Store API account-address listing is `POST /store-api/account/address` with an optional JSON body,
not `GET`. A `GET /store-api/account/address` returns HTTP 405 on supported versions and proves
only that the repro used the wrong route contract. For registration/address bugs, make the register
request a setup step, carry the context token automatically, then use `POST /store-api/account/address`
as the final asserted request and select the distinguishing address in the response.

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
  "assertions": [
    { "// precondition: the request worked": "", "role": "precondition", "kind": "http_status", "expect": "200" },
    { "// precondition: both line items are actually in the cart": "", "role": "precondition", "field": ".lineItems | length", "expect": "2" },
    { "// symptom: a healthy shop totals 23.80": "", "field": ".price.totalPrice", "expect": "23.8" }
  ]
}
```

Note: no `sw-access-key`, `Authorization`, or `sw-context-token` anywhere — the executor
injects auth by path and carries the context token. Each `expect` is the HEALTHY value, so a
buggy shop deviating from any of them scores `reproduced`.

## `POST /store-api/product-listing/{categoryId}` — filters are scalar/CSV, not arrays
Body filters take **comma-separated strings** of ids, NOT JSON arrays:
`{"properties":"<optionId1>,<optionId2>","manufacturer":"<id>"}`. An array
(`"properties":["..."]`) returns **HTTP 400 "contains a non-scalar value"** — a harness mistake,
not the bug. The response is `{ elements:[…products…], total, aggregations:{ properties:{entities:[…]} } }`.
A variant only appears here if it's seeded to surface (see the **fixtures cookbook**: the
filterable property must be on the variant, `visibility`+`categories` set, and reindexed). If the
listing is empty, that's the seed — verify the UNFILTERED listing returns your product before
trusting a filtered one.

## Failure semantics (no false positives)
- A non-2xx on a **non-final** request → `blocked` (setup broke; body shown).
- A failed **`role: "precondition"`** check → `inconclusive` (scenario state invalid; the failing
  `require*` is shown), never a bogus `reproduced`.
- A 401/403 that isn't itself asserted → `inconclusive` (auth rejected before the symptom ran).
- A **missing field** on a non-2xx **final** response → `inconclusive` (the symptom couldn't be evaluated).

## Comment every step
Comment each request explaining what it does and what the final assertion checks. (Inline
`"// ...": ""` keys like the example above are a convenient JSON-safe way to do this.)
