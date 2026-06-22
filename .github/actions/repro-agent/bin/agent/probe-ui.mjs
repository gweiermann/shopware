#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const [appUrl, route, viewportArg = '1280x900', storageState = ''] = process.argv.slice(2);

if (!appUrl || !route) {
  console.error('usage: probe-ui.mjs <APP_URL> <route-or-url> [viewport=1280x900] [storage-state.json]');
  process.exit(2);
}

const viewportMatch = String(viewportArg).match(/^(\d{2,5})x(\d{2,5})$/);
if (!viewportMatch) {
  console.error(`invalid viewport '${viewportArg}', expected WIDTHxHEIGHT such as 375x812`);
  process.exit(2);
}

const viewport = {
  width: Number(viewportMatch[1]),
  height: Number(viewportMatch[2]),
};

function targetUrl(base, value) {
  if (/^https?:\/\//.test(value)) return value;
  return `${base.replace(/\/$/, '')}${value.startsWith('/') ? value : `/${value}`}`;
}

function sanitize(value) {
  return String(value)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'route';
}

function formatList(items) {
  if (items.length === 0) return '  - none';
  return items.map((item) => `  - ${item}`).join('\n');
}

const browser = await chromium.launch();
try {
  const contextOptions = { viewport };
  if (storageState && fs.existsSync(storageState)) {
    contextOptions.storageState = storageState;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const url = targetUrl(appUrl, route);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(750);

  const screenshotDir = path.resolve('test-results', 'ui-probes');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `${Date.now()}-${sanitize(route)}-${viewport.width}x${viewport.height}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const evidence = await page.evaluate(() => {
    const roleSelectors = {
      button: 'button,[role="button"]',
      link: 'a[href],[role="link"]',
      tab: '[role="tab"]',
      heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]',
      navigation: 'nav,[role="navigation"]',
      dialog: 'dialog,[role="dialog"]',
      textbox: 'input:not([type]),input[type="text"],input[type="email"],input[type="password"],textarea,[role="textbox"],[contenteditable="true"]',
      searchbox: 'input[type="search"],[role="searchbox"]',
      checkbox: 'input[type="checkbox"],[role="checkbox"]',
    };

    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) !== 0
        && rect.width > 0
        && rect.height > 0;
    }

    function labelText(element) {
      if (element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label?.textContent?.trim()) return label.textContent.trim();
      }
      const wrappingLabel = element.closest('label');
      if (wrappingLabel?.textContent?.trim()) return wrappingLabel.textContent.trim();
      return '';
    }

    function nameOf(element) {
      const value = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        labelText(element),
        element.getAttribute('placeholder'),
        element.getAttribute('alt'),
        element.textContent,
        element.getAttribute('value'),
        element.getAttribute('name'),
        element.getAttribute('href'),
      ].find((candidate) => candidate && candidate.trim());

      return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140);
    }

    const roles = {};
    for (const [role, selector] of Object.entries(roleSelectors)) {
      const seen = new Set();
      roles[role] = [...document.querySelectorAll(selector)]
        .filter(visible)
        .map(nameOf)
        .filter(Boolean)
        .filter((name) => {
          const key = name.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 30);
    }

    const text = (document.body?.innerText || '')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 80);

    return { roles, text };
  });

  let ariaSnapshot = '';
  try {
    ariaSnapshot = await page.locator('body').ariaSnapshot({ timeout: 5_000 });
    ariaSnapshot = ariaSnapshot.split('\n').slice(0, 160).join('\n');
  } catch {
    ariaSnapshot = '';
  }

  console.log(`# UI Probe`);
  console.log(`route: ${route}`);
  console.log(`finalUrl: ${page.url()}`);
  console.log(`viewport: ${viewport.width}x${viewport.height}`);
  console.log(`screenshot: ${path.relative(process.cwd(), screenshotPath)}`);
  console.log('');
  console.log('## Visible Roles');
  for (const [role, items] of Object.entries(evidence.roles)) {
    console.log(`### ${role}`);
    console.log(formatList(items));
  }
  console.log('');
  console.log('## Visible Text Excerpt');
  console.log(formatList(evidence.text.slice(0, 60)));
  if (ariaSnapshot) {
    console.log('');
    console.log('## ARIA Snapshot Excerpt');
    console.log(ariaSnapshot);
  }
} catch (error) {
  console.error(`probe failed: ${error.message?.split('\n')[0] || error}`);
  process.exit(1);
} finally {
  await browser.close();
}
