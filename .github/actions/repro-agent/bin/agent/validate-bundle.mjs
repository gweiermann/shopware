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
  if (/\b(admin|administration|sidebar|menu)\b/i.test(text)
    && !/\b(add to (shopping )?cart|shopping cart|checkout|wishlist|cart)\b/i.test(text)) {
    return false;
  }

  return /\b(add to (shopping )?cart|shopping cart|off[- ]?canvas)\b/i.test(text)
    && /\b(click|opens?|shown|visible|rendered|appears?|add(ed)?|wishlist|product card)\b/i.test(text);
}

function storefrontAccountFormIssue(text) {
  return /\b(storefront|customer|account|login|wishlist|register|registration)\b/i.test(text)
    && /\b(login|log in|register|registration|customer|wishlist|account)\b/i.test(text);
}

function usesBrittleStorefrontAccountLabelLocator(source) {
  return /\bgetByLabel\s*\(\s*(?:\/|\{|\[|'|")[^)\n]*(?:your\s+)?(?:email address|password)[^)\n]*\)/i.test(source);
}

function hasEnabledWishlistConfig(data) {
  return entityRows(data, 'system_config').some((row) => (
    row?.configurationKey === 'core.cart.wishlistEnabled'
      && (row.configurationValue === true || row.configurationValue === 1 || row.configurationValue === 'true')
  ));
}

function productHasCategory(data, product) {
  if (entityPayload(product?.categories).length > 0) return true;
  return entityRows(data, 'product_category').some((row) => String(row?.productId ?? '') === String(product?.id ?? ''));
}

function productHasVisibility(data, product) {
  if (entityPayload(product?.visibilities).length > 0) return true;
  return entityRows(data, 'product_visibility').some((row) => String(row?.productId ?? '') === String(product?.id ?? ''));
}

function storefrontProductFixtureGaps(data) {
  return entityRows(data, 'product')
    .filter((product) => product?.id && product?.active !== false)
    .flatMap((product) => {
      const gaps = [];
      if (!productHasCategory(data, product)) gaps.push(`${product.id}: missing category assignment`);
      if (!productHasVisibility(data, product)) gaps.push(`${product.id}: missing sales-channel visibility`);
      return gaps;
    });
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

function adminMobileRouteNavigationIssue(text) {
  return adminMobileNavigationIssue(text)
    && /\b(click(?:ing)?|select(?:ing)?|open(?:ing)?|navigate|navigation|route|module|menu item|link)\b/i.test(text);
}

function adminPriceEditIssue(text) {
  return /\b(admin|administration|product|price|gross|net|decimal|trailing|edit|editing|field)\b/i.test(text)
    && /\b(price|gross|net|decimal|trailing zero|backspace|field)\b/i.test(text);
}

function adminMediaReplacementIssue(text) {
  return /\b(admin|administration|media|image|asset|file|upload|replace|replacement|gallery|teaser|cms)\b/i.test(text)
    && /\b(media|image|asset|file|upload|replace|replacement|gallery)\b/i.test(text)
    && /\b(replace|replacement|upload|button|disabled|enabled|gray|grey|used|usage|teaser|cms)\b/i.test(text);
}

function syncSeedsMediaRows(data) {
  return entityRows(data, 'media').length > 0;
}

function specUsesMediaLibraryReplaceFlow(source) {
  return /\/admin#\/sw\/media(?:\/index)?|replace media|getByRole\s*\([^)]*replace|filechooser|setInputFiles/i.test(source);
}

function productLayoutPreconditionForMediaReplacement(source) {
  return /\/sw\/product\/detail\/[^'"`]+\/layout/.test(source)
    && /PRECONDITION_NOT_FOUND:[^'"`\n]*(?:layout|CMS|teaser|assignment)/i.test(source);
}

function cmsEditorTextClick(source) {
  const cmsSegments = [];
  const gotoMatches = [...source.matchAll(/\bpage\.goto\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)];
  for (const [index, match] of gotoMatches.entries()) {
    if (!/\/admin#\/sw\/cms\/detail\//.test(match[2])) continue;
    const start = match.index ?? 0;
    const next = gotoMatches[index + 1]?.index ?? source.length;
    cmsSegments.push(source.slice(start, next));
  }
  if (cmsSegments.length === 0) return false;

  return cmsSegments.some((segment) => {
    if (/getByText\s*\([^)]*\)\s*\.click\s*\(/s.test(segment)) return true;

    const textLocatorVariables = [...segment.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*getByText\s*\(/g)]
      .map((match) => match[1]);

    return textLocatorVariables.some((name) => new RegExp(`\\b${name}\\s*\\.\\s*click\\s*\\(`).test(segment));
  });
}

function rawAdminApiCallInPlaywright(source) {
  return /\bfetch\s*\(\s*['"`]\/api\//s.test(source)
    || /\bpage\.request\.(?:get|post|put|patch|delete)\s*\(\s*['"`]\/api\//s.test(source);
}

function hasGuestWishlistAddWithoutStateProof(source) {
  const addMatch = source.match(/(?:Add to wishlist|add to wishlist)/i);
  if (!addMatch) return false;

  const afterAddText = source.slice(addMatch.index);
  const clickMatch = afterAddText.match(/\.click\s*\(/);
  if (!clickMatch) return false;

  const afterClick = afterAddText.slice(clickMatch.index + clickMatch[0].length);
  const wishlistGotoMatch = afterClick.match(/\.goto\s*\([^)]*['"`][^'"`]*\/wishlist\b/i);
  if (!wishlistGotoMatch) return false;

  const setupProof = afterClick.slice(0, wishlistGotoMatch.index);
  return !/\b(?:waitForResponse|waitForFunction|localStorage|sessionStorage|wishlist[- ]?(?:count|badge|link|storage)|header[^;\n]*wishlist|getByRole\s*\(\s*['"]link['"][^;\n]*wishlist)\b/i.test(setupProof);
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

function hasGenericAdminChromeFailure(source, text) {
  const preconditions = preconditionSnippet(source);
  const genericChrome = /\bPRECONDITION_NOT_FOUND:[^\n]*(?:back|save|dashboard|toolbar|admin shell|administration shell)\b/i.test(preconditions);
  const reported = /\b(back|save|dashboard|toolbar|admin shell|administration shell)\b/i.test(text);
  return genericChrome && !reported;
}

function hasBootstrapUsabilityAsPrecondition(source) {
  const preconditions = preconditionSnippet(source);
  return /\bPRECONDITION_NOT_FOUND:[^\n]*(?:admin(?:istration)? shell|shell|main|banner|dashboard|usable|progress|progressbar|spinner|loading indicator|did not become visible|did not appear|did not load|within \d+\s*seconds?)\b/i.test(preconditions);
}

function parseSimpleThroughputExpression(expression) {
  const normalized = String(expression).replace(/\s+/g, '');
  const firstNumber = normalized.match(/^\d+(?:\.\d+)?/);
  if (!firstNumber) return null;

  let value = Number(firstNumber[0]);
  const factors = normalized.match(/\*1024/g) ?? [];
  for (const _factor of factors) value *= 1024;
  if (/\/8(?:\D|$)/.test(normalized)) value /= 8;
  return Number.isFinite(value) ? value : null;
}

function slow3gIssue(text) {
  return /\b(slow|throttl|3g|network)\b/i.test(text) && /\b3g\b/i.test(text);
}

function usesTooFastNetworkProfileForSlow3g(source) {
  if (!/Network\.emulateNetworkConditions/s.test(source)) return false;

  const download = source.match(/downloadThroughput\s*:\s*([^,\n}]+)/);
  const latency = source.match(/latency\s*:\s*(\d+(?:\.\d+)?)/);
  const downloadBytesPerSecond = download ? parseSimpleThroughputExpression(download[1]) : null;
  const latencyMs = latency ? Number(latency[1]) : null;

  return (downloadBytesPerSecond !== null && downloadBytesPerSecond > (600 * 1024 / 8))
    || (latencyMs !== null && latencyMs < 300);
}

function usesTooLongBootstrapAssertionTimeout(source) {
  const timeoutMatches = [...source.matchAll(/expect\s*\([\s\S]{0,160}?\)\s*\.\s*to(?:BeVisible|HaveURL|BeInViewport|ContainText|HaveText)\s*\(\s*(?:[^,)]*,\s*)?\{[^}]*timeout\s*:\s*([0-9_]+)/g)];
  return timeoutMatches.some((match) => Number(match[1].replace(/_/g, '')) > 35_000);
}

function hasBootstrapElapsedTimeAssertion(source) {
  return /\b(?:Date\.now|performance\.now)\s*\(/s.test(source)
    && /\b(?:elapsed|duration|took|startedAt|startTime)\b/i.test(source)
    && /expect\s*\([^)]*(?:elapsed|duration|took|Date\.now|performance\.now)[^)]*\)\s*\.\s*(?:toBeLessThan(?:OrEqual)?|toBeGreaterThan(?:OrEqual)?|toBe)\s*\(/is.test(source);
}

function hasUnboundedClick(source) {
  return [...source.matchAll(/\.click\s*\(([^)]*)\)/g)]
    .some((match) => {
      const args = match[1].trim();
      return !/\btimeout\s*:/.test(args);
    });
}

function hasUnboundedFileChooserWait(source) {
  return [...source.matchAll(/\.waitForEvent\s*\(\s*['"]filechooser['"]\s*(?:,([^)]*))?\)/g)]
    .some((match) => !/\btimeout\s*:/.test(match[1] ?? ''));
}

function usesAdminDetailTabAsLink(source) {
  const detailRoute = /\/admin#\/sw\/[^'"`]+\/detail\//.test(source);
  const detailTabNames = /(?:General|Specifications|Advanced pricing|Variants|Layout|SEO|Cross Selling|Reviews|Media|Documents|Addresses|Orders|Customers)/i;
  return detailRoute
    && [...source.matchAll(/getByRole\s*\(\s*['"]link['"]\s*,\s*\{[^}]*name\s*:\s*([^}\n]+)\}/g)]
      .some((match) => detailTabNames.test(match[1]));
}

function usesUnsupportedPageDisplayValueLocator(source) {
  return /\bpage\.getByDisplayValue\s*\(/.test(source);
}

function uploadsBeforeMediaLibraryForMediaReplacement(source) {
  const firstFileChooser = source.search(/\.waitForEvent\s*\(\s*['"]filechooser['"]/);
  if (firstFileChooser === -1) return false;
  const firstMediaLibraryNavigation = source.search(/\/admin#\/sw\/media(?:\/index)?/);
  return firstMediaLibraryNavigation === -1 || firstFileChooser < firstMediaLibraryNavigation;
}

function hasSeededNavigationCategory(data) {
  return entityRows(data, 'category').some((row) => (
    row?.id
      && row.id !== '{{NAV_CAT}}'
      && (row.parentId === '{{NAV_CAT}}' || row.parentId)
      && (row.name || row.translated?.name)
  ));
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

function assertionsFromPlan(data) {
  if (Array.isArray(data.assertions)) return data.assertions;
  if (data.assertion && typeof data.assertion === 'object') return [data.assertion];
  return [];
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
    if (/PRECONDITION_NOT_FOUND|\.waitFor\s*\(|\brequireVisible\s*\(/.test(line)) {
      const maxOffset = /PRECONDITION_NOT_FOUND/.test(line) ? 0 : 1;
      for (let offset = -4; offset <= maxOffset; offset += 1) {
        const target = index + offset;
        if (target >= 0 && target < lines.length) picked.add(target);
      }
    }
  });
  return [...picked].sort((a, b) => a - b).map((index) => lines[index]).join('\n');
}

function groupedPreconditionCatch(source) {
  const tryCatchBlocks = source.matchAll(/try\s*\{([\s\S]*?)\}\s*catch\s*\{([\s\S]*?PRECONDITION_NOT_FOUND[\s\S]*?)\}/g);
  return [...tryCatchBlocks].some((match) => {
    const waitCount = (match[1].match(/\.waitFor\s*\(/g) ?? []).length;
    return waitCount > 1;
  });
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
  if (/\{\{[A-Z0-9_]+\}\}/.test(executable)) {
    fail('Playwright spec contains unresolved {{PLACEHOLDER}} tokens; placeholders are substituted only in fixtures/plan seeding, not inside browser-executed test code');
  }
  if (rawAdminApiCallInPlaywright(executable)) {
    fail('Playwright UI repros must not perform raw Admin API setup calls from page.evaluate/fetch or page.request; seed static state with fixtures.json or use real UI interactions so auth, placeholders, and screenshots stay faithful');
  }
  if (/\bscrollIntoViewIfNeeded\s*\(/.test(executable)) {
    fail('Playwright repros must not use scrollIntoViewIfNeeded(); it uses automation-only scrolling and can hide reachability bugs or burn the test timeout on invisible elements. Use route/state setup, visible target waits, and user-like wheel scrolling only when scrolling itself is part of the reported symptom');
  }
  if (hasUnboundedFileChooserWait(executable)) {
    fail('Playwright file upload flows must bound page.waitForEvent("filechooser", { timeout: ... }); an upload selector that does not open the chooser should fail fast as setup drift instead of burning the full test timeout');
  }
  if (usesAdminDetailTabAsLink(executable)) {
    fail('Admin detail page tabs such as General, Layout, Variants, SEO, Cross Selling, and Reviews expose ARIA role "tab", not "link"; use getByRole("tab", { name: ... }) for tab-strip navigation to avoid false PRECONDITION_NOT_FOUND failures');
  }
  if (usesUnsupportedPageDisplayValueLocator(executable)) {
    fail('This Playwright runtime does not provide page.getByDisplayValue(); use supported semantic locators such as getByRole("textbox", { name: ... }), getByLabel, getByText markers, or a scoped locator from a visible field/container');
  }
  if (!executable.includes('PRECONDITION_NOT_FOUND')) {
    fail('playwright spec has no PRECONDITION_NOT_FOUND precondition gate; missing setup must be inconclusive, not a reproduced/not_reproduced verdict');
  }
  if (!/\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]/s.test(executable)) {
    fail('playwright spec has no visible waitFor precondition; gate the rendered setup with locator.waitFor({ state: "visible", ... }) before the symptom expect');
  }
  if (groupedPreconditionCatch(executable)) {
    fail('Playwright preconditions must not group multiple distinct waits in one PRECONDITION_NOT_FOUND catch; wrap each required marker/control separately so verifier failures name the exact missing state');
  }

  if (wishlistIssue(issue) && !hasEnabledWishlistConfig(fixtures)) {
    fail('wishlist Playwright repro must seed system_config core.cart.wishlistEnabled=true; a missing wishlist button/page is setup failure, not the symptom');
  }
  if (wishlistIssue(issue)) {
    const productGaps = storefrontProductFixtureGaps(fixtures);
    if (productGaps.length > 0) {
      fail([
        'wishlist/storefront Playwright repro must seed products as storefront-visible before using /detail/<productId>',
        `fixture gaps: ${productGaps.slice(0, 5).join('; ')}`,
        'add both a {{NAV_CAT}} category assignment and sales-channel visibility; a blank product detail page is a seed gap, not the symptom'
      ].join(' — '));
    }
    if (hasGuestWishlistAddWithoutStateProof(executable)) {
      fail('wishlist Playwright repro clicks Add to wishlist and then opens /wishlist without proving the guest wishlist state changed; wait for the header wishlist count/link, localStorage wishlist entry, or guest-pagelet response before navigating, otherwise an empty /wishlist page is only a setup failure');
    }
  }
  if (storefrontAccountFormIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
    && usesBrittleStorefrontAccountLabelLocator(executable)) {
    fail('storefront account/login form repro must use scoped getByRole("textbox", { name }) for email/password fields; getByLabel is brittle on older storefront markup even when the label is visible');
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
      if (hasBootstrapUsabilityAsPrecondition(executable)) {
        fail('admin bootstrap/login repro must assert shell usability as the single healthy expect; do not convert “admin shell did not become usable within the timeout” into PRECONDITION_NOT_FOUND, because that is the reported symptom');
      }
      if (slow3gIssue(issue) && usesTooFastNetworkProfileForSlow3g(executable)) {
        fail('admin slow-3G repro must use a Slow-3G-like network profile, not Fast 3G. Keep download throughput around 500 kbit/s or lower and latency around 300-400ms; a faster profile can create a false not_reproduced verdict');
      }
      if (slow3gIssue(issue) && usesTooLongBootstrapAssertionTimeout(executable)) {
        fail('admin slow-3G repro must keep the shell-usability assertion near the reported 30-second threshold; using a much longer timeout can mask the reported bootstrap failure');
      }
      if (slow3gIssue(issue) && !hasBootstrapElapsedTimeAssertion(executable)) {
        fail('admin slow-3G repro must measure elapsed time from before navigation/login/bootstrap and assert it stays within the reported threshold; a locator timeout alone starts too late and can miss over-30-second bootstrap failures');
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
      if (adminMobileRouteNavigationIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
        && !/getByRole\s*\(\s*['"]link['"]/s.test(executable)) {
        fail('mobile admin route-navigation repro must click the issue-specific link inside the opened off-canvas menu; an outside click does not exercise the reported menu-item navigation path');
      }
      if (adminMobileRouteNavigationIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
        && /page\.mouse\.click\s*\(/s.test(executable)) {
        fail('mobile admin route-navigation repro must not replace the reported menu-item/link click with a generic outside click; click the opened menu link and then assert the off-canvas state');
      }
      if (adminMobileRouteNavigationIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
        && hasUnboundedClick(executable)) {
        fail('mobile admin route-navigation repro must bound setup clicks with click({ timeout: ... }) and convert failures to PRECONDITION_NOT_FOUND; off-canvas text can be visible while outside the viewport and an unbounded click can waste the full test timeout');
      }
    }
    if (!bootstrapIssue && !hasTargetedAdminPrecondition(executable)) {
      fail([
        'admin-ui Playwright spec preconditions are too generic',
        'wait for the issue-specific module/action/entity/control before the symptom expect',
        'dashboard, shell, navigation, toolbar, or Home chrome can prove the admin loaded but cannot prove the reported state is exercisable'
      ].join(' — '));
    }
    if (adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && syncSeedsMediaRows(fixtures)
      && specUsesMediaLibraryReplaceFlow(executable)) {
      fail('admin media replacement/upload repro must not rely on sync-seeded media rows as visible replaceable files; a media row has metadata but no uploaded bytes/hasFile state. Use fixtures.json for the product/CMS usage relation, but create the actual media file through a real UI upload before exercising replacement');
    }
    if (adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && specUsesMediaLibraryReplaceFlow(executable)
      && productLayoutPreconditionForMediaReplacement(executable)) {
      fail('admin media replacement repro must not make the product layout/CMS assignment screen a decisive PRECONDITION_NOT_FOUND gate before the Media-library replacement flow. Use source-derived fixtures to create the usage relation, optionally sanity-check the marker, then gate the actual setup on the replaceable media item/control in /admin#/sw/media/index');
    }
    if (adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && uploadsBeforeMediaLibraryForMediaReplacement(executable)) {
      fail('admin media replacement repros must create the initial uploaded file in /admin#/sw/media/index, not through product-detail or CMS-editor upload controls. Encode product/CMS usage relations from fixtures, use product/CMS pages only as optional state gates, then exercise upload and replacement in the media library');
    }
    if (adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && cmsEditorTextClick(executable)) {
      fail('admin CMS/media editor repro must not click visible CMS block text to select the block; the CMS config overlay intercepts pointer events. If the symptom is Media-library replacement, use the CMS page only as a seeded-state gate, then exercise replacement from /admin#/sw/media/index. If CMS editor controls are the reported target, click a real block overlay/control with a bounded click and convert failure to PRECONDITION_NOT_FOUND');
    }
    if (!bootstrapIssue && hasGenericAdminChromeFailure(executable, issue)) {
      fail([
        'admin-ui Playwright spec uses generic Admin chrome as a decisive PRECONDITION_NOT_FOUND gate',
        'Back/Save/dashboard/toolbar waits are version-specific shell checks and must not decide the run unless the issue is about that chrome',
        'gate on the seeded issue target instead, such as the product value, CMS page/block, row, field value, modal action, or media item'
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
        'keep variant names faithful to the source/test-derived product graph and assert the real card/field the reported UI should render'
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
  const assertions = assertionsFromPlan(plan);
  const responseFieldAssertions = assertions.filter((assertion) => (
    String(assertion?.role ?? 'assert') !== 'precondition'
      && (assertion?.field || assertion?.kind === 'response_field')
  ));
  const hasFinalStatusPrecondition = assertions.some((assertion) => (
    assertion?.role === 'precondition'
      && String(assertion?.kind ?? (assertion?.field ? 'response_field' : 'http_status')) === 'http_status'
      && /^2\d\d$/.test(String(assertion?.expect ?? ''))
  ));
  if (responseFieldAssertions.length > 0 && !hasFinalStatusPrecondition) {
    fail('http response-field symptom assertions must include a final 2xx http_status precondition; otherwise a setup/route/auth failure can be misclassified as the reported symptom');
  }

  const requests = Array.isArray(plan.requests) ? plan.requests : [plan.request].filter(Boolean);
  const navigationRequest = requests.some((request) => /^\/store-api\/navigation\//.test(String(request?.path ?? '')));
  if (navigationRequest && !hasSeededNavigationCategory(fixtures)) {
    fail('Store API navigation repros must seed a concrete active category below {{NAV_CAT}} and precondition on that seeded id/name; relying on the default install tree can return an empty HTTP 200 and false inconclusive');
  }
  if (navigationRequest && assertions.some((assertion) => assertion?.role === 'precondition' && String(assertion?.field ?? '') === '.id')) {
    fail('Store API navigation responses can be trees/arrays/wrapped objects; do not use root `.id` as a precondition. Use a recursive/tree-tolerant jq expression such as `[.. | objects | select(has("id"))] | length`.');
  }
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
