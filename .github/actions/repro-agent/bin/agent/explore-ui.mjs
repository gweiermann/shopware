#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

const [appUrl, target, viewportArg = '1280x900', storageState = ''] = process.argv.slice(2);

if (!appUrl || !target) {
  console.error('usage: explore-ui.mjs <APP_URL> <route-or-local-script> [viewport=1280x900] [storage-state.json]');
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
  if (/^https?:\/\//i.test(value)) return value;
  return `${base.replace(/\/$/, '')}${value.startsWith('/') ? value : `/${value}`}`;
}

function sanitize(value) {
  return String(value)
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'explore';
}

function formatList(items) {
  if (items.length === 0) return '  - none';
  return items.map((item) => `  - ${item}`).join('\n');
}

async function collectPageSummary(page) {
  return page.evaluate(() => {
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
      ].find((candidate) => candidate && candidate.trim());

      return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    }

    const selectors = {
      button: 'button,[role="button"]',
      link: 'a[href],[role="link"]',
      heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]',
      input: 'input,textarea,select,[contenteditable="true"]',
    };

    const roles = {};
    for (const [role, selector] of Object.entries(selectors)) {
      roles[role] = [...document.querySelectorAll(selector)]
        .filter(visible)
        .map((element) => nameOf(element))
        .filter(Boolean)
        .slice(0, 40);
    }

    const text = (document.body?.innerText || '')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 80);

    return { url: location.href, title: document.title, roles, text };
  });
}

const artifactDir = path.resolve('test-results', 'ui-explore');
fs.mkdirSync(artifactDir, { recursive: true });
const notes = [];

function note(message, data = undefined) {
  const line = data === undefined ? String(message) : `${message}: ${JSON.stringify(data)}`;
  notes.push(line);
  console.log(line);
}

const browser = await chromium.launch();
try {
  const contextOptions = { viewport };
  if (storageState && fs.existsSync(storageState)) {
    contextOptions.storageState = storageState;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  async function screenshot(name = 'screenshot', options = {}) {
    const file = path.join(artifactDir, `${Date.now()}-${sanitize(name)}.png`);
    await page.screenshot({ path: file, fullPage: false, ...options });
    note(`screenshot ${path.relative(process.cwd(), file)}`);
    return file;
  }

  async function writeArtifact(name, content) {
    const file = path.join(artifactDir, sanitize(name));
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    note(`artifact ${path.relative(process.cwd(), file)}`);
    return file;
  }

  const scriptPath = path.resolve(target);
  if (fs.existsSync(scriptPath) && /\.(?:mjs|js)$/i.test(scriptPath)) {
    const mod = await import(pathToFileURL(scriptPath).href);
    const explore = mod.default || mod.explore;
    if (typeof explore !== 'function') {
      throw new Error(`${target} must export default async function or named async function explore`);
    }
    await explore({
      browser,
      context,
      page,
      expect,
      appUrl,
      viewport,
      targetUrl: (value) => targetUrl(appUrl, value),
      artifactDir,
      screenshot,
      writeArtifact,
      collectPageSummary: () => collectPageSummary(page),
      note,
    });
  } else {
    await page.goto(targetUrl(appUrl, target), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(1_000);
    await screenshot(target);
    const summary = await collectPageSummary(page);
    await writeArtifact(`${sanitize(target)}-summary.json`, summary);
    note('# UI Explore');
    note(`route: ${target}`);
    note(`finalUrl: ${summary.url}`);
    note(`viewport: ${viewport.width}x${viewport.height}`);
    note('## Visible Headings');
    console.log(formatList(summary.roles.heading));
    note('## Visible Buttons');
    console.log(formatList(summary.roles.button));
    note('## Visible Inputs');
    console.log(formatList(summary.roles.input));
    note('## Visible Text Excerpt');
    console.log(formatList(summary.text.slice(0, 60)));
  }

  await writeArtifact('explore-notes.txt', `${notes.join('\n')}\n`);
} catch (error) {
  console.error(`explore-ui failed: ${error.message?.split('\n')[0] || error}`);
  process.exit(1);
} finally {
  await browser.close();
}
