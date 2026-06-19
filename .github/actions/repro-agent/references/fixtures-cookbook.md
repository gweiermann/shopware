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

## Product-slider / CMS bug
The same product graph applies; the slider slot's config references this product (or a product-stream
that matches it) — keep the product graph above as the base and add the CMS page on top, verifying the
product is listable FIRST (Rule 1).
