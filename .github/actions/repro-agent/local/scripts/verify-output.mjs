#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const root = path.resolve(arg('--root', '.'));
const planPath = path.join(root, 'reproduction-plan.json');
const fixturesPath = path.join(root, 'fixtures.json');
const specPath = path.join(root, 'repro.spec.ts');
const resultPath = path.join(root, 'builder-result.json');

const failures = [];
const warnings = [];

function readJson(file, required = true) {
  if (!fs.existsSync(file)) {
    if (required) failures.push(`Missing ${path.relative(process.cwd(), file)}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    failures.push(`Invalid JSON in ${path.relative(process.cwd(), file)}: ${error.message}`);
    return null;
  }
}

const plan = readJson(planPath);
const fixtures = readJson(fixturesPath, false);
const spec = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf8') : '';

if (plan) {
  if (!['playwright', 'http', 'direct'].includes(plan.executor)) {
    failures.push(`Invalid executor '${plan.executor}'`);
  }
  if (!Object.hasOwn(plan, 'issue')) failures.push('reproduction-plan.json must include issue');
  if (!plan.version) warnings.push('reproduction-plan.json has no version');
  if (plan.executor === 'playwright') {
    if (!spec) failures.push('Playwright plan must include repro.spec.ts');
    if (plan.script_path && plan.script_path !== 'repro.spec.ts') {
      warnings.push(`Unexpected playwright script_path '${plan.script_path}'`);
    }
  }
}

if (plan?.executor === 'playwright' && spec) {
  const expectCount = [...spec.matchAll(/\bawait\s+expect\s*\(/g)].length;
  if (expectCount !== 1) {
    failures.push(`Playwright specs must contain exactly one awaited expect(); found ${expectCount}`);
  }
  if (!spec.includes('PRECONDITION_NOT_FOUND')) {
    failures.push('Playwright spec must mark missing setup with PRECONDITION_NOT_FOUND');
  }
  if (!/page\.goto\(['"]\/(landingPage|detail|navigation)\//.test(spec)) {
    warnings.push('Storefront specs should navigate by a technical route (/landingPage, /detail, /navigation)');
  }
  if (/locator\(|\$\(|data-testid|querySelector|\.[a-zA-Z0-9_-]+/.test(spec)) {
    warnings.push('Spec may contain non-semantic locators or CSS-like selectors; inspect manually');
  }
}

if (fixtures?.cms_page) {
  for (const page of fixtures.cms_page) {
    if (!Array.isArray(page.sections)) {
      failures.push('cms_page entries must nest sections');
      continue;
    }
    for (const section of page.sections) {
      if (!Array.isArray(section.blocks)) failures.push('cms_page.sections entries must nest blocks');
      for (const block of section.blocks || []) {
        if (!Array.isArray(block.slots)) failures.push('cms_page.sections.blocks entries must nest slots');
      }
    }
  }
}

if (fs.existsSync(resultPath)) {
  const result = readJson(resultPath);
  if (result && plan?.executor === 'playwright') {
    const hasArtifact = result.evidence?.artifacts?.some((item) => item.kind === 'playwright-results');
    if (!hasArtifact) failures.push('Playwright result lacks playwright-results artifact evidence');
  }
} else {
  warnings.push('No builder-result.json found; skipped runtime evidence checks');
}

for (const warning of warnings) console.warn(`WARN: ${warning}`);
for (const failure of failures) console.error(`FAIL: ${failure}`);

if (failures.length > 0) process.exit(1);
console.log(`OK: ${path.relative(process.cwd(), root)} passes local repro-agent contract checks`);
