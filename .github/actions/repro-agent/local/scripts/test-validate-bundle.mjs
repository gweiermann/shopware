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

const supportedInstallPlaceholdersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(supportedInstallPlaceholdersDir, 'issue.md'), '# Admin order API endpoint returns a billing address\n');
fs.writeFileSync(path.join(supportedInstallPlaceholdersDir, 'issue-class.txt'), 'api');
fs.writeFileSync(path.join(supportedInstallPlaceholdersDir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 23,
  executor: 'http',
  request: {
    method: 'POST',
    path: '/api/_action/sync',
    body: '{"stateId":"{{ORDER_STATE_OPEN}}","deliveryStateId":"{{ORDER_DELIVERY_STATE_OPEN}}","transactionStateId":"{{ORDER_TRANSACTION_STATE_OPEN}}","shippingMethodId":"{{SHIPPING_METHOD}}","paymentMethodId":"{{PAYMENT_METHOD}}"}',
  },
  assertions: [{ kind: 'http_status', expect: '200' }],
}, null, 2)}\n`);
fs.writeFileSync(path.join(supportedInstallPlaceholdersDir, 'fixtures.json'), '{}\n');
const supportedInstallPlaceholdersResult = run(supportedInstallPlaceholdersDir);
if (supportedInstallPlaceholdersResult.status !== 0) {
  console.error(`Expected supported install placeholders to pass:\n${supportedInstallPlaceholdersResult.stdout}\n${supportedInstallPlaceholdersResult.stderr}`);
  process.exit(1);
}

const badRegisterPayloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(badRegisterPayloadDir, 'issue.md'), '# store-api registration preserves shipping address salutation\n');
fs.writeFileSync(path.join(badRegisterPayloadDir, 'issue-class.txt'), 'api');
fs.writeFileSync(path.join(badRegisterPayloadDir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 2,
  executor: 'http',
  request: {
    method: 'POST',
    path: '/store-api/account/register',
    body: JSON.stringify({
      firstName: 'Max',
      lastName: 'Mustermann',
      email: 'max@example.com',
      password: 'shopware',
      billingAddress: {
        countryId: '{{COUNTRY}}',
        street: 'Example St 1',
        zipcode: '12345',
        city: 'Example City',
      },
    }),
  },
  assertions: [{ kind: 'http_status', expect: '200' }],
}, null, 2)}\n`);
fs.writeFileSync(path.join(badRegisterPayloadDir, 'fixtures.json'), '{}\n');
const badRegisterPayloadResult = run(badRegisterPayloadDir);
if (badRegisterPayloadResult.status === 0) {
  console.error('Expected nested-only store-api account/register billing payload to be rejected');
  process.exit(1);
}
if (!badRegisterPayloadResult.stdout.includes('top-level billing field')) {
  console.error(`Unexpected bad-register-payload output:\n${badRegisterPayloadResult.stdout}\n${badRegisterPayloadResult.stderr}`);
  process.exit(1);
}

const wrongAccountAddressMethodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(wrongAccountAddressMethodDir, 'issue.md'), '# store-api registration preserves shipping address salutation\n');
fs.writeFileSync(path.join(wrongAccountAddressMethodDir, 'issue-class.txt'), 'api');
fs.writeFileSync(path.join(wrongAccountAddressMethodDir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 2,
  executor: 'http',
  requests: [
    { method: 'POST', path: '/store-api/account/register', body: '{}' },
    { method: 'GET', path: '/store-api/account/address' },
  ],
  assertions: [{ role: 'precondition', kind: 'http_status', expect: '200' }],
}, null, 2)}\n`);
fs.writeFileSync(path.join(wrongAccountAddressMethodDir, 'fixtures.json'), '{}\n');
const wrongAccountAddressMethodResult = run(wrongAccountAddressMethodDir);
if (wrongAccountAddressMethodResult.status === 0) {
  console.error('Expected GET /store-api/account/address to be rejected');
  process.exit(1);
}
if (!wrongAccountAddressMethodResult.stdout.includes('POST /store-api/account/address')) {
  console.error(`Unexpected account-address-method output:\n${wrongAccountAddressMethodResult.stdout}\n${wrongAccountAddressMethodResult.stderr}`);
  process.exit(1);
}

const responseFieldWithoutStatusPreconditionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(responseFieldWithoutStatusPreconditionDir, 'issue.md'), '# store-api product listing returns product ids\n');
fs.writeFileSync(path.join(responseFieldWithoutStatusPreconditionDir, 'issue-class.txt'), 'api');
fs.writeFileSync(path.join(responseFieldWithoutStatusPreconditionDir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 98,
  executor: 'http',
  request: {
    method: 'POST',
    path: '/store-api/product-listing/{{NAV_CAT}}',
    body: '{}',
  },
  assertions: [
    { field: '.elements | length', op: 'gt', expect: '0' },
  ],
}, null, 2)}\n`);
fs.writeFileSync(path.join(responseFieldWithoutStatusPreconditionDir, 'fixtures.json'), '{}\n');
const responseFieldWithoutStatusPreconditionResult = run(responseFieldWithoutStatusPreconditionDir);
if (responseFieldWithoutStatusPreconditionResult.status === 0) {
  console.error('Expected response-field HTTP assertion without status precondition to be rejected');
  process.exit(1);
}
if (!responseFieldWithoutStatusPreconditionResult.stdout.includes('final 2xx http_status precondition')) {
  console.error(`Unexpected response-field-status-precondition output:\n${responseFieldWithoutStatusPreconditionResult.stdout}\n${responseFieldWithoutStatusPreconditionResult.stderr}`);
  process.exit(1);
}

const responseFieldWithStatusPreconditionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(responseFieldWithStatusPreconditionDir, 'issue.md'), '# store-api product listing returns product ids\n');
fs.writeFileSync(path.join(responseFieldWithStatusPreconditionDir, 'issue-class.txt'), 'api');
fs.writeFileSync(path.join(responseFieldWithStatusPreconditionDir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 98,
  executor: 'http',
  request: {
    method: 'POST',
    path: '/store-api/product-listing/{{NAV_CAT}}',
    body: '{}',
  },
  assertions: [
    { role: 'precondition', kind: 'http_status', expect: '200' },
    { field: '.elements | length', op: 'gt', expect: '0' },
  ],
}, null, 2)}\n`);
fs.writeFileSync(path.join(responseFieldWithStatusPreconditionDir, 'fixtures.json'), '{}\n');
const responseFieldWithStatusPreconditionResult = run(responseFieldWithStatusPreconditionDir);
if (responseFieldWithStatusPreconditionResult.status !== 0) {
  console.error(`Expected response-field HTTP assertion with status precondition to pass:\n${responseFieldWithStatusPreconditionResult.stdout}\n${responseFieldWithStatusPreconditionResult.stderr}`);
  process.exit(1);
}

const badNavigationRootIdPreconditionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(badNavigationRootIdPreconditionDir, 'issue.md'), '# includes parameter from encoded _criteria ignored for Store API GET requests\n');
fs.writeFileSync(path.join(badNavigationRootIdPreconditionDir, 'issue-class.txt'), 'api');
fs.writeFileSync(path.join(badNavigationRootIdPreconditionDir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 24,
  executor: 'http',
  request: {
    method: 'GET',
    path: '/store-api/navigation/main-navigation/main-navigation?depth=2&_criteria=encoded',
  },
  assertions: [
    { role: 'precondition', kind: 'http_status', expect: '200' },
    { role: 'precondition', field: '.id', op: 'present' },
    { field: '.description', op: 'absent' },
  ],
}, null, 2)}\n`);
fs.writeFileSync(path.join(badNavigationRootIdPreconditionDir, 'fixtures.json'), `${JSON.stringify({
  category: [
    {
      id: '24000000000000000000000000000001',
      parentId: '{{NAV_CAT}}',
      name: 'Repro Navigation Category',
      type: 'page',
      active: true,
      visible: true,
    },
  ],
}, null, 2)}\n`);
const badNavigationRootIdPreconditionResult = run(badNavigationRootIdPreconditionDir);
if (badNavigationRootIdPreconditionResult.status === 0) {
  console.error('Expected root .id Store API navigation precondition to be rejected');
  process.exit(1);
}
if (!badNavigationRootIdPreconditionResult.stdout.includes('Store API navigation responses')) {
  console.error(`Unexpected navigation-root-id output:\n${badNavigationRootIdPreconditionResult.stdout}\n${badNavigationRootIdPreconditionResult.stderr}`);
  process.exit(1);
}

const goodNavigationTreePreconditionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(goodNavigationTreePreconditionDir, 'issue.md'), '# includes parameter from encoded _criteria ignored for Store API GET requests\n');
fs.writeFileSync(path.join(goodNavigationTreePreconditionDir, 'issue-class.txt'), 'api');
fs.writeFileSync(path.join(goodNavigationTreePreconditionDir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 24,
  executor: 'http',
  request: {
    method: 'GET',
    path: '/store-api/navigation/main-navigation/main-navigation?depth=2&_criteria=encoded',
  },
  assertions: [
    { role: 'precondition', kind: 'http_status', expect: '200' },
    { role: 'precondition', field: '[.. | objects | select(has("id"))] | length', op: 'gt', expect: '0' },
    { field: '[.. | objects | select(has("description"))] | length', expect: '0' },
  ],
}, null, 2)}\n`);
fs.writeFileSync(path.join(goodNavigationTreePreconditionDir, 'fixtures.json'), `${JSON.stringify({
  category: [
    {
      id: '24000000000000000000000000000001',
      parentId: '{{NAV_CAT}}',
      name: 'Repro Navigation Category',
      type: 'page',
      active: true,
      visible: true,
    },
  ],
}, null, 2)}\n`);
const goodNavigationTreePreconditionResult = run(goodNavigationTreePreconditionDir);
if (goodNavigationTreePreconditionResult.status !== 0) {
  console.error(`Expected tree-tolerant Store API navigation assertions to pass:\n${goodNavigationTreePreconditionResult.stdout}\n${goodNavigationTreePreconditionResult.stderr}`);
  process.exit(1);
}

const badNavigationWithoutSeededCategoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(badNavigationWithoutSeededCategoryDir, 'issue.md'), '# includes parameter from encoded _criteria ignored for Store API GET requests\n');
fs.writeFileSync(path.join(badNavigationWithoutSeededCategoryDir, 'issue-class.txt'), 'api');
fs.writeFileSync(path.join(badNavigationWithoutSeededCategoryDir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 24,
  executor: 'http',
  request: {
    method: 'GET',
    path: '/store-api/navigation/main-navigation/main-navigation?depth=2&_criteria=encoded',
  },
  assertions: [
    { role: 'precondition', kind: 'http_status', expect: '200' },
    { role: 'precondition', field: '[.. | objects | select(has("id"))] | length', op: 'gt', expect: '0' },
    { field: '[.. | objects | select(has("description"))] | length', expect: '0' },
  ],
}, null, 2)}\n`);
fs.writeFileSync(path.join(badNavigationWithoutSeededCategoryDir, 'fixtures.json'), '{}\n');
const badNavigationWithoutSeededCategoryResult = run(badNavigationWithoutSeededCategoryDir);
if (badNavigationWithoutSeededCategoryResult.status === 0) {
  console.error('Expected Store API navigation repro without seeded category to be rejected');
  process.exit(1);
}
if (!badNavigationWithoutSeededCategoryResult.stdout.includes('seed a concrete active category')) {
  console.error(`Unexpected navigation-without-seeded-category output:\n${badNavigationWithoutSeededCategoryResult.stdout}\n${badNavigationWithoutSeededCategoryResult.stderr}`);
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
      active: true,
      categories: [{ id: '{{NAV_CAT}}' }],
      visibilities: [
        {
          id: 'ab000000000000000000000000000002',
          salesChannelId: '{{SC}}',
          visibility: 30,
        },
      ],
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

const brittleStorefrontLoginLabels = writeBundle(`
import { test, expect } from '@playwright/test';
test('bad storefront login labels', async ({ page }) => {
  await page.goto('/account/login');
  await page.getByLabel(/^your email address$/i).fill('customer@example.com');
  await page.getByLabel(/^your password$/i).fill('shopware');
  const product = page.getByText('Wishlist Repro Product');
  await product.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: wishlist product missing'); });
  await expect(page.getByRole('dialog').getByText('Wishlist Repro Product')).toBeVisible();
});
`, {
  system_config: [{
    id: '11111111111111111111111111111113',
    configurationKey: 'core.cart.wishlistEnabled',
    configurationValue: true,
  }],
  product: wishlistFixturesWithoutConfig.product,
});
fs.writeFileSync(path.join(brittleStorefrontLoginLabels, 'issue.md'), wishlistIssue);
const brittleStorefrontLoginLabelsResult = run(brittleStorefrontLoginLabels);
if (brittleStorefrontLoginLabelsResult.status === 0) {
  console.error('Expected storefront account getByLabel login fields to be rejected');
  process.exit(1);
}
if (!brittleStorefrontLoginLabelsResult.stdout.includes('scoped getByRole("textbox"')) {
  console.error(`Unexpected storefront-login-label output:\n${brittleStorefrontLoginLabelsResult.stdout}\n${brittleStorefrontLoginLabelsResult.stderr}`);
  process.exit(1);
}

const wishlistWithoutVisibleProduct = writeBundle(`
import { test, expect } from '@playwright/test';
test('bad wishlist storefront product seed', async ({ page }) => {
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
  product: [
    {
      id: 'ab000000000000000000000000000001',
      name: 'Wishlist Product',
      productNumber: 'WISH-1',
      active: true,
    },
  ],
});
fs.writeFileSync(path.join(wishlistWithoutVisibleProduct, 'issue.md'), wishlistIssue);
const wishlistWithoutVisibleProductResult = run(wishlistWithoutVisibleProduct);
if (wishlistWithoutVisibleProductResult.status === 0) {
  console.error('Expected wishlist repro without storefront-visible product fixture to be rejected');
  process.exit(1);
}
if (!wishlistWithoutVisibleProductResult.stdout.includes('storefront-visible')) {
  console.error(`Unexpected wishlist-without-visible-product output:\n${wishlistWithoutVisibleProductResult.stdout}\n${wishlistWithoutVisibleProductResult.stderr}`);
  process.exit(1);
}

const weakCartOffcanvasAssertion = writeBundle(`
import { test, expect } from '@playwright/test';
test('bad cart offcanvas assertion', async ({ page }) => {
  const product = page.getByRole('link', { name: /^Wishlist Product$/i }).first();
  await product.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: wishlist product missing'); });
  await page.getByRole('button', { name: /Add to shopping cart/i }).click();
  await expect(page.getByRole('link', { name: /^Wishlist Product$/i }).last()).toBeVisible();
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
fs.writeFileSync(path.join(weakCartOffcanvasAssertion, 'issue.md'), wishlistIssue);
const weakCartOffcanvasAssertionResult = run(weakCartOffcanvasAssertion);
if (weakCartOffcanvasAssertionResult.status === 0) {
  console.error('Expected cart/off-canvas repro with only a product-link assertion to be rejected');
  process.exit(1);
}
if (!weakCartOffcanvasAssertionResult.stdout.includes('cart/off-canvas')) {
  console.error(`Unexpected weak-cart-offcanvas output:\n${weakCartOffcanvasAssertionResult.stdout}\n${weakCartOffcanvasAssertionResult.stderr}`);
  process.exit(1);
}

const goodCartOffcanvasAssertion = writeBundle(`
import { test, expect } from '@playwright/test';
test('good cart offcanvas assertion', async ({ page }) => {
  const product = page.getByRole('link', { name: /^Wishlist Product$/i }).first();
  await product.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: wishlist product missing'); });
  await page.getByRole('button', { name: /Add to shopping cart/i }).click();
  await expect(page.getByRole('dialog', { name: /shopping cart/i })).toBeVisible();
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
fs.writeFileSync(path.join(goodCartOffcanvasAssertion, 'issue.md'), wishlistIssue);
const goodCartOffcanvasAssertionResult = run(goodCartOffcanvasAssertion);
if (goodCartOffcanvasAssertionResult.status !== 0) {
  console.error(`Expected cart/off-canvas dialog assertion to pass:\n${goodCartOffcanvasAssertionResult.stdout}\n${goodCartOffcanvasAssertionResult.stderr}`);
  process.exit(1);
}

const inactiveVariantsNotCartIssue = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
fs.writeFileSync(path.join(inactiveVariantsNotCartIssue, 'issue.md'), `# Parent product should be considered inactive when all its variants are inactive

Visitors land on a product page with no way to add anything to their cart. The expected behavior is a 404 product detail response.
`);
fs.writeFileSync(path.join(inactiveVariantsNotCartIssue, 'issue-class.txt'), 'visual');
fs.writeFileSync(path.join(inactiveVariantsNotCartIssue, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 15,
  layer: 'storefront-ui',
  executor: 'playwright',
  script_path: 'repro.spec.ts',
}, null, 2)}\n`);
fs.writeFileSync(path.join(inactiveVariantsNotCartIssue, 'fixtures.json'), `${JSON.stringify({
  product: [
    {
      id: '15000000000000000000000000000001',
      name: 'Inactive Variant Parent',
      productNumber: 'INACTIVE-PARENT-1',
    },
  ],
}, null, 2)}\n`);
fs.writeFileSync(path.join(inactiveVariantsNotCartIssue, 'repro.spec.ts'), `
import { test, expect } from '@playwright/test';
test('inactive variant parent returns not found', async ({ page }) => {
  const marker = page.getByText(/Inactive Variant Parent/i);
  await marker.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded product marker missing'); });
  await expect(page.getByText(/not found/i)).toBeVisible();
});
`);
const inactiveVariantsNotCartIssueResult = run(inactiveVariantsNotCartIssue);
if (inactiveVariantsNotCartIssueResult.status !== 0) {
  console.error(`Expected inactive-variants product detail issue not to be treated as cart/off-canvas:\n${inactiveVariantsNotCartIssueResult.stdout}\n${inactiveVariantsNotCartIssueResult.stderr}`);
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

const genericAdminChromeGate = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test('bad generic admin chrome precondition', async ({ page }) => {
  await page.goto('/admin#/sw/cms/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const back = page.getByText(/^Back$/i);
  await back.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: admin shell Back control never rendered'); });
  const pageTitle = page.getByText('Repro Wide Image Test');
  await pageTitle.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded CMS page title missing'); });
  await expect(pageTitle).toBeVisible();
});
`, `# CMS editor image is too wide

An oversized img tag in a CMS text block makes the settings button inaccessible.
`);
const genericAdminChromeGateResult = run(genericAdminChromeGate);
if (genericAdminChromeGateResult.status === 0) {
  console.error('Expected generic admin chrome PRECONDITION_NOT_FOUND gate to be rejected');
  process.exit(1);
}
if (!genericAdminChromeGateResult.stdout.includes('generic Admin chrome')
  && !genericAdminChromeGateResult.stdout.includes('admin-ui Playwright spec preconditions are too generic')) {
  console.error(`Unexpected generic-admin-chrome-gate output:\n${genericAdminChromeGateResult.stdout}\n${genericAdminChromeGateResult.stderr}`);
  process.exit(1);
}

const badAdminPriceLabelPrecondition = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test('bad admin price label precondition', async ({ page }) => {
  await page.goto('/admin#/sw/product/detail/99000000000000000000000000000001');
  const productNumber = page.getByRole('textbox', { name: /^Product number$/i });
  await productNumber.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded product detail page missing'); });
  const grossPrice = page.getByRole('textbox', { name: /^Price \\(gross\\)$/i });
  await grossPrice.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: gross price field missing'); });
  await expect(grossPrice).toHaveValue(/^1[,.]0$/);
});
`, `# Gross price editing loses trailing decimal zero

Editing the gross price field with Backspace removes the decimal zero while focused.
`);
const badAdminPriceLabelPreconditionResult = run(badAdminPriceLabelPrecondition);
if (badAdminPriceLabelPreconditionResult.status === 0) {
  console.error('Expected admin price edit repro with guessed gross label precondition to be rejected');
  process.exit(1);
}
if (!badAdminPriceLabelPreconditionResult.stdout.includes('getByDisplayValue')) {
  console.error(`Unexpected bad-admin-price-label output:\n${badAdminPriceLabelPreconditionResult.stdout}\n${badAdminPriceLabelPreconditionResult.stderr}`);
  process.exit(1);
}

const goodAdminPrecondition = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test('good targeted admin precondition', async ({ page }) => {
  await page.goto('/admin#/sw/product/index');
  const grossPrice = page.getByDisplayValue(/1[,.]07/);
  await grossPrice.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded gross price value missing'); });
  await expect(grossPrice).toBeEnabled();
});
`);
const goodAdminPreconditionResult = run(goodAdminPrecondition);
if (goodAdminPreconditionResult.status !== 0) {
  console.error(`Expected targeted admin precondition to pass:\n${goodAdminPreconditionResult.stdout}\n${goodAdminPreconditionResult.stderr}`);
  process.exit(1);
}

const badBootstrapUsesModuleLink = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 375, height: 812 } });
test('bad admin bootstrap precondition', async ({ page }) => {
  await page.goto('/admin#/sw/dashboard/index');
  const products = page.getByRole('link', { name: /^Products$/i });
  await products.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: Products link missing'); });
  await expect(products).toBeVisible();
});
`, `# Admin area login is impossible on a slow throttled 3G connection

Logging into the Administration over a slow but stable connection times out before the admin shell becomes usable.
`);
const badBootstrapUsesModuleLinkResult = run(badBootstrapUsesModuleLink);
if (badBootstrapUsesModuleLinkResult.status === 0) {
  console.error('Expected admin bootstrap repro with unrelated module precondition to be rejected');
  process.exit(1);
}
if (!badBootstrapUsesModuleLinkResult.stdout.includes('admin bootstrap/login repro')) {
  console.error(`Unexpected bad-bootstrap-module output:\n${badBootstrapUsesModuleLinkResult.stdout}\n${badBootstrapUsesModuleLinkResult.stderr}`);
  process.exit(1);
}

const goodBootstrapPrecondition = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test('good admin bootstrap precondition', async ({ page }) => {
  await page.goto('/admin#/sw/dashboard/index');
  const banner = page.getByRole('banner');
  await banner.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: Administration banner missing'); });
  await expect(banner).toBeVisible();
});
`, `# Admin area login is impossible on a slow throttled 3G connection

Logging into the Administration over a slow but stable connection times out before the admin shell becomes usable.
`);
const goodBootstrapPreconditionResult = run(goodBootstrapPrecondition);
if (goodBootstrapPreconditionResult.status !== 0) {
  console.error(`Expected admin bootstrap shell precondition to pass:\n${goodBootstrapPreconditionResult.stdout}\n${goodBootstrapPreconditionResult.stderr}`);
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
  await products.click();
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

const badMobileAdminOutsideClick = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 375, height: 812 } });
test('bad mobile admin outside-click trigger', async ({ page }) => {
  await page.goto('/admin#/sw/dashboard/index');
  const menuButton = page.getByRole('banner').getByRole('button').first();
  await menuButton.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: mobile menu button missing'); });
  await menuButton.click();
  await page.mouse.click(300, 300);
  await expect(page.getByRole('navigation')).not.toBeInViewport();
});
`, `# Administration sidebar does not close on mobile

On a mobile viewport, opening the Administration sidebar and navigating to Products leaves the off-canvas menu over the page.
`);
const badMobileAdminOutsideClickResult = run(badMobileAdminOutsideClick);
if (badMobileAdminOutsideClickResult.status === 0) {
  console.error('Expected mobile admin route-navigation repro with outside-click trigger to be rejected');
  process.exit(1);
}
if (!badMobileAdminOutsideClickResult.stdout.includes('outside click')) {
  console.error(`Unexpected bad-mobile-admin-outside-click output:\n${badMobileAdminOutsideClickResult.stdout}\n${badMobileAdminOutsideClickResult.stderr}`);
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

const childNameMasksCmsSliderVariant = writeBundle(`
import { test, expect } from '@playwright/test';
test('bad cms slider child-name masking assertion', async ({ page }) => {
  const card = page.getByRole('link', { name: /Slider Variant Product/i }).first();
  await card.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: seeded product not visible'); });
  await expect(page.getByText('Slider Variant Product Black')).toBeVisible();
});
`, {
  ...fixtures,
  product: [
    fixtures.product[0],
    {
      ...fixtures.product[1],
      name: 'Slider Variant Product Black',
    },
    fixtures.product[2],
  ],
});
const childNameMasksCmsSliderVariantResult = run(childNameMasksCmsSliderVariant);
if (childNameMasksCmsSliderVariantResult.status === 0) {
  console.error('Expected CMS slider variant child-name masking to be rejected');
  process.exit(1);
}
if (!childNameMasksCmsSliderVariantResult.stdout.includes('encodes option text into the child variant name')) {
  console.error(`Unexpected child-name-mask output:\n${childNameMasksCmsSliderVariantResult.stdout}\n${childNameMasksCmsSliderVariantResult.stderr}`);
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

const badOrderFixture = writeBundle(`
import { test, expect } from '@playwright/test';
test('order fixture shape', async ({ page }) => {
  const marker = page.getByText('Order fixture marker');
  await marker.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: marker missing'); });
  await expect(marker).toBeVisible();
});
`, {
  order: [
    {
      id: '12000000000000000000000000000001',
      lineItems: [
        {
          id: '12000000000000000000000000000002',
          priceDefinition: { type: 'quantity', price: 10, quantity: 1, isCalculated: true },
        },
      ],
      deliveries: [
        {
          id: '12000000000000000000000000000003',
          positions: [],
        },
      ],
      transactions: [
        {
          id: '12000000000000000000000000000004',
          stateId: '{{ORDER_STATE_OPEN}}',
        },
      ],
    },
  ],
});
const badOrderFixtureResult = run(badOrderFixture);
if (badOrderFixtureResult.status === 0) {
  console.error('Expected malformed order fixture to be rejected');
  process.exit(1);
}
if (!badOrderFixtureResult.stdout.includes('priceDefinition.taxRules')) {
  console.error(`Unexpected bad-order-fixture output:\n${badOrderFixtureResult.stdout}\n${badOrderFixtureResult.stderr}`);
  process.exit(1);
}

const mediaReplacementWithSyncMedia = writeAdminBundle(`
import { test, expect } from '@playwright/test';
test('bad media replacement seed', async ({ page }) => {
  await page.goto('/admin#/sw/media/index');
  const media = page.getByText(/^repro_teaser_media_27$/i);
  await media.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: media item missing'); });
  await media.click();
  await page.getByRole('button', { name: /^replace$/i }).waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: replace action missing'); });
  await expect(page.getByRole('button', { name: /^replace$/i })).toBeEnabled();
});
`, `# Replace button stays disabled for image used in CMS teaser

When replacing a media image that is used by a teaser, the Administration Media library keeps the Replace button disabled after upload.
`);
fs.writeFileSync(path.join(mediaReplacementWithSyncMedia, 'fixtures.json'), `${JSON.stringify({
  media: {
    entity: 'media',
    action: 'upsert',
    payload: [
      {
        id: '27000000000000000000000000000001',
        fileName: 'repro_teaser_media_27',
        fileExtension: 'png',
        mimeType: 'image/png',
        private: false,
      },
    ],
  },
}, null, 2)}\n`);
const mediaReplacementWithSyncMediaResult = run(mediaReplacementWithSyncMedia);
if (mediaReplacementWithSyncMediaResult.status === 0) {
  console.error('Expected Admin Media replacement repro with sync-seeded media rows to be rejected');
  process.exit(1);
}
if (!mediaReplacementWithSyncMediaResult.stdout.includes('sync-seeded media rows')) {
  console.error(`Unexpected media-replacement fixture output:\n${mediaReplacementWithSyncMediaResult.stdout}\n${mediaReplacementWithSyncMediaResult.stderr}`);
  process.exit(1);
}

console.log('validate-bundle tests passed');
