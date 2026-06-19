#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../../../../..');
const runner = path.join(repo, '.github/actions/repro-agent/bin/execute/run-playwright.sh');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function report(errorMessage) {
  return {
    stats: { expected: 0, unexpected: 1, skipped: 0 },
    suites: [
      {
        specs: [
          {
            tests: [
              {
                results: [
                  {
                    status: 'failed',
                    error: { message: errorMessage },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function classify(errorMessage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-pw-classifier-'));
  const plan = path.join(dir, 'reproduction-plan.json');
  const out = path.join(dir, 'result.json');
  const pwReport = path.join(dir, 'pw-report.json');
  const spec = path.join(dir, 'repro.spec.ts');

  writeJson(plan, {
    schema_version: '1',
    issue: 30,
    executor: 'playwright',
    version: '6.7.8.2',
    script_path: spec,
  });
  fs.writeFileSync(spec, "import { test, expect } from '@playwright/test';\n");
  writeJson(pwReport, report(errorMessage));

  const result = spawnSync('bash', [runner], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      REPRO_PLAN: plan,
      PW_REPORT: pwReport,
      OUT: out,
      APP_URL: 'http://localhost.invalid',
      TARGET: 'builder',
    },
  });

  if (result.status !== 0) {
    throw new Error(`run-playwright failed:\n${result.stdout}\n${result.stderr}`);
  }

  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

const selectedValueMissing = classify(`Error: expect(locator).toContainText(expected) failed

Locator: getByRole('link', { name: /Slider Variant Product/i }).first()
Timeout: 15000ms
Expected pattern: /Black/i
Received string: " Slider Variant Product "
Call log:
  - Expect "toContainText" with timeout 15000ms
  - waiting for getByRole('link', { name: /Slider Variant Product/i }).first()
    34 x locator resolved to <a title="Slider Variant Product">Slider Variant Product</a>
       - unexpected value " Slider Variant Product "
`);

if (selectedValueMissing.status !== 'reproduced') {
  console.error(`Expected selected value assertion failure to be reproduced, got ${selectedValueMissing.status}`);
  process.exit(1);
}

const missingPrecondition = classify('Error: PRECONDITION_NOT_FOUND: seeded slider product card not visible');
if (missingPrecondition.status !== 'inconclusive') {
  console.error(`Expected missing precondition to be inconclusive, got ${missingPrecondition.status}`);
  process.exit(1);
}

const strictMode = classify('Error: strict mode violation: getByRole("button") resolved to 2 elements');
if (strictMode.status !== 'inconclusive') {
  console.error(`Expected strict mode violation to be inconclusive, got ${strictMode.status}`);
  process.exit(1);
}

console.log('run-playwright classifier tests passed');
