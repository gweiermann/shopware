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

function normalizeTerms(terms) {
  const generic = /^(home|dashboard|demo ?store|default|standard|main|repro|test|true|false|null|0|1)$/i;
  return [...terms]
    .map((term) => String(term).trim())
    .filter((term) => term.length >= 3)
    .filter((term) => !generic.test(term));
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

console.log('== validate-bundle: ok ==');
