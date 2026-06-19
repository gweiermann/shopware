#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

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
const sandbox = option('--sandbox', config.sandbox || 'workspace-write');

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
  sandbox,
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

const codexCheck = spawnSync('codex', ['--version'], { encoding: 'utf8' });
if (codexCheck.status !== 0) {
  console.error('Codex CLI is not runnable. Run `codex --version` and fix the installation before using this runner.');
  if (codexCheck.stderr) process.stderr.write(codexCheck.stderr);
  process.exit(1);
}

const codexArgs = [
  'exec',
  '--ephemeral',
  '--sandbox',
  sandbox,
  '--config',
  `model_reasoning_effort="${reasoningEffort}"`,
  '--config',
  'shell_environment_policy.inherit="all"',
  '--model',
  model,
  '-C',
  process.cwd(),
  `Use at most ${maxTurns} tool turns. Follow build-context.md exactly. Do not trigger GitHub workflows.`
];

const run = spawnSync('codex', codexArgs, {
  encoding: 'utf8',
  input: prompt,
  stdio: ['pipe', 'pipe', 'pipe']
});

fs.writeFileSync(path.join(runDir, 'codex-stdout.log'), run.stdout || '');
fs.writeFileSync(path.join(runDir, 'codex-stderr.log'), run.stderr || '');

if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
