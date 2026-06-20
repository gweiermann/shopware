# Fixtures cookbook — verified seed graphs + the rule that makes them actually surface

> Each graph below also exists as a **runnable example** under [`cookbook/<name>/`](cookbook/) (a
> `fixtures.json` + a `reproduction-plan.json` whose assertions encode the healthy response). CI
> (`repro-cookbook-selfcheck`) seeds them on a fresh trunk shop and requires `not_reproduced`, so a
> drift turns the build red instead of letting these notes rot. Reuse an example as a starting bundle.

Most "I seeded it but it doesn't show up / the field is null / the listing is empty" failures are
**not the bug** — they are a seed/index gap. Seeded entities only become observable through
RUNTIME RESOLUTION: indexing, field **inheritance**, sales-channel **visibility**, and
listing/search **filters**. Author for that, and verify presence before trusting a result.

## Rule 1 — an empty / `null` / absent result is a SEED gap, not the symptom
An empty listing, a `null` response field, a missing slider item is almost always YOUR seed, not
the defect. Before you add the constraint that triggers the symptom (the filter / sort / search):
1. **Reindex after seeding.** `verify-reproduction.sh` runs `dal:refresh:index` for you; nothing you seed
   is listable/searchable until the DAL index runs.
2. **Confirm your entity appears in the SIMPLEST query first** (an UNFILTERED listing, or
   `shop-get`), THEN add the symptom's constraint. If the simplest query is already empty, fix the
   seed — do **not** report an empty result as the bug. A `null` you can't explain = go back to the
   seed, not to the source code.

## Rule 2 — inheritance: set parent fields once, child-read fields on the child
A variant child **inherits** `name` / `price` / `tax` / `categories` / `visibilities` from its
parent — do NOT repeat them on the child. BUT any field the symptom READS on the child must be set
ON THE CHILD. The classic trap: a **filterable property only on the parent never reaches the
listing aggregation**, so filtering by it returns ZERO rows (looks like the bug; is a seed gap).
Put the filterable property on every variant that must appear.

## Verified template — variant product that appears in a category listing
Tested live: parent + black/white variants, a filterable property (`Test=Yes`) on the variants, a
preselected display variant, assigned + visible in the sales channel. After reindex it appears in
the category listing — unfiltered → the preselected (white) variant; filtered by `Test=Yes` →
still white on a healthy shop. This is the graph for **product-listing / product-slider /
variant-preselection / availability** bugs. Reuse it; change ids + the distinguishing fields.

```json
{
  "property_group": [
    { "id": "bb000000000000000000000000000001", "name": "Test", "sortingType": "alphanumeric", "displayType": "text",
      "options": [ { "id": "bb000000000000000000000000000002", "name": "Yes", "position": 1 } ] },
    { "id": "bb000000000000000000000000000003", "name": "Color", "sortingType": "alphanumeric", "displayType": "text",
      "options": [ { "id": "bb000000000000000000000000000004", "name": "black", "position": 1 },
                   { "id": "bb000000000000000000000000000005", "name": "white", "position": 2 } ] }
  ],
  "product": [
    { "id": "cc000000000000000000000000000001", "name": "Repro", "productNumber": "REPRO-001", "stock": 100, "active": true,
      "taxId": "{{TAX}}", "price": [ { "currencyId": "{{CURRENCY}}", "gross": 19.99, "net": 16.80, "linked": true } ],
      "properties": [ { "id": "bb000000000000000000000000000002" } ],
      "configuratorSettings": [ { "id": "dd000000000000000000000000000001", "optionId": "bb000000000000000000000000000004" },
                                { "id": "dd000000000000000000000000000002", "optionId": "bb000000000000000000000000000005" } ],
      "variantListingConfig": { "displayParent": false, "mainVariantId": "cc000000000000000000000000000003", "configuratorGroupConfig": null },
      "categories": [ { "id": "{{NAV_CAT}}" } ],
      "visibilities": [ { "id": "ee000000000000000000000000000001", "salesChannelId": "{{SC}}", "visibility": 30 } ] },
    { "id": "cc000000000000000000000000000002", "productNumber": "REPRO-002-BLACK", "parentId": "cc000000000000000000000000000001",
      "stock": 50, "active": true, "options": [ { "id": "bb000000000000000000000000000004" } ],
      "properties": [ { "id": "bb000000000000000000000000000002" } ] },
    { "id": "cc000000000000000000000000000003", "productNumber": "REPRO-003-WHITE", "parentId": "cc000000000000000000000000000001",
      "stock": 50, "active": true, "options": [ { "id": "bb000000000000000000000000000005" } ],
      "properties": [ { "id": "bb000000000000000000000000000002" } ] }
  ]
}
```

Each part was verified to matter:
- `configuratorSettings` on the **parent** declare the variant axis (the options that form variants).
- `variantListingConfig.mainVariantId` **set to the variant under test** (NOT `null`) — `null`
  means no preselection, so a preselection bug isn't even exercised.
- the filterable `properties` entry on **each child** (not just the parent) — else the filter
  matches nothing.
- `visibilities` (`visibility: 30` = "everywhere") + `categories` on the parent (children inherit).
- reindex (automatic in `verify-reproduction.sh`).

## Variant option text — where it actually is (verified healthy response)
A `product-listing` element for the white variant, on a HEALTHY shop:
```json
{ "productNumber": "REPRO-003-WHITE", "variation": null, "options": [{ "name": "white" }] }
```
Option text = `.options[].name`. `variation` is `null` over http (the storefront resolves it at
render time) — so asserting `variation` is empty ⇒ false `reproduced`. A bug about the text *as
displayed* ⇒ `playwright`, not http.

## Product-slider / CMS / landing-page bug (VERIFIED — `cookbook/cms-product-slider/`)
The same product graph applies; the slider slot's config references the product (or a product-stream
that matches it). Keep the product graph above as the base, verify it's listable FIRST (Rule 1), then
add the CMS page on top. **Copy `cookbook/cms-product-slider/` verbatim and change only the
distinguishing fields** — the CMS graph below is the #1 thing runs get wrong by hand.

**Rule 3 — NEST the CMS graph; never hand-write flat `cms_section`/`cms_block`/`cms_slot`.** Author
one `cms_page` with its `sections` → `blocks` → `slots` nested inside it. Nesting lets the sync API
assign every parent FK **and the shared `versionId`** automatically. Hand-writing the children as
top-level entities means guessing the FK field names — and they are NOT `cmsPageId`/`cmsSectionId`/
`cmsBlockId`; they are **`pageId` / `sectionId` / `blockId`** — so the flat form fails sync with
`"This value should not be blank"` (a real, repeated waste of a whole run). The nested form:

```json
"cms_page": [
  { "id": "…41", "name": "Repro page", "type": "landingpage",
    "sections": [ { "id": "…42", "type": "default", "position": 0,
      "blocks": [ { "id": "…43", "type": "product-slider", "position": 0, "sectionPosition": "main",
        "slots": [ { "id": "…44", "type": "product-slider", "slot": "productSlider",
          "config": { "products": { "source": "static", "value": [ "<productId>" ] },
                      "title": { "source": "static", "value": "Repro" } } } ] } ] } ] }
],
"landing_page": [
  { "id": "…51", "name": "Repro LP", "url": "repro-slider", "active": true,
    "cmsPageId": "…41", "salesChannels": [ { "id": "{{SC}}" } ] }
]
```

**Reaching the page in the storefront (visual / `playwright`):** go to the TECHNICAL route
`/landingPage/<landingPageId>`. It **301-redirects to the page's SEO url** (Playwright follows it) —
a freshly-seeded slug is not guaranteed, the id is. The slider renders a `product-name` link whose
accessible name is the product name (which you control) — gate the precondition on that.

**Variants in a slider:** a static slider given a variant **parent** id renders **one** card that
links to the **parent** (the slider does not expand variants). For bugs where a **specific child
variant is selected/assigned** in the CMS slider, put that child variant id in
`config.products.value` and make the product card only a precondition. The symptom assertion must
target the distinguishing child value inside the rendered card (for example the option text
`Black`/`White`, a variant product number, or another visible variant-specific field). Do not score
`not_reproduced` from a visible generic parent card; that misses the reported selected-variant
symptom.

For the static CMS product-slider variant-assignment bug where the reported symptom is an empty
slider/card missing after assigning a child product id, do not make the child variant's translated
`name` unique just to create an easy assertion. That can mask the bug by changing what the default
product card renders. Keep the parent/child names in the verified cookbook shape and assert the
seeded product card/link itself becomes visible; use option names or product numbers only when the
real rendered UI is expected to show those fields.

Do not seed a hidden `customFields` label just so the assertion has text to look for. The default
product card will not render arbitrary custom fields, so that creates an artificial failing
assertion unrelated to the reported UI. Use the default variant data that Shopware can render, and
if the real issue screenshot shows a line such as `Live-Film: Stream`, model that as actual variant
configuration/name data rather than a custom-field sentinel.

## Wishlist storefront flows — prove state before the card symptom

Wishlist bugs are visual/storefront interaction bugs, so use `playwright`, but do not trust a click
on a heart icon as the setup by itself. The wishlist page can stay empty when guest/session state was
not established, and that is a setup failure, not the reported symptom.

Use the same customer shape as `cookbook/customer-addresses/` when the issue can involve a logged-in
customer, and add a deterministic password. Also explicitly enable the wishlist feature:

```json
"system_config": [
  { "id": "aa00000000000000000000000000cf01",
    "configurationKey": "core.cart.wishlistEnabled",
    "configurationValue": true }
]
```

Customer fixture:

```json
"customer": [
  { "id": "aa00000000000000000000000000c001", "customerNumber": "REPRO-C-1",
    "firstName": "Repro", "lastName": "Customer", "email": "repro-c1@example.com",
    "password": "shopware",
    "salesChannelId": "{{SC}}", "groupId": "{{CUSTOMER_GROUP}}",
    "defaultPaymentMethodId": "{{PAYMENT_METHOD}}", "salutationId": "{{SALUTATION}}",
    "defaultBillingAddressId": "aa00000000000000000000000000c002",
    "defaultShippingAddressId": "aa00000000000000000000000000c002",
    "addresses": [
      { "id": "aa00000000000000000000000000c002", "firstName": "Repro", "lastName": "Customer",
        "street": "Test St 1", "zipcode": "12345", "city": "Test",
        "countryId": "{{COUNTRY}}", "salutationId": "{{SALUTATION}}" }
    ] }
]
```

For the spec, use three preconditions before the symptom assertion:

1. The seeded product detail page rendered by technical route (`/detail/<productId>`).
2. After clicking the wishlist control, the storefront shows the wishlist state changed (header
   wishlist count/link or product wishlist button state).
3. `/wishlist` visibly contains the seeded product card.

Only then click the wishlist card's `Add to shopping cart` button and assert the healthy off-canvas
state. If `/wishlist` shows the empty-state illustration or text, fix the login/session/wishlist
setup or stop as inconclusive; never score that as the product-card bug.

## Order fixtures — keep order addresses inside the order aggregate

Order graphs are FK-heavy. Do not reuse a `customer_address` id as an
`order_delivery.shippingOrderAddressId` or `order.billingAddressId`; those fields point to
`order_address`, not `customer_address`. The portable pattern is to create the address inside the
same `order` payload and reference that order-address id from `billingAddressId` and each delivery:

```json
"order": [
  {
    "id": "12000000000000000000000000000001",
    "orderNumber": "REPRO-ORDER-1",
    "salesChannelId": "{{SC}}",
    "currencyId": "{{CURRENCY}}",
    "languageId": "{{LANGUAGE}}",
    "currencyFactor": 1,
    "orderDateTime": "2024-01-01T00:00:00+00:00",
    "stateId": "{{ORDER_STATE_OPEN}}",
    "billingAddressId": "1200000000000000000000000000000a",
    "price": { "netPrice": 10, "totalPrice": 10, "positionPrice": 10, "rawTotal": 10,
      "taxStatus": "gross", "calculatedTaxes": [], "taxRules": [] },
    "shippingCosts": { "unitPrice": 0, "totalPrice": 0, "quantity": 1,
      "calculatedTaxes": [], "taxRules": [] },
    "itemRounding": { "decimals": 2, "interval": 0.01, "roundForNet": true },
    "totalRounding": { "decimals": 2, "interval": 0.01, "roundForNet": true },
    "addresses": [
      { "id": "1200000000000000000000000000000a", "firstName": "Order", "lastName": "Billing",
        "street": "Order St 1", "zipcode": "12345", "city": "Order City",
        "countryId": "{{COUNTRY}}", "salutationId": "{{SALUTATION}}" }
    ],
    "lineItems": [
      { "id": "12000000000000000000000000000002", "identifier": "repro-line-1",
        "quantity": 1, "label": "Repro item", "good": true, "stackable": true, "removable": true,
        "type": "custom", "price": { "unitPrice": 10, "totalPrice": 10, "quantity": 1,
          "calculatedTaxes": [], "taxRules": [] },
        "priceDefinition": { "type": "quantity", "price": 10, "quantity": 1,
          "taxRules": [], "isCalculated": true } }
    ],
    "deliveries": [
      { "id": "12000000000000000000000000000003",
        "shippingOrderAddressId": "1200000000000000000000000000000a",
        "shippingCosts": { "unitPrice": 0, "totalPrice": 0, "quantity": 1,
          "calculatedTaxes": [], "taxRules": [] },
        "stateId": "{{ORDER_DELIVERY_STATE_OPEN}}",
        "shippingMethodId": "{{SHIPPING_METHOD}}",
        "positions": [
          { "id": "12000000000000000000000000000004",
            "orderLineItemId": "12000000000000000000000000000002",
            "price": { "unitPrice": 10, "totalPrice": 10, "quantity": 1,
              "calculatedTaxes": [], "taxRules": [] } }
        ] }
    ]
  }
]
```

For basic open orders, use `{{ORDER_STATE_OPEN}}` and `{{ORDER_DELIVERY_STATE_OPEN}}` instead of
literal state-machine UUIDs. For transactions, use `{{ORDER_TRANSACTION_STATE_OPEN}}`, not
`{{ORDER_STATE_OPEN}}`. Every order line item's `priceDefinition` must include `taxRules: []`, and
each delivery should include `positions` pointing at the seeded line item. If an order bug needs a
non-open state, resolve it with `shop-get.sh state-machine-state --filter ...` before authoring the
final fixture, or choose an `http` flow that creates/updates through the Admin API and marks state
resolution as setup. An FK failure while seeding an order is a fixture precondition failure, never
the reported symptom.
