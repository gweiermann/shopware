import { test, expect } from '@playwright/test';

// VERIFIED storefront render of a CMS product-slider on a landing page (the issue-#30 family:
// "<thing> not displayed in CMS product slider"). The graph in fixtures.json is the part that
// breaks runs — copy it verbatim and change only the distinguishing fields; do NOT hand-roll the
// CMS entities (see fixtures-cookbook.md "CMS pages").
//
// Proven facts this spec relies on (don't re-derive them):
//   • Landing pages are reached by their TECHNICAL route `/landingPage/<id>`. It 301-redirects to
//     the SEO url; Playwright follows it. (The id is deterministic; the slug is not.)
//   • A variant *parent* in a STATIC slider renders ONE card linking to the parent — the slider
//     does not expand variants. The card's accessible name is the (inherited) product name.
//
// This example asserts the HEALTHY, version-stable fact (the seeded product is visible in the
// slider) so the cookbook self-check stays green. For a real bug, KEEP the precondition (gate that
// the slider rendered our product) and replace the single expect() with the bug's symptom.

test('product slider on a landing page renders the seeded product', async ({ page }) => {
  await page.goto('/landingPage/cc000000000000000000000000000051');

  // Precondition: the slider rendered our seeded product as a link. Gate on the product NAME (which
  // we control) so an empty/mis-seeded slider yields PRECONDITION_NOT_FOUND (inconclusive), never a
  // false reproduced.
  const card = page.getByRole('link', { name: /Slider Variant Product/i }).first();
  await card.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded product not visible in the slider'); });

  // Symptom (HEALTHY behaviour): the seeded product is visible in the slider.
  await expect(card).toBeVisible();
});
