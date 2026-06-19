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
      id: 'group',
      name: 'Color',
      options: [
        { id: 'black', name: 'Black' },
        { id: 'white', name: 'White' },
      ],
    },
  ],
  product: [
    { id: 'parent', productNumber: 'PARENT', name: 'Slider Variant Product' },
    { id: 'child-black', parentId: 'parent', productNumber: 'SLIDE-VAR-1.1', options: [{ id: 'black' }] },
    { id: 'child-white', parentId: 'parent', productNumber: 'SLIDE-VAR-1.2', options: [{ id: 'white' }] },
  ],
};

function writeBundle(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-validate-'));
  fs.writeFileSync(path.join(dir, 'issue.md'), issue);
  fs.writeFileSync(path.join(dir, 'reproduction-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'fixtures.json'), `${JSON.stringify(fixtures, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'repro.spec.ts'), spec);
  return dir;
}

function run(dir) {
  return spawnSync('node', [validator], { cwd: dir, encoding: 'utf8' });
}

const bad = writeBundle(`
import { test, expect } from '@playwright/test';
// Black appears only in a comment, so this must not count.
test('bad generic card assertion', async ({ page }) => {
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

const good = writeBundle(`
import { test, expect } from '@playwright/test';
test('good selected variant assertion', async ({ page }) => {
  await expect(page.getByRole('link', { name: /Slider Variant Product/i }).first()).toBeVisible();
  await expect(page.getByText('Black')).toBeVisible();
});
`);
const goodResult = run(good);
if (goodResult.status !== 0) {
  console.error(`Expected selected-variant assertion to pass:\n${goodResult.stdout}\n${goodResult.stderr}`);
  process.exit(1);
}

console.log('validate-bundle tests passed');
