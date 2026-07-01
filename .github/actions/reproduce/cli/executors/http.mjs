// `http` executor: run a request (or a request SEQUENCE), then evaluate a LIST of assertions on the
// FINAL response. Auth is chosen by surface and owned by the executor — /api/* gets an admin Bearer
// token, /store-api/* gets the sw-access-key — so an agent-authored auth header can't skew the leg.
//
// Combine rule: every assertion passes ⇒ not_reproduced (healthy); any symptom assertion fails ⇒
// reproduced. False-positive guards win: a failed precondition, an unasserted 401/403, or an
// unreadable value on a non-2xx response ⇒ inconclusive, never a bogus "reproduced".
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { appUrl, makeResult, fillPlaceholders } from '../lib.mjs';
import { token, resolvePlaceholders, salesChannelAccessKey } from '../admin-api.mjs';

const isAdminPath = (p) => p.startsWith('/api/');
const isStorePath = (p) => p.startsWith('/store-api/');
const jqField = (filter, body) => (spawnSync('jq', ['-r', filter], { input: body, encoding: 'utf8' }).stdout || '').trim();

export async function run({ plan, target }) {
  const requests = plan.requests || [plan.request];
  const assertions = plan.assertions || (plan.assertion ? [plan.assertion] : []);

  const ids = await resolveContext(plan, requests, assertions);
  const evaluation = await sendRequests(requests, ids);
  fs.writeFileSync('repro.sh', `#!/usr/bin/env bash\n# Reproduction request(s) — set $APP_URL (executor injects auth + sw-context-token).\n${evaluation.script}`);

  const { status, checks, reporter } = classify(assertions, evaluation);
  return makeResult({
    plan, target, status,
    assertion: { matched: status === 'not_reproduced', checks },
    evidence: { script: evaluation.script, script_lang: 'sh', reporter_output: reporter, http: [{ status: evaluation.code || 0 }] },
    blockedReason: ['blocked', 'inconclusive'].includes(status) ? reporter : null,
  });
}

// Resolve only what this plan needs: install ids (if it references entity placeholders), a store
// access key (for store-api without one provided), and the base storefront URL.
async function resolveContext(plan, requests, assertions) {
  const referenced = [...JSON.stringify(requests).matchAll(/\{\{([A-Z0-9_]+)\}\}/g), ...JSON.stringify(assertions).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]);
  const needsIds = referenced.some((k) => !['SW_ACCESS_KEY', 'STOREFRONT_URL', 'SW_CONTEXT_TOKEN'].includes(k));
  const paths = requests.map((r) => r?.path || '');
  const needsStore = paths.some(isStorePath);

  let ids = { STOREFRONT_URL: appUrl() };
  if (needsIds) ids = { ...await resolvePlaceholders() };
  ids.STOREFRONT_URL = ids.STOREFRONT_URL || appUrl();
  ids.SW_ACCESS_KEY = process.env.SW_ACCESS_KEY || (needsStore ? await salesChannelAccessKey() : '');
  ids.SW_CONTEXT_TOKEN = '';
  return ids;
}

async function sendRequests(requests, ids) {
  let code = ''; let bodyText = ''; let blocked = ''; let script = '';
  for (let i = 0; i < requests.length; i += 1) {
    const req = requests[i];
    const method = req.method || 'GET';
    const path = fillPlaceholders(req.path || '', ids);
    const body = req.body ? fillPlaceholders(typeof req.body === 'string' ? req.body : JSON.stringify(req.body), ids) : '';
    const headers = { Accept: 'application/json' };

    if (isAdminPath(path)) headers.Authorization = `Bearer ${await token()}`;
    else if (ids.SW_ACCESS_KEY) headers['sw-access-key'] = ids.SW_ACCESS_KEY;
    if (ids.SW_CONTEXT_TOKEN) headers['sw-context-token'] = ids.SW_CONTEXT_TOKEN;
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (['sw-access-key', 'authorization'].includes(k.toLowerCase())) continue; // executor owns auth
      headers[k] = fillPlaceholders(String(v), ids);
    }
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    script += `curl -sS -X ${method} "$APP_URL${path}"${body ? ` --data '${body}'` : ''}\n`;

    let res;
    try { res = await fetch(`${appUrl()}${path}`, { method, headers, body: body || undefined }); }
    catch { blocked = `request ${i + 1} (${method} ${path}) — transport failure`; break; }
    code = String(res.status);
    bodyText = await res.text();
    const ctx = res.headers.get('sw-context-token');
    if (ctx) ids.SW_CONTEXT_TOKEN = ctx;
    if (i < requests.length - 1 && !code.startsWith('2')) {
      blocked = `setup request ${i + 1} (${method} ${path}) returned HTTP ${code} — ${bodyText.slice(0, 300)}`;
      break;
    }
  }
  return { code, bodyText, blocked, script };
}

const OPS = {
  equals: (a, e) => a === e,
  contains: (a, e) => a.includes(e),
  matches: (a, e) => new RegExp(e).test(a),
  present: (a) => !['', '<unparseable>', 'null', '[]', '{}'].includes(a),
  absent: (a) => ['', '<unparseable>', 'null'].includes(a),
  gt: (a, e) => Number(a) > Number(e),
  lt: (a, e) => Number(a) < Number(e),
};

function classify(assertions, { code, bodyText, blocked }) {
  if (blocked) return { status: 'blocked', checks: [], reporter: blocked };
  if (assertions.length === 0) return { status: 'inconclusive', checks: [], reporter: 'the plan declares no assertions' };

  const is2xx = /^2/.test(code);
  const authAsserted = assertions.some((a) => a.kind === 'http_status' && ['401', '403'].includes(String(a.expect)));
  if (['401', '403'].includes(code) && !authAsserted) {
    return { status: 'inconclusive', checks: [], reporter: `request returned HTTP ${code} (auth rejected) before the symptom could run — harness-credential failure, not the reported bug` };
  }

  const checks = [];
  let precondOk = true; let symptomOk = true; let unreadableNon2xx = false;
  for (const a of assertions) {
    const op = OPS[a.op] ? a.op : 'equals';
    const role = a.role === 'precondition' ? 'precondition' : 'assert';
    const kind = a.kind || (a.field ? 'response_field' : 'http_status');
    const expected = a.expect !== undefined ? String(a.expect) : '';
    const subject = kind === 'http_status' ? 'status' : `response | ${a.field}`;
    const actual = kind === 'http_status' ? code : (jqField(a.field, bodyText) || '<unparseable>');
    const ok = OPS[op](actual, expected);

    if (role === 'precondition') { if (!ok) precondOk = false; }
    else {
      if (!ok) symptomOk = false;
      if (['equals', 'contains', 'matches', 'gt', 'lt'].includes(op) && actual === '<unparseable>' && !is2xx) unreadableNon2xx = true;
    }
    checks.push({ subject, role, op, expected, actual, label: a.label || a.comment || '', ok });
  }

  if (!precondOk) {
    const failed = checks.filter((c) => c.role === 'precondition' && !c.ok).map((c) => `${c.subject} (expected ${c.expected}, got ${c.actual})`).join('; ');
    return { status: 'inconclusive', checks, reporter: `precondition(s) not met: ${failed} — the scenario was not set up as expected` };
  }
  if (unreadableNon2xx) return { status: 'inconclusive', checks: [], reporter: `final request returned HTTP ${code} and an asserted field was unreadable` };
  if (symptomOk) return { status: 'not_reproduced', checks, reporter: `all assertions passed; HTTP ${code}` };
  const failed = checks.filter((c) => c.role === 'assert' && !c.ok).length;
  return { status: 'reproduced', checks, reporter: `${failed} symptom assertion(s) failed; HTTP ${code}` };
}
