#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] || process.cwd());
const enableCookbookGuards = process.env.REPRO_AGENT_ENABLE_COOKBOOK_GUARDS === '1';

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
const errorSummary = errorContext.split(/\n# Page snapshot\b/)[0] || errorContext;
const errorEvidence = errorContext.split(/\n# Test source\b/)[0] || errorContext;
const screenshotPath = newest(walkFiles('test-results', (file) => /\.(png|jpe?g|webp)$/i.test(file)));
const reporter = builder?.evidence?.reporter_output || builder?.blocked_reason || '';
const status = builder?.status || 'missing';
const combined = [reporter, errorContext].filter(Boolean).join('\n\n');
const failureSummary = [reporter, errorSummary].filter(Boolean).join('\n\n');

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

if (!hint && /PRECONDITION_NOT_FOUND:[^\n]*(route change|route|URL)/i.test(failureSummary)) {
  const families = routeFamiliesFromSpec(spec);
  const matchedFamily = families.find((family) => containsRouteFamily(errorEvidence, family));
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

if (!hint && /PRECONDITION_NOT_FOUND:[^\n]*(dashboard|admin shell|administration shell|header|toolbar|generic chrome|home)/i.test(failureSummary)) {
  hint = result(
    'generic_chrome_precondition',
    'high',
    'The failing precondition targets generic Admin chrome rather than the issue-specific module, entity, control, or rendered state.',
    'Replace the generic shell/dashboard/header gate with the smallest issue-specific target that proves the scenario is exercisable.',
    { error_context: errorContextPath, screenshot: screenshotPath },
  );
}

if (!hint && /Error:\s*locator\.click:\s*Test timeout/i.test(errorContext)
  && />\s*\d+\s*\|\s*await[\s\S]{0,180}\.click\(\s*\)\s*;/i.test(errorContext)) {
  hint = result(
    'unbounded_setup_click_timeout',
    'high',
    'A setup click used Playwright’s default full-test timeout and timed out before the symptom assertion could run.',
    'Bound setup clicks with click({ timeout: 5000-10000 }) and convert failures to PRECONDITION_NOT_FOUND, or switch to the precise visible role/control shown in the snapshot before clicking. Do not let setup clicks consume the whole test timeout.',
    { error_context: errorContextPath, screenshot: screenshotPath },
  );
}

if (!hint && /waiting for locator\('\.sw-cms-el-config-[^']+'\)/i.test(errorContext)
  && /#\/sw\/cms\/detail|\/admin#\/sw\/cms\/detail/i.test(spec)
  && /button "Settings"|button "Blocks"|button "Navigator"/i.test(errorContext)) {
  hint = result(
    'cms_element_config_not_open',
    'high',
    'The spec waited for a CMS element configuration selector, but the page snapshot shows the CMS canvas/sidebar tabs rather than an opened element config panel.',
    'Open the issue-specific CMS element settings first: click/select the seeded element in the canvas or use the navigator/settings sidebar until the matching .sw-cms-el-config-* panel is visible, then interact with its upload/config control.',
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

if (!hint && enableCookbookGuards
  && /PRECONDITION_NOT_FOUND:[^\n]*(?:seeded media item|media tile|media item).*?(?:not visible|missing|not listed)/i.test(failureSummary)
  && /#\/sw\/media\/index|\/admin#\/sw\/media\/index/i.test(spec)
  && /getByText\s*\(\s*(?:mediaName|mediaFileName|fileName|['"`][^'"`]+['"`])\s*,\s*\{[^}]*exact\s*:\s*true/i.test(errorContext)
  && /button\s+"[^"]*(?:media|image|file|png|jpe?g|webp|svg)[^"]*"/i.test(errorContext)) {
  hint = result(
    'over_exact_media_tile_text',
    'high',
    'The Media index snapshot contains media tiles, but the spec used an exact text locator for a tile. Shopware media tiles can expose combined text such as filename plus display name or extension.',
    'Select the seeded media with a tile/container locator that uses hasText or a non-exact/regex filename match, then gate on the selected sidebar quick action. If the tile is not in the current viewport, first reveal it with the source/probe-backed current-folder search field.',
    { error_context: errorContextPath, screenshot: screenshotPath },
  );
}

if (!hint && /PRECONDITION_NOT_FOUND:[^\n]*(?:upload input|file input)/i.test(combined)
  && /\bbutton\s+"Upload file/i.test(errorContext)
  && /input\s*\[\s*type\s*=\s*["']?file|file-input/i.test(spec)) {
  hint = result(
    'missing_uploaded_binary_state',
    'high',
    'The page snapshot exposes a visible Upload file button, while the spec waited for a hidden file-input control.',
    'Use page.waitForEvent("filechooser", { timeout }) around the visible Upload file button, or wait for the file input to be attached rather than visible only when source proves direct setInputFiles is required.',
    { error_context: errorContextPath, screenshot: screenshotPath },
  );
}

if (!hint && /(?:media|image|file|upload|replace)/i.test([combined, spec].join('\n'))
  && /(?:hasFile|uploaded bytes|file bytes|Replace button|disabled|media item missing|No media)/i.test([combined, errorContext].join('\n'))) {
  hint = result(
    'missing_uploaded_binary_state',
    'high',
    'Evidence points at media/file UI state, where static DAL rows may exist without uploaded binary state.',
    'Seed static relations with fixtures, but create the actual uploaded file through the owning UI flow before exercising replacement or file-dependent controls. If the upload creates the id you need, attach it through the owning product/CMS/media UI flow rather than patching Admin API state from Playwright.',
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
