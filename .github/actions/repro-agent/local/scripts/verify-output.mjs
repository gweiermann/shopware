#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

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

const validator = path.join(process.cwd(), '.github/actions/repro-agent/bin/agent/validate-bundle.mjs');
if (fs.existsSync(validator)) {
  const result = spawnSync('node', [validator], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    failures.push(`validate-bundle rejected the reproduction bundle:\n${result.stdout}${result.stderr}`);
  }
}

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
  const expectCount = [...spec.matchAll(/\bawait\s+expect\s*(?:\.\s*poll)?\s*\(/g)].length;
  if (expectCount !== 1) {
    failures.push(`Playwright specs must contain exactly one awaited expect(); found ${expectCount}`);
  }
  if (!spec.includes('PRECONDITION_NOT_FOUND')) {
    failures.push('Playwright spec must mark missing setup with PRECONDITION_NOT_FOUND');
  }
  const layer = String(plan.layer ?? '');
  const isStorefrontPlan = !layer.includes('admin') && /page\.goto\(['"]\/(?!admin\b)/.test(spec);
  if (isStorefrontPlan && !/page\.goto\(['"]\/(landingPage|detail|navigation)\//.test(spec)) {
    warnings.push('Storefront specs should navigate by a technical route (/landingPage, /detail, /navigation)');
  }
  if (/locator\(|\$\(|data-testid|querySelector|\.[a-zA-Z0-9_-]+/.test(spec)) {
    warnings.push('Spec may contain non-semantic locators or CSS-like selectors; inspect manually');
  }
}

function entityPayload(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.payload)) return value.payload;
  return [];
}

function normalizeSource(source) {
  return String(source ?? '').replace(/\r\n/g, '\n').trim();
}

if (fixtures?.cms_page) {
  for (const page of entityPayload(fixtures.cms_page)) {
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
    if (spec && normalizeSource(result.evidence?.script) !== normalizeSource(spec)) {
      failures.push('Playwright runtime evidence is stale: builder-result.json evidence.script does not match the final repro.spec.ts; rerun verify-reproduction.sh after editing the spec');
    }
  }
  if (result && plan && ['blocked', 'inconclusive', 'missing'].includes(result.status)) {
    if (typeof plan.confidence === 'number' && plan.confidence > 0.5) {
      failures.push(`Runtime result is ${result.status}, but reproduction-plan.json still claims high confidence (${plan.confidence})`);
    }
    if (!plan.blocked_reason && !plan.confidence_reason) {
      failures.push(`Runtime result is ${result.status}; reproduction-plan.json must explain the uncertainty in blocked_reason or confidence_reason`);
    }
  }
  if (result && plan && ['reproduced', 'not_reproduced'].includes(result.status)) {
    if (plan.blocked_reason) {
      failures.push(`Runtime result is ${result.status}, but reproduction-plan.json still has blocked_reason; remove stale blocked metadata after a classified verifier result`);
    }
    if (typeof plan.confidence !== 'number' || plan.confidence <= 0.5) {
      failures.push(`Runtime result is ${result.status}, but reproduction-plan.json confidence is not classified-run confidence (${plan.confidence ?? 'missing'})`);
    }
    if (plan.confidence_reason && /\b(blocked|inconclusive|precondition missing|could not|uncertain|unproven|not stable|failed)\b/i.test(String(plan.confidence_reason))) {
      failures.push(`Runtime result is ${result.status}, but reproduction-plan.json confidence_reason still describes a failed or uncertain run`);
    }
  }
} else {
  warnings.push('No builder-result.json found; skipped runtime evidence checks');
}

for (const warning of warnings) console.warn(`WARN: ${warning}`);
for (const failure of failures) console.error(`FAIL: ${failure}`);

if (failures.length > 0) process.exit(1);
console.log(`OK: ${path.relative(process.cwd(), root)} passes local repro-agent contract checks`);
