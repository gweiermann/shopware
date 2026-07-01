#!/usr/bin/env node
// Render the GitHub issue comment from templates/ — no prose lives here, only selection and layout.
// Two shapes: a full verdict comment (legs ran) and the short "incomplete" comment (no verdict
// possible). All wording is in templates/verdicts.json + templates/comment.*.md.
//
//   verdict comment:  VERDICT, UNSURE, FIX, RUN_URL, ISSUE, ART(=artifacts) → comment.md
//   incomplete:       MODE=incomplete, REASON, RUN_URL                      → comment.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const templates = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const DATA = JSON.parse(fs.readFileSync(path.join(templates, 'verdicts.json'), 'utf8'));
const OUT = process.env.OUT || 'comment.md';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const fill = (str, vars) => String(str ?? '').replace(/{{(\w+)}}/g, (_, k) => vars[k] ?? '');

// Read an extra file written by the agent job (agent-summary.md, workspace-edits.txt): from the
// collected artifact dir first, then the working dir (where the incomplete path extracts it).
function readExtra(name) {
  for (const p of [`${process.env.ART || 'artifacts'}/repro-plan/${name}`, name]) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t; } catch { /* next */ }
  }
  return '';
}

// mustache-lite: {{#KEY}}…{{/KEY}} keeps the block iff ctx[KEY] is truthy; {{KEY}} substitutes.
// Single var pass (sections just inline their body), so substituted values — e.g. the agent summary —
// are never re-scanned for placeholders.
function render(tpl, ctx) {
  const withSections = tpl.replace(/{{#(\w+)}}\n?([\s\S]*?){{\/\1}}\n?/g, (_, key, inner) => (ctx[key] ? inner : ''));
  return withSections.replace(/{{(\w+)}}/g, (_, key) => ctx[key] ?? '');
}

const redact = (text) => text
  .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]')
  .replace(/(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED_TOKEN]')
  .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_TOKEN]')
  .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]')
  .replace(/([Bb]earer\s+)[A-Za-z0-9._~+/-]{16,}=*/g, '$1[REDACTED]');

// Guarantee a blank line before every heading (sections may collapse the spacing) and squeeze
// runs of blank lines — so the layout is robust to which optional sections rendered.
const tidy = (md) => `${md.replace(/([^\n])\n(#{2,4} )/g, '$1\n\n$2').replace(/\n{3,}/g, '\n\n').trim()}\n`;

function write(markdown) {
  const redacted = redact(tidy(markdown));
  fs.writeFileSync(OUT, redacted);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, redacted);
  process.stdout.write(redacted);
}

if (process.env.MODE === 'incomplete') {
  const tpl = fs.readFileSync(path.join(templates, 'comment.incomplete.md'), 'utf8');
  const edits = readExtra('workspace-edits.txt');
  write(render(tpl, {
    REASON: process.env.REASON || DATA.incomplete_reason_default,
    RUN_URL: process.env.RUN_URL || '',
    AGENT_SUMMARY: readExtra('agent-summary.md'),
    EDITS: edits,
  }));
} else {
  write(renderVerdict());
}

function renderVerdict() {
  const art = process.env.ART || 'artifacts';
  const plan = readJson(`${art}/repro-plan/reproduction-plan.json`) || {};
  const legA = readJson(`${art}/repro-reported/result.json`);
  const legB = readJson(`${art}/repro-trunk/result.json`);
  const as = legA?.status ?? 'null';
  const bs = legB?.status ?? 'null';
  const rv = (legA || plan).version ?? '?';
  const labels = { AL: `v${rv}`, BL: 'trunk', AS: as, BS: bs, RV: rv, DATE: process.env.DATE || new Date().toISOString().slice(0, 10) };

  const verdict = process.env.VERDICT || 'needs_human_review';
  const fix = process.env.FIX || '';
  const unsure = process.env.UNSURE || '';
  const p = DATA.phrases;
  const vars = {
    ...labels,
    SURFACE: p.surface[plan.layer] || plan.layer || 'unknown',
    EXECUTOR: p.executor[plan.executor] || plan.executor || 'unknown',
    FIX: fix,
    FIX_SUFFIX: fix ? fill(p.fix_suffix, { FIX: fix }) : '',
    NHR_HEADLINE: fix ? p.nhr_headline_with_fix : p.nhr_headline,
    NHR_UNDERLYING: fill(p.nhr_underlying[`${as}/${bs}`] || p.nhr_underlying.default, labels),
    UNSURE_SUFFIX: unsure ? fill(p.unsure_suffix, { UNSURE: unsure }) : '',
    NHR_TAIL: fix ? fill(p.nhr_tail_with_fix, { FIX: fix }) : p.nhr_tail,
    NHR_CALLOUT: fix ? fill(p.nhr_callout_with_fix, { FIX: fix }) : p.nhr_callout,
  };

  const entry = DATA.verdicts[verdict] || { headline: verdict, summary: `Verdict: ${verdict}.`, callout: '' };
  // Show the bundle for confident verdicts, and always when a leg actually reproduced (the bundle is
  // demonstrably meaningful then) — only hide it for a blocked/unsure verdict where neither leg did.
  const reproduced = as === 'reproduced' || bs === 'reproduced';
  const omitBundle = (verdict === 'needs_human_review' || verdict === 'blocked') && !reproduced;
  const specLeg = legA || legB;
  const script = omitBundle ? '' : (specLeg?.evidence?.script || '');
  const fixturesPath = `${art}/repro-plan/fixtures.json`;
  const hasFixtures = !omitBundle && fs.existsSync(fixturesPath);

  const ctx = {
    HEADLINE: fill(entry.headline, vars),
    SUMMARY: fill(entry.summary, vars),
    CALLOUT: fill(entry.callout, vars),
    RUN_URL: process.env.RUN_URL || '',
    SCENARIO: scenarioBlock(plan),
    AGENT_EXPLANATION: agentExplanation(plan),
    RESULT: resultSection({ legA, legB, as, bs, labels }),
    EDITS: readExtra('workspace-edits.txt'),
    AGENT_SUMMARY: readExtra('agent-summary.md'),
    TESTCASE: script,
    TESTCASE_LANG: specLeg?.evidence?.script_lang || 'sh',
    TESTCASE_TOOL: p.testcase_tool[plan.executor] || specLeg?.evidence?.script_lang || 'sh',
    FIXTURES: hasFixtures ? fs.readFileSync(fixturesPath, 'utf8').trim() : '',
  };
  return render(fs.readFileSync(path.join(templates, 'comment.verdict.md'), 'utf8'), ctx);
}

function scenarioBlock(plan) {
  return Array.isArray(plan.scenario) && plan.scenario.length
    ? plan.scenario.map((s) => `- ${s.replace(/^(Given|When|Then|And|But) /, '**$1** ')}`).join('\n')
    : '';
}

function agentExplanation(plan) {
  const text = plan.agent_explanation || plan.confidence_reason;
  if (!text || text === 'null') return '';
  const confidence = plan.confidence != null ? `\n\n**Confidence:** ${plan.confidence}` : '';
  return `${String(text).replace(/\s+/g, ' ').trim()}${confidence}`;
}

// Merge the two legs into one block when they reached the same status; otherwise show each.
function resultSection({ legA, legB, as, bs, labels }) {
  if (legA && legB && as === bs) return legBlock(`${labels.AL} & ${labels.BL}`, as, legA);
  return [legA && legBlock(labels.AL, as, legA), legB && legBlock(labels.BL, bs, legB)].filter(Boolean).join('\n');
}

function legBlock(label, status, leg) {
  const parts = [`\n#### On ${label}: \`${status}\`\n`, checksBlock(leg), DATA.phrases.gloss[status] || ''];
  if (leg.blocked_reason && leg.blocked_reason !== 'null') parts.push(`\n> ${leg.blocked_reason}`);
  return parts.join('\n');
}

function qval(v) { return /^\d+$/.test(v) ? v : `'${v}'`; }
function clean(s) { return String(s).replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim(); }

// Render assertion.checks as named asserts (require* = precondition, assert* = symptom) with ✅/❌;
// fall back to the raw reporter line when an executor emits no checks.
function checksBlock(leg) {
  const checks = leg.assertion?.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    const reporter = leg.evidence?.reporter_output;
    return reporter && reporter !== 'null' ? `\`\`\`\n${reporter}\n\`\`\`` : '';
  }
  const ops = { present: 'Present', absent: 'Absent', contains: 'Contains', matches: 'Matches', gt: 'GreaterThan', lt: 'LessThan', equals: 'Equals' };
  const sorted = [...checks].sort((a, b) => (a.role === 'precondition' ? 0 : 1) - (b.role === 'precondition' ? 0 : 1));
  const lines = ['```js'];
  let lastRole;
  for (const c of sorted) {
    const role = c.role === 'precondition' ? 'precondition' : 'assert';
    if (role !== lastRole) { if (lastRole) lines.push(''); lines.push(`// === ${role === 'precondition' ? 'PRECONDITIONS' : 'ASSERTIONS'} ===`); lastRole = role; }
    const verb = role === 'precondition' ? 'require' : 'assert';
    const name = ops[c.op] || 'Equals';
    const call = ['present', 'absent'].includes(c.op) ? `${verb}${name}(${c.subject})` : `${verb}${name}(${c.subject}, ${qval(String(c.expected))})`;
    const suffix = c.label && c.label !== 'null' ? ` - ${clean(c.label)}` : '';
    if (c.ok) { lines.push(`${call} // ✅${suffix}`); continue; }
    const actual = String(c.actual);
    if (actual.includes('\n')) {
      // A multi-line value (e.g. a JSON error body) can't sit behind a `//` line comment — the
      // second line would break the fence. Put it in a /* … */ block on its own lines.
      lines.push(`${call} // ❌${suffix}`, `/* got:\n${blockSafe(actual)}\n*/`);
    } else {
      lines.push(`${call} // ❌ got ${qval(actual)}${suffix}`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

// Keep a multi-line value intact for a block comment: cap the length and neutralize any `*/`.
function blockSafe(s) {
  const capped = s.length > 1200 ? `${s.slice(0, 1200)}\n… (truncated)` : s;
  return capped.replace(/\*\//g, '* /');
}
