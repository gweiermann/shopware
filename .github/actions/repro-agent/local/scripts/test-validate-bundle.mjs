#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../../../../..');
const validator = path.join(repo, '.github/actions/repro-agent/bin/agent/validate-bundle.mjs');

const issue = `# Selected variant not displayed in CMS product slider

When selecting a specific product variant in a CMS product slider, the storefront does not display the selected variant.
`;

const plan = {
  schema_version: '1',
  issue: 30,
  executor: 'playwright',
  script_path: 'repro.spec.ts',
};

const fixtures = {
  property_group: [
    {
      id: 'aa000000000000000000000000000001',
      name: 'Color',
      options: [
        { id: 'aa000000000000000000000000000002', name: 'Black' },
        { id: 'aa000000000000000000000000000003', name: 'White' },
      ],
    },
  ],
  product: [
    { id: 'bb000000000000000000000000000001', productNumber: 'PARENT', name: 'Slider Variant Product' },
    { id: 'bb000000000000000000000000000002', parentId: 'bb000000000000000000000000000001', productNumber: 'SLIDE-VAR-1.1', options: [{ id: 'aa000000000000000000000000000002' }] },
    { id: 'bb000000000000000000000000000003', parentId: 'bb000000000000000000000000000001', productNumber: 'SLIDE-VAR-1.2', options: [{ id: 'aa000000000000000000000000000003' }] },
  ],
};

function writeBundle(spec, bundleFixtures = fixtures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
  fs.writeFileSync(path.join(dir, 'issue.md'), issue);
  fs.writeFileSync(path.join(dir, 'issue-class.txt'), 'visual');
  fs.writeFileSync(path.join(dir, 'reproduction-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'fixtures.json'), `${JSON.stringify(bundleFixtures, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'repro.spec.ts'), spec);
  return dir;
}

function run(dir) {
  return spawnSync('node', [validator], { cwd: dir, encoding: 'utf8' });
}

function writeAdminBundle(spec, adminIssue = `# Gross price field is not editable in Administration

The Products module should allow editing the Gross price field, but the field is not usable.
`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
  fs.writeFileSync(path.join(dir, 'issue.md'), adminIssue);
  fs.writeFileSync(path.join(dir, 'issue-class.txt'), 'visual');
  fs.writeFileSync(path.join(dir, 'reproduction-plan.json'), `${JSON.stringify({
    schema_version: '1',
    issue: 99,
    layer: 'admin-ui',
    executor: 'playwright',
    script_path: 'repro.spec.ts',
    build_profile: {
      admin_build: true,
      storefront_build: false,
      theme_build: false,
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'fixtures.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'repro.spec.ts'), spec);
  return dir;
}

const invalidUuid = writeBundle(`
import { test, expect } from '@playwright/test';
test('bad fixture uuid', async ({ page }) => {
  const card = page.getByRole('link', { name: /Slider Variant Product/i }).first();
  await card.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded product not visible'); });
  await expect(page.getByText('Black')).toBeVisible();
});
`, {
  ...fixtures,
  product: [
    { ...fixtures.product[0], id: 'cc00000000000000000000000000w101' },
    fixtures.product[1],
    fixtures.product[2],
  ],
});
const invalidUuidResult = run(invalidUuid);
if (invalidUuidResult.status === 0) {
  console.error('Expected invalid fixture UUID to be rejected');
  process.exit(1);
}
if (!invalidUuidResult.stdout.includes('32-character hex UUID')) {
  console.error(`Unexpected invalid-uuid output:\n${invalidUuidResult.stdout}\n${invalidUuidResult.stderr}`);
  process.exit(1);
}

const unsupportedPlaceholderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(unsupportedPlaceholderDir, 'issue.md'), issue);
fs.writeFileSync(path.join(unsupportedPlaceholderDir, 'issue-class.txt'), 'api');
fs.writeFileSync(path.join(unsupportedPlaceholderDir, 'reproduction-plan.json'), `${JSON.stringify({
  ...plan,
  executor: 'http',
  request: {
    method: 'POST',
    path: '/api/customer',
    body: '{"groupId":"{{UNKNOWN_GROUP}}"}',
  },
  assertions: [{ kind: 'http_status', expect: '200' }],
}, null, 2)}\n`);
fs.writeFileSync(path.join(unsupportedPlaceholderDir, 'fixtures.json'), '{}\n');
const unsupportedPlaceholderResult = run(unsupportedPlaceholderDir);
if (unsupportedPlaceholderResult.status === 0) {
  console.error('Expected unsupported placeholder to be rejected');
  process.exit(1);
}
if (!unsupportedPlaceholderResult.stdout.includes('unsupported placeholder')) {
  console.error(`Unexpected unsupported-placeholder output:\n${unsupportedPlaceholderResult.stdout}\n${unsupportedPlaceholderResult.stderr}`);
  process.exit(1);
}

const wishlistIssue = `# Wishlist add to cart button cannot be clicked

The wishlist product card renders, but clicking Add to shopping cart from the wishlist does not open the off-canvas cart.
`;
const wishlistFixturesWithoutConfig = {
  product: [
    {
      id: 'ab000000000000000000000000000001',
      name: 'Wishlist Product',
      productNumber: 'WISH-1',
    },
  ],
};
const wishlistWithoutConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(wishlistWithoutConfig, 'issue.md'), wishlistIssue);
fs.writeFileSync(path.join(wishlistWithoutConfig, 'issue-class.txt'), 'visual');
fs.writeFileSync(path.join(wishlistWithoutConfig, 'reproduction-plan.json'), `${JSON.stringify({
  ...plan,
  issue: 1,
}, null, 2)}\n`);
fs.writeFileSync(path.join(wishlistWithoutConfig, 'fixtures.json'), `${JSON.stringify(wishlistFixturesWithoutConfig, null, 2)}\n`);
fs.writeFileSync(path.join(wishlistWithoutConfig, 'repro.spec.ts'), `
import { test, expect } from '@playwright/test';
test('bad wishlist setup', async ({ page }) => {
  const product = page.getByRole('heading', { name: /^Wishlist Product$/i });
  await product.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: product missing'); });
  await expect(page.getByRole('button', { name: /Add to shopping cart/i })).toBeVisible();
});
`);
const wishlistWithoutConfigResult = run(wishlistWithoutConfig);
if (wishlistWithoutConfigResult.status === 0) {
  console.error('Expected wishlist repro without enabled wishlist config to be rejected');
  process.exit(1);
}
if (!wishlistWithoutConfigResult.stdout.includes('core.cart.wishlistEnabled')) {
  console.error(`Unexpected wishlist-without-config output:\n${wishlistWithoutConfigResult.stdout}\n${wishlistWithoutConfigResult.stderr}`);
  process.exit(1);
}

const wishlistWithConfig = writeBundle(`
import { test, expect } from '@playwright/test';
test('good wishlist setup', async ({ page }) => {
  const product = page.getByRole('heading', { name: /^Wishlist Product$/i });
  await product.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: product missing'); });
  await expect(page.getByRole('button', { name: /Add to shopping cart/i })).toBeVisible();
});
`, {
  system_config: [
    {
      id: 'ac000000000000000000000000000001',
      configurationKey: 'core.cart.wishlistEnabled',
      configurationValue: true,
    },
  ],
  product: wishlistFixturesWithoutConfig.product,
});
fs.writeFileSync(path.join(wishlistWithConfig, 'issue.md'), wishlistIssue);
const wishlistWithConfigResult = run(wishlistWithConfig);
if (wishlistWithConfigResult.status !== 0) {
  console.error(`Expected wishlist repro with enabled wishlist config to pass:\n${wishlistWithConfigResult.stdout}\n${wishlistWithConfigResult.stderr}`);
  process.exit(1);
}

const bad = writeBundle(`
import { test, expect } from '@playwright/test';
// Black appears only in a comment, so this must not count.
test('bad generic card assertion', async ({ page }) => {
  const card = page.getByRole('link', { name: /Slider Variant Product/i }).first();
  await card.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded product not visible'); });
  await expect(page.getByRole('link', { name: /Slider Variant Product/i }).first()).toBeVisible();
});
`);
const badResult = run(bad);
if (badResult.status === 0) {
  console.error('Expected generic parent-card assertion to be rejected');
  process.exit(1);
}
if (!badResult.stdout.includes('distinguishing selected-variant value')) {
  console.error(`Unexpected rejection output:\n${badResult.stdout}\n${badResult.stderr}`);
  process.exit(1);
}

const noPrecondition = writeBundle(`
import { test, expect } from '@playwright/test';
test('missing explicit precondition', async ({ page }) => {
  await expect(page.getByText('Black')).toBeVisible();
});
`);
const noPreconditionResult = run(noPrecondition);
if (noPreconditionResult.status === 0) {
  console.error('Expected missing precondition gate to be rejected');
  process.exit(1);
}
if (!noPreconditionResult.stdout.includes('PRECONDITION_NOT_FOUND')) {
  console.error(`Unexpected missing-precondition output:\n${noPreconditionResult.stdout}\n${noPreconditionResult.stderr}`);
  process.exit(1);
}

const genericPrecondition = writeBundle(`
import { test, expect } from '@playwright/test';
test('generic page chrome precondition', async ({ page }) => {
  const home = page.getByRole('link', { name: /^Home$/i });
  await home.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: home link missing'); });
  await expect(page.getByText('Black')).toBeVisible();
});
`);
const genericPreconditionResult = run(genericPrecondition);
if (genericPreconditionResult.status === 0) {
  console.error('Expected generic page chrome precondition to be rejected');
  process.exit(1);
}
if (!genericPreconditionResult.stdout.includes('controlled seeded fixture marker')) {
  console.error(`Unexpected generic-precondition output:\n${genericPreconditionResult.stdout}\n${genericPreconditionResult.stderr}`);
  process.exit(1);
}

const genericAdminShell = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test('bad generic admin shell precondition', async ({ page }) => {
  await page.goto('/admin');
  const navigation = page.getByRole('navigation');
  await navigation.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: admin navigation missing'); });
  await expect(page.getByRole('textbox', { name: /^Gross price$/i })).toBeVisible();
});
`);
const genericAdminShellResult = run(genericAdminShell);
if (genericAdminShellResult.status === 0) {
  console.error('Expected generic admin shell precondition to be rejected');
  process.exit(1);
}
if (!genericAdminShellResult.stdout.includes('generic Administration shell')) {
  console.error(`Unexpected generic-admin-shell output:\n${genericAdminShellResult.stdout}\n${genericAdminShellResult.stderr}`);
  process.exit(1);
}

const genericAdminPrecondition = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test('bad generic admin module precondition', async ({ page }) => {
  await page.goto('/admin#/sw/product/index');
  const toolbar = page.getByRole('toolbar');
  await toolbar.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: product toolbar missing'); });
  await expect(page.getByRole('textbox', { name: /^Gross price$/i })).toBeVisible();
});
`);
const genericAdminPreconditionResult = run(genericAdminPrecondition);
if (genericAdminPreconditionResult.status === 0) {
  console.error('Expected generic admin module precondition to be rejected');
  process.exit(1);
}
if (!genericAdminPreconditionResult.stdout.includes('admin-ui Playwright spec preconditions are too generic')) {
  console.error(`Unexpected generic-admin-precondition output:\n${genericAdminPreconditionResult.stdout}\n${genericAdminPreconditionResult.stderr}`);
  process.exit(1);
}

const goodAdminPrecondition = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test('good targeted admin precondition', async ({ page }) => {
  await page.goto('/admin#/sw/product/index');
  const grossPrice = page.getByRole('textbox', { name: /^Gross price$/i });
  await grossPrice.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: Gross price field missing'); });
  await expect(grossPrice).toBeEnabled();
});
`);
const goodAdminPreconditionResult = run(goodAdminPrecondition);
if (goodAdminPreconditionResult.status !== 0) {
  console.error(`Expected targeted admin precondition to pass:\n${goodAdminPreconditionResult.stdout}\n${goodAdminPreconditionResult.stderr}`);
  process.exit(1);
}

const badMobileAdminNavigation = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 375, height: 812 } });
test('bad mobile admin navigation precondition', async ({ page }) => {
  await page.goto('/admin#/sw/dashboard/index');
  await page.getByText(/^Catalogues$/i).click();
  const products = page.getByRole('link', { name: /^Products$/i });
  await products.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: Products link missing'); });
  await expect(products).not.toBeInViewport();
});
`, `# Administration sidebar does not close on mobile

On a mobile viewport, opening the Administration sidebar and navigating to Products leaves the off-canvas menu over the page.
`);
const badMobileAdminNavigationResult = run(badMobileAdminNavigation);
if (badMobileAdminNavigationResult.status === 0) {
  console.error('Expected mobile admin navigation without hamburger/menu precondition to be rejected');
  process.exit(1);
}
if (!badMobileAdminNavigationResult.stdout.includes('header hamburger/menu button')) {
  console.error(`Unexpected bad-mobile-admin-navigation output:\n${badMobileAdminNavigationResult.stdout}\n${badMobileAdminNavigationResult.stderr}`);
  process.exit(1);
}

const goodMobileAdminNavigation = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 375, height: 812 } });
test('good mobile admin navigation precondition', async ({ page }) => {
  await page.goto('/admin#/sw/dashboard/index');
  const menuButton = page.getByRole('banner').getByRole('button').first();
  await menuButton.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: mobile menu button missing'); });
  await menuButton.click();
  const products = page.getByRole('link', { name: /^Products$/i });
  await products.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: Products link missing'); });
  await expect(products).not.toBeInViewport();
});
`, `# Administration sidebar does not close on mobile

On a mobile viewport, opening the Administration sidebar and navigating to Products leaves the off-canvas menu over the page.
`);
const goodMobileAdminNavigationResult = run(goodMobileAdminNavigation);
if (goodMobileAdminNavigationResult.status !== 0) {
  console.error(`Expected mobile admin navigation with hamburger/menu precondition to pass:\n${goodMobileAdminNavigationResult.stdout}\n${goodMobileAdminNavigationResult.stderr}`);
  process.exit(1);
}

const customFieldSentinel = writeBundle(`
import { test, expect } from '@playwright/test';
test('bad hidden custom field sentinel assertion', async ({ page }) => {
  const card = page.getByRole('link', { name: /Slider Variant Product/i }).first();
  await card.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded product not visible'); });
  await expect(page.getByText('Variant: Black', { exact: true })).toBeVisible();
});
`, {
  ...fixtures,
  product: [
    fixtures.product[0],
    {
      ...fixtures.product[1],
      translations: {
        'en-GB': {
          customFields: {
            variantLabel: 'Variant: Black',
          },
        },
      },
    },
    fixtures.product[2],
  ],
});
const customFieldSentinelResult = run(customFieldSentinel);
if (customFieldSentinelResult.status === 0) {
  console.error('Expected hidden custom field sentinel assertion to be rejected');
  process.exit(1);
}
if (!customFieldSentinelResult.stdout.includes('customFields text')) {
  console.error(`Unexpected custom-field-sentinel output:\n${customFieldSentinelResult.stdout}\n${customFieldSentinelResult.stderr}`);
  process.exit(1);
}

const good = writeBundle(`
import { test, expect } from '@playwright/test';
test('good selected variant assertion', async ({ page }) => {
  const card = page.getByRole('link', { name: /Slider Variant Product/i }).first();
  await card.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded product not visible'); });
  await expect(page.getByText('Black')).toBeVisible();
});
`);
const goodResult = run(good);
if (goodResult.status !== 0) {
  console.error(`Expected selected-variant assertion to pass:\n${goodResult.stdout}\n${goodResult.stderr}`);
  process.exit(1);
}

const syncWrappedFixtures = {
  sync_property_group: {
    entity: 'property_group',
    action: 'upsert',
    payload: fixtures.property_group,
  },
  sync_product: {
    entity: 'product',
    action: 'upsert',
    payload: fixtures.product,
  },
};
const goodSyncWrapped = writeBundle(`
import { test, expect } from '@playwright/test';
test('good selected variant assertion from sync wrapper fixtures', async ({ page }) => {
  const card = page.getByRole('link', { name: /Slider Variant Product/i }).first();
  await card.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded product not visible'); });
  await expect(page.getByText('Black')).toBeVisible();
});
`, syncWrappedFixtures);
const goodSyncWrappedResult = run(goodSyncWrapped);
if (goodSyncWrappedResult.status !== 0) {
  console.error(`Expected sync-wrapper selected-variant assertion to pass:\n${goodSyncWrappedResult.stdout}\n${goodSyncWrappedResult.stderr}`);
  process.exit(1);
}

console.log('validate-bundle tests passed');
