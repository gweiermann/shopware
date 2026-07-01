#!/usr/bin/env node
import fs from 'node:fs';

function readJson(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function outputTypes(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function statusLine(value) {
  return value || 'unknown';
}

function compactPublicSummary(value) {
  const text = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, '[omitted code block]')
    .replace(/`{1,3}/g, '')
    .replace(/@([A-Za-z0-9_-]+)/g, '&#64;$1')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= 1200) {
    return text;
  }

  return `${text.slice(0, 1197).replace(/\s+\S*$/, '')}...`;
}

function agentPipelineSummary(items) {
  const missingTool = items.find((item) => item?.type === 'missing_tool');
  if (missingTool) {
    return compactPublicSummary([
      missingTool.tool ? `A required workflow tool was unavailable: ${missingTool.tool}.` : 'A required workflow tool was unavailable.',
      missingTool.alternatives ? `Suggested recovery: ${missingTool.alternatives}` : '',
    ].filter(Boolean).join(' '));
  }

  const incomplete = items
    .filter((item) => item?.type === 'report_incomplete')
    .map((item) => compactPublicSummary(item?.reason || item?.details))
    .filter(Boolean);
  if (incomplete.length > 0) {
    return incomplete.at(-1);
  }

  const messages = items
    .filter((item) => item?.type === 'noop')
    .filter((item) => !item?.secrecy || item.secrecy === 'public')
    .map((item) => compactPublicSummary(item?.message))
    .filter(Boolean);

  return messages.at(-1) || '';
}

function readPlan() {
  const candidates = [
    process.env.REPRO_PLAN,
    'reproduction-plan.json',
    'repro-plan/reproduction-plan.json',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const value = readJson(candidate);
    if (value) return value;
  }

  return null;
}

function cleanNullable(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text === 'null' ? '' : text;
}

function planBlockedReason(plan) {
  if (!plan || typeof plan !== 'object') return '';
  return compactPublicSummary(cleanNullable(plan.blocked_reason));
}

function firstUsefulReason(...candidates) {
  return candidates.map((candidate) => compactPublicSummary(candidate)).find(Boolean) || '';
}

const agentOutput = readJson(process.env.AGENT_OUTPUT || process.argv[2]);
const items = Array.isArray(agentOutput?.items) ? agentOutput.items : [];
const errors = Array.isArray(agentOutput?.errors) ? agentOutput.errors : [];
const types = new Set([
  ...outputTypes(process.env.OUTPUT_TYPES),
  ...items.map((item) => String(item?.type || '')).filter(Boolean),
]);

const agentResult = statusLine(process.env.AGENT_RESULT);
const trunkResult = statusLine(process.env.REPRODUCE_ON_TRUNK_RESULT);
const safeOutputsResult = statusLine(process.env.SAFE_OUTPUTS_RESULT);
const runUrl = process.env.RUN_URL || '';
const hasTrunkHandoff = types.has('reproduce_on_trunk');
const hasGiveupHandoff = items.some((item) => item?.type === 'reproduce_on_trunk' && item?.status === 'giveup');
const agentLog = readText(process.env.AGENT_LOG || '/tmp/gh-aw/agent-stdio.log');
const transientProviderFailure = /(?:api_error_status":500|error_status":529|API Error: 500|Internal server error|overloaded_error|error":"overloaded"|Overloaded)/i.test(agentLog);
const plan = readPlan();
const planBlocked = planBlockedReason(plan);

let status = 'No deterministic verdict produced';
let summary = 'The agent finished without handing off a classified reported-version result to the deterministic trunk/verdict job.';
let omitNotice = true;
let shortPipelineFailed = false;
let why = '';

if (agentResult === 'failure' && transientProviderFailure) {
  status = 'Agent provider failure (retry later)';
  summary = 'The Claude API returned overload/internal-server errors before the agent could produce a reproduction bundle. This is likely transient; retrying later may resolve it.';
  why = summary;
} else if (['failure', 'cancelled', 'timed_out'].includes(agentResult)) {
  status = 'incomplete';
  summary = 'The workflow was not able to confirm or disprove the bug report.';
  why = firstUsefulReason(agentPipelineSummary(items), planBlocked, `the agent job ended with ${agentResult}`);
} else if (hasGiveupHandoff) {
  shortPipelineFailed = true;
} else if (hasTrunkHandoff && trunkResult === 'success') {
  status = 'Deterministic report completed';
  summary = 'The agent handed off a reported-version result and the deterministic trunk/verdict job finished.';
  omitNotice = false;
} else if (hasTrunkHandoff) {
  status = 'incomplete';
  summary = 'The workflow was not able to confirm or disprove the bug report.';
  why = firstUsefulReason(planBlocked, `the deterministic report job ended with ${trunkResult}`);
} else if (items.some((item) => item?.type === 'report_incomplete')) {
  shortPipelineFailed = true;
} else if (items.some((item) => item?.type === 'noop')) {
  shortPipelineFailed = true;
} else if (items.some((item) => item?.type === 'missing_tool')) {
  shortPipelineFailed = true;
} else if (errors.length > 0) {
  status = 'incomplete';
  summary = 'The workflow was not able to confirm or disprove the bug report.';
  why = firstUsefulReason(errors.map((error) => error?.message || error).join('; '), 'safe-output processing reported errors before a trusted verdict could be posted');
}

if (shortPipelineFailed) {
  const pipelineSummary = firstUsefulReason(agentPipelineSummary(items), planBlocked, 'the agent did not hand off a verified reproduction bundle');

  console.log('## Reproduction: incomplete');
  console.log();
  console.log('The workflow was not able to confirm or disprove the bug report.');
  console.log('The agent did not produce a verified reproduction bundle, so the deterministic checks could not reach a trusted verdict.');
  console.log();
  console.log(`**Why:** ${pipelineSummary}`);
  if (runUrl) {
    console.log();
    console.log(`[Run details](${runUrl})`);
  }
  process.exit(0);
}

if (status === 'incomplete') {
  console.log('## Reproduction: incomplete');
  console.log();
  console.log(summary);
  console.log('The agent did not succeed with setting up its environment or required preconditions, so the deterministic checks could not reach a trusted verdict.');
  console.log();
  console.log(`**Why:** ${firstUsefulReason(why, planBlocked, 'the workflow stopped before a verified reproduction result was available')}`);
  if (runUrl) {
    console.log();
    console.log(`[Run details](${runUrl})`);
  }
  process.exit(0);
}

console.log('## Reproduction (gh-aw) status');
console.log();
console.log(`**Status:** ${status}`);
console.log();
console.log(`**Summary:** ${summary}`);
console.log();
console.log(`**Jobs:** agent \`${agentResult}\`, trunk \`${trunkResult}\`, safe outputs \`${safeOutputsResult}\`.`);
if (runUrl) {
  console.log();
  console.log(`[Run details](${runUrl})`);
}
if (omitNotice) {
  console.log();
  console.log('Generated fixtures and test-case contents are omitted because there is no trusted automated verdict.');
}
