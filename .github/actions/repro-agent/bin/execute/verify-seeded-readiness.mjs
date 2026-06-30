#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
const planPath = process.env.REPRO_PLAN || 'reproduction-plan.json';
const out = process.env.OUT || 'seeded-readiness.json';

function writeResult(result) {
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}

function localTarget(rawTarget) {
  const target = String(rawTarget ?? '');
  if (!target) return null;
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (!['localhost', '127.0.0.1', 'host.docker.internal'].includes(url.hostname)) return null;
      return target;
    } catch {
      return null;
    }
  }
  return `${appUrl}/${target.replace(/^\/+/, '')}`;
}

function screenshotPath(check, index) {
  const explicit = typeof check.screenshot === 'string' ? check.screenshot : '';
  if (explicit && !path.isAbsolute(explicit) && !explicit.includes('..')) return explicit;
  return path.join('test-results', `seeded-readiness-${index + 1}.png`);
}

function checksFromPlan(plan) {
  if (Array.isArray(plan.seeded_readiness)) return plan.seeded_readiness;
  if (Array.isArray(plan.readiness_checks)) return plan.readiness_checks;
  return [];
}

if (!appUrl || !fs.existsSync(planPath)) {
  writeResult({ ok: true, skipped: true, reason: 'missing APP_URL or plan' });
  process.exit(0);
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
if (plan.executor !== 'playwright') {
  writeResult({ ok: true, skipped: true, reason: 'not a playwright plan' });
  process.exit(0);
}

const checks = checksFromPlan(plan).filter((check) => check && (check.kind ?? 'browser') === 'browser');
if (checks.length === 0) {
  writeResult({ ok: true, skipped: true, reason: 'no browser readiness checks declared' });
  process.exit(0);
}

const failures = [];
const observations = [];
const browser = await chromium.launch({ headless: true });

try {
  const contextOptions = fs.existsSync('admin-state.json') ? { storageState: 'admin-state.json' } : {};
  const context = await browser.newContext({ ...contextOptions, viewport: { width: 1280, height: 840 } });
  const page = await context.newPage();

  for (const [index, check] of checks.entries()) {
    const name = String(check.name || `readiness check ${index + 1}`);
    const target = localTarget(check.path ?? check.url ?? check.route);
    if (!target) {
      failures.push(`${name}: missing or non-local path/url`);
      continue;
    }

    const url = `${target}${target.includes('?') ? '&' : '?'}seededReadiness=${Date.now()}-${index}`;
    await page.goto(url, { waitUntil: check.waitUntil || 'load', timeout: Number(check.timeout_ms || 30000) });

    const cookieButton = page.getByRole('button', { name: 'Only technically required' });
    if (await cookieButton.count() === 1) {
      await cookieButton.click().catch(() => {});
    }

    const selector = String(check.selector || 'body');
    const timeout = Number(check.timeout_ms || 15000);
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
    } catch {
      failures.push(`${name}: selector ${JSON.stringify(selector)} was not visible on ${url}`);
    }

    const textSelector = String(check.text_selector || selector);
    const textLocator = page.locator(textSelector).first();
    const expectedText = typeof check.text === 'string' ? check.text : null;
    if (expectedText !== null) {
      try {
        await textLocator.waitFor({ state: 'visible', timeout });
        const actualText = (await textLocator.textContent({ timeout }).catch(() => '') ?? '').replace(/\s+/g, ' ').trim();
        if (!actualText.includes(expectedText)) {
          failures.push(`${name}: ${JSON.stringify(textSelector)} does not include ${JSON.stringify(expectedText)} on ${url}`);
        }
      } catch {
        failures.push(`${name}: text selector ${JSON.stringify(textSelector)} was not visible on ${url}`);
      }
    }

    const observation = await page.evaluate(({ selector: evaluatedSelector, textSelector: evaluatedTextSelector }) => {
      const rectOf = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const textOf = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const element = document.querySelector(evaluatedSelector);
      const textElement = document.querySelector(evaluatedTextSelector);

      return {
        title: document.title,
        url: location.href,
        selector: evaluatedSelector,
        selectorCount: document.querySelectorAll(evaluatedSelector).length,
        selectorRect: rectOf(element),
        selectorText: textOf(element).slice(0, 500),
        textSelector: evaluatedTextSelector,
        textSelectorText: textOf(textElement).slice(0, 500),
      };
    }, { selector, textSelector });

    observations.push({ name, ...observation });

    const minWidth = Number(check.min_width ?? 1);
    const minHeight = Number(check.min_height ?? 1);
    const width = observation.selectorRect?.width ?? 0;
    const height = observation.selectorRect?.height ?? 0;
    if (width < minWidth) failures.push(`${name}: ${selector} is too narrow (${width}px < ${minWidth}px)`);
    if (height < minHeight) failures.push(`${name}: ${selector} is too short (${height}px < ${minHeight}px)`);

    const shot = screenshotPath(check, index);
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  }

  await context.close();
} finally {
  await browser.close();
}

writeResult({ ok: failures.length === 0, failures, observations });

if (failures.length > 0) {
  console.error('seeded readiness check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`seeded readiness check passed (${observations.length} check(s))`);
