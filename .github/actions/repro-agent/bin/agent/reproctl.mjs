#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const selfDir = path.dirname(fileURLToPath(import.meta.url));
const defaultToolRoot = fs.existsSync(path.join(selfDir, 'bin'))
  ? selfDir
  : path.resolve(selfDir, '../..');
const toolRoot = path.resolve(process.env.REPROCTL_ROOT || defaultToolRoot);
const reproRoot = path.resolve(process.env.REPRO_AGENT_ROOT || toolRoot);
const bin = path.resolve(process.env.REPRO_AGENT_BIN || path.join(reproRoot, 'bin'));

function usage(exitCode = 0) {
  console.log(`usage:
  node /tmp/reproctl/reproctl.mjs probe-ui <route-or-url> [viewport]
  node /tmp/reproctl/reproctl.mjs validate
  node /tmp/reproctl/reproctl.mjs verify
  node /tmp/reproctl/reproctl.mjs giveup
  node /tmp/reproctl/reproctl.mjs analyze`);
  process.exit(exitCode);
}

function die(message, exitCode = 2) {
  console.error(`reproctl: ${message}`);
  process.exit(exitCode);
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      REPRO_AGENT_ROOT: reproRoot,
      REPRO_AGENT_BIN: bin,
      ...extraEnv,
    },
    stdio: 'inherit',
  });

  if (result.error) die(result.error.message, 1);
  process.exit(result.status ?? 1);
}

function ensureLocalRoute(route) {
  if (!route) die('probe-ui needs a route or local URL');
  if (/^https?:\/\//i.test(route)) {
    const url = new URL(route);
    if (!['127.0.0.1', 'localhost', 'host.docker.internal'].includes(url.hostname)) {
      die(`probe-ui only accepts local URLs, got ${url.hostname}`);
    }
  }
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case undefined:
  case '-h':
  case '--help':
  case 'help':
    usage(0);
    break;
  case 'probe-ui':
    ensureLocalRoute(args[0]);
    run('bash', [path.join(bin, 'agent/probe-ui.sh'), ...args]);
    break;
  case 'validate':
    run('node', [path.join(bin, 'agent/validate-bundle.mjs')]);
    break;
  case 'verify':
    run('bash', [path.join(bin, 'agent/verify-reproduction.sh')], {
      REPRO_AGENT_DEFER_REPORTED_RESULT: '1',
      REPRO_SKIP_DB_RESTORE: '1',
    });
    break;
  case 'giveup':
    run('bash', [path.join(bin, 'agent/verify-reproduction.sh'), 'giveup'], {
      REPRO_AGENT_DEFER_REPORTED_RESULT: '1',
    });
    break;
  case 'verify-authoritative':
    if (process.env.REPROCTL_ALLOW_AUTHORITATIVE !== '1') {
      die('verify-authoritative is reserved for deterministic workflow steps');
    }
    run('bash', [path.join(bin, 'agent/verify-reproduction.sh')], {
      REPRO_AGENT_SKIP_HANDOFF: '1',
      REPRO_VERIFY_ATTEMPT_FILE: '.repro-post-verify-attempts',
      REPRO_HANDOFF_SENT_FILE: '.repro-post-handoff-sent',
    });
    break;
  case 'analyze':
    run('node', [path.join(bin, 'agent/analyze-failure.mjs'), ...args]);
    break;
  default:
    die(`unknown command '${command}'`);
}
