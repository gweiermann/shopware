#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function readConfig() {
  return JSON.parse(fs.readFileSync('.github/actions/repro-agent/local/config.json', 'utf8'));
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const config = readConfig();
const dryRun = process.argv.includes('--dry-run');
const issue = Number(option('--issue', config.defaultIssue));
const maxTurns = Number(option('--max-turns', config.maxTurns));
const model = option('--model', config.model);
const reasoningEffort = option('--reasoning-effort', config.reasoningEffort);

const contextPath = path.resolve('build-context.md');
if (!fs.existsSync(contextPath)) {
  console.error('Missing build-context.md. Run: ISSUE=30 REPO=gweiermann/shopware bash .github/actions/repro-agent/local/scripts/prepare-run.sh');
  process.exit(1);
}

const prompt = fs.readFileSync(contextPath, 'utf8');
const runDir = path.resolve(`.scratch/repro-agent-local/runs/issue-${issue}`);
fs.mkdirSync(runDir, { recursive: true });

const manifest = {
  issue,
  model,
  reasoning: { effort: reasoningEffort },
  maxTurns,
  promptPath: contextPath,
  allowedCommands: [
    config.agentVerifyCommand,
    config.agentShopGetCommand,
    'jq', 'rg', 'grep', 'find', 'cat', 'ls', 'head', 'tail', 'sed', 'wc',
    'git log', 'git show', 'git diff', 'git blame', 'cp', 'mkdir'
  ],
  createdAt: new Date().toISOString()
};

fs.writeFileSync(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

if (dryRun) {
  console.log(`Dry run OK. Prompt bytes: ${Buffer.byteLength(prompt)}. Manifest: ${path.relative(process.cwd(), path.join(runDir, 'manifest.json'))}`);
  process.exit(0);
}

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required for a non-dry-run simulated agent execution.');
  process.exit(1);
}

console.error('The API-backed agent loop is intentionally not implemented as a loose shell bridge yet.');
console.error('Wire this file to the Responses API only after adding a constrained local tool adapter that enforces allowedCommands and maxTurns.');
process.exit(2);
