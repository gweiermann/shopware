#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

function readConfig() {
  return JSON.parse(fs.readFileSync('.github/actions/repro-agent/local/config.json', 'utf8'));
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function prepareIsolatedCodexHome() {
  const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sourceAuth = path.join(sourceHome, 'auth.json');
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-agent-codex-home-'));

  if (fs.existsSync(sourceAuth)) {
    fs.copyFileSync(sourceAuth, path.join(isolatedHome, 'auth.json'));
  }

  return isolatedHome;
}

const config = readConfig();
const dryRun = process.argv.includes('--dry-run');
const issue = Number(option('--issue', config.defaultIssue));
const maxTurns = Number(option('--max-turns', config.maxTurns));
const model = option('--model', config.model);
const reasoningEffort = option('--reasoning-effort', config.reasoningEffort);
const sandbox = option('--sandbox', config.sandbox || 'workspace-write');
const completionGraceMs = Number(option('--completion-grace-ms', process.env.REPRO_AGENT_COMPLETION_GRACE_MS || '5000'));

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
  isolatedCodexContext: true,
  maxTurns,
  promptPath: contextPath,
  allowedCommands: [
    config.agentVerifyCommand,
    config.agentShopGetCommand,
    'bash .github/actions/repro-agent/bin/agent/probe-ui.sh',
    'node .github/actions/repro-agent/bin/agent/analyze-failure.mjs',
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

const isolatedCodexHome = prepareIsolatedCodexHome();
const codexEnv = {
  ...process.env,
  CODEX_HOME: isolatedCodexHome,
};

const codexCheck = spawnSync('codex', ['--version'], { encoding: 'utf8', env: codexEnv });
if (codexCheck.status !== 0) {
  console.error('Codex CLI is not runnable. Run `codex --version` and fix the installation before using this runner.');
  if (codexCheck.stderr) process.stderr.write(codexCheck.stderr);
  fs.rmSync(isolatedCodexHome, { recursive: true, force: true });
  process.exit(1);
}

const codexArgs = [
  'exec',
  '--ephemeral',
  '--ignore-user-config',
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

function runCodex() {
  return new Promise((resolve) => {
    const child = spawn('codex', codexArgs, {
      env: codexEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let sawCompletionFooter = false;
    let killedAfterCompletion = false;
    let graceTimer = null;
    let killTimer = null;

    const combinedOutput = () => `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}`;
    const completionFooterPattern = /(?:^|\r?\n)tokens used\r?\n[\d,]+(?:\r?\n|$)/;

    const scheduleCompletionKill = () => {
      if (!sawCompletionFooter || graceTimer || child.exitCode !== null) return;

      graceTimer = setTimeout(() => {
        if (child.exitCode !== null) return;

        killedAfterCompletion = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 2000);
      }, completionGraceMs);
    };

    const collect = (chunks) => (chunk) => {
      chunks.push(Buffer.from(chunk));
      if (!sawCompletionFooter && completionFooterPattern.test(combinedOutput())) {
        sawCompletionFooter = true;
        scheduleCompletionKill();
      }
    };

    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('close', (status, signal) => {
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);

      resolve({
        status: killedAfterCompletion && sawCompletionFooter ? 0 : (status ?? 1),
        signal: killedAfterCompletion && sawCompletionFooter ? null : signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });

    child.stdin.end(prompt);
  });
}

const run = await runCodex();

fs.writeFileSync(path.join(runDir, 'codex-stdout.log'), run.stdout || '');
fs.writeFileSync(path.join(runDir, 'codex-stderr.log'), run.stderr || '');
fs.rmSync(isolatedCodexHome, { recursive: true, force: true });

if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
