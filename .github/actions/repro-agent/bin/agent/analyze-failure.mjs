#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] || process.cwd());

function readText(relativePath) {
  try {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
  } catch {
    return '';
  }
}

function readJson(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch {
    return null;
  }
}

function walkFiles(dir, predicate, found = []) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return found;

  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(absolute, entry.name);
    const relative = path.relative(root, child);
    if (entry.isDirectory()) {
      walkFiles(relative, predicate, found);
    } else if (predicate(relative)) {
      found.push(relative);
    }
  }

  return found;
}

function newest(files) {
  return files
    .map((file) => ({ file, mtime: fs.statSync(path.join(root, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.file || null;
}

function normalizeRoute(value) {
  return value
    .replace(/\\\\/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '/')
    .replace(/^\*\*/, '')
    .replace(/^#?\/?/, '#/');
}

function routeFamiliesFromSpec(spec) {
  const routes = new Set();
  for (const match of spec.matchAll(/sw(?:\\\/|\/|\\{2}\/)([a-z0-9-]+)(?:\\\/|\/|\\{2}\/)([a-z0-9-]+)/gi)) {
    routes.add(`#/sw/${match[1]}/${match[2]}`);
  }
  for (const match of spec.matchAll(/#\/sw\/([a-z0-9-]+)\/([a-z0-9-]+)/gi)) {
    routes.add(`#/sw/${match[1]}/${match[2]}`);
  }
  return [...routes].map(normalizeRoute);
}

function containsRouteFamily(text, family) {
  const prefix = family.endsWith('/') ? family : `${family}/`;
  return text.includes(family) || text.includes(prefix);
}

function routeRepair(family) {
  const escaped = family.replace('#/', '#\\\\/').replaceAll('/', '\\\\/');
  const modulePrefix = family.split('/').slice(0, 3).join('/');
  const escapedModulePrefix = modulePrefix.replace('#/', '#\\\\/').replaceAll('/', '\\\\/');
  return `Use a route-family/hash-prefix gate such as /${escapedModulePrefix}\\\\// unless the exact child route is the reported symptom.`;
}

function result(kind, confidence, evidence, repair, extra = {}) {
  return {
    kind,
    confidence,
    evidence,
    repair,
    ...extra,
  };
}

const builder = readJson('builder-result.json');
const plan = readJson('reproduction-plan.json');
const specPath = plan?.script_path || 'repro.spec.ts';
const spec = readText(specPath);
const errorContextPath = newest(walkFiles('test-results', (file) => file.endsWith('error-context.md')));
const errorContext = errorContextPath ? readText(errorContextPath) : '';
const screenshotPath = newest(walkFiles('test-results', (file) => /\.(png|jpe?g|webp)$/i.test(file)));
const reporter = builder?.evidence?.reporter_output || builder?.blocked_reason || '';
const status = builder?.status || 'missing';
const combined = [reporter, errorContext].filter(Boolean).join('\n\n');

let hint = null;

if (!builder) {
  hint = result(
    'unknown',
    'low',
    'builder-result.json is missing or unreadable.',
    'Run the verifier first, then rerun the analyzer.',
  );
}

if (!hint && /element is outside of the viewport/i.test(combined)) {
  hint = result(
    'offscreen_click_target',
    'high',
    'Playwright found the element but reported it outside the viewport during click action.',
    'Use probe entries marked in viewport, choose a reachable control, or navigate through a stable direct route instead of clicking an offscreen accessibility-tree entry.',
    { error_context: errorContextPath, screenshot: screenshotPath },
  );
}

if (!hint && /PRECONDITION_NOT_FOUND:[^\n]*(route change|route|URL)/i.test(combined)) {
  const families = routeFamiliesFromSpec(spec);
  const matchedFamily = families.find((family) => containsRouteFamily(errorContext, family));
  if (matchedFamily) {
    hint = result(
      'over_exact_route_gate',
      'high',
      `Failure was a route precondition, and the page snapshot shows the same route family (${matchedFamily}) or a child/default route.`,
      routeRepair(matchedFamily),
      { route_family: matchedFamily, error_context: errorContextPath, screenshot: screenshotPath },
    );
  }
}

if (!hint && /PRECONDITION_NOT_FOUND:[^\n]*(dashboard|admin shell|administration shell|header|toolbar|generic chrome|home)/i.test(combined)) {
  hint = result(
    'generic_chrome_precondition',
    'high',
    'The failing precondition targets generic Admin chrome rather than the issue-specific module, entity, control, or rendered state.',
    'Replace the generic shell/dashboard/header gate with the smallest issue-specific target that proves the scenario is exercisable.',
    { error_context: errorContextPath, screenshot: screenshotPath },
  );
}

if (!hint && /(?:No .+ yet|empty state|There are no|No products yet|No media yet)/i.test(errorContext)
  && /PRECONDITION_NOT_FOUND|missing|not visible/i.test(combined)) {
  hint = result(
    'empty_seeded_page',
    'high',
    'The page rendered an empty-state view while the verifier failed before finding the expected issue-specific content.',
    'Treat this as fixture/setup drift: verify DAL shape, active/visibility/indexing requirements, and navigate by a stable technical route to seeded content.',
    { error_context: errorContextPath, screenshot: screenshotPath },
  );
}

if (!hint && /(?:Choose media|Media Library)/i.test(errorContext)
  && /\bNothing found\b/i.test(errorContext)
  && /PRECONDITION_NOT_FOUND:[^\n]*(?:media modal|media tile|media item|uploaded media)/i.test(combined)) {
  hint = result(
    'missing_uploaded_binary_state',
    'high',
    'The media selector opened a scoped media-library folder and rendered an empty state while the spec waited for the uploaded file.',
    'Create or upload the file in the same media-library context/folder that the owning selector opens, or navigate/search inside the selector before selecting it; a file uploaded elsewhere in Media is not enough to prove the usage relation.',
    { error_context: errorContextPath, screenshot: screenshotPath },
  );
}

if (!hint && /(?:media|image|file|upload|replace)/i.test([combined, spec].join('\n'))
  && /(?:hasFile|uploaded bytes|file bytes|Replace button|disabled|media item missing|No media)/i.test([combined, errorContext].join('\n'))) {
  hint = result(
    'missing_uploaded_binary_state',
    'high',
    'Evidence points at media/file UI state, where static DAL rows may exist without uploaded binary state.',
    'Seed static relations with fixtures, but create the actual uploaded file through the owning UI flow before exercising replacement or file-dependent controls.',
    { error_context: errorContextPath, screenshot: screenshotPath },
  );
}

if (!hint) {
  hint = result(
    'unknown',
    'low',
    status === 'missing' ? 'No verifier status was found.' : `No high-confidence repair hint matched verifier status '${status}'.`,
    'Use the verifier failure, Playwright error context, and screenshot directly.',
    { error_context: errorContextPath, screenshot: screenshotPath },
  );
}

console.log(JSON.stringify(hint, null, 2));
