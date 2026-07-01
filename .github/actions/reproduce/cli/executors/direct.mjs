// `direct` executor: run a generated PHPUnit integration test that drives the service/DAL directly —
// for bugs that can't fire faithfully through the API or UI. The test asserts the HEALTHY behaviour,
// so it FAILS on the buggy version (⇒ reproduced) and PASSES when healthy (⇒ not_reproduced). A test
// that ERRORS (can't bootstrap/compile — often a cross-version API mismatch) ⇒ inconclusive, unless
// the plan's assertion.symptom_pattern matches the error text, in which case the throw IS the symptom.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FILES, makeResult } from '../lib.mjs';

export function run({ plan, target }) {
  const specPath = plan.script_path || FILES.testPhp;
  const shop = process.env.SHOP_DIR || (fs.existsSync('vendor/bin/phpunit') ? '.' : 'shop');
  const spec = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf8') : '';

  const output = runPhpunit(specPath, shop, plan, target);
  if (output === null) return blocked(plan, target, spec, `generated test '${specPath}' not found`);
  fs.writeFileSync('phpunit-output.txt', output);

  const { status, matched, reporter, reason } = classify(output, plan);
  return makeResult({
    plan, target, status,
    assertion: { expect: 'test passes (healthy)', actual: reporter, matched },
    evidence: { script: spec, script_lang: 'php', reporter_output: reporter, artifacts: [{ kind: 'phpunit-test', name: FILES.testPhp }] },
    blockedReason: reason,
  });
}

function runPhpunit(specPath, shop, plan, target) {
  if (process.env.PHPUNIT_REPORT) return fs.readFileSync(process.env.PHPUNIT_REPORT, 'utf8');
  if (!fs.existsSync(specPath)) return null;
  // PSR-4 autoload-dev (Shopware\Tests\Integration\) discovers the test here.
  const dest = path.join(shop, 'tests/integration/Repro');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(specPath, path.join(dest, FILES.testPhp));
  const res = spawnSync('php', ['vendor/bin/phpunit', '--colors=never', 'tests/integration/Repro/ReproTest.php'], { cwd: shop, encoding: 'utf8', env: { ...process.env, APP_ENV: 'test' } });
  return `${res.stdout || ''}${res.stderr || ''}` || `PHP direct executor could not run phpunit in ${shop}. Install PHP or set PHPUNIT_REPORT.`;
}

function classify(output, plan) {
  const firstError = (output.match(/^\d+\).+(\n.+){0,4}/m) || [''])[0].replace(/\s+/g, ' ').slice(0, 700);
  if (/^OK[ (]/m.test(output)) return { status: 'not_reproduced', matched: true, reporter: 'PHPUnit OK (healthy)', reason: null };
  if (/FAILURES!/.test(output)) return { status: 'reproduced', matched: false, reporter: (output.match(/^\d+\).+/m) || ['assertion failed (symptom present)'])[0].slice(0, 300), reason: null };
  if (/ERRORS!|No tests executed|Fatal error|PHP Fatal|Uncaught/.test(output)) {
    const pattern = plan.assertion?.symptom_pattern;
    if (pattern && new RegExp(pattern).test(output)) {
      return { status: 'reproduced', matched: false, reporter: `symptom exception matched '${pattern}'`, reason: null };
    }
    return { status: 'inconclusive', matched: null, reporter: 'PHPUnit errored (test could not run)', reason: `PHPUnit could not run the test (errored before/outside the symptom assertion): ${firstError} — full output in phpunit-output.txt` };
  }
  return { status: 'blocked', matched: null, reporter: 'PHPUnit produced no result', reason: `PHPUnit produced no recognisable result: ${output.slice(-1500).replace(/\s+/g, ' ')}` };
}

const blocked = (plan, target, spec, reason) => makeResult({ plan, target, status: 'blocked', assertion: { expect: null, actual: null, matched: null }, evidence: { script: spec, script_lang: 'php', reporter_output: reason }, blockedReason: reason });
