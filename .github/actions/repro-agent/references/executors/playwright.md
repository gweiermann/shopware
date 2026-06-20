# Executor: `playwright` (UI — storefront / admin)

Use for any **visual / rendered-state / interaction** bug — it is the ONLY faithful layer for
"what the page shows" (missing/blank/mis-rendered/misaligned/wrong on screen). It's the most
expensive layer, so don't use it for a pure API/service bug — but for a visual symptom it is
**required**, and an `http` check of the underlying data is not an acceptable substitute.

**If the page comes up empty or a precondition won't appear, that is a FIXTURE problem to FIX
(seed the right visible+indexed data, force the viewport, use the technical route below), or a
`blocked`/low-confidence stop — NEVER a reason to switch to `http`.** Switching to an API check for
a visual bug produces an unfaithful reproduction.

## Hard rules (the rest of this file is the WHY)
1. **Semantic locators only** — `getByRole`/`getByLabel`/`getByText`/`getByPlaceholder`
   with anchored, role-pinned names. NEVER CSS / data-test / attribute selectors, not even
   as a fallback.
2. **admin-ui specs START AUTHENTICATED** — the harness logs in. Do NOT author login steps.
3. **Preconditions** wait via `locator.waitFor({state:'visible',timeout})` and throw
   `PRECONDITION_NOT_FOUND: <what>` on miss. NEVER gate them on `isVisible()`/`isHidden()`
   or on `expect()`.
   The verifier rejects fixture-backed visual specs whose preconditions only wait for generic page
   chrome. Gate on a controlled seeded marker that makes the symptom possible: the exact product,
   CMS title/container, row, option, media, or other entity you created.
   For `admin-ui`, a route/shell/dashboard/toolbar wait is only a bootstrap check. The accepted
   precondition must also wait for the issue-specific module, action, entity, field, row, or control
   that makes the reported interaction possible.
4. **Exactly ONE `await expect(...)`** — the symptom, asserting the HEALTHY behaviour. It is
   the only failure allowed to mean `reproduced`.
5. **Make the precondition actually hold** — force a viewport for overflow/cut-off bugs;
   scroll like a user (`mouse.wheel`), never `scrollIntoViewIfNeeded()`.
   For mobile Admin sidebar/off-canvas bugs, force the viewport before `page.goto()`, open the
   real header hamburger button, wait for the target sidebar link, then trigger the symptom.
6. For hidden/off-canvas symptoms assert explicit state (`not.toBeInViewport()` /
   `toHaveAttribute(...)`), NOT `not.toBeVisible()`.
7. **Reach a seeded storefront page by its TECHNICAL route** — `/landingPage/<id>`,
   `/detail/<productId>`, `/navigation/<categoryId>`. A freshly-seeded entity has no SEO URL
   yet, so a guessed slug 404s. Never assume a slug exists; never source-dive routing to find one.
8. **The shop renders ENGLISH (en-GB).** Do NOT copy UI strings from a non-English issue
   screenshot (e.g. "In den Warenkorb") — use the English label ("Add to shopping cart") or, better,
   a language-agnostic locator: the seeded entity's own name (which you control).
9. **The final screenshot must visibly prove the issue-specific state.** If a visual fixture uses
   an image, color, badge, wide element, or selected value, make it visible in the screenshot. A
   transparent 1x1 image with CSS dimensions can satisfy Playwright visibility while proving
   nothing to a human reviewer; use a visibly colored image/text sentinel or stop as inconclusive.

## What you author
Generate `repro.spec.ts` and set `script_path: "repro.spec.ts"` in `reproduction-plan.json`. It asserts the HEALTHY
behaviour, is generated ONCE, and the SAME spec runs on BOTH the reported and trunk
versions — so it must tolerate cross-version UI drift. Use relative paths (`baseURL` is
injected). Comment every step.

**`admin-ui` specs START AUTHENTICATED — do NOT write login steps.** The harness logs in
deterministically (proven locators) and injects the session via `storageState` before your
spec runs. Begin directly at the target module, e.g.
`await page.goto('/admin#/sw/cms/index')`, and wait for a concrete element of that page.
Authoring a login preamble is the single most common source of broken runs (strict-mode
locator fumbles) — it will be redundant at best and flaky at worst. (Storefront *customer*
login, when an issue genuinely needs it, is still yours to author — follow the locator
rules below.)

For Admin issues that are not explicitly about bootstrap/login/loading, **do not start at plain
`/admin`**. Use the concrete hash route for the reported module/action (`/admin#/sw/product/index`,
`/admin#/sw/settings/rule/index`, `/admin#/sw/cms/index`, ...). Then make the precondition prove
that target, not the shell: wait for the reported field label, button, row name, module term, or
seeded entity text. If you cannot reach a target marker semantically after one verifier-guided
selector fix, stop as inconclusive with a low confidence reason; do not turn a missing target into
a healthy `not_reproduced`.

## Locators — version-stable, semantic ONLY
- Use `getByRole(role, {name})` / `getByLabel` / `getByText` / `getByPlaceholder` with
  case-insensitive regex and accessible/visible names. `getByRole` and `getByLabel` both
  resolve `aria-label` / `aria-labelledby` / associated `<label>` — Shopware's `mt-*`
  fields expose their label as the accessible name, so both work for inputs.
- **Scope inside the relevant landmark + use SPECIFIC names** to avoid strict-mode
  ambiguity: `getByRole('navigation').getByRole('link', {name:/^Products$/i})`, NOT a broad
  regex with `.first()`.
- **Anchor names and pin the role** — a broad regex matches sibling controls and throws a
  strict-mode violation. Real example: `getByLabel(/password/i)` matched the field, the
  "Show password" toggle, AND the "Forgot your password?" link. Use `/^password$/i` and pin
  the role: `getByRole('textbox', {name:/^password$/i})` (a password input is a `textbox`;
  the toggle is a `button`), so only the field matches.
- **Beware untranslated snippet keys.** If the target admin renders raw keys (e.g.
  `global.sw-admin-menu.navigation.label` instead of "Navigation"), accessible-name / text
  locators can't match. Prefer the issue's own visible strings + structural roles; a
  name-not-found is a `PRECONDITION_NOT_FOUND` (→ inconclusive), never the symptom.
- **The shop is English (en-GB); issue screenshots may not be.** Match on the ENGLISH label,
  not the screenshot's language ("Add to shopping cart", not "In den Warenkorb"). Best: anchor on
  the seeded entity's own name (which you set in the fixture and is language-independent) rather
  than a translated chrome label — a real run wasted ~10 turns because a German button-text
  precondition never matched the English UI and looked like an empty page.
- **NEVER** use CSS classes, data-test ids, or attribute selectors — not even as a
  fallback. An element no semantic locator can reach IS a `PRECONDITION_NOT_FOUND` (and may
  mean the bug isn't faithfully automatable — set low confidence).

## Structure: precondition vs symptom (this drives the verdict)
**(1) Navigation / precondition** — reach the state and WAIT for each element it depends on:
```ts
await locator.waitFor({ state: 'visible', timeout })
  .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: <what>') });
```
- NEVER gate a precondition on `isVisible()`/`isHidden()` — they return the CURRENT state
  immediately and IGNORE the timeout, so right after `page.goto()` they false-negative
  while the SPA is still bootstrapping.
- NEVER gate a precondition on `expect()`/`toBeVisible()` — a timed-out `expect` is
  classified as the SYMPTOM → false `reproduced`.
- Do NOT wait via `waitForLoadState('networkidle')` (the admin SPA long-polls and never
  settles) or `waitForURL()` on a pattern already true before the action — wait for a
  concrete post-action element.
- **The precondition MUST wait for the SPECIFIC seeded entity by its unique text, never a
  generic control.** A bare `getByRole('button', {name:/add to cart/i})` matches *any* product
  card (or a spuriously-present/partly-rendered one), so it passes even when YOUR product never
  rendered — and then the symptom `expect` fails for the wrong reason → a **false `reproduced`**.
  Real incident: an empty product slider (zero cards) passed a generic add-to-cart precondition,
  and the missing label scored `reproduced` though nothing was there. Instead, gate on the
  seeded product's own name, e.g. `getByRole('link', {name:/Live-Film Repro/i})` scoped to the
  slider — so an empty/wrong page fails the precondition (→ `inconclusive`), never fakes a repro.
- **The precondition must prove the trigger, not just the page.** If the bug needs a selected
  variant, a long dropdown, a configured CMS block, assigned media, a specific rule, or a seeded
  entity relationship, wait for a controlled marker from that trigger before the single symptom
  `expect`. A page heading, `Home`, dashboard chrome, or a generic product card is not enough.
- Do not invent hidden sentinel text and then assert it as the symptom. For example, setting a
  product `customFields.variantLabel = "Variant: Black"` does not make the stock storefront render
  that label. If the issue is about selected variant display, assert a value the default UI actually
  renders: the option name, product number, child product name, or real product-card variant
  characteristic shown in the issue screenshots.
- **For Admin dashboard/bootstrap checks, precondition on a real page marker and assert the
  reported interaction.** Do not use guessed headings like `/^dashboard$/i`; Shopware may show
  time-based greetings (`Hi!`, `Good evening.`) or cards instead. If the screenshot shows the
  Administration is usable, a missing generic heading is a locator bug, not a reproduction.
- **For Admin module/form bugs, use two mental checkpoints.** First, the admin shell must be usable;
  second, the issue-specific target must be present. Only the second checkpoint belongs in the
  decisive `PRECONDITION_NOT_FOUND` gate. Examples of good target gates: a seeded product name in
  the Products grid, a field label like `Gross price`, a named rule in Rule Builder, the exact
  module-filter row from the issue, or the action button the bug says cannot be reached. Bad gates:
  `Dashboard`, `Home`, `navigation`, `toolbar`, `Administration`, or a generic row/card/button.
- **For mobile Admin sidebar/off-canvas bugs, do not click nested menu text until the menu is open.**
  A narrow viewport collapses the menu behind the header hamburger icon, and some builds do not give
  that icon a stable accessible name. Use the banner-scoped icon button, wait for it, click it, then
  wait for the issue-specific link:
  ```ts
  test.use({ viewport: { width: 375, height: 812 } });
  await page.goto('/admin#/sw/dashboard/index');
  const menuButton = page.getByRole('banner').getByRole('button').first();
  await menuButton.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: mobile Admin menu button did not render'); });
  await menuButton.click();
  const products = page.getByRole('link', { name: /^Products$/i });
  await products.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: Products link did not render in the open mobile menu'); });
  ```
  Only after that should the spec click the target link and make the single symptom assertion.
- **For wishlist storefront bugs, prove the wishlist state before testing the card interaction.**
  First seed `system_config` with `core.cart.wishlistEnabled=true`; otherwise the product detail
  page can render without any wishlist control. Guest wishlist state can be version/session-sensitive.
  Prefer a seeded customer and a normal storefront login when the issue is about registered-customer
  wishlist behavior. If you add from a product detail page, wait for the header wishlist count/link
  to reflect the addition, then go to `/wishlist` and precondition on the seeded product card. An
  empty wishlist page or a missing wishlist button is setup failure, not the symptom. Do not click
  `Add to shopping cart` until the seeded product is visibly present on `/wishlist`.

**(2) Symptom** — exactly ONE `await expect(...)` of the HEALTHY behaviour, with a generous
timeout. This is the ONLY failure that may mean `reproduced`.
- For a hidden / closed / collapsed / off-canvas symptom use
  `await expect(locator).not.toBeInViewport()` or assert explicit state
  (`toHaveAttribute('aria-hidden','true')`) — **NOT** `not.toBeVisible()`: an element moved
  off-screen via transform/translate is still "visible" to Playwright, so `toBeVisible`
  fails on BOTH versions and FAKES a reproduction.
- **Make the symptom's PRECONDITION actually hold.** If it only fires when content exceeds
  the visible area (overflow/cut-off/"cannot scroll" bugs), FORCE a viewport that guarantees
  it (`test.use({ viewport: { width: 1280, height: 500 } })`) — at the default 720p the
  content may simply fit and the spec passes on the BUGGY version (a silent false negative
  we hit live: a 17-entry dropdown fit the default viewport).
- **For "cannot scroll / cannot reach" symptoms, scroll like a USER** — hover the element's
  container, then `page.mouse.wheel(0, N)`, then assert `toBeInViewport()`. **NEVER**
  `scrollIntoViewIfNeeded()` for these: it uses CDP and can scroll `overflow:hidden`
  ancestors a real user cannot, masking the bug (hit live: it scrolled the admin's
  `overflow:hidden` layout wrapper and faked a pass on the buggy version).
- When the target is one of many same-role items (rows, options), scope by each item's own
  visible text (`getByRole('row', {name:/module.?filter/i})`) before `.first()`/`.last()` —
  a bare role can match unrelated tables elsewhere on the page.
- For unwanted visual badges/labels, assert absence of the full symptom family, not a single
  literal value. Example: a discount rounding bug should fail if ANY `%` badge or
  `/\d+([.,]\d+)?%\s+(saved|gespart)/i` text is visible, even when the exact percentage differs
  from the issue screenshot.
- For overflow/oversized-image bugs, the screenshot must show the oversized element and the
  control it can block. A hidden, transparent, or visually blank element is a precondition gap,
  even if `getByRole('img')` is visible to Playwright.

## Worked example — admin-ui spec (starts authenticated)
A bug where the CMS module's "Create layout" button is missing. Note: no login steps, one
`expect`, precondition via `waitFor` + `PRECONDITION_NOT_FOUND`.

```ts
import { test, expect } from '@playwright/test';

test('CMS layout list shows the "Create layout" action', async ({ page }) => {
  // Precondition: reach the CMS module and wait for its list to render (NOT isVisible/expect).
  await page.goto('/admin#/sw/cms/index');
  const toolbar = page.getByRole('toolbar');
  await toolbar.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: CMS toolbar never rendered'); });

  // Symptom: a healthy admin shows the create action; the buggy one omits it.
  // This is the ONLY expect() — its failure is the reproduction.
  await expect(toolbar.getByRole('button', { name: /create layout/i })).toBeVisible({ timeout: 15_000 });
});
```

## How `run-playwright.sh` classifies the result
- genuine `expect()` assertion failure → `reproduced`
- `PRECONDITION_NOT_FOUND` / `test.skip`, navigation/connection error, or a non-assertion
  locator/timeout failure → `inconclusive` (cross-version UI drift, never a bogus
  `reproduced`)
- all pass → `not_reproduced`; no tests collected / unparseable → `inconclusive` / `blocked`

Evidence (screenshot, video, trace) is captured automatically under `test-results/`.
