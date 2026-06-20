#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => {
  try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; }
};
const readJson = (file) => {
  const text = read(file);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

const issue = read('issue.md');
const plan = readJson('reproduction-plan.json') ?? {};
const fixtures = readJson('fixtures.json') ?? {};
const executor = String(plan.executor ?? '');
const issueClass = read('issue-class.txt').trim();
const allowedPlaceholders = new Set([
  'SC',
  'NAV_CAT',
  'COUNTRY',
  'SALUTATION',
  'SALUTATION2',
  'TAX',
  'CURRENCY',
  'LANGUAGE',
  'CUSTOMER_GROUP',
  'PAYMENT_METHOD',
  'SHIPPING_METHOD',
  'ORDER_STATE_OPEN',
  'ORDER_DELIVERY_STATE_OPEN',
  'ORDER_TRANSACTION_STATE_OPEN',
  'STOREFRONT_URL',
  'SW_ACCESS_KEY',
  'SW_CONTEXT_TOKEN',
]);

function fail(reason) {
  console.log(`== validate-bundle: REFUSED — ${reason} ==`);
  process.exit(1);
}

function entityPayload(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.payload)) return value.payload;
  return [];
}

function entityRows(data, entityName) {
  const rows = [...entityPayload(data?.[entityName])];
  if (!data || typeof data !== 'object') return rows;

  for (const value of Object.values(data)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (value.entity === entityName) rows.push(...entityPayload(value));
  }

  return rows;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/g, ''))
    .join('\n');
}

function selectedVariantIssue(text) {
  return /\b(selected|specific|assigned|preselected)\b/i.test(text)
    && /\b(variant|option|property|configuration|configurator|cms product slider|product slider)\b/i.test(text)
    && /\b(displayed|visible|rendered|shown|appears?)\b/i.test(text);
}

function cmsProductSliderVariantIssue(text) {
  return selectedVariantIssue(text) && /\b(cms product slider|product slider)\b/i.test(text);
}

function wishlistIssue(text) {
  return /\bwishlist\b/i.test(text);
}

function cartOffcanvasIssue(text) {
  return /\b(add to (shopping )?cart|shopping cart|off[- ]?canvas)\b/i.test(text)
    && /\b(click|opens?|shown|visible|rendered|appears?|add(ed)?|wishlist|product card)\b/i.test(text);
}

function hasEnabledWishlistConfig(data) {
  return entityRows(data, 'system_config').some((row) => (
    row?.configurationKey === 'core.cart.wishlistEnabled'
      && (row.configurationValue === true || row.configurationValue === 1 || row.configurationValue === 'true')
  ));
}

function collectControlledTerms(value, terms = new Set(), key = '') {
  if (Array.isArray(value)) {
    for (const item of value) collectControlledTerms(item, terms, key);
    return terms;
  }
  if (!value || typeof value !== 'object') return terms;

  for (const [childKey, childValue] of Object.entries(value)) {
    if (typeof childValue === 'string') {
      if (/(^|\.)(name|title|label|productNumber|url)$/i.test(childKey) || /(^|\.)(name|title|label|productNumber|url)$/i.test(key)) {
        terms.add(childValue);
      }
    } else {
      collectControlledTerms(childValue, terms, childKey);
    }
  }
  return terms;
}

function collectCustomFieldTerms(value, terms = new Set(), insideCustomFields = false) {
  if (Array.isArray(value)) {
    for (const item of value) collectCustomFieldTerms(item, terms, insideCustomFields);
    return terms;
  }
  if (!value || typeof value !== 'object') return terms;

  for (const [childKey, childValue] of Object.entries(value)) {
    const nextInsideCustomFields = insideCustomFields || childKey === 'customFields';
    if (nextInsideCustomFields && typeof childValue === 'string') {
      terms.add(childValue);
    } else {
      collectCustomFieldTerms(childValue, terms, nextInsideCustomFields);
    }
  }
  return terms;
}

function collectVariantTerms(data) {
  const terms = new Set();
  const products = entityRows(data, 'product');
  const optionNamesById = new Map();

  for (const group of entityRows(data, 'property_group')) {
    for (const option of entityPayload(group.options)) {
      if (option?.id && option?.name) optionNamesById.set(String(option.id), String(option.name));
    }
  }

  for (const product of products) {
    if (!product?.parentId) continue;
    if (product.productNumber) terms.add(String(product.productNumber));
    if (product.name) terms.add(String(product.name));
    for (const option of entityPayload(product.options)) {
      const name = optionNamesById.get(String(option?.id ?? ''));
      if (name) terms.add(name);
      if (option?.name) terms.add(String(option.name));
    }
  }

  return [...terms]
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .filter((term) => !/^slider variant product$/i.test(term));
}

function childVariantNamesContainingOptionTerms(data) {
  const optionNames = [];
  for (const group of entityRows(data, 'property_group')) {
    for (const option of entityPayload(group.options)) {
      if (option?.name) optionNames.push(String(option.name).trim());
    }
  }

  return entityRows(data, 'product')
    .filter((product) => product?.parentId && product?.name)
    .filter((product) => optionNames.some((name) => name.length >= 3 && String(product.name).toLowerCase().includes(name.toLowerCase())))
    .map((product) => String(product.name));
}

function normalizeTerms(terms) {
  const generic = /^(home|dashboard|demo ?store|default|standard|main|repro|test|true|false|null|0|1)$/i;
  return [...terms]
    .map((term) => String(term).trim())
    .filter((term) => term.length >= 3)
    .filter((term) => !generic.test(term));
}

function adminUiPlan() {
  const layer = String(plan.layer ?? '');
  return executor === 'playwright'
    && (layer.includes('admin') || plan.build_profile?.admin_build === true);
}

function adminBootstrapIssue(text) {
  return /\b(admin|administration|login|dashboard)\b/i.test(text)
    && /\b(loads?|loading|bootstrap|startup|start[- ]?up|login|authentication|slow|network|timeout|blank|stuck)\b/i.test(text);
}

function adminMobileNavigationIssue(text) {
  return /\b(admin|administration|sidebar|off[- ]?canvas|menu|navigation)\b/i.test(text)
    && /\b(mobile|small viewport|narrow|sidebar|off[- ]?canvas|hamburger)\b/i.test(text);
}

function collectIssueTerms(text) {
  const terms = new Set();
  for (const match of text.matchAll(/[`"“”']([^`"“”']{4,80})[`"“”']/g)) terms.add(match[1]);
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]+(?:[- ][A-Za-z0-9]+){1,5}\b/g)) terms.add(match[0]);
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]{3,}\b/g)) terms.add(match[0]);
  for (const match of text.matchAll(/\b(?:sw-[a-z0-9-]+|[a-z0-9]+(?:-[a-z0-9]+){1,5})\b/gi)) terms.add(match[0]);
  return normalizeTerms(terms);
}

function hasTargetedAdminPrecondition(source) {
  const preconditions = preconditionSnippet(source);
  const terms = [
    ...normalizeTerms(collectControlledTerms(fixtures)),
    ...collectIssueTerms(issue),
  ];
  if (terms.some((term) => preconditions.toLowerCase().includes(term.toLowerCase()))) return true;

  return /\b(getByRole|getByLabel|getByText|getByPlaceholder)\s*\([^)]*\{\s*name\s*:\s*(\/|\{|\[|'|")/s.test(preconditions)
    && !/\b(dashboard|home|navigation|toolbar|main navigation|administration shell|admin shell)\b/i.test(preconditions);
}

function hasAdminBootstrapPrecondition(source) {
  const preconditions = preconditionSnippet(source);
  return /\b(progressbar|banner|login|administration|admin shell|main|document)\b/i.test(preconditions);
}

function hasUnrelatedAdminModulePrecondition(source, text) {
  const preconditions = preconditionSnippet(source);
  const modules = [
    'Catalogues',
    'Catalogs',
    'Products',
    'Orders',
    'Customers',
    'Content',
    'Marketing',
    'Extensions',
    'Settings',
  ];

  return modules.some((module) => {
    const used = new RegExp(`\\b${module}\\b`, 'i').test(preconditions);
    const reported = new RegExp(`\\b${module}\\b`, 'i').test(text);
    return used && !reported;
  });
}

function isPlaceholder(value) {
  const match = String(value).match(/^\{\{([A-Z0-9_]+)\}\}$/);
  return match && allowedPlaceholders.has(match[1]);
}

function validateUuidFields(value, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateUuidFields(item, [...pathParts, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, childValue] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (typeof childValue === 'string' && /(^id$|Id$)/.test(key)) {
      if (!isPlaceholder(childValue) && !/^[0-9a-f]{32}$/i.test(childValue)) {
        fail(`fixtures.json field ${nextPath.join('.')} must be a 32-character hex UUID or supported {{PLACEHOLDER}}, got '${childValue}'`);
      }
    } else {
      validateUuidFields(childValue, nextPath);
    }
  }
}

function validateOrderFixtures(data) {
  for (const order of entityRows(data, 'order')) {
    for (const [index, lineItem] of entityPayload(order.lineItems).entries()) {
      const priceDefinition = lineItem?.priceDefinition;
      if (priceDefinition && !Array.isArray(priceDefinition.taxRules)) {
        fail(`order fixture lineItems.${index}.priceDefinition.taxRules must be an array; missing taxRules often seeds as array_map(... null ...) before the reported symptom can run`);
      }
    }

    for (const [index, delivery] of entityPayload(order.deliveries).entries()) {
      if (!Array.isArray(delivery?.positions) || delivery.positions.length === 0) {
        fail(`order fixture deliveries.${index}.positions must include at least one position for the seeded line item; an order seed that cannot create delivery positions is a precondition failure`);
      }
    }

    for (const [index, transaction] of entityPayload(order.transactions).entries()) {
      if (transaction?.stateId === '{{ORDER_STATE_OPEN}}') {
        fail(`order fixture transactions.${index}.stateId uses {{ORDER_STATE_OPEN}}; use {{ORDER_TRANSACTION_STATE_OPEN}} for order_transaction.state`);
      }
    }
  }
}

function collectPlaceholders(value, found = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) found.add(match[1]);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;

  for (const childValue of Object.values(value)) collectPlaceholders(childValue, found);
  return found;
}

function preconditionSnippet(source) {
  const lines = source.split('\n');
  const picked = new Set();
  lines.forEach((line, index) => {
    if (/PRECONDITION_NOT_FOUND|\.waitFor\s*\(/.test(line)) {
      const maxOffset = /PRECONDITION_NOT_FOUND/.test(line) ? 0 : 1;
      for (let offset = -4; offset <= maxOffset; offset += 1) {
        const target = index + offset;
        if (target >= 0 && target < lines.length) picked.add(target);
      }
    }
  });
  return [...picked].sort((a, b) => a - b).map((index) => lines[index]).join('\n');
}

validateUuidFields(fixtures);
validateOrderFixtures(fixtures);

const unknownPlaceholders = [...collectPlaceholders(plan)]
  .filter((name) => !allowedPlaceholders.has(name));
if (unknownPlaceholders.length > 0) {
  fail(`reproduction-plan.json uses unsupported placeholder(s): ${unknownPlaceholders.join(', ')}`);
}

if (executor === 'playwright') {
  const specPath = String(plan.script_path || 'repro.spec.ts');
  const spec = read(specPath);
  if (!spec) fail(`playwright executor but ${specPath} is missing`);

  const executable = stripComments(spec);
  if (!executable.includes('PRECONDITION_NOT_FOUND')) {
    fail('playwright spec has no PRECONDITION_NOT_FOUND precondition gate; missing setup must be inconclusive, not a reproduced/not_reproduced verdict');
  }
  if (!/\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]/s.test(executable)) {
    fail('playwright spec has no visible waitFor precondition; gate the rendered setup with locator.waitFor({ state: "visible", ... }) before the symptom expect');
  }

  if (wishlistIssue(issue) && !hasEnabledWishlistConfig(fixtures)) {
    fail('wishlist Playwright repro must seed system_config core.cart.wishlistEnabled=true; a missing wishlist button/page is setup failure, not the symptom');
  }

  if (cartOffcanvasIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)) {
    const assertionLines = executable
      .split('\n')
      .filter((line) => /\bexpect\s*\(/.test(line))
      .join('\n');
    if (!/\b(cart|off[- ]?canvas|dialog|modal|lineItems?|checkout)\b/i.test(assertionLines)) {
      fail('cart/off-canvas Playwright repro must assert the cart/off-canvas/dialog state; a repeated product link can already be visible on the source card and is only a precondition');
    }
  }

  if (adminUiPlan()) {
    const bootstrapIssue = adminBootstrapIssue(issue);
    if (!bootstrapIssue && /page\.goto\s*\(\s*['"`]\/admin\/?['"`]/.test(executable)) {
      fail('admin-ui Playwright spec navigates only to the generic Administration shell; use the concrete /admin#/sw/... route for the reported module/action, then precondition on that target state');
    }
    if (bootstrapIssue) {
      if (!/\b(mobile|small viewport|narrow|phone|responsive)\b/i.test(issue)
        && /test\.use\s*\(\s*\{[^}]*viewport\s*:\s*\{[^}]*width\s*:\s*(?:[1-5]\d{2}|600)\b/s.test(executable)) {
        fail('admin bootstrap/login repro must not force a mobile viewport unless the issue is about mobile/responsive behavior; viewport-specific chrome creates false setup failures');
      }
      if (!hasAdminBootstrapPrecondition(executable)) {
        fail('admin bootstrap/login repro must precondition on the login/bootstrap/admin-shell state itself, not on an unrelated downstream module');
      }
      if (hasUnrelatedAdminModulePrecondition(executable, issue)) {
        fail('admin bootstrap/login repro uses an unrelated module/menu link as a precondition; prove the admin shell or reported login/bootstrap state instead');
      }
    }
    if (adminMobileNavigationIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)) {
      if (!/test\.use\s*\(\s*\{[^}]*viewport\s*:\s*\{[^}]*width\s*:\s*(?:[1-5]\d{2}|600)\b/s.test(executable)) {
        fail('mobile admin navigation repro must force a narrow viewport before loading the admin route');
      }
      if (!/getByRole\s*\(\s*['"]banner['"]\s*\)[\s\S]{0,160}getByRole\s*\(\s*['"]button['"]/s.test(executable)) {
        fail('mobile admin navigation repro must open the actual header hamburger/menu button before interacting with sidebar links; do not click nested menu text before proving the menu is open');
      }
    }
    if (!bootstrapIssue && !hasTargetedAdminPrecondition(executable)) {
      fail([
        'admin-ui Playwright spec preconditions are too generic',
        'wait for the issue-specific module/action/entity/control before the symptom expect',
        'dashboard, shell, navigation, toolbar, or Home chrome can prove the admin loaded but cannot prove the reported state is exercisable'
      ].join(' — '));
    }
  }

  const fixtureTerms = normalizeTerms(collectControlledTerms(fixtures));
  if (issueClass === 'visual' && fixtureTerms.length > 0) {
    const preconditions = preconditionSnippet(executable);
    const matched = fixtureTerms.filter((term) => preconditions.includes(term));
    if (matched.length === 0) {
      fail([
        'visual playwright spec preconditions do not wait for any controlled seeded fixture marker',
        `derived candidate markers: ${fixtureTerms.slice(0, 20).join(', ')}`,
        'precondition on the exact seeded entity/container that makes the symptom possible, not generic page chrome'
      ].join(' — '));
    }
  }
}

if (executor === 'playwright' && selectedVariantIssue(issue)) {
  const specPath = String(plan.script_path || 'repro.spec.ts');
  const spec = read(specPath);
  if (!spec) fail(`selected/specific variant issue but ${specPath} is missing`);

  const executable = stripComments(spec);
  if (cmsProductSliderVariantIssue(issue)) {
    const variantNames = childVariantNamesContainingOptionTerms(fixtures);
    if (variantNames.length > 0) {
      fail([
        'CMS product-slider selected-variant repro encodes option text into the child variant name',
        `child names: ${variantNames.join(', ')}`,
        'this can mask an empty/missing-card bug by changing what the stock product card renders',
        'keep the verified cookbook variant naming shape and assert the real card/field the reported UI should render'
      ].join(' — '));
    }
  }
  const assertionLines = executable
    .split('\n')
    .filter((line) => /\b(expect|getByText|getByRole|getByLabel|getByTestId|locator|toContainText|toHaveText|textContent)\b/.test(line))
    .join('\n');

  const terms = collectVariantTerms(fixtures);
  const assertedTerms = terms.filter((term) => assertionLines.includes(term));
  const customFieldTerms = normalizeTerms(collectCustomFieldTerms(fixtures));
  const assertedCustomFieldTerms = customFieldTerms.filter((term) => assertionLines.includes(term));
  if (assertedCustomFieldTerms.length > 0) {
    fail([
      'selected/specific variant issue but the Playwright assertion uses seeded customFields text',
      `custom field values found in assertion: ${assertedCustomFieldTerms.join(', ')}`,
      'do not invent hidden sentinel text; assert a variant value the stock storefront/admin actually renders, such as the option name, product number, or real product-card variant characteristic'
    ].join(' — '));
  }
  if (terms.length === 0) {
    fail('selected/specific variant issue but fixtures.json contains no child-variant option name or product number to assert');
  }
  if (assertedTerms.length === 0) {
    fail([
      'selected/specific variant issue but the Playwright spec does not assert any distinguishing selected-variant value',
      `derived candidate values: ${terms.join(', ')}`,
      'assert the selected option/product number/variant marker in executable locator or expect code; a generic parent product card is insufficient'
    ].join(' — '));
  }
}

if (executor === 'http') {
  const requests = Array.isArray(plan.requests) ? plan.requests : [plan.request].filter(Boolean);
  for (const request of requests) {
    const method = String(request?.method ?? 'GET').toUpperCase();
    const path = String(request?.path ?? '');
    if (method === 'GET' && /^\/store-api\/account\/address(?:\?|$)/.test(path)) {
      fail('store-api account address listing uses POST /store-api/account/address, not GET; wrong method returns 405 and makes the repro inconclusive');
    }
    if (method === 'POST' && /^\/store-api\/account\/register(?:\?|$)/.test(path)) {
      let body = null;
      try { body = JSON.parse(String(request?.body ?? '{}')); } catch {}
      const missingRootBillingFields = ['countryId', 'street', 'zipcode', 'city']
        .filter((field) => !body?.[field]);
      if (body?.billingAddress && missingRootBillingFields.length > 0) {
        fail(`store-api account/register payload puts billingAddress in a nested object but omits required top-level billing field(s): ${missingRootBillingFields.join(', ')}; Shopware returns 400 before the symptom can run`);
      }
    }
  }
}

console.log('== validate-bundle: ok ==');
