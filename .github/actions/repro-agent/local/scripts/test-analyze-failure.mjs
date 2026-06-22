#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const analyzer = path.join(root, '.github/actions/repro-agent/bin/agent/analyze-failure.mjs');

function writeJson(dir, file, value) {
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function runCase(name, files, expectedKind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repro-agent-analyze-${name}-`));
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(dir, file);
      mkdirp(path.dirname(target));
      if (typeof content === 'string') {
        fs.writeFileSync(target, content);
      } else {
        writeJson(dir, file, content);
      }
    }

    const result = spawnSync('node', [analyzer, dir], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status !== 0) {
      console.error(`Analyzer failed for ${name}:\n${result.stdout}\n${result.stderr}`);
      process.exit(1);
    }

    const hint = JSON.parse(result.stdout);
    if (hint.kind !== expectedKind) {
      console.error(`Expected ${name} to emit ${expectedKind}, got ${hint.kind}:\n${result.stdout}`);
      process.exit(1);
    }

    return hint;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const basePlan = {
  schema_version: '1',
  issue: 1,
  layer: 'admin-ui',
  executor: 'playwright',
  version: '6.7.9.0',
  script_path: 'repro.spec.ts',
  confidence: 0.75,
};

runCase('route', {
  'reproduction-plan.json': basePlan,
  'repro.spec.ts': `
    await Promise.all([
      page.waitForURL('**#/sw/settings/index', { timeout: 10000 }),
      settingsLink.click({ timeout: 10000 }),
    ]);
  `,
  'builder-result.json': {
    status: 'inconclusive',
    evidence: { reporter_output: 'precondition absent on this version — Error: PRECONDITION_NOT_FOUND: route change to Settings' },
  },
  'test-results/repro/error-context.md': `
# Error details
Error: PRECONDITION_NOT_FOUND: route change to Settings

# Page snapshot
- link "Go back":
  - /url: "#/sw/settings/index/system"
- heading "System Shopware Services"
  `,
  'test-results/repro/test-failed-1.png': 'not really an image',
}, 'over_exact_route_gate');

runCase('offscreen', {
  'reproduction-plan.json': basePlan,
  'repro.spec.ts': 'await page.getByText("Catalogues").click();',
  'builder-result.json': {
    status: 'inconclusive',
    evidence: { reporter_output: 'failure was not a value assertion' },
  },
  'test-results/repro/error-context.md': `
TimeoutError: locator.click: Timeout 10000ms exceeded.
  - element is visible, enabled and stable
  - element is outside of the viewport
  `,
}, 'offscreen_click_target');

runCase('generic-chrome', {
  'reproduction-plan.json': basePlan,
  'repro.spec.ts': 'await page.getByRole("heading", { name: "Howdy!" }).waitFor();',
  'builder-result.json': {
    status: 'inconclusive',
    evidence: { reporter_output: 'Error: PRECONDITION_NOT_FOUND: dashboard heading Howdy!' },
  },
  'test-results/repro/error-context.md': 'Error: PRECONDITION_NOT_FOUND: dashboard heading Howdy!',
}, 'generic_chrome_precondition');

const cmsConfigHint = runCase('cms-config-not-open', {
  'reproduction-plan.json': basePlan,
  'repro.spec.ts': `
    await page.goto('/admin#/sw/cms/detail/11000000000000000000000000000001');
    const upload = page.locator('.sw-cms-el-config-image .sw-media-upload-v2').first();
    await upload.waitFor();
  `,
  'builder-result.json': {
    status: 'inconclusive',
    evidence: { reporter_output: 'failure was not a value assertion — Test timeout of 120000ms exceeded.' },
  },
  'test-results/repro/error-context.md': `
Error: locator.waitFor: Test timeout of 120000ms exceeded.
Call log:
  - waiting for locator('.sw-cms-el-config-image .sw-media-upload-v2').first() to be visible

# Page snapshot
- heading "Seeded CMS page" [level=2]
- paragraph: Seeded marker
- complementary:
  - button "Settings"
  - button "Blocks"
  - button "Navigator"
  `,
}, 'cms_element_config_not_open');
if (!cmsConfigHint.repair.includes('Open the issue-specific CMS element settings first')) {
  console.error(`Expected CMS config hint to mention opening settings first:\n${JSON.stringify(cmsConfigHint, null, 2)}`);
  process.exit(1);
}

const mediaFolderHint = runCase('media-folder-empty', {
  'reproduction-plan.json': basePlan,
  'repro.spec.ts': `
    await page.goto('/admin#/sw/media/index');
    await page.getByRole('button', { name: /^Upload file$/i }).click({ timeout: 5000 });
    await page.goto('/admin#/sw/product/detail/27000000000000000000000000000001/base');
    await page.locator('.sw-media-upload-v2__button.open-media-sidebar').click({ timeout: 5000 });
    await page.getByText('img-1.png', { exact: true }).waitFor({ state: 'visible' })
      .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: media modal tile img-1.png'); });
  `,
  'builder-result.json': {
    status: 'inconclusive',
    evidence: { reporter_output: 'precondition absent — Error: PRECONDITION_NOT_FOUND: media modal tile img-1.png' },
  },
  'test-results/repro/error-context.md': `
# Page snapshot
- dialog "Choose media":
  - tab "Media Library"
  - text: Product Media
  - heading "Nothing found"
  `,
}, 'missing_uploaded_binary_state');
if (!mediaFolderHint.repair.includes('same media-library context/folder')) {
  console.error(`Expected media-folder hint to mention folder context:\n${JSON.stringify(mediaFolderHint, null, 2)}`);
  process.exit(1);
}

const hiddenFileInputHint = runCase('hidden-file-input', {
  'reproduction-plan.json': basePlan,
  'repro.spec.ts': `
    const mediaUploadInput = page.locator('.sw-media-index .sw-media-upload-v2__file-input').first();
    await mediaUploadInput.waitFor({ state: 'visible', timeout: 15000 })
      .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: media module upload input'); });
  `,
  'builder-result.json': {
    status: 'inconclusive',
    evidence: { reporter_output: 'precondition absent — Error: PRECONDITION_NOT_FOUND: media module upload input' },
  },
  'test-results/repro/error-context.md': `
# Page snapshot
- main:
  - button "Upload file"
  `,
}, 'missing_uploaded_binary_state');
if (!hiddenFileInputHint.repair.includes('filechooser')) {
  console.error(`Expected hidden-file-input hint to mention filechooser:\n${JSON.stringify(hiddenFileInputHint, null, 2)}`);
  process.exit(1);
}

runCase('unknown', {
  'reproduction-plan.json': basePlan,
  'repro.spec.ts': 'await expect(page.getByText("Specific value")).toBeVisible();',
  'builder-result.json': {
    status: 'inconclusive',
    evidence: { reporter_output: 'ambiguous custom failure' },
  },
  'test-results/repro/error-context.md': 'Something unusual happened.',
}, 'unknown');

console.log('analyze-failure tests passed');
