#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const config = JSON.parse(fs.readFileSync('.github/actions/repro-agent/local/config.json', 'utf8'));

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function run(label, command, args, env = {}, options = {}) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  return {
    status: result.status ?? (result.signal ? 124 : 1),
    signal: result.signal || null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function copyIfExists(from, to) {
  const source = path.join(root, from);
  if (!fs.existsSync(source)) return false;
  const target = path.join(root, to);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  return true;
}

function archiveIssue(issue) {
  const runDir = `.scratch/repro-agent-local/runs/issue-${issue}`;
  const artifactDir = `${runDir}/artifacts`;
  fs.mkdirSync(path.join(root, artifactDir), { recursive: true });

  for (const artifact of config.generatedArtifacts) {
    copyIfExists(artifact, `${artifactDir}/${artifact}`);
  }

  const screenshots = [];
  const testResults = path.join(root, 'test-results');
  if (fs.existsSync(testResults)) {
    for (const entry of fs.readdirSync(testResults, { recursive: true })) {
      if (String(entry).endsWith('.png')) screenshots.push(path.join('test-results', String(entry)));
    }
  }

  const builder = readJson('builder-result.json');
  const result = readJson('result.json');
  const plan = readJson('reproduction-plan.json');
  const summary = {
    issue,
    status: builder?.status || result?.status || 'missing',
    executor: plan?.executor || builder?.executor || result?.executor || null,
    version: plan?.version || builder?.version || result?.version || null,
    assertion: builder?.assertion || result?.assertion || null,
    reporter_output: builder?.evidence?.reporter_output || result?.evidence?.reporter_output || null,
    blocked_reason: builder?.blocked_reason || result?.blocked_reason || plan?.blocked_reason || null,
    confidence: plan?.confidence ?? null,
    screenshots,
    archived_at: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(root, runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function parseIssues(value) {
  if (!value) return [];
  return value.split(',').flatMap((part) => {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
    return [Number(part)];
  }).filter((issue) => Number.isInteger(issue) && issue > 0);
}

function resolveStorefrontAccessKey() {
  if (process.env.SW_ACCESS_KEY) return process.env.SW_ACCESS_KEY;

  const code = [
    '$pdo=new PDO("mysql:host=database;dbname=shopware","root","root");',
    '$sql="SELECT access_key FROM sales_channel WHERE access_key IS NOT NULL AND name <> \'Headless\' ORDER BY created_at DESC LIMIT 1";',
    '$key=$pdo->query($sql)->fetchColumn();',
    'if (!$key) { exit(1); }',
    'echo $key;',
  ].join(' ');

  const result = spawnSync('docker', ['compose', 'exec', 'web', 'php', '-r', code], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) return '';
  return result.stdout.trim();
}

const issues = parseIssues(option('--issues', ''));
if (issues.length === 0) {
  console.error('Usage: node .github/actions/repro-agent/local/scripts/eval-issues.mjs --issues 1-31 [--max-turns 8]');
  process.exit(1);
}

const maxTurns = option('--max-turns', String(config.maxTurns));
const model = option('--model', config.model);
const reasoningEffort = option('--reasoning-effort', config.reasoningEffort);
const sandbox = option('--sandbox', config.sandbox || 'danger-full-access');
const repo = option('--repo', config.repo);
const upstream = option('--upstream', config.upstream);
const appUrl = option('--app-url', process.env.APP_URL || 'http://localhost:18080');
const agentTimeoutMs = Number(option('--agent-timeout-ms', '600000'));
const stopOnFailure = hasFlag('--stop-on-failure');
const skipDbRestore = hasFlag('--skip-db-restore');

const summaries = [];
for (const issue of issues) {
  const localRestoreFlag = path.join(root, '.repro-agent-local-restore');
  const issueEnv = {
    ISSUE: String(issue),
    REPO: repo,
    UPSTREAM: upstream,
    MAX_TURNS: maxTurns,
    APP_URL: appUrl,
    ADMIN_USER: process.env.ADMIN_USER || 'admin',
    ADMIN_PASS: process.env.ADMIN_PASS || 'shopware',
    REPRO_AGENT_LOCAL_RESTORE: '1',
  };

  if (!skipDbRestore) {
    const restored = run(`restore DB before issue #${issue}`, 'bash', ['.github/actions/repro-agent/local/scripts/restore-db.sh'], issueEnv);
    if (restored.status !== 0) {
      const summary = { issue, status: 'restore_failed', reporter_output: restored.stderr || restored.stdout };
      summaries.push(summary);
      fs.mkdirSync(path.join(root, `.scratch/repro-agent-local/runs/issue-${issue}`), { recursive: true });
      fs.writeFileSync(path.join(root, `.scratch/repro-agent-local/runs/issue-${issue}/summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
      if (stopOnFailure) break;
      continue;
    }
  }

  const accessKey = resolveStorefrontAccessKey();
  if (accessKey) issueEnv.SW_ACCESS_KEY = accessKey;

  if (!skipDbRestore) {
    fs.writeFileSync(localRestoreFlag, '1\n');
  } else {
    fs.rmSync(localRestoreFlag, { force: true });
  }

  const prepared = run(`prepare issue #${issue}`, 'bash', ['.github/actions/repro-agent/local/scripts/prepare-run.sh'], issueEnv);
  if (prepared.status !== 0) {
    fs.rmSync(localRestoreFlag, { force: true });
    const summary = { issue, status: 'prepare_failed', reporter_output: prepared.stderr || prepared.stdout };
    summaries.push(summary);
    fs.mkdirSync(path.join(root, `.scratch/repro-agent-local/runs/issue-${issue}`), { recursive: true });
    fs.writeFileSync(path.join(root, `.scratch/repro-agent-local/runs/issue-${issue}/summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
    if (stopOnFailure) break;
    continue;
  }

  const agent = run(`agent issue #${issue}`, 'node', [
    '.github/actions/repro-agent/local/scripts/run-agent.mjs',
    '--issue', String(issue),
    '--max-turns', maxTurns,
    '--model', model,
    '--reasoning-effort', reasoningEffort,
    '--sandbox', sandbox,
  ], issueEnv, { timeoutMs: agentTimeoutMs });
  fs.rmSync(localRestoreFlag, { force: true });
  if (agent.timedOut) {
    console.error(`agent issue #${issue} timed out after ${agentTimeoutMs}ms`);
  }

  const contract = run(`contract issue #${issue}`, 'node', [
    '.github/actions/repro-agent/local/scripts/verify-output.mjs',
  ], issueEnv);

  const summary = archiveIssue(issue);
  summary.agent_exit = agent.status;
  summary.contract_exit = contract.status;
  summaries.push(summary);
  console.log(`== issue #${issue}: ${summary.status} (${summary.executor || 'unknown'}) ==`);

  if (stopOnFailure && (agent.status !== 0 || contract.status !== 0 || summary.status === 'blocked' || summary.status === 'inconclusive' || summary.status === 'missing')) {
    break;
  }
}

fs.mkdirSync(path.join(root, '.scratch/repro-agent-local'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.scratch/repro-agent-local/summary.json'),
  `${JSON.stringify({ generated_at: new Date().toISOString(), issues: summaries }, null, 2)}\n`,
);

const counts = summaries.reduce((acc, summary) => {
  acc[summary.status] = (acc[summary.status] || 0) + 1;
  return acc;
}, {});
console.log('\n== summary ==');
console.log(JSON.stringify(counts, null, 2));
