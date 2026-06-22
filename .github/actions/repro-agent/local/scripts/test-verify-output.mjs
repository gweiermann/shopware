#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../../../../..');
const verifier = path.join(repo, '.github/actions/repro-agent/local/scripts/verify-output.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-output-'));

fs.writeFileSync(path.join(dir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 15,
  executor: 'playwright',
  version: '6.7.11.0',
  script_path: 'repro.spec.ts',
}, null, 2)}\n`);
fs.writeFileSync(path.join(dir, 'issue.md'), '# Product detail page should return not found for inactive variants\n');
fs.writeFileSync(path.join(dir, 'issue-class.txt'), 'visual\n');
fs.writeFileSync(path.join(dir, 'fixtures.json'), '{}\n');
const expectPollSpec = `
import { test, expect } from '@playwright/test';
test('expect poll counts as the single symptom assertion', async ({ page }) => {
  await page.goto('/detail/15000000000000000000000000000101');
  const marker = page.getByText(/Product number:/i);
  await marker.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: product detail page missing'); });
  const response = await page.goto('/detail/15000000000000000000000000000101');
  await expect.poll(async () => response?.status(), { timeout: 30_000 }).toBe(404);
});
`;
fs.writeFileSync(path.join(dir, 'repro.spec.ts'), expectPollSpec);
fs.writeFileSync(path.join(dir, 'builder-result.json'), `${JSON.stringify({
  executor: 'playwright',
  evidence: {
    script: expectPollSpec,
    artifacts: [{ kind: 'playwright-results', name: 'test-results/' }],
  },
}, null, 2)}\n`);

const result = spawnSync('node', [verifier, '--root', dir], { cwd: repo, encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}

const inconclusiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-output-inconclusive-'));
fs.writeFileSync(path.join(inconclusiveDir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 6,
  executor: 'playwright',
  version: '6.7.9.0',
  confidence: 0.9,
  script_path: 'repro.spec.ts',
}, null, 2)}\n`);
fs.writeFileSync(path.join(inconclusiveDir, 'issue.md'), '# Mobile Administration navigation stays open\n');
fs.writeFileSync(path.join(inconclusiveDir, 'issue-class.txt'), 'visual\n');
fs.writeFileSync(path.join(inconclusiveDir, 'repro.spec.ts'), `
import { test, expect } from '@playwright/test';
test('inconclusive result must not stay high confidence', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('document').waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: admin document missing'); });
  await expect(page.getByRole('navigation')).not.toBeInViewport();
});
`);
fs.writeFileSync(path.join(inconclusiveDir, 'builder-result.json'), `${JSON.stringify({
  status: 'inconclusive',
  executor: 'playwright',
  blocked_reason: 'precondition element was not present',
  evidence: {
    artifacts: [{ kind: 'playwright-results', name: 'test-results/' }],
  },
}, null, 2)}\n`);

const inconclusiveResult = spawnSync('node', [verifier, '--root', inconclusiveDir], { cwd: repo, encoding: 'utf8' });
if (inconclusiveResult.status === 0 || !inconclusiveResult.stderr.includes('still claims high confidence')) {
  console.error('Expected high-confidence inconclusive result to fail verification');
  console.error(inconclusiveResult.stdout);
  console.error(inconclusiveResult.stderr);
  process.exit(1);
}

const staleEvidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-output-stale-evidence-'));
fs.writeFileSync(path.join(staleEvidenceDir, 'reproduction-plan.json'), `${JSON.stringify({
  schema_version: '1',
  issue: 6,
  executor: 'playwright',
  layer: 'admin-ui',
  build_profile: { admin_build: true },
  version: '6.7.9.0',
  confidence: 0.4,
  confidence_reason: 'previous run was inconclusive',
  script_path: 'repro.spec.ts',
}, null, 2)}\n`);
fs.writeFileSync(path.join(staleEvidenceDir, 'issue.md'), '# Mobile Administration navigation stays open\n');
fs.writeFileSync(path.join(staleEvidenceDir, 'issue-class.txt'), 'visual\n');
fs.writeFileSync(path.join(staleEvidenceDir, 'repro.spec.ts'), `
import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 375, height: 812 } });
test('final spec edited after verifier', async ({ page }) => {
  await page.goto('/admin#/sw/dashboard/index');
  const menu = page.locator('aside.sw-admin-menu');
  await menu.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: menu missing'); });
  await expect(menu).not.toHaveClass(/is--off-canvas-shown/);
});
`);
fs.writeFileSync(path.join(staleEvidenceDir, 'builder-result.json'), `${JSON.stringify({
  status: 'inconclusive',
  executor: 'playwright',
  blocked_reason: 'previous setup failure',
  evidence: {
    script: 'import { test } from "@playwright/test"; test("old", async () => {});',
    artifacts: [{ kind: 'playwright-results', name: 'test-results/' }],
  },
}, null, 2)}\n`);

const staleEvidenceResult = spawnSync('node', [verifier, '--root', staleEvidenceDir], { cwd: repo, encoding: 'utf8' });
if (staleEvidenceResult.status === 0 || !staleEvidenceResult.stderr.includes('runtime evidence is stale')) {
  console.error('Expected stale Playwright runtime evidence to fail verification');
  console.error(staleEvidenceResult.stdout);
  console.error(staleEvidenceResult.stderr);
  process.exit(1);
}

console.log('verify-output tests passed');
