#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const configPath = path.join(root, '.github/actions/repro-agent/local/config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function rm(target) {
  const full = path.join(root, target);
  fs.rmSync(full, { recursive: true, force: true });
}

function cleanup() {
  for (const artifact of config.generatedArtifacts) {
    rm(artifact);
  }
  console.log(`Removed ${config.generatedArtifacts.length} generated artifact paths.`);
}

function usage() {
  console.log('Usage: node .github/actions/repro-agent/local/scripts/run-eval.mjs cleanup');
}

const command = process.argv[2];
if (command === 'cleanup') {
  cleanup();
} else {
  usage();
  process.exit(command ? 1 : 0);
}
