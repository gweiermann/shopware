#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const patchPath = process.argv[2];
if (!patchPath) {
  console.error('Usage: node .github/actions/repro-agent/local/scripts/compare-prompt-generalization.mjs <prompt-or-patch-file>');
  process.exit(1);
}

const text = fs.readFileSync(path.resolve(patchPath), 'utf8');
const issueSpecificPatterns = [
  /issue\s*#?\s*30/i,
  /16851/,
  /Selected variant not displayed/i,
  /SLIDE-VAR/i,
  /cc0000000000000000000000000000[a-z0-9]{2}/i,
  /repro-variant-slider/i
];

const hits = issueSpecificPatterns.filter((pattern) => pattern.test(text));
if (hits.length > 0) {
  console.error('Prompt patch appears issue-specific. Keep prompt changes generalized and move issue-specific checks into eval assertions.');
  process.exit(1);
}

console.log('OK: no obvious issue-specific prompt terms found');
