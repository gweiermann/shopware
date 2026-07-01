#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { sanitizePlaywrightSpec } from '../execute/sanitize-playwright-spec.mjs';

const root = process.cwd();
const read = (file) => {
  try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; }
};
const readJson = (file) => {
  const text = read(file);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

const issue = read('issue.md');
const plan = readJson('reproduction-plan.json') ?? {};
const fixtures = readJson('fixtures.json') ?? {};
const executor = String(plan.executor ?? '');
const issueClass = read('issue-class.txt').trim();
const enableCookbookGuards = process.env.REPRO_AGENT_ENABLE_COOKBOOK_GUARDS === '1';
const allowedPlaceholders = new Set([
  'SC',
  'NAV_CAT',
  'COUNTRY',
  'SALUTATION',
  'SALUTATION2',
  'TAX',
  'CURRENCY',
  'LANGUAGE',
  'SYSTEM_LANGUAGE',
  'CUSTOMER_GROUP',
  'PAYMENT_METHOD',
  'SHIPPING_METHOD',
  'ORDER_STATE_OPEN',
  'ORDER_DELIVERY_STATE_OPEN',
  'ORDER_TRANSACTION_STATE_OPEN',
  'STOREFRONT_URL',
  'SW_ACCESS_KEY',
  'SW_CONTEXT_TOKEN',
]);

function fail(reason) {
  console.log(`== validate-bundle: REFUSED — ${reason} ==`);
  process.exit(1);
}

function unfinishedBlockedReason(value) {
  const reason = String(value ?? '');
  return /\b(?:not yet|future attempt|has not been|have not been|still lacks?|still missing|missing step|needs? to be (?:rewritten|implemented|created|attached|seeded|added)|todo)\b/i.test(reason);
}

function entityPayload(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.payload)) return value.payload;
  return [];
}

function entityRows(data, entityName) {
  const rows = [...entityPayload(data?.[entityName])];
  if (!data || typeof data !== 'object') return rows;

  for (const value of Object.values(data)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (value.entity === entityName) rows.push(...entityPayload(value));
  }

  return rows;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

function hostilePlaywrightSpecReason(source) {
  const executable = stripComments(source);
  const imports = [
    ...executable.matchAll(/^\s*import\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"];?/gm),
    ...executable.matchAll(/^\s*import\s+['"]([^'"]+)['"];?/gm),
  ].map((match) => match[1]);
  const requires = [...executable.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1]);

  const disallowedImport = [...imports, ...requires]
    .find((specifier) => specifier !== '@playwright/test');
  if (disallowedImport) {
    return `Playwright spec imports '${disallowedImport}'; generated specs may only import @playwright/test. Video helpers are allowed only in REPRO_VIDEO_ONLY blocks and are stripped before verdict execution`;
  }
  if (/\bimport\s*\(/.test(executable)) {
    return 'Playwright spec uses dynamic import(); generated specs must be static Playwright tests with no runtime module loading';
  }
  if (/\b(?:child_process|node:child_process)\b/.test(executable)) {
    return 'Playwright spec references child_process; generated specs must not execute shell commands';
  }
  if (/\bprocess\.env\b/.test(executable)) {
    return 'Playwright spec reads process.env; generated specs must use Playwright baseURL/storage from the harness and fixture placeholders from seeding only';
  }
  if (/\b(?:eval|Function)\s*\(/.test(executable)) {
    return 'Playwright spec uses eval/Function; generated specs must not execute generated code';
  }
  if (/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|mkdir(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|rmdir(?:Sync)?|openSync)\s*\(/.test(executable)) {
    return 'Playwright spec writes through Node filesystem APIs; generated specs may only create files through browser/filechooser flows or Playwright screenshots in the test output directory';
  }
  const remoteUrl = executable.match(/https?:\/\/(?!127\.0\.0\.1(?::|\/|['"`])|localhost(?::|\/|['"`])|host\.docker\.internal(?::|\/|['"`]))[^\s'"`)]+/i)?.[0];
  if (remoteUrl) {
    return `Playwright spec references non-local network URL '${remoteUrl}'; generated specs may only drive the provisioned local Shopware instance`;
  }
  if (/\b[A-Za-z_$][\w$]*\.goto\s*\(\s*['"`]https?:\/\/(?:127\.0\.0\.1|localhost|host\.docker\.internal)(?::\d+)?\//.test(executable)) {
    return 'Playwright spec hardcodes a local absolute navigation URL; generated specs must use relative page.goto() paths so the harness baseURL controls sandbox and host verification URLs';
  }

  return null;
}

function selectedVariantIssue(text) {
  return /\b(selected|specific|assigned|preselected)\b/i.test(text)
    && /\b(variant|option|property|configuration|configurator|cms product slider|product slider)\b/i.test(text)
    && /\b(displayed|visible|rendered|shown|appears?)\b/i.test(text);
}

function cmsProductSliderVariantIssue(text) {
  return selectedVariantIssue(text) && /\b(cms product slider|product slider)\b/i.test(text);
}

function wishlistIssue(text) {
  return /\bwishlist\b/i.test(text);
}

function wishlistHtmlInjectionIssue(text) {
  return wishlistIssue(text)
    && /\b(?:html|injected?|injects?|full[- ]?(?:html|page|document)|404|error page|Oops|raw response)\b/i.test(text);
}

function cartOffcanvasIssue(text) {
  if (/\b(admin|administration|sidebar|menu)\b/i.test(text)
    && !/\b(add to (shopping )?cart|shopping cart|checkout|wishlist|cart)\b/i.test(text)) {
    return false;
  }

  return /\b(add to (shopping )?cart|shopping cart|off[- ]?canvas)\b/i.test(text)
    && /\b(click|opens?|shown|visible|rendered|appears?|add(ed)?|wishlist|product card)\b/i.test(text);
}

function storefrontAccountFormIssue(text) {
  return /\b(storefront|customer|account|login|wishlist|register|registration)\b/i.test(text)
    && /\b(login|log in|register|registration|customer|wishlist|account)\b/i.test(text);
}

function usesBrittleStorefrontAccountLabelLocator(source) {
  return /\bgetByLabel\s*\(\s*(?:\/|\{|\[|'|")[^)\n]*(?:your\s+)?(?:email address|password)[^)\n]*\)/i.test(source);
}

function usesUnscopedStorefrontAccountLoginInput(source) {
  if (!/\/account\/login/.test(source)) return false;

  return /(?:^|[^\w.])(?:page|secondTab|loginPage)\.locator\s*\(\s*['"`]input\[name=["'](?:email|password)["']\]['"`]\s*\)(?:\s*\.first\s*\(\s*\))?[\s\S]{0,180}\.(?:fill|waitFor)\s*\(/s.test(source)
    || /(?:^|[^\w.])(?:page|secondTab|loginPage)\.locator\s*\(\s*['"`]input\[type=["'](?:email|password)["']\][^'"`]*['"`]\s*\)(?:\s*\.first\s*\(\s*\))?[\s\S]{0,180}\.(?:fill|waitFor)\s*\(/s.test(source);
}

function usesBrittleStorefrontAuthChromeProof(source) {
  if (!/\/account\/login/.test(source)) return false;

  const loginSubmit = source.search(/(?:form\[action\*=["']\/account\/login["']\][^'"`]*button|button\[type=["']submit["']|getByRole\s*\(\s*['"]button['"][\s\S]{0,120}(?:Log in|Login|Sign in))[\s\S]{0,180}\.click\s*\(/i);
  if (loginSubmit === -1) return false;

  const afterSubmit = source.slice(loginSubmit);
  return /(?:account-menu-dropdown|account-menu|\/account\/logout|account\/logout|logout|Log out)[\s\S]{0,260}\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]/i.test(afterSubmit)
    && !/(?:\.goto\s*\([^)]*\/(?:wishlist\/list|account\/(?:profile|overview|home)|checkout\/confirm)\b|waitForURL\s*\([^)]*\/account\/|waitForResponse\s*\([^)]*\/(?:wishlist\/list|account\/(?:profile|overview|home)|checkout\/confirm)\b)/i.test(afterSubmit);
}

function hasEnabledWishlistConfig(data) {
  return entityRows(data, 'system_config').some((row) => (
    row?.configurationKey === 'core.cart.wishlistEnabled'
      && (row.configurationValue === true || row.configurationValue === 1 || row.configurationValue === 'true')
  ));
}

function productHasCategory(data, product) {
  if (entityPayload(product?.categories).length > 0) return true;
  return entityRows(data, 'product_category').some((row) => String(row?.productId ?? '') === String(product?.id ?? ''));
}

function productHasVisibility(data, product) {
  if (entityPayload(product?.visibilities).length > 0) return true;
  return entityRows(data, 'product_visibility').some((row) => String(row?.productId ?? '') === String(product?.id ?? ''));
}

function storefrontProductFixtureGaps(data) {
  return entityRows(data, 'product')
    .filter((product) => product?.id && product?.active !== false)
    .flatMap((product) => {
      const gaps = [];
      if (!productHasCategory(data, product)) gaps.push(`${product.id}: missing category assignment`);
      if (!productHasVisibility(data, product)) gaps.push(`${product.id}: missing sales-channel visibility`);
      return gaps;
    });
}

function usesSearchRouteForSeededProductSetup(source, data, text) {
  if (/\b(search|search result|search page|search ranking|search term|Elasticsearch|OpenSearch)\b/i.test(text)) {
    return false;
  }
  if (!/\.goto\s*\([^)]*\/search\?search=/i.test(source)) return false;

  const productTerms = entityRows(data, 'product')
    .flatMap((product) => [product?.name, product?.productNumber])
    .filter((term) => typeof term === 'string' && term.trim().length >= 3);

  return productTerms.length === 0 || productTerms.some((term) => source.includes(term));
}

function collectControlledTerms(value, terms = new Set(), key = '') {
  if (Array.isArray(value)) {
    for (const item of value) collectControlledTerms(item, terms, key);
    return terms;
  }
  if (!value || typeof value !== 'object') return terms;

  for (const [childKey, childValue] of Object.entries(value)) {
    if (typeof childValue === 'string') {
      if (/(^|\.)(name|title|label|productNumber|fileName|url)$/i.test(childKey) || /(^|\.)(name|title|label|productNumber|fileName|url)$/i.test(key)) {
        terms.add(childValue);
      } else if (/^value$/i.test(childKey) && /\b(content|text|description|headline)\b/i.test(key)) {
        const text = childValue
          .replace(/<[^>]*>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) terms.add(text);
        for (const segment of cmsStaticTextSegments(childValue)) terms.add(segment);
      }
    } else {
      collectControlledTerms(childValue, terms, childKey);
    }
  }
  return terms;
}

function cmsStaticTextSegments(html) {
  return [...String(html).matchAll(/<[^/!][^>]*>([^<]+)<\/[^>]+>/g)]
    .map((match) => match[1].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function collectCmsStaticTextSegmentGroups(value, groups = [], key = '') {
  if (Array.isArray(value)) {
    for (const item of value) collectCmsStaticTextSegmentGroups(item, groups, key);
    return groups;
  }
  if (!value || typeof value !== 'object') return groups;

  for (const [childKey, childValue] of Object.entries(value)) {
    if (typeof childValue === 'string' && /^value$/i.test(childKey) && /\b(content|text|description|headline)\b/i.test(key)) {
      const segments = cmsStaticTextSegments(childValue);
      if (segments.length > 1) groups.push(segments);
    } else {
      collectCmsStaticTextSegmentGroups(childValue, groups, childKey);
    }
  }

  return groups;
}

function collectCustomFieldTerms(value, terms = new Set(), insideCustomFields = false) {
  if (Array.isArray(value)) {
    for (const item of value) collectCustomFieldTerms(item, terms, insideCustomFields);
    return terms;
  }
  if (!value || typeof value !== 'object') return terms;

  for (const [childKey, childValue] of Object.entries(value)) {
    const nextInsideCustomFields = insideCustomFields || childKey === 'customFields';
    if (nextInsideCustomFields && typeof childValue === 'string') {
      terms.add(childValue);
    } else {
      collectCustomFieldTerms(childValue, terms, nextInsideCustomFields);
    }
  }
  return terms;
}

function collectVariantTerms(data) {
  const terms = new Set();
  const products = entityRows(data, 'product');
  const optionNamesById = new Map();

  for (const group of entityRows(data, 'property_group')) {
    for (const option of entityPayload(group.options)) {
      if (option?.id && option?.name) optionNamesById.set(String(option.id), String(option.name));
    }
  }

  for (const product of products) {
    if (!product?.parentId) continue;
    if (product.productNumber) terms.add(String(product.productNumber));
    if (product.name) terms.add(String(product.name));
    for (const option of entityPayload(product.options)) {
      const name = optionNamesById.get(String(option?.id ?? ''));
      if (name) terms.add(name);
      if (option?.name) terms.add(String(option.name));
    }
  }

  return [...terms]
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .filter((term) => !/^slider variant product$/i.test(term));
}

function childVariantNamesContainingOptionTerms(data) {
  const optionNames = [];
  for (const group of entityRows(data, 'property_group')) {
    for (const option of entityPayload(group.options)) {
      if (option?.name) optionNames.push(String(option.name).trim());
    }
  }

  return entityRows(data, 'product')
    .filter((product) => product?.parentId && product?.name)
    .filter((product) => optionNames.some((name) => name.length >= 3 && String(product.name).toLowerCase().includes(name.toLowerCase())))
    .map((product) => String(product.name));
}

function normalizeTerms(terms) {
  const generic = /^(home|dashboard|demo ?store|default|standard|main|repro|test|true|false|null|0|1)$/i;
  return [...terms]
    .map((term) => String(term).trim())
    .filter((term) => term.length >= 3)
    .filter((term) => !generic.test(term));
}

function adminUiPlan() {
  const layer = String(plan.layer ?? '');
  return executor === 'playwright'
    && (layer.includes('admin') || plan.build_profile?.admin_build === true);
}

function playwrightUsesAdminRoute(source) {
  return /\bpage\.goto\s*\(\s*['"`]\/admin(?:#\/sw\/|\/|\b|['"`])/s.test(source)
    || /['"`]\/admin#\/sw\//.test(source);
}

function adminBootstrapIssue(text) {
  return /\b(admin|administration|login|dashboard)\b/i.test(text)
    && /\b(loads?|loading|bootstrap|startup|start[- ]?up|login|authentication|slow|network|timeout|blank|stuck)\b/i.test(text);
}

function adminLoginFlowIssue(text) {
  return /\b(admin|administration)\b/i.test(text)
    && /\b(login|log in|authentication|sign[- ]?in)\b/i.test(text);
}

function hasAdminLoginFlow(source) {
  const loginRoute = /\/admin#\/(?:sw\/)?login\b|\/admin#\/login\b/.test(source);
  const fillsCredentials = /\.(?:fill|type)\s*\(\s*['"`](?:admin|shopware)['"`]\s*\)/i.test(source)
    || /(?:Username|Password|sw-field--username|sw-field--password|input\[type=["']password["']\])[\s\S]{0,300}\.(?:fill|type)\s*\(/i.test(source);

  return loginRoute && fillsCredentials;
}

function adminMobileNavigationIssue(text) {
  return /\b(admin|administration|sidebar|off[- ]?canvas|menu|navigation)\b/i.test(text)
    && /\b(mobile|small viewport|narrow|sidebar|off[- ]?canvas|hamburger)\b/i.test(text);
}

function adminMobileRouteNavigationIssue(text) {
  return adminMobileNavigationIssue(text)
    && /\b(click(?:ing)?|select(?:ing)?|open(?:ing)?|navigate|navigation|route|module|menu item|link)\b/i.test(text);
}

function adminPriceEditIssue(text) {
  return /\b(admin|administration|product|price|gross|net|decimal|trailing|edit|editing|field)\b/i.test(text)
    && /\b(price|gross|net|decimal|trailing zero|backspace|field)\b/i.test(text);
}

function adminMediaReplacementIssue(text) {
  return /\b(admin|administration|media|image|asset|file|upload|replace|replacement|gallery|teaser|cms)\b/i.test(text)
    && /\b(media|image|asset|file|upload|replace|replacement|gallery)\b/i.test(text)
    && /\b(replace|replacement)\b/i.test(text);
}

function syncSeedsMediaRows(data) {
  return entityRows(data, 'media').length > 0;
}

function mediaUploadSpecs(data) {
  return Array.isArray(data?._repro_media_uploads) ? data._repro_media_uploads : [];
}

function uploadedMediaIds(data) {
  return new Set(mediaUploadSpecs(data)
    .map((upload) => upload?.mediaId)
    .filter((id) => typeof id === 'string'));
}

function syncSeededMediaRowsMissingUploads(data) {
  const uploaded = uploadedMediaIds(data);
  return entityRows(data, 'media')
    .map((row) => row?.id)
    .filter((id) => typeof id === 'string' && !uploaded.has(id));
}

function seededMediaRowsWithWriteProtectedFileFields(data) {
  const writeProtectedFields = ['path', 'uploadedAt', 'fileSize', 'metaData', 'hasFile', 'url'];
  const bad = [];
  for (const row of entityRows(data, 'media')) {
    for (const field of writeProtectedFields) {
      if (Object.hasOwn(row ?? {}, field)) {
        bad.push(`${row?.id || row?.fileName || 'unknown'}.${field}`);
      }
    }
  }
  return bad;
}

function sourceNeedsFileBackedSeededMedia(source, data, issueKind) {
  if (entityRows(data, 'media').length === 0) return false;

  return issueKind === 'visual'
    || /\/admin#\/sw\/media|\/admin#\/sw\/cms|Media index|Media Library|media library|media tile|media item|media grid|image slot|CMS slot|file-backed|thumbnail|sw-media|upload|replace/i.test(source)
    || collectStaticCmsMediaValues(data).length > 0
    || collectFixtureFields(data, 'mediaId').length > 0;
}

function assumesSeededMediaVisibleInRootGrid(source, data) {
  if (entityRows(data, 'media').length === 0) return false;
  if (!/\/admin#\/sw\/media(?:\/index)?|\/admin#\/sw\/media\b/.test(source)) return false;
  if (!/locator\s*\(\s*`?\s*\[data-id=|locator\s*\(\s*['"`]\[data-id=/.test(source)) return false;

  return !/(?:Search current folder|\.sw-search-bar__input|getByRole\s*\(\s*['"]searchbox['"][\s\S]{0,240}\.(?:fill|type)|locator\s*\([^)]*(?:search|sw-search)[^)]*\)[\s\S]{0,240}\.(?:fill|type))/i.test(source);
}

function createsMediaUsageViaCmsEditorBeforeMediaFlow(source) {
  const cmsSetup = source.search(/\/admin#\/sw\/cms\/(?:index|detail)|\.sw-cms-el-config|sw-media-upload-v2[\s\S]{0,240}setInputFiles|setInputFiles[\s\S]{0,240}sw-media-upload-v2/i);
  const mediaFlow = source.search(/\/admin#\/sw\/media(?:\/index)?|\.sw-media-modal-replace|sw-media-context-item__replace-media-action|sw-media-replace__replace-media-action/i);
  if (cmsSetup === -1 || mediaFlow === -1 || cmsSetup > mediaFlow) return false;

  return /setInputFiles|filechooser|input\[type=["']file["']/.test(source)
    && /\.sw-cms-el-config|sw-media-upload-v2|Default product page Layout|Shopping Experiences/i.test(source);
}

function specUsesMediaLibraryReplaceFlow(source) {
  return /\/admin#\/sw\/media(?:\/index)?|replace media|getByRole\s*\([^)]*replace|filechooser|setInputFiles/i.test(source);
}

function productLayoutPreconditionForMediaReplacement(source) {
  return /\/sw\/product\/detail\/[^'"`]+\/layout/.test(source)
    && /PRECONDITION_NOT_FOUND:[^'"`\n]*(?:layout|CMS|teaser|assignment)/i.test(source);
}

function productMediaPreconditionForMediaReplacement(source) {
  return (/\/sw\/product\/detail\/[^'"`]+\/media/.test(source) || /\bsw-product-media-form\b/.test(source))
    && /PRECONDITION_NOT_FOUND:[^'"`\n]*(?:product|media|upload|cover|image)/i.test(source);
}

function cmsEditorTextClick(source) {
  const cmsSegments = [];
  const gotoMatches = [...source.matchAll(/\bpage\.goto\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)];
  for (const [index, match] of gotoMatches.entries()) {
    if (!/\/admin#\/sw\/cms\/detail\//.test(match[2])) continue;
    const start = match.index ?? 0;
    const next = gotoMatches[index + 1]?.index ?? source.length;
    cmsSegments.push(source.slice(start, next));
  }
  if (cmsSegments.length === 0) return false;

  return cmsSegments.some((segment) => {
    if (/getByText\s*\([^)]*\)\s*\.click\s*\(/s.test(segment)) return true;

    const textLocatorVariables = [...segment.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*getByText\s*\(/g)]
      .map((match) => match[1]);

    return textLocatorVariables.some((name) => new RegExp(`\\b${name}\\s*\\.\\s*click\\s*\\(`).test(segment));
  });
}

function usesCmsEditorSlotConfigForMediaReplacement(source) {
  if (!/\/admin#\/sw\/cms\/detail\//.test(source)) return false;
  if (!specUsesMediaLibraryReplaceFlow(source)) return false;

  return /(?:\b(?:sw-cms-slot__settings-action|sw-cms-slot__config-modal|cms image upload|CMS image upload|slotConfigModal)\b|\.sw-cms-el-config-image\b|\bsw-cms-el-config-image\b)/s.test(source);
}

function usesCmsCanvasSlotGateForMediaReplacement(source) {
  if (!/\/admin#\/sw\/cms\/detail\//.test(source)) return false;
  if (!specUsesMediaLibraryReplaceFlow(source)) return false;

  return /(?:data-cms-slot-id|\.sw-cms-el-image|\.sw-cms-slot|seeded image slot config|image slot config|slotCanvasTarget)/i.test(source)
    && /(?:PRECONDITION_NOT_FOUND:[^'"`\n]*)?(?:seeded image slot|slot config|cms image|CMS image|image slot|source media)/i.test(source);
}

function usesCmsMediaFilenameGateForMediaReplacement(source) {
  const cmsRoute = source.search(/\/admin#\/sw\/cms\/detail\//);
  if (cmsRoute === -1) return false;
  if (!specUsesMediaLibraryReplaceFlow(source)) return false;

  const mediaRoute = mediaLibraryNavigationOffset(source, source.slice(cmsRoute));
  const beforeMediaLibrary = mediaRoute === -1
    ? source.slice(cmsRoute)
    : source.slice(cmsRoute, cmsRoute + mediaRoute);

  return /getByText\s*\(\s*(?:originalFileName|mediaFileName|fileName|mediaName|new\s+RegExp\s*\(\s*(?:originalFileName|mediaFileName|fileName|mediaName))/s.test(beforeMediaLibrary)
    && /(?:PRECONDITION_NOT_FOUND:[^'"`\n]*)?(?:teaser|slot|cms|CMS)[^'"`\n]*(?:seeded media|media|filename|file name|reference)/i.test(beforeMediaLibrary);
}

function createsOriginalMediaOutsideMediaLibraryForReplacement(source) {
  const mediaRoute = mediaLibraryNavigationOffset(source, source);
  const beforeMediaLibrary = mediaRoute === -1 ? source : source.slice(0, mediaRoute);

  return /\/admin#\/sw\/(?:cms\/detail|product\/detail)\//.test(beforeMediaLibrary)
    && /\.(?:setInputFiles|setFiles)\s*\(/.test(beforeMediaLibrary);
}

function usesUnscopedMediaSearchbox(source) {
  return /\bpage\s*\.getByRole\s*\(\s*['"]searchbox['"]/s.test(source);
}

function usesTagQualifiedMediaQuickactionReplace(source) {
  return /locator\s*\(\s*['"`](?:button|a|div|span)\.quickaction--replace['"`]\s*\)/.test(source);
}

function usesMisScopedMediaSearchInput(source) {
  return /(?:main|\.sw-media-library__content|\.sw-media-index__content)\s+input\[[^\]]*(?:placeholder|aria-label|name)=['"]Search current folder\.\.\.['"][^\]]*\]/i.test(source);
}

function usesMediaQuickinfoHeadingGate(source) {
  if (!/\/admin#\/sw\/media(?:\/index)?/.test(source)) return false;

  return /getByRole\s*\(\s*['"]heading['"]\s*,\s*\{[^}]*name\s*:\s*(?:mediaName|mediaFileName|mediaMarker|new\s+RegExp\s*\(\s*(?:mediaName|mediaFileName|mediaMarker)|\/[^/]*(?:media|teaser)[^/]*\/)/s.test(source);
}

function rawAdminApiCallInPlaywright(source) {
  const adminApiPath = '(?:\\/api\\/|api\\/|\\/api_|api_|_action\\/sync|\\/api\\/search)';

  return new RegExp('\\bfetch\\s*\\(\\s*[\'"`][^\'"`]{0,120}' + adminApiPath, 's').test(source)
    || new RegExp('\\bpage\\.request\\.(?:get|post|put|patch|delete)\\s*\\(\\s*[\'"`][^\'"`]{0,180}' + adminApiPath, 's').test(source)
    || /\bpage\.evaluate\s*\([\s\S]{0,2000}\bfetch\s*\(/s.test(source)
    || new RegExp('\\bpage\\.request\\.(?:get|post|put|patch|delete)\\s*\\([\\s\\S]{0,260}' + adminApiPath, 's').test(source)
    || /\b(?:apiPath|path|url)\s*:\s*path\b[\s\S]{0,1000}\bfetch\s*\(\s*(?:apiPath|path|url)\b/s.test(source);
}

function hasGuestWishlistAddWithoutStateProof(source) {
  const clickOffsets = [];
  for (const match of source.matchAll(/(?:Add to wishlist|add to wishlist)[\s\S]{0,900}?\.click\s*\(/gi)) {
    clickOffsets.push(match.index + match[0].length);
  }
  for (const match of source.matchAll(/\b(?:wishlistToggle|wishlistButton|wishlistBtn|addToWishlist|addWishlist|wishlistControl)\s*\.click\s*\(/g)) {
    clickOffsets.push(match.index + match[0].length);
  }
  for (const match of source.matchAll(/locator\s*\([^)]*(?:product-wishlist|wishlist-btn|add-to-wishlist)[^)]*\)[\s\S]{0,500}?\.click\s*\(/gi)) {
    clickOffsets.push(match.index + match[0].length);
  }

  return clickOffsets.some((offset) => {
    const afterClick = source.slice(offset);
    const wishlistGotoMatch = afterClick.match(/\.goto\s*\([^)]*['"`][^'"`]*\/wishlist\b/i);
    if (!wishlistGotoMatch) return false;

    const setupProof = afterClick.slice(0, wishlistGotoMatch.index);
    return !/(?:\bwaitForFunction\b|localStorage|sessionStorage|waitForResponse[\s\S]{0,240}(?:wishlist|guest-pagelet)|(?:guest-pagelet|data-guest-wishlist-page))/i.test(setupProof);
  });
}

function usesWishlistAddSetup(source) {
  return /(?:Add to wishlist|add to wishlist)[\s\S]{0,900}?\.click\s*\(/i.test(source)
    || /\b(?:wishlistToggle|wishlistButton|wishlistBtn|addToWishlist|addWishlist|wishlistControl)\s*\.click\s*\(/.test(source)
    || /locator\s*\([^)]*(?:data-add-to-wishlist|add-to-wishlist)[^)]*\)[\s\S]{0,500}?\.click\s*\(/i.test(source);
}

function usesContextCookiesForGuestWishlist(source) {
  return /(?:page\.)?context\s*\(\s*\)\s*\.addCookies\s*\([\s\S]{0,800}(?:wishlist-enabled|cookie-preference)/s.test(source)
    || /\bcontext\.addCookies\s*\([\s\S]{0,800}(?:wishlist-enabled|cookie-preference)/s.test(source);
}

function requiresWishlistCookieBeforeWishlistAction(source) {
  const cookieCheck = source.search(/(?:document\.cookie|CookieStorageHelper)[\s\S]{0,220}wishlist-enabled|wishlist-enabled[\s\S]{0,220}(?:document\.cookie|CookieStorageHelper)/);
  if (cookieCheck === -1) return false;

  const wishlistAction = source.search(/(?:Add to wishlist|add to wishlist|wishlistToggle|wishlistButton|wishlistBtn|addToWishlist|addWishlist|data-add-to-wishlist)[\s\S]{0,700}\.click\s*\(/i);
  return wishlistAction !== -1 && cookieCheck < wishlistAction;
}

function requiresGenericCookieBannerForGuestWishlist(source) {
  const wishlistAction = source.search(/(?:Add to wishlist|add to wishlist|wishlistToggle|wishlistButton|wishlistBtn|addToWishlist|addWishlist|data-add-to-wishlist|product-wishlist)[\s\S]{0,700}\.click\s*\(/i);
  if (wishlistAction === -1) return false;

  const afterWishlistAction = source.slice(wishlistAction);
  const requiredCookieBanner = /(?:requireVisible|waitFor|waitForSelector)[\s\S]{0,500}(?:Accept cookie|Accept cookies|Configure|Only technically required|Cookie preferences|cookie acceptance dialog|cookie banner|cookie consent)/i.test(afterWishlistAction);
  if (!requiredCookieBanner) return false;

  const precedingSetup = source.slice(0, wishlistAction);
  return !/document\.cookie[\s\S]{0,220}wishlist-enabled|wishlist-enabled[\s\S]{0,220}document\.cookie|localStorage\.setItem[\s\S]{0,220}wishlist-/s.test(precedingSetup);
}

function requiresGenericCookieBannerBeforeWishlistStateSetup(source) {
  const stateSetup = source.search(/(?:document\.cookie[\s\S]{0,220}wishlist-enabled|wishlist-enabled[\s\S]{0,220}document\.cookie|localStorage\.setItem[\s\S]{0,220}wishlist-)/);
  if (stateSetup === -1) return false;

  const beforeStateSetup = source.slice(0, stateSetup);
  return /(?:Accept all|Accept cookie|Accept cookies|Configure|Only technically required|Cookie preferences|cookie acceptance dialog|cookie banner|cookie consent)[\s\S]{0,500}(?:waitFor|waitForSelector)/i.test(beforeStateSetup)
    || /(?:waitFor|waitForSelector)[\s\S]{0,500}(?:Accept all|Accept cookie|Accept cookies|Configure|Only technically required|Cookie preferences|cookie acceptance dialog|cookie banner|cookie consent)/i.test(beforeStateSetup);
}

function usesGenericWishlistRemoveSelector(source) {
  const genericSelector = /(?:form\.product-wishlist-form(?:\s+button(?:\[type=["']submit["']\])?)?|\.wishlist-listing-col\s+button)/.test(source);
  if (!genericSelector) return false;

  return !/(?:product-wishlist-btn-remove|getByRole\s*\(\s*['"]button['"][\s\S]{0,160}\bremove\b|aria-label[\s\S]{0,120}\bremove\b|title[\s\S]{0,120}\bremove\b)/i.test(source);
}

function waitsForVisibleWishlistFormContainer(source) {
  if (/form\.product-wishlist-form[\s\S]{0,260}\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]/s.test(source)) {
    return true;
  }

  const aliases = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*form\.product-wishlist-form[^;\n]*/g)]
    .map((match) => match[1]);

  const hasVisibleWaitHelper = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{[\s\S]{0,500}\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]/s.exec(source)?.[1]
    || /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{[\s\S]{0,500}\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]/s.exec(source)?.[1];

  return aliases.some((alias) => (
    new RegExp(`\\b${alias}\\s*\\.\\s*waitFor\\s*\\(\\s*\\{[^}]*state\\s*:\\s*['"]visible['"]`, 's').test(source)
    || (hasVisibleWaitHelper && new RegExp(`\\b${hasVisibleWaitHelper}\\s*\\(\\s*${alias}\\b`).test(source))
  ));
}

function lacksWishlistHtmlInjectionAssertion(source) {
  const finalAssertionOffset = source.search(/\bawait\s+expect\s*\(/);
  const assertion = finalAssertionOffset === -1 ? '' : source.slice(finalAssertionOffset);

  const checksInjectedErrorText = /not\s*\.\s*toContainText\s*\([\s\S]{0,240}(?:Oops|404|error|html|doctype|<html|full[- ]?page|raw)/i.test(assertion)
    || /not\s*\.\s*toHaveText\s*\([\s\S]{0,240}(?:Oops|404|error|html|doctype|<html|full[- ]?page|raw)/i.test(assertion);
  const checksInjectedDocumentShape = /:has\s*\(\s*(?:html|head|body|\.error-code|\.error-code-main)/i.test(assertion)
    || /locator\s*\([\s\S]{0,160}(?:html|head|body|\.error-code|\.error-code-main)[\s\S]{0,160}\)[\s\S]{0,160}(?:toBeHidden|not\s*\.\s*toBeVisible|toHaveCount\s*\(\s*0)/i.test(assertion);

  return !checksInjectedErrorText && !checksInjectedDocumentShape;
}

function usesSeparateBrowserContextForCrossTabSession(source, text) {
  const crossTabIssue = /\b(?:tab|window|same browser|same session|cross[- ]?tab|another tab|second tab|stale tab)\b/i.test(text)
    && /\b(?:login|log[ -]?in|logs? in|logged in|account|session|customer|cookie)\b/i.test(text);
  if (!crossTabIssue) return false;

  return /\bbrowser\.newPage\s*\(/.test(source) || /\bbrowser\.newContext\s*\(/.test(source);
}

function collectIssueTerms(text) {
  const terms = new Set();
  for (const match of text.matchAll(/[`"“”']([^`"“”']{4,80})[`"“”']/g)) terms.add(match[1]);
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]+(?:[- ][A-Za-z0-9]+){1,5}\b/g)) terms.add(match[0]);
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]{3,}\b/g)) terms.add(match[0]);
  for (const match of text.matchAll(/\b(?:sw-[a-z0-9-]+|[a-z0-9]+(?:-[a-z0-9]+){1,5})\b/gi)) terms.add(match[0]);
  return normalizeTerms(terms);
}

function hasTargetedAdminPrecondition(source) {
  const preconditions = preconditionSnippet(source);
  const terms = [
    ...normalizeTerms(collectControlledTerms(fixtures)),
    ...collectIssueTerms(issue),
  ];
  if (terms.some((term) => preconditions.toLowerCase().includes(term.toLowerCase()))) return true;

  return /\b(getByRole|getByLabel|getByText|getByPlaceholder)\s*\([^)]*\{\s*name\s*:\s*(\/|\{|\[|'|")/s.test(preconditions)
    && !/\b(dashboard|home|navigation|toolbar|main navigation|administration shell|admin shell)\b/i.test(preconditions);
}

function hasAdminBootstrapPrecondition(source) {
  const preconditions = preconditionSnippet(source);
  return /\b(progressbar|banner|login|administration|admin shell|main|document)\b/i.test(preconditions);
}

function hasUnrelatedAdminModulePrecondition(source, text) {
  const preconditions = preconditionSnippet(source);
  const modules = [
    'Catalogues',
    'Catalogs',
    'Products',
    'Orders',
    'Customers',
    'Content',
    'Marketing',
    'Extensions',
    'Settings',
  ];

  return modules.some((module) => {
    const used = new RegExp(`\\b${module}\\b`, 'i').test(preconditions);
    const reported = new RegExp(`\\b${module}\\b`, 'i').test(text);
    return used && !reported;
  });
}

function hasGenericAdminChromeFailure(source, text) {
  const preconditions = preconditionSnippet(source);
  const genericChrome = /\bPRECONDITION_NOT_FOUND:[^\n]*(?:back|save|dashboard|toolbar|admin shell|administration shell)\b/i.test(preconditions);
  const reported = /\b(back|save|dashboard|toolbar|admin shell|administration shell)\b/i.test(text);
  return genericChrome && !reported;
}

function hasBootstrapUsabilityAsPrecondition(source) {
  const preconditions = preconditionSnippet(source);
  return /\bPRECONDITION_NOT_FOUND:[^\n]*(?:admin(?:istration)? shell|shell|main|banner|dashboard|usable|progress|progressbar|spinner|loading indicator|did not become visible|did not appear|did not load|within \d+\s*seconds?)\b/i.test(preconditions);
}

function parseSimpleThroughputExpression(expression) {
  const normalized = String(expression).replace(/\s+/g, '');
  const firstNumber = normalized.match(/^\d+(?:\.\d+)?/);
  if (!firstNumber) return null;

  let value = Number(firstNumber[0]);
  const factors = normalized.match(/\*1024/g) ?? [];
  for (const _factor of factors) value *= 1024;
  if (/\/8(?:\D|$)/.test(normalized)) value /= 8;
  return Number.isFinite(value) ? value : null;
}

function slow3gIssue(text) {
  return /\b(slow|throttl|3g|network)\b/i.test(text) && /\b3g\b/i.test(text);
}

function usesTooFastNetworkProfileForSlow3g(source) {
  if (!/Network\.emulateNetworkConditions/s.test(source)) return false;

  const download = source.match(/downloadThroughput\s*:\s*([^,\n}]+)/);
  const latency = source.match(/latency\s*:\s*(\d+(?:\.\d+)?)/);
  const downloadBytesPerSecond = download ? parseSimpleThroughputExpression(download[1]) : null;
  const latencyMs = latency ? Number(latency[1]) : null;

  return (downloadBytesPerSecond !== null && downloadBytesPerSecond > (600 * 1024 / 8))
    || (latencyMs !== null && latencyMs < 300);
}

function usesTooLongBootstrapAssertionTimeout(source) {
  const timeoutMatches = [...source.matchAll(/expect\s*\([\s\S]{0,160}?\)\s*\.\s*to(?:BeVisible|HaveURL|BeInViewport|ContainText|HaveText)\s*\(\s*(?:[^,)]*,\s*)?\{[^}]*timeout\s*:\s*([0-9_]+)/g)];
  return timeoutMatches.some((match) => Number(match[1].replace(/_/g, '')) > 35_000);
}

function hasBootstrapElapsedTimeAssertion(source) {
  const elapsedVariableNames = new Set(
    [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Date\.now|performance\.now)\s*\(\s*\)\s*-\s*[A-Za-z_$][\w$]*/g)]
      .map((match) => match[1])
      .filter((name) => /(?:elapsed|duration|took|budget|time|ms)/i.test(name)),
  );
  const elapsedVariableAssertion = [...elapsedVariableNames]
    .some((name) => new RegExp(`expect\\s*\\(\\s*${name}\\s*\\)\\s*\\.\\s*(?:toBeLessThan(?:OrEqual)?|toBeGreaterThan(?:OrEqual)?|toBe)\\s*\\(`, 's').test(source));

  const explicitElapsedAssertion = /\b(?:Date\.now|performance\.now)\s*\(/s.test(source)
    && /\b(?:elapsed|duration|took|startedAt|startTime)\b/i.test(source)
    && /expect\s*\([^)]*(?:elapsed|duration|took|Date\.now|performance\.now)[^)]*\)\s*\.\s*(?:toBeLessThan(?:OrEqual)?|toBeGreaterThan(?:OrEqual)?|toBe)\s*\(/is.test(source);

  const boundedFlowAssertion = /await\s+expect\s*\(\s*async\s*\(\s*\)\s*=>\s*\{[\s\S]{0,3000}(?:page\.goto|\.click\s*\(|\.fill\s*\(|waitForURL)[\s\S]{0,3000}(?:\/admin#\/sw\/login|Username|Password|login|dashboard|sw-admin|admin shell)[\s\S]{0,3000}\}\s*\)\s*\.toPass\s*\(\s*\{[^}]*timeout\s*:\s*(?:30_?000|[12]\d_?000)\b/is.test(source);
  const pollBudgetAssertion = /await\s+expect\s*\.\s*poll\s*\(\s*async\s*\(\s*\)\s*=>\s*\{[\s\S]{0,1800}(?:Date\.now|performance\.now)\s*\(\s*\)[\s\S]{0,800}(?:startedAt|startTime|withinBudget|elapsed|duration)[\s\S]{0,800}\}\s*,\s*\{[^}]*timeout\s*:\s*(?:30_?000|[12]\d_?000)\b[\s\S]{0,1200}\)\s*\.toEqual\s*\([\s\S]{0,500}(?:withinBudget\s*:\s*true|shellVisible\s*:\s*true)/is.test(source);

  return explicitElapsedAssertion || elapsedVariableAssertion || boundedFlowAssertion || pollBudgetAssertion;
}

function hasTimedPrimitiveAssertion(source) {
  return /expect\s*\.\s*poll\s*\(/s.test(source)
    || /expect\s*\(\s*[A-Za-z_$][\w$]*(?:Ms|MS|Seconds|Millis|Elapsed|elapsed|Duration|duration)?\s*\)\s*\.\s*(?:toBeLessThan(?:OrEqual)?|toBeGreaterThan(?:OrEqual)?|toBe)\s*\(/s.test(source);
}

function hasFailureScreenshotHook(source) {
  return /test\.afterEach\s*\([\s\S]{0,2000}testInfo\.status\s*!==\s*testInfo\.expectedStatus[\s\S]{0,2000}page\.screenshot\s*\([\s\S]{0,800}testInfo\.outputPath\s*\(/s.test(source);
}

function hasBootstrapShellUsabilityAssertion(source) {
  const shellTarget = /(?:\.sw-admin-menu|\.sw-page|\.sw-dashboard-index|sw-admin-menu|dashboard|main navigation|administration shell|admin shell|getByRole\s*\(\s*['"]main['"]|getByRole\s*\(\s*['"]navigation['"])/i;
  const visibleGate = /(?:expect\s*\([\s\S]{0,500}(?:\.sw-admin-menu|\.sw-page|\.sw-dashboard-index|sw-admin-menu|dashboard|main navigation|administration shell|admin shell|getByRole\s*\(\s*['"]main['"]|getByRole\s*\(\s*['"]navigation['"])[\s\S]{0,500}\)\s*\.\s*to(?:BeVisible|BeInViewport)|(?:\.sw-admin-menu|\.sw-page|\.sw-dashboard-index|getByRole\s*\(\s*['"]main['"]|getByRole\s*\(\s*['"]navigation['"])[\s\S]{0,300}\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"])/is;
  const pollVisibleGate = /expect\s*\.\s*poll\s*\(\s*async\s*\(\s*\)\s*=>\s*\{[\s\S]{0,1600}(?:\.sw-admin-menu|\.sw-page|\.sw-dashboard-index|adminShellMarker)[\s\S]{0,500}\.isVisible\s*\(\s*\)[\s\S]{0,1200}\)\s*\.toEqual\s*\([\s\S]{0,500}shellVisible\s*:\s*true/is;

  return shellTarget.test(source) && (visibleGate.test(source) || pollVisibleGate.test(source));
}

function hasUnboundedClick(source) {
  return [...source.matchAll(/\.click\s*\(([^)]*)\)/g)]
    .some((match) => {
      const args = match[1].trim();
      return !/\btimeout\s*:/.test(args);
    });
}

function hasImmediateCountPrecondition(source) {
  return /if\s*\(\s*\(?\s*await\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*\s*\([^)]*\))*\.count\s*\(\s*\)\s*\)?\s*(?:===|==|<=)\s*0\s*\)\s*\{?\s*throw\s+new\s+Error\s*\(\s*['"`]PRECONDITION_NOT_FOUND:/s.test(source)
    || /if\s*\(\s*\(?\s*await\s+page\.(?:locator|getByRole|getByText|getByLabel|getByPlaceholder)[\s\S]{0,500}\.count\s*\(\s*\)\s*\)?\s*(?:===|==|<=)\s*0\s*\)\s*\{?\s*throw\s+new\s+Error\s*\(\s*['"`]PRECONDITION_NOT_FOUND:/s.test(source);
}

function hasUnboundedFileChooserWait(source) {
  return [...source.matchAll(/\.waitForEvent\s*\(\s*['"]filechooser['"]\s*(?:,([^)]*))?\)/g)]
    .some((match) => !/\btimeout\s*:/.test(match[1] ?? ''));
}

function waitsForVisibleFileInput(source) {
  if (/locator\s*\([^)]*(?:input\s*\[\s*type\s*=\s*["']?file|file-input)[^)]*\)\s*(?:\.\w+\s*\([^)]*\)\s*)*\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]/i.test(source)) {
    return true;
  }

  const fileInputLocators = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*locator\s*\([^)]*(?:input\s*\[\s*type\s*=\s*["']?file|file-input)[^)]*\)/gi)]
    .map((match) => match[1]);
  const visibleWaitHelpers = [...source.matchAll(/\b(?:async\s+function|function)\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{[^}]*\b\2\s*\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]/g)]
    .map((match) => match[1]);

  return fileInputLocators.some((name) => (
    new RegExp(`\\b${name}\\s*\\.\\s*waitFor\\s*\\(\\s*\\{[^}]*state\\s*:\\s*['"]visible['"]`, 's').test(source)
      || visibleWaitHelpers.some((helper) => new RegExp(`\\b${helper}\\s*\\(\\s*${name}\\b`, 's').test(source))
  ));
}

function awaitedExpectCount(source) {
  return [...source.matchAll(/\bawait\s+expect\s*(?:\.\s*poll)?\s*\(/g)].length;
}

function passesLocatorToPageWaitForFunction(source) {
  const locatorVariables = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\b(?:page|[A-Za-z_$][\w$]*)\s*\.locator\s*\(/g)]
    .map((match) => match[1]);

  return /\.waitForFunction\s*\([\s\S]{0,500},\s*locator\b/s.test(source)
    || locatorVariables.some((name) => new RegExp(`\\.waitForFunction\\s*\\([\\s\\S]{0,500},\\s*${name}\\b`, 's').test(source));
}

function usesAdminMobileModuleHeadingGate(source) {
  const moduleNames = /(?:Categories|Products|Orders|Customers|Media|Content|Catalogues|Dashboard|Settings|Landing pages)/i;
  return [...source.matchAll(/getByRole\s*\(\s*['"]heading['"]\s*,\s*\{[^}]*name\s*:\s*([^}\n]+)\}/g)]
    .some((match) => moduleNames.test(match[1]));
}

function usesAdminMobileDestinationContentGate(source) {
  const preconditions = preconditionSnippet(source);
  return /waitForURL\s*\([\s\S]{0,900}\bgetByText\s*\([\s\S]{0,260}\.(?:waitFor|toBeVisible|toHaveText|toContainText)\s*\(/s.test(preconditions)
    && /PRECONDITION_NOT_FOUND:[^'"`\n]*(?:page|route|module|title|listing|empty state|visible after navigation|loaded|content)/i.test(preconditions);
}

function directlyFillsAdminLoginFields(source) {
  return /\bgetByLabel\s*\(\s*(?:['"`]Username['"`]|\/username\/i)\s*\)\s*\.fill\s*\(/i.test(source)
    || /\bgetByLabel\s*\(\s*(?:['"`]Password['"`]|\/password\/i)\s*\)\s*\.fill\s*\(/i.test(source);
}

function usesRawAdminMobileToggleSelector(source) {
  return /locator\s*\(\s*['"`]\.sw-search-bar__mobile-controls\s+\.sw-search-bar__button['"`]\s*\)(?!\s*\.first\s*\()/s.test(source);
}

function usesAdminMenuGroupAsLink(source) {
  const groupNames = /(?:Catalogues|Orders|Customers|Content|Marketing|Extensions)/i;
  return [...source.matchAll(/getByRole\s*\(\s*['"]link['"]\s*,\s*\{[^}]*name\s*:\s*([^}\n]+)\}/g)]
    .some((match) => groupNames.test(match[1]));
}

function usesAdminMobileClassOnlyClosureAssertion(source) {
  return /await\s+expect[\s\S]{0,180}\.not\s*\.toHaveClass\s*\([\s\S]{0,120}is--off-canvas-shown/s.test(source);
}

function clicksAdminMobileNavigationLink(source) {
  if (/getByRole\s*\(\s*['"]link['"]/s.test(source)) {
    return true;
  }

  const menuLinkVariables = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.locator\s*\([^;\n]*sw-admin-menu__navigation-link[^;\n]*\)/g)]
    .map((match) => match[1]);

  return menuLinkVariables.some((name) => new RegExp(`\\b${name}\\s*\\.\\s*click\\s*\\(\\s*\\{[^}]*\\btimeout\\s*:`, 's').test(source));
}

function usesAdminDetailTabAsLink(source) {
  const detailRoute = /\/admin#\/sw\/[^'"`]+\/detail\//.test(source);
  const detailTabNames = /(?:General|Specifications|Advanced pricing|Variants|Layout|SEO|Cross Selling|Reviews|Media|Documents|Addresses|Orders|Customers)/i;
  return detailRoute
    && [...source.matchAll(/getByRole\s*\(\s*['"]link['"]\s*,\s*\{[^}]*name\s*:\s*([^}\n]+)\}/g)]
      .some((match) => detailTabNames.test(match[1]));
}

function usesUnsupportedPageDisplayValueLocator(source) {
  return /\bpage\.getByDisplayValue\s*\(/.test(source);
}

function usesCmsCreateLayoutWizardAsSetup(source, text) {
  const usesWizard = /\/admin#\/sw\/cms\/index/.test(source)
    && /Create new layout|What kind of page would you like to create|sw-cms-create-wizard/i.test(source);
  if (!usesWizard) return false;

  const reportedWizard = /\b(create|new|wizard|shopping experiences?|layout type|page type|cms layout|block picker|block selection)\b/i.test(text)
    && /\b(layout|cms|shopping experiences?|page)\b/i.test(text);
  return !reportedWizard;
}

function usesCombinedCmsStaticTextLocator(source, data) {
  const groups = collectCmsStaticTextSegmentGroups(data);
  if (groups.length === 0) return false;

  const textLocators = [...source.matchAll(/\bgetByText\s*\(\s*(['"`])([^'"`]+)\1/g)]
    .map((match) => match[2].replace(/\s+/g, ' ').trim());

  return textLocators.some((locatorText) => (
    groups.some((segments) => segments.filter((segment) => locatorText.includes(segment)).length > 1)
  ));
}

function usesDirectCmsElementClick(source) {
  if (/\blocator\s*\(\s*['"`]\.sw-cms-el-[^'"`]+['"`]\s*\)[\s\S]{0,160}\.click\s*\(/.test(source)) {
    return true;
  }

  const cmsElementLocatorAliases = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*locator\s*\(\s*['"`]\.sw-cms-el-[^'"`]+['"`]\s*\)[^;\n]*/g)]
    .map((match) => match[1]);

  return cmsElementLocatorAliases.some((name) => new RegExp(`\\b${name}\\s*\\.\\s*click\\s*\\(`).test(source));
}

function waitsForVisibleCmsHiddenEditorControl(source) {
  const hiddenControlSelector = String.raw`(?:\.sw-cms-block__config-overlay|\.sw-cms-slot__settings-action)`;
  const aliases = [...source.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*locator\s*\(\s*['"]${hiddenControlSelector}['"]\s*\)[^;\n]*`, 'g'))]
    .map((match) => match[1]);

  return new RegExp(String.raw`${hiddenControlSelector}[\s\S]{0,180}\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]`, 's').test(source)
    || aliases.some((name) => new RegExp(`\\b${name}\\s*\\.\\s*waitFor\\s*\\(\\s*\\{[^}]*state\\s*:\\s*['"]visible['"]`, 's').test(source));
}

function usesUnstableTmpUploadPath(source) {
  return /(?:setFiles|setInputFiles)\s*\([^)]*['"`]\/tmp\//.test(source)
    || /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*['"`]\/tmp\//.test(source)
    || /\bpath\.resolve\s*\(\s*(?:process\.cwd\(\)\s*,\s*)?['"`]\/tmp\//.test(source);
}

function absoluteLiteralUploadPaths(source) {
  const paths = new Set();
  const literalByVariable = new Map();

  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])(\/[^'"`]+)\2/g)) {
    literalByVariable.set(match[1], match[3]);
  }

  for (const match of source.matchAll(/(?:setFiles|setInputFiles)\s*\(\s*(['"`])(\/[^'"`]+)\1/g)) {
    paths.add(match[2]);
  }

  for (const match of source.matchAll(/(?:setFiles|setInputFiles)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const literal = literalByVariable.get(match[1]);
    if (literal) paths.add(literal);
  }

  return [...paths];
}

function missingLiteralUploadPaths(source) {
  const paths = new Set();
  const literalByVariable = new Map();

  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`]+)\2/g)) {
    literalByVariable.set(match[1], match[3]);
  }

  for (const match of source.matchAll(/(?:setFiles|setInputFiles)\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    paths.add(match[2]);
  }

  for (const match of source.matchAll(/(?:setFiles|setInputFiles)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const literal = literalByVariable.get(match[1]);
    if (literal) paths.add(literal);
  }

  return [...paths].filter((uploadPath) => (
    !uploadPath.startsWith('/')
      && !uploadPath.includes('${')
      && !fs.existsSync(path.join(root, uploadPath))
  ));
}

function mediaLibraryUploadCountBeforeAssertion(source) {
  const bodyStart = source.search(/\btest\s*\(/);
  const executableBody = bodyStart === -1 ? source : source.slice(bodyStart);
  const finalAssertion = executableBody.search(/\bawait\s+expect\s*\(/);
  const setupBody = finalAssertion === -1 ? executableBody : executableBody.slice(0, finalAssertion);
  const mediaLibraryNavigation = mediaLibraryNavigationOffset(source, setupBody);
  if (mediaLibraryNavigation === -1) return 0;

  const afterMediaLibraryNavigation = setupBody.slice(mediaLibraryNavigation);
  let count = (afterMediaLibraryNavigation.match(/\.setInputFiles\s*\(/g) ?? []).length
    + (afterMediaLibraryNavigation.match(/\.setFiles\s*\(/g) ?? []).length
    + (afterMediaLibraryNavigation.match(/\.waitForEvent\s*\(\s*['"]filechooser['"]/g) ?? []).length;

  const uploadHelpers = [...source.matchAll(/\b(?:async\s+function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)[\s\S]{0,900}?(?:\.setInputFiles\s*\(|\.setFiles\s*\(|\.waitForEvent\s*\(\s*['"]filechooser['"])/g)]
    .map((match) => match[1] ?? match[2]);
  for (const helper of uploadHelpers) {
    const calls = afterMediaLibraryNavigation.match(new RegExp(`\\b${helper}\\s*\\(`, 'g')) ?? [];
    count += calls.length;
  }

  return count;
}

function mediaSelectionCountBeforeAssertion(source) {
  const bodyStart = source.search(/\btest\s*\(/);
  const executableBody = bodyStart === -1 ? source : source.slice(bodyStart);
  const finalAssertion = executableBody.search(/\bawait\s+expect\s*\(/);
  const setupBody = finalAssertion === -1 ? executableBody : executableBody.slice(0, finalAssertion);
  const mediaLibraryNavigation = mediaLibraryNavigationOffset(source, setupBody);
  if (mediaLibraryNavigation === -1) return 0;

  const afterMediaLibraryNavigation = setupBody.slice(mediaLibraryNavigation);
  const mediaNameVariables = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`][^'"`]*(?:media|teaser|image|file)[^'"`]*['"`]/gi)]
    .map((match) => match[1]);
  const mediaLocatorVariables = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)]
    .filter((match) => /getByText\s*\([^;\n]*(?:media|fileName)|mediaFileName|repro_teaser_media|seeded-media/i.test(match[2])
      || /sw-media-grid-item/.test(match[2])
      || mediaNameVariables.some((name) => new RegExp(`\\bhasText\\s*:\\s*${name}\\b`).test(match[2]))
      || mediaNameVariables.some((name) => new RegExp(`\\bname\\s*:\\s*(?:new\\s+RegExp\\s*\\(\\s*)?${name}\\b`).test(match[2])))
    .map((match) => match[1]);
  const clickHelpers = [...source.matchAll(/\b(?:async\s+function|function)\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{[^}]*\b\2\s*\.click\s*\(/g)]
    .map((match) => match[1]);
  const mediaSelectionHelpers = [...source.matchAll(/\b(?:async\s+function|function)\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/g)]
    .filter((match) => {
      const body = match[2];
      return /\.click\s*\(/.test(body)
        && (/getByText\s*\([^;\n]*(?:media|fileName)|mediaFileName|repro_teaser_media|seeded-media/i.test(body)
          || mediaNameVariables.some((name) => new RegExp(`\\bhasText\\s*:\\s*${name}\\b`).test(body))
          || mediaNameVariables.some((name) => new RegExp(`\\bname\\s*:\\s*(?:new\\s+RegExp\\s*\\(\\s*)?${name}\\b`).test(body)));
    })
    .map((match) => match[1]);

  const directSelectionCount = mediaLocatorVariables.reduce((count, name) => (
    count
      + (afterMediaLibraryNavigation.match(new RegExp(`\\b${name}\\s*\\.\\s*click\\s*\\(`, 'g')) ?? []).length
      + clickHelpers.reduce((helperCount, helper) => (
        helperCount + (afterMediaLibraryNavigation.match(new RegExp(`\\b${helper}\\s*\\(\\s*${name}\\b`, 'g')) ?? []).length
      ), 0)
  ), 0);
  const directTextSelectionCount = mediaNameVariables.reduce((count, name) => (
    count + (afterMediaLibraryNavigation.match(new RegExp(`\\bgetByText\\s*\\(\\s*${name}\\b[\\s\\S]{0,180}\\)\\s*(?:\\.first\\s*\\(\\s*\\)\\s*)?\\.click\\s*\\(`, 'g')) ?? []).length
  ), 0);

  return directSelectionCount + directTextSelectionCount + mediaSelectionHelpers.reduce((count, helper) => (
    count + (afterMediaLibraryNavigation.match(new RegExp(`\\b${helper}\\s*\\(`, 'g')) ?? []).length
  ), 0);
}

function mediaLibraryNavigationOffset(source, setupBody) {
  const literalOffset = setupBody.search(/\/admin#\/sw\/media(?:\/index)?/);
  if (literalOffset !== -1) return literalOffset;

  const mediaRouteVariables = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]\/admin#\/sw\/media(?:\/index)?['"`]/g)]
    .map((match) => match[1]);
  for (const name of mediaRouteVariables) {
    const variableNavigation = setupBody.search(new RegExp(`\\b(?:page|[A-Za-z_$][\\w$]*)\\s*\\.\\s*goto\\s*\\(\\s*${name}\\b`));
    if (variableNavigation !== -1) return variableNavigation;
  }

  return -1;
}

function hasReplaceModalAnchor(source) {
  return /\.sw-media-modal-replace/.test(source)
    && /\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]/s.test(source);
}

function mediaReplacementModalWithoutMediaLibraryNavigation(source) {
  if (!/\.sw-media-modal-replace/.test(source)) return false;

  return mediaLibraryNavigationOffset(source, source) === -1;
}

function mediaReplacementHasFinalUploadCompletionGate(source) {
  const bodyStart = source.search(/\btest\s*\(/);
  const executableBody = bodyStart === -1 ? source : source.slice(bodyStart);
  const finalAssertion = executableBody.search(/\bawait\s+expect\s*\(/);
  const setupBody = finalAssertion === -1 ? executableBody : executableBody.slice(0, finalAssertion);
  const assertionBody = finalAssertion === -1 ? '' : executableBody.slice(finalAssertion);
  if (/\.sw-media-modal-replace/.test(source)
    && /\bawait\s+expect\s*\([\s\S]{0,400}\b(?:getByRole|locator)\s*\([\s\S]{0,400}(?:replace|Replace)[\s\S]{0,400}\)\s*\)\s*\.\s*toBeEnabled\s*\(/.test(assertionBody)) {
    return true;
  }
  const replaceButtonAliases = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*(?:getByRole\s*\([\s\S]{0,200}(?:replace|Replace|ersetzen|Ersetzen)[\s\S]{0,200}\)|locator\s*\(\s*['"`]\.sw-media-replace__replace-media-action['"`]\s*\))/g)]
    .map((match) => match[1]);
  if (/\.sw-media-modal-replace/.test(source)
    && replaceButtonAliases.some((name) => new RegExp(String.raw`\bawait\s+expect\s*\(\s*${name}\s*\)\s*\.\s*toBeEnabled\s*\(`).test(assertionBody))) {
    return true;
  }

  const uploadMatches = [...setupBody.matchAll(/(?:setFiles|setInputFiles)\s*\(|\.waitForEvent\s*\(\s*['"]filechooser['"]/g)];
  if (uploadMatches.length === 0) return true;

  const lastUploadIndex = uploadMatches.at(-1).index ?? -1;
  const afterLastUpload = setupBody.slice(lastUploadIndex);
  const aroundLastUpload = setupBody.slice(Math.max(0, lastUploadIndex - 1000), lastUploadIndex + 500);
  return /\bwaitForResponse\s*\(/.test(afterLastUpload)
    || /Promise\.all\s*\(\s*\[[\s\S]{0,1200}\bwaitForResponse\s*\([\s\S]{0,1200}(?:setFiles|setInputFiles)\s*\(/.test(aroundLastUpload)
    || /Promise\.all\s*\(\s*\[[\s\S]{0,1200}(?:setFiles|setInputFiles)\s*\([\s\S]{0,1200}\bwaitForResponse\s*\(/.test(aroundLastUpload)
    || /(?:Uploading files|upload(?:ing)?(?:[- ]progress)?|progress)[\s\S]{0,240}\.(?:waitFor|toBeHidden|toBeDetached|not\.toBeVisible)\s*\(/i.test(afterLastUpload)
    || /\.(?:waitFor|toBeHidden|toBeDetached|not\.toBeVisible)\s*\([\s\S]{0,180}(?:state\s*:\s*['"](?:hidden|detached)['"][\s\S]{0,180})?(?:Uploading files|upload(?:ing)?(?:[- ]progress)?|progress)/i.test(afterLastUpload);
}

function mediaReplacementWaitsForUploadCompletionBeforeReplaceCommit(source) {
  if (!/\.sw-media-modal-replace/.test(source)) return false;

  const replaceModalOffset = source.search(/\.sw-media-modal-replace/);
  const finalAssertionOffset = source.search(/\bawait\s+expect\s*\(/);
  const replaceModalFlow = source.slice(
    replaceModalOffset,
    finalAssertionOffset === -1 ? undefined : finalAssertionOffset,
  );
  if (/Promise\.all\s*\(\s*\[[\s\S]*?\bwaitForResponse\s*\([\s\S]*?\b[A-Za-z_$][\w$]*\s*\.\s*(?:setFiles|setInputFiles)\s*\([\s\S]*?\]\s*\)/.test(replaceModalFlow)
    || /Promise\.all\s*\(\s*\[[\s\S]*?\b[A-Za-z_$][\w$]*\s*\.\s*(?:setFiles|setInputFiles)\s*\([\s\S]*?\bwaitForResponse\s*\([\s\S]*?\]\s*\)/.test(replaceModalFlow)) {
    return true;
  }
  for (const match of replaceModalFlow.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*\bwaitForResponse\s*\(/g)) {
    const afterWaitAlias = replaceModalFlow.slice(match.index ?? 0);
    const alias = match[1];
    if (new RegExp(String.raw`\.(?:setFiles|setInputFiles)\s*\([\s\S]*?\bawait\s+${alias}\b`).test(afterWaitAlias)) {
      return true;
    }
  }

  const uploadMatches = [...source.matchAll(/\.(?:setFiles|setInputFiles)\s*\(/g)];
  for (const match of uploadMatches) {
    const beforeUpload = source.slice(Math.max(0, (match.index ?? 0) - 900), match.index ?? 0);
    if (!/\.sw-media-modal-replace|replaceModal|modalReplace|replace\s*modal/i.test(beforeUpload)) continue;

    const aroundUpload = source.slice(Math.max(0, (match.index ?? 0) - 900), (match.index ?? 0) + 1200);
    if (/Promise\.all\s*\(\s*\[[\s\S]{0,1000}\bwaitForResponse\s*\([\s\S]{0,1000}\.(?:setFiles|setInputFiles)\s*\(/.test(aroundUpload)
      || /Promise\.all\s*\(\s*\[[\s\S]{0,1000}\.(?:setFiles|setInputFiles)\s*\([\s\S]{0,1000}\bwaitForResponse\s*\(/.test(aroundUpload)) {
      return true;
    }

    const afterUpload = source.slice(match.index ?? 0, (match.index ?? 0) + 1800);
    const replaceClick = afterUpload.search(/(?:getByRole\s*\([\s\S]{0,180}(?:replace|Replace)[\s\S]{0,180}\)|\.sw-media-replace__replace-media-action[\s\S]{0,180})[\s\S]{0,240}\.click\s*\(/);
    const finalEnabledAssertion = afterUpload.search(/\bawait\s+expect\s*\([\s\S]{0,500}(?:replace|Replace)[\s\S]{0,500}\)\s*\.\s*toBeEnabled\s*\(/);
    if (replaceClick === -1 && finalEnabledAssertion === -1) continue;

    const decisiveAction = replaceClick === -1
      ? finalEnabledAssertion
      : finalEnabledAssertion === -1
        ? replaceClick
        : Math.min(replaceClick, finalEnabledAssertion);
    const beforeReplaceClick = afterUpload.slice(0, decisiveAction);
    if (/(?:Uploading files?|upload[- ]progress|progress|uploadProgress\w*)[\s\S]{0,320}(?:waitFor|toBeHidden|toBeDetached|not\.toBeVisible)\s*\(/i.test(beforeReplaceClick)
      || /(?:waitFor|toBeHidden|toBeDetached|not\.toBeVisible)\s*\([\s\S]{0,260}(?:state\s*:\s*['"](?:hidden|detached)['"][\s\S]{0,260})?(?:Uploading files?|upload[- ]progress|progress|uploadProgress\w*)/i.test(beforeReplaceClick)
      || /\bwaitForResponse\s*\(/.test(beforeReplaceClick)) {
      return true;
    }
  }

  return false;
}

function mediaReplacementAllowsOriginalFilenameAsStagingMarker(source, fixturesData) {
  if (!/\.sw-media-modal-replace/.test(source)) return false;
  const uploadNames = new Set(mediaUploadSpecs(fixturesData)
    .map((upload) => String(upload?.fileName ?? '').trim())
    .filter(Boolean));
  if (uploadNames.size === 0) return false;

  const finalAssertion = source.search(/\bawait\s+expect\s*\(/);
  const setupBody = finalAssertion === -1 ? source : source.slice(0, finalAssertion);
  const uploadMatches = [...setupBody.matchAll(/\.(?:setFiles|setInputFiles)\s*\(/g)];
  const setFilesOffset = uploadMatches.at(-1)?.index ?? -1;
  if (setFilesOffset === -1) return false;
  const afterFinalUpload = setupBody.slice(setFilesOffset);

  return [...uploadNames].some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(String.raw`getByText\s*\(\s*\/[^/\n]*${escaped}[^/\n]*\|`).test(afterFinalUpload)
      || new RegExp(String.raw`getByText\s*\(\s*\/[^/\n]*\|[^/\n]*${escaped}[^/\n]*\/`).test(afterFinalUpload)
      || new RegExp(String.raw`getByText\s*\(\s*['"\`]${escaped}(?:\.[a-z0-9]+)?['"\`]`).test(afterFinalUpload);
  });
}

function hasSeededNavigationCategory(data) {
  return entityRows(data, 'category').some((row) => (
    row?.id
      && row.id !== '{{NAV_CAT}}'
      && (row.parentId === '{{NAV_CAT}}' || row.parentId)
      && (row.name || row.translated?.name)
  ));
}

function isPlaceholder(value) {
  const match = String(value).match(/^\{\{([A-Z0-9_]+)\}\}$/);
  return match && allowedPlaceholders.has(match[1]);
}

function validateUuidFields(value, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateUuidFields(item, [...pathParts, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, childValue] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (typeof childValue === 'string' && /(^id$|Id$)/.test(key)) {
      if (!isPlaceholder(childValue) && !/^[0-9a-f]{32}$/i.test(childValue)) {
        fail(`fixtures.json field ${nextPath.join('.')} must be a 32-character hex UUID or supported {{PLACEHOLDER}}, got '${childValue}'`);
      }
    } else {
      validateUuidFields(childValue, nextPath);
    }
  }
}

function validateOrderFixtures(data) {
  for (const order of entityRows(data, 'order')) {
    for (const [index, lineItem] of entityPayload(order.lineItems).entries()) {
      const priceDefinition = lineItem?.priceDefinition;
      if (priceDefinition && !Array.isArray(priceDefinition.taxRules)) {
        fail(`order fixture lineItems.${index}.priceDefinition.taxRules must be an array; missing taxRules often seeds as array_map(... null ...) before the reported symptom can run`);
      }
    }

    for (const [index, delivery] of entityPayload(order.deliveries).entries()) {
      if (!Array.isArray(delivery?.positions) || delivery.positions.length === 0) {
        fail(`order fixture deliveries.${index}.positions must include at least one position for the seeded line item; an order seed that cannot create delivery positions is a precondition failure`);
      }
    }

    for (const [index, transaction] of entityPayload(order.transactions).entries()) {
      if (transaction?.stateId === '{{ORDER_STATE_OPEN}}') {
        fail(`order fixture transactions.${index}.stateId uses {{ORDER_STATE_OPEN}}; use {{ORDER_TRANSACTION_STATE_OPEN}} for order_transaction.state`);
      }
    }
  }
}

function validateCmsPageFixtures(data) {
  const cmsPageTypesById = new Map(entityRows(data, 'cms_page')
    .filter((page) => page?.id)
    .map((page) => [String(page.id), String(page.type ?? '')]));
  const knownBlockSlots = new Map([
    ['image', new Set(['image'])],
    ['image-text', new Set(['left', 'right'])],
    ['product-three-column', new Set(['left', 'center', 'right'])],
  ]);

  for (const category of entityRows(data, 'category')) {
    const cmsPageType = cmsPageTypesById.get(String(category?.cmsPageId ?? ''));
    if (cmsPageType && cmsPageType !== 'product_list') {
      fail(`category fixture '${category.name || category.id || 'unknown'}' assigns cmsPageId ${category.cmsPageId} to a cms_page of type '${cmsPageType}'. Storefront /navigation category pages need a product_list CMS page; a generic page/landingpage layout can render only the category shell and leave the seeded CMS body blank`);
    }
  }

  for (const page of entityRows(data, 'cms_page')) {
    if (!Array.isArray(page.sections)) {
      fail('cms_page fixture entries must nest sections, blocks, and slots inside the cms_page payload; do not split CMS layouts into top-level cms_section/cms_block/cms_slot payloads because the verifier expects the renderable layout graph from the seeded page marker');
    }
    for (const section of page.sections) {
      if (!Array.isArray(section.blocks)) {
        fail('cms_page fixture sections must nest blocks inside each section');
      }
      for (const block of section.blocks) {
        if (!Array.isArray(block.slots)) {
          fail('cms_page fixture blocks must nest slots inside each block');
        }
        const allowedSlots = knownBlockSlots.get(String(block.type ?? ''));
        for (const slot of block.slots) {
          if (slot && typeof slot === 'object' && Object.hasOwn(slot, 'data')) {
            fail('cms_page fixture slots must not include runtime-only data objects; seed persisted slot config and referenced entities/media instead. CMS slot data is resolved at runtime and can make Sync API fixture seeding fail before the reported symptom runs');
          }
          if (allowedSlots && !allowedSlots.has(String(slot?.slot ?? ''))) {
            fail(`cms_page fixture block type '${block.type}' contains unsupported slot '${slot?.slot ?? 'unknown'}'. Use the slot names from the Shopware CMS block registration so the seeded CMS page renders before the symptom runs`);
          }
        }
      }
    }
  }
}

function extractObjectLiteral(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return '';
  const open = source.indexOf('{', markerIndex + marker.length);
  if (open === -1) return '';

  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return '';
}

function topLevelObjectKeys(objectLiteral) {
  const keys = new Set();
  let depth = 0;
  let quote = '';
  let escaped = false;
  let token = '';
  let collecting = true;

  for (let index = 1; index < objectLiteral.length - 1; index += 1) {
    const char = objectLiteral[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      if (collecting) token += char;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      if (collecting) token += char;
      continue;
    }
    if (char === '{' || char === '[' || char === '(') {
      depth += 1;
      collecting = false;
      continue;
    }
    if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
      continue;
    }
    if (depth === 0 && char === ':') {
      const key = token.trim().replace(/^['"`]|['"`]$/g, '');
      if (/^[A-Za-z_$][\w$-]*$/.test(key)) keys.add(key);
      token = '';
      collecting = false;
      continue;
    }
    if (depth === 0 && char === ',') {
      token = '';
      collecting = true;
      continue;
    }
    if (depth === 0 && collecting) token += char;
  }

  return keys;
}

function cmsSlotEntries(data) {
  return entityRows(data, 'cms_page').flatMap((page) => (
    (page.sections ?? []).flatMap((section) => (
      (section.blocks ?? []).flatMap((block) => (
        (block.slots ?? []).map((slot) => ({ page, section, block, slot }))
      ))
    ))
  ));
}

function sourceTrailPaths() {
  return (Array.isArray(plan.source_trail) ? plan.source_trail : [])
    .map((entry) => String(entry?.path ?? entry ?? ''))
    .filter(Boolean);
}

function collectTranslationLanguagePlaceholders(value, paths = [], pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTranslationLanguagePlaceholders(item, paths, [...pathParts, String(index)]));
    return paths;
  }
  if (!value || typeof value !== 'object') return paths;

  if (Object.hasOwn(value, 'translations') && value.translations && typeof value.translations === 'object') {
    const translationPath = [...pathParts, 'translations'].join('.');
    if (Array.isArray(value.translations)) {
      value.translations.forEach((translation, index) => {
        if (translation?.languageId === '{{LANGUAGE}}') {
          paths.push(`${translationPath}.${index}.languageId`);
        }
      });
    } else {
      for (const key of Object.keys(value.translations)) {
        if (key === '{{LANGUAGE}}') {
          paths.push(`${translationPath}.{{LANGUAGE}}`);
        }
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    collectTranslationLanguagePlaceholders(child, paths, [...pathParts, key]);
  }
  return paths;
}

function validateTranslationLanguagePlaceholders(data) {
  const ambiguous = collectTranslationLanguagePlaceholders(data);
  if (ambiguous.length > 0) {
    fail([
      'translation fixtures must use {{SYSTEM_LANGUAGE}} for required translated rows',
      '{{LANGUAGE}} is the sales-channel/display language and may not satisfy DAL system-language validation',
      `ambiguous translation language placeholder(s): ${ambiguous.slice(0, 10).join(', ')}`
    ].join(' — '));
  }
}

function validateSourceTrailIsFixtureScoped() {
  const entries = Array.isArray(plan.source_trail) ? plan.source_trail : [];
  for (const entry of entries) {
    const sourcePath = String(entry?.path ?? entry ?? '');
    const reason = String(entry?.reason ?? '');
    if (/\.(?:s?css|less)(?:$|[?#])/i.test(sourcePath)) {
      fail(`source_trail path '${sourcePath}' researches styling/layout code. Reproduction agents may inspect source only for fixture schema, route ownership, rendered seeded fields, or readiness selectors`);
    }
    if (/\b(?:root[- ]?cause|bug cause|culprit|fix(?:es|ed)?|regression|layout issue|css issue|min-width|flex(?:box)?|collapse[sd]?|overflow|intercept(?:ing|ion)?|z-index|stacking context)\b/i.test(reason)) {
      fail(`source_trail reason for '${sourcePath || 'unknown'}' describes bug-cause analysis instead of fixture/schema/render-proof evidence`);
    }
  }
}

function templateConfigKeysForCmsElement(type) {
  const templatePath = `src/Storefront/Resources/views/storefront/element/cms-element-${type}.html.twig`;
  const source = read(templatePath);
  if (!source) return { templatePath, keys: new Set(), exists: false };

  const keys = new Set();
  for (const match of source.matchAll(/\b(?:sliderConfig|config)\.([A-Za-z_$][\w$]*)\.value\b/g)) {
    keys.add(match[1]);
  }
  return { templatePath, keys, exists: true };
}

function defaultConfigKeysForCmsElement(type) {
  const elementPath = `src/Administration/Resources/app/administration/src/module/sw-cms/elements/${type}/index.ts`;
  const source = read(elementPath);
  if (!source) return { elementPath, keys: new Set(), exists: false };

  const literal = extractObjectLiteral(source, 'defaultConfig');
  return { elementPath, keys: topLevelObjectKeys(literal), exists: true };
}

function validateCmsOpaqueConfigEvidence(data) {
  const paths = sourceTrailPaths();
  const checkedTypes = new Set();

  for (const { block, slot } of cmsSlotEntries(data)) {
    const type = String(slot?.type || block?.type || '');
    if (!type || checkedTypes.has(type)) continue;
    checkedTypes.add(type);

    const template = templateConfigKeysForCmsElement(type);
    if (!template.exists || template.keys.size === 0) continue;

    const defaults = defaultConfigKeysForCmsElement(type);
    const sourceEvidence = paths.some((sourcePath) => sourcePath.endsWith(`/sw-cms/elements/${type}/index.ts`))
      && paths.some((sourcePath) => sourcePath.endsWith(`/cms-element-${type}.html.twig`));
    if (!sourceEvidence) {
      fail(`cms_page fixture uses CMS element '${type}' whose storefront template reads persisted config. source_trail must include the element defaultConfig source and storefront template so opaque cms_slot.config is schema-derived, not guessed`);
    }

    const requiredKeys = [...template.keys].filter((key) => defaults.keys.size === 0 || defaults.keys.has(key));
    const missing = requiredKeys.filter((key) => !Object.hasOwn(slot?.config ?? {}, key));
    if (missing.length > 0) {
      fail(`cms_page fixture slot type '${type}' is missing config keys read by the storefront template: ${missing.join(', ')}. Seed the complete minimum opaque config shape from the CMS element defaultConfig`);
    }
  }
}

function validateProductPriceCurrency(data) {
  for (const product of entityRows(data, 'product')) {
    const prices = entityPayload(product.price);
    if (prices.length === 0) continue;

    if (!prices.some((price) => price?.currencyId === '{{CURRENCY}}')) {
      const label = product.productNumber || product.name || product.id || 'unknown product';
      fail(`product fixture '${label}' defines price entries but no default {{CURRENCY}} price; use "currencyId": "{{CURRENCY}}" so the provisioned shop can seed the default-currency price`);
    }
  }
}

function validateProductVisibilityIds(data) {
  for (const product of entityRows(data, 'product')) {
    for (const [index, visibility] of entityPayload(product.visibilities).entries()) {
      if (!visibility?.id) {
        const label = product.productNumber || product.name || product.id || 'unknown product';
        fail(`product fixture '${label}' visibilities.${index} must include a stable id; nested product visibility rows are not idempotent without an id and can duplicate on repeated seeding`);
      }
    }
  }
}

function validateSystemConfigValues(data) {
  for (const row of entityRows(data, 'system_config')) {
    if (row?.configurationValue && typeof row.configurationValue === 'object' && !Array.isArray(row.configurationValue)) {
      const key = row.configurationKey || row.id || 'unknown system_config';
      fail(`system_config fixture '${key}' uses an object for configurationValue; Sync API expects the literal config value such as true, "value", or a plain array, not {"_value": ...}`);
    }
  }
}

function validateSyncOperationEnvelope(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;

  for (const [key, value] of Object.entries(data)) {
    if (key === '_repro_media_uploads') continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (!Object.hasOwn(value, 'payload')) {
      const nestedOperationKeys = Object.entries(value)
        .filter(([, nested]) => nested && typeof nested === 'object' && !Array.isArray(nested))
        .filter(([, nested]) => Object.hasOwn(nested, 'entity') || Object.hasOwn(nested, 'action') || Object.hasOwn(nested, 'payload'))
        .map(([nestedKey]) => nestedKey);
      if (nestedOperationKeys.length > 0) {
        fail(`fixtures.json operation '${key}' wraps sync operation(s) ${nestedOperationKeys.join(', ')}; put each operation at the top level instead of nesting under '${key}'`);
      }
      continue;
    }

    if (!Object.hasOwn(value, 'action')) {
      fail(`fixtures.json operation '${key}' has a payload object but no action; use a bare array shape like "${key}": [...] or a full sync envelope with "action": "upsert"`);
    }
    if (!['upsert', 'delete'].includes(String(value.action))) {
      fail(`fixtures.json operation '${key}' has unsupported action '${value.action}'; Sync API supports "upsert" and "delete"`);
    }
    for (const [index, row] of value.payload.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(`fixtures.json operation '${key}' payload.${index} must be an object; do not JSON-encode Sync payload rows as strings`);
      }
    }
  }
}

function collectFixtureFields(data, fieldName, found = []) {
  if (Array.isArray(data)) {
    for (const item of data) collectFixtureFields(item, fieldName, found);
    return found;
  }
  if (!data || typeof data !== 'object') return found;

  for (const [key, value] of Object.entries(data)) {
    if (key === fieldName && typeof value === 'string') {
      found.push(value);
    }
    collectFixtureFields(value, fieldName, found);
  }

  return found;
}

function collectStaticCmsMediaValues(data, found = []) {
  if (Array.isArray(data)) {
    for (const item of data) collectStaticCmsMediaValues(item, found);
    return found;
  }
  if (!data || typeof data !== 'object') return found;

  if (data.media
    && typeof data.media === 'object'
    && data.media.source === 'static'
    && typeof data.media.value === 'string') {
    found.push(data.media.value);
  }

  for (const value of Object.values(data)) {
    collectStaticCmsMediaValues(value, found);
  }

  return found;
}

function validateMediaReferences(data, reproPlan) {
  if (reproPlan?.fixtures?.demodata === true) return;

  const seededMediaIds = new Set(entityRows(data, 'media')
    .map((row) => row?.id)
    .filter((id) => typeof id === 'string'));
  const unresolved = [
    ...collectFixtureFields(data, 'mediaId'),
    ...collectStaticCmsMediaValues(data),
  ]
    .filter((id) => !isPlaceholder(id) && !seededMediaIds.has(id));

  if (unresolved.length > 0) {
    fail(`fixtures.json references media value(s) that are not seeded in fixtures.json: ${[...new Set(unresolved)].join(', ')}. With demodata disabled, do not depend on built-in/demo media; seed the referenced media row or create/select runtime media through the owning UI flow`);
  }
}

function validateMediaFolderReferences(data, reproPlan) {
  if (reproPlan?.fixtures?.demodata === true) return;

  const seededMediaFolderIds = new Set(entityRows(data, 'media_folder')
    .map((row) => row?.id)
    .filter((id) => typeof id === 'string'));
  const unresolved = collectFixtureFields(data, 'mediaFolderId')
    .filter((id) => id !== null && !isPlaceholder(id) && !seededMediaFolderIds.has(id));

  if (unresolved.length > 0) {
    fail(`fixtures.json references mediaFolderId value(s) that are not seeded in fixtures.json: ${[...new Set(unresolved)].join(', ')}. With demodata disabled, put seeded media in the root folder with mediaFolderId null or seed the referenced media_folder row`);
  }
}

function validateReproMediaUploads(data) {
  for (const [index, upload] of mediaUploadSpecs(data).entries()) {
    const prefix = `_repro_media_uploads.${index}`;
    if (!upload || typeof upload !== 'object') {
      fail(`fixtures.json ${prefix} must be an object with mediaId, path, extension, and mimeType`);
    }
    if (typeof upload.mediaId !== 'string' || (!isPlaceholder(upload.mediaId) && !/^[0-9a-f]{32}$/i.test(upload.mediaId))) {
      fail(`fixtures.json ${prefix}.mediaId must be a 32-character hex UUID or supported {{PLACEHOLDER}}`);
    }
    if (typeof upload.path !== 'string' || !/^issue-assets\/[^/]+$/.test(upload.path) || !fs.existsSync(path.join(root, upload.path))) {
      fail(`fixtures.json ${prefix}.path must reference an existing issue-assets file`);
    }
    if (typeof upload.extension !== 'string' || !/^[a-z0-9]+$/i.test(upload.extension)) {
      fail(`fixtures.json ${prefix}.extension must be a simple file extension such as png or jpg`);
    }
    if (typeof upload.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(upload.mimeType)) {
      fail(`fixtures.json ${prefix}.mimeType must be a MIME type such as image/png`);
    }
    if (upload.fileName !== undefined && (typeof upload.fileName !== 'string' || upload.fileName.trim() === '')) {
      fail(`fixtures.json ${prefix}.fileName must be a non-empty string when present`);
    }
    if (typeof upload.fileName === 'string' && typeof upload.extension === 'string') {
      const extension = upload.extension.replace(/^\./, '');
      if (extension && upload.fileName.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
        fail(`fixtures.json ${prefix}.fileName must be a basename without .${extension}; _repro_media_uploads already passes extension separately`);
      }
    }
  }
}

function validateSeededReadinessChecks(reproPlan) {
  if (executor !== 'playwright' || !fs.existsSync(path.join(root, 'fixtures.json'))) return;

  const checks = Array.isArray(reproPlan.seeded_readiness)
    ? reproPlan.seeded_readiness
    : (Array.isArray(reproPlan.readiness_checks) ? reproPlan.readiness_checks : []);

  if (checks.length === 0) {
    fail('playwright bundles with fixtures.json must declare seeded_readiness checks that prove the seeded target is reachable in the UI before the final symptom assertion');
  }

  checks.forEach((check, index) => {
    const label = `seeded_readiness[${index}]`;
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      fail(`${label} must be an object`);
    }
    if ((check.kind ?? 'browser') !== 'browser') {
      fail(`${label}.kind must be "browser"; HTTP/direct setup checks belong in plan assertions or the generated test`);
    }

    const target = check.path ?? check.url ?? check.route;
    if (typeof target !== 'string' || target.trim() === '') {
      fail(`${label} must include a local path/url/route for the surface that reads the seeded state`);
    }
    if (/^https?:\/\//i.test(target)) {
      let host = '';
      try {
        host = new URL(target).hostname;
      } catch {
        fail(`${label} has an invalid url`);
      }
      if (!['localhost', '127.0.0.1', 'host.docker.internal'].includes(host)) {
        fail(`${label} must not point at a remote url; readiness checks run against the provisioned local shop`);
      }
    }

    if (typeof check.selector !== 'string' || check.selector.trim() === '') {
      fail(`${label} must include a source/probe-backed selector for the seeded target or control`);
    }
    if (check.text !== undefined && typeof check.text !== 'string') {
      fail(`${label}.text must be a string when present`);
    }
    for (const key of ['min_width', 'min_height', 'timeout_ms']) {
      if (check[key] !== undefined && (!Number.isFinite(Number(check[key])) || Number(check[key]) < 0)) {
        fail(`${label}.${key} must be a non-negative number`);
      }
    }
  });
}

function assertionsFromPlan(data) {
  if (Array.isArray(data.assertions)) return data.assertions;
  if (data.assertion && typeof data.assertion === 'object') return [data.assertion];
  return [];
}

function collectPlaceholders(value, found = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) found.add(match[1]);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;

  for (const childValue of Object.values(value)) collectPlaceholders(childValue, found);
  return found;
}

function preconditionSnippet(source) {
  const lines = source.split('\n');
  const picked = new Set();
  const waitPreconditionHelpers = [...source.matchAll(/\b(?:async\s+function|function)\s+([A-Za-z_$][\w$]*)\s*\([\s\S]{0,500}?\.waitFor\s*\([\s\S]{0,500}?PRECONDITION_NOT_FOUND/g)]
    .map((match) => match[1]);
  lines.forEach((line, index) => {
    const callsWaitPreconditionHelper = waitPreconditionHelpers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(line));
    if (/PRECONDITION_NOT_FOUND|\.waitFor\s*\(|\brequireVisible\s*\(/.test(line) || callsWaitPreconditionHelper) {
      const maxOffset = /PRECONDITION_NOT_FOUND/.test(line) ? 0 : 1;
      for (let offset = -4; offset <= maxOffset; offset += 1) {
        const target = index + offset;
        if (target >= 0 && target < lines.length) picked.add(target);
      }
    }
  });
  return [...picked].sort((a, b) => a - b).map((index) => lines[index]).join('\n');
}

function preconditionActionSnippet(source) {
  return preconditionSnippet(source)
    .split('\n')
    .filter((line) => !/PRECONDITION_NOT_FOUND|throw\s+new\s+Error/.test(line))
    .join('\n');
}

function setupBeforeFinalAssertion(source) {
  const finalAssertionOffset = source.search(/\bawait\s+expect\s*(?:\.\s*poll)?\s*\(/);
  return finalAssertionOffset === -1 ? source : source.slice(0, finalAssertionOffset);
}

function clickInterceptionIssue(text) {
  return /\b(?:click|clicked|clicking|tap|button|link|pointer|mouse|cursor|buy|cart)\b/i.test(text)
    && /\b(?:intercept|intercepts|intercepted|overlap|overlaps|overlay|cover|covers|covered|covering|z-index|pointer-events|click[- ]?area|hit[- ]?test|stretched[- ]link|stretched link)\b/i.test(text);
}

function stretchedLinkIssue(text) {
  return /\b(?:stretched[- ]link|stretched link)\b/i.test(text);
}

function hasPointerHitTestPrecondition(source) {
  const setup = setupBeforeFinalAssertion(source);
  return /document\.elementFromPoint\s*\(/.test(setup)
    && /\.(?:boundingBox|getBoundingClientRect)\s*\(/.test(setup)
    && /PRECONDITION_NOT_FOUND/.test(setup)
    && /\b(?:topmost|intercept|overlay|cover|hit[- ]?test|click point|click target|stretched[- ]link|stretched link)\b/i.test(setup);
}

function hasStretchedLinkPrecondition(source) {
  const setup = setupBeforeFinalAssertion(source);
  return /stretched-link/.test(setup)
    && /\b(?:productCard|card|product-box|product-name|wishlist|closest)\b/i.test(setup)
    && /(?:\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]|querySelector|matches|closest)/s.test(setup)
    && /PRECONDITION_NOT_FOUND/.test(setup);
}

function stringConstantAliases(source) {
  const aliases = [];
  for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]{3,120})\2\s*;/g)) {
    aliases.push({ name: match[1], value: match[3] });
  }
  return aliases;
}

function snippetContainsTermOrAlias(source, snippet, term) {
  if (snippet.toLowerCase().includes(String(term).toLowerCase())) return true;
  const flexibleTerm = String(term)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/(?:\s|-|_)+/g, '[\\\\s_-]+');
  if (flexibleTerm && new RegExp(flexibleTerm, 'i').test(snippet)) return true;
  return stringConstantAliases(source).some((alias) => {
    const aliasValue = String(alias.value);
    const aliasMatchesTerm = aliasValue === term
      || aliasValue.toLowerCase() === String(term).toLowerCase()
      || (flexibleTerm && new RegExp(flexibleTerm, 'i').test(aliasValue));

    return aliasMatchesTerm && new RegExp(`\\b${alias.name}\\b`).test(snippet);
  });
}

function groupedPreconditionCatch(source) {
  const tryCatchBlocks = source.matchAll(/try\s*\{([\s\S]*?)\}\s*catch\s*\{([\s\S]*?PRECONDITION_NOT_FOUND[\s\S]*?)\}/g);
  return [...tryCatchBlocks].some((match) => {
    const waitCount = (match[1].match(/\.waitFor\s*\(/g) ?? []).length;
    return waitCount > 1;
  });
}

validateUuidFields(fixtures);
validateOrderFixtures(fixtures);
validateCmsPageFixtures(fixtures);
validateCmsOpaqueConfigEvidence(fixtures);
validateProductPriceCurrency(fixtures);
validateProductVisibilityIds(fixtures);
validateSystemConfigValues(fixtures);
validateSyncOperationEnvelope(fixtures);
validateTranslationLanguagePlaceholders(fixtures);
validateMediaReferences(fixtures, plan);
validateMediaFolderReferences(fixtures, plan);
validateReproMediaUploads(fixtures);
validateSeededReadinessChecks(plan);
validateSourceTrailIsFixtureScoped();
const mediaWriteProtectedFields = seededMediaRowsWithWriteProtectedFileFields(fixtures);
if (mediaWriteProtectedFields.length > 0) {
  fail(`fixtures.json media rows must not set write-protected file state fields (${mediaWriteProtectedFields.join(', ')}); seed the media row metadata and use _repro_media_uploads for uploaded bytes`);
}

const unknownPlaceholders = [...collectPlaceholders(plan)]
  .filter((name) => !allowedPlaceholders.has(name));
if (unknownPlaceholders.length > 0) {
  fail(`reproduction-plan.json uses unsupported placeholder(s): ${unknownPlaceholders.join(', ')}`);
}

if (unfinishedBlockedReason(plan.blocked_reason)) {
  fail('blocked_reason describes unfinished agent work rather than an external reproduction blocker; attempt the source-backed setup once, or use a blocker that explains why the live shop cannot faithfully exercise the issue');
}
if (String(plan.derived_from ?? '').trim() && String(plan.derived_from).trim() !== 'null') {
  fail('derived_from must stay null in reproduce bundles; do not research source history, likely fixes, or bug-cause provenance while building fixtures');
}

if (executor === 'playwright') {
  const specPath = String(plan.script_path || 'repro.spec.ts');
  const spec = read(specPath);
  if (!spec) fail(`playwright executor but ${specPath} is missing`);
  const verdictSpec = sanitizePlaywrightSpec(spec);
  const hostileReason = hostilePlaywrightSpecReason(verdictSpec);
  if (hostileReason) fail(hostileReason);

  const executable = stripComments(verdictSpec);
  if (/\{\{[A-Z0-9_]+\}\}/.test(executable)) {
    fail('Playwright spec contains unresolved {{PLACEHOLDER}} tokens; placeholders are substituted only in fixtures/plan seeding, not inside browser-executed test code');
  }
  if (/\bprocess\.env\.(?:SC|NAV_CAT|TAX|CURRENCY|COUNTRY|SALUTATION2?|LANGUAGE|SYSTEM_LANGUAGE|CUSTOMER_GROUP|PAYMENT_METHOD|SHIPPING_METHOD|ORDER_STATE_OPEN|ORDER_DELIVERY_STATE_OPEN|ORDER_TRANSACTION_STATE_OPEN)\b/.test(executable)) {
    fail('Playwright spec must not read install placeholder ids from process.env; fixture placeholders are resolved only during seeding. Seed a concrete route/page/entity in fixtures and navigate by its source-backed technical URL or visible link');
  }
  if (rawAdminApiCallInPlaywright(executable)) {
    fail('Playwright UI repros must not perform raw Admin API setup calls from page.evaluate/fetch or page.request; seed static state with fixtures.json and create/attach runtime browser state through the owning UI flow. If a UI upload generates a media id, attach it via product/CMS/media UI interactions, not an Admin API patch, so auth, placeholders, and screenshots stay faithful');
  }
  if (usesUnstableTmpUploadPath(executable)) {
    fail('Playwright upload files must come from repo-local issue-assets or another file the spec creates in the workspace; do not pass /tmp paths to filechooser.setFiles/setInputFiles because the verifier does not guarantee those files exist');
  }
  if (sourceNeedsFileBackedSeededMedia(executable, fixtures, issueClass)) {
    const missingUploadedBytes = syncSeededMediaRowsMissingUploads(fixtures);
    if (missingUploadedBytes.length > 0) {
      fail(`Playwright UI repro seeds media rows that must render as files, but these media id(s) have no _repro_media_uploads entry: ${missingUploadedBytes.join(', ')}. A media database row alone is not file-backed and can render an empty Media UI or missing thumbnails`);
    }
  }
  if (assumesSeededMediaVisibleInRootGrid(executable, fixtures)) {
    fail('Playwright Media-index repro must not assume a seeded media file is visible in the root folder grid by [data-id]. The Media module can open on a folder overview; first reveal the file with the source/probe-backed current-folder search or navigate to the owning folder context, then select the rendered tile');
  }
  if (createsMediaUsageViaCmsEditorBeforeMediaFlow(executable)) {
    fail('Playwright repro must not create static media/CMS usage state through the Admin CMS editor before exercising a later Media-index replacement flow. Seed the source-owned entity graph and uploaded bytes with fixtures/_repro_media_uploads, then use the CMS editor only when the reported symptom itself is the editor UI');
  }
  if (hasImmediateCountPrecondition(executable)) {
    fail('Playwright preconditions must not throw PRECONDITION_NOT_FOUND from an immediate locator.count() sample; SPA, Admin, and throttled-network pages can still be loading. Use locator.waitFor({ state: "visible", timeout: ... }).catch(...) so absence is decided only after the bounded setup wait');
  }
  const absoluteUploads = absoluteLiteralUploadPaths(executable);
  if (absoluteUploads.length > 0) {
    fail(`Playwright upload path(s) must be workspace-relative, not absolute: ${absoluteUploads.join(', ')}. Use exact prefetched issue-assets/img-*.png paths so the bundle works locally and in CI workspaces`);
  }
  const missingUploads = missingLiteralUploadPaths(executable);
  if (missingUploads.length > 0) {
    fail(`Playwright upload path(s) do not exist in this workspace: ${missingUploads.join(', ')}. Use exact prefetched issue-assets/img-*.png paths or create the file inside the spec before uploading`);
  }
  if (/\bscrollIntoViewIfNeeded\s*\(/.test(executable)) {
    fail('Playwright repros must not use scrollIntoViewIfNeeded(); it uses automation-only scrolling and can hide reachability bugs or burn the test timeout on invisible elements. Use route/state setup, visible target waits, and user-like wheel scrolling only when scrolling itself is part of the reported symptom');
  }
  if (hasUnboundedFileChooserWait(executable)) {
    fail('Playwright file upload flows must bound page.waitForEvent("filechooser", { timeout: ... }); an upload selector that does not open the chooser should fail fast as setup drift instead of burning the full test timeout');
  }
  if (waitsForVisibleFileInput(executable)) {
    fail('Playwright file upload flows must not wait for input[type=file] or Shopware file-input controls to become visible; these inputs can stay hidden while a visible Upload button opens the chooser. Use page.waitForEvent("filechooser", { timeout }) around the visible upload trigger, or wait for the input to be attached only when source proves direct setInputFiles is required');
  }
  if (usesAdminDetailTabAsLink(executable)) {
    fail('Admin detail page tabs such as General, Layout, Variants, SEO, Cross Selling, and Reviews expose ARIA role "tab", not "link"; use getByRole("tab", { name: ... }) for tab-strip navigation to avoid false PRECONDITION_NOT_FOUND failures');
  }
  if (usesUnsupportedPageDisplayValueLocator(executable)) {
    fail('This Playwright runtime does not provide page.getByDisplayValue(); use supported semantic locators such as getByRole("textbox", { name: ... }), getByLabel, getByText markers, or a scoped locator from a visible field/container');
  }
  if (usesCmsCreateLayoutWizardAsSetup(executable, issue)) {
    fail('Playwright repros must not use the Shopping Experiences "Create new layout" wizard merely as setup for an unrelated CMS/media/product symptom; seed CMS pages/sections/blocks/slots through fixtures.json and precondition on the seeded marker instead');
  }
  if (usesCombinedCmsStaticTextLocator(executable, fixtures)) {
    fail('Playwright CMS preconditions must not concatenate separate static CMS text nodes in one getByText locator; gate on one exact seeded heading/text marker or use separate bounded precondition waits for each rendered node');
  }
  if (usesDirectCmsElementClick(executable)) {
    fail('Playwright CMS editor setup must not click rendered .sw-cms-el-* elements directly; the block config overlay intercepts pointer events. Click the visible .sw-cms-block__config-overlay/config control or use a locator copied from probe-ui instead');
  }
  if (waitsForVisibleCmsHiddenEditorControl(executable)) {
    fail('Playwright CMS editor setup must not wait for hidden CMS editor chrome such as .sw-cms-block__config-overlay or .sw-cms-slot__settings-action to become visible; these controls can stay hidden until hover/focus and burn the full timeout. Use probe-ui locators or a bounded click with a short timeout after proving the seeded CMS marker rendered');
  }
  if (!executable.includes('PRECONDITION_NOT_FOUND')) {
    fail('playwright spec has no PRECONDITION_NOT_FOUND precondition gate; missing setup must be inconclusive, not a reproduced/not_reproduced verdict');
  }
  if (passesLocatorToPageWaitForFunction(executable)) {
    fail('Playwright repro must not pass a Locator object into page.waitForFunction/locator.page().waitForFunction; browser predicates receive serializable values or element handles, so this pattern can timeout even when the UI is ready. Use locator.waitFor/click for setup and reserve expect(locator) for the final symptom assertion');
  }
  const expectCount = awaitedExpectCount(executable);
  if (expectCount !== 1) {
    fail(`Playwright specs must contain exactly one awaited expect(); found ${expectCount}. Replace setup expects with page.waitForURL(...) or locator.waitFor({ state: 'visible' }).catch(() => { throw new Error('PRECONDITION_NOT_FOUND: ...'); }) and reserve the single awaited expect for the final healthy symptom assertion`);
  }
  if (!/\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"]visible['"]/s.test(executable)) {
    fail('playwright spec has no visible waitFor precondition; gate the rendered setup with locator.waitFor({ state: "visible", ... }) before the symptom expect');
  }
  if (groupedPreconditionCatch(executable)) {
    fail('Playwright preconditions must not group multiple distinct waits in one PRECONDITION_NOT_FOUND catch; wrap each required marker/control separately so verifier failures name the exact missing state');
  }
  if (playwrightUsesAdminRoute(executable)) {
    const layer = String(plan.layer ?? '');
    if (!layer.includes('admin') || plan.build_profile?.admin_build !== true) {
      fail('Playwright spec navigates to the Administration, so reproduction-plan.json must declare layer "admin-ui" and build_profile.admin_build=true; storefront/theme builds do not provision the Admin surface the spec exercises');
    }
  }
  if (usesSearchRouteForSeededProductSetup(executable, fixtures, `${issue}\n${JSON.stringify(plan.scenario ?? [])}`)) {
    fail('Storefront Playwright repros for non-search issues must not use /search?search=... to reach freshly seeded product fixtures; search indexing can lag or differ across versions. Navigate by a stable technical route such as /detail/<productId> or a seeded /navigation category page, then prove the seeded marker before the final assertion');
  }

  const issueText = [
    issue,
    JSON.stringify(plan.scenario ?? []),
    JSON.stringify(plan.source_trail ?? []),
    String(plan.agent_explanation ?? ''),
    String(plan.confidence_reason ?? ''),
  ].join('\n');
  if (issueClass === 'visual' && clickInterceptionIssue(issueText)) {
    if (!hasPointerHitTestPrecondition(executable)) {
      fail('click-interception/overlap UI repro must prove the hazardous pointer precondition with document.elementFromPoint at the intended click point and throw PRECONDITION_NOT_FOUND when the reported interceptor/geometry is absent; otherwise a healthy click can become a false not_reproduced verdict');
    }
    if (stretchedLinkIssue(issueText) && !hasStretchedLinkPrecondition(executable)) {
      fail('stretched-link click-interception repro must precondition on the .stretched-link title/link in the same target card/container before clicking the buy/control button');
    }
    if (/\.click\s*\(\s*\{[^}]*\bforce\s*:\s*true\b/s.test(executable)) {
      fail('click-interception/overlap repro must not use click({ force: true }); forced clicks bypass Playwright pointer hit-testing and can hide the reported intercepting element');
    }
  }

  if (enableCookbookGuards && wishlistIssue(issue) && !hasEnabledWishlistConfig(fixtures)) {
    fail('wishlist Playwright repro must seed system_config core.cart.wishlistEnabled=true; a missing wishlist button/page is setup failure, not the symptom');
  }
  if (enableCookbookGuards && wishlistIssue(issue)) {
    const productGaps = storefrontProductFixtureGaps(fixtures);
    if (productGaps.length > 0) {
      fail([
        'wishlist/storefront Playwright repro must seed products as storefront-visible before using /detail/<productId>',
        `fixture gaps: ${productGaps.slice(0, 5).join('; ')}`,
        'add both a {{NAV_CAT}} category assignment and sales-channel visibility; a blank product detail page is a seed gap, not the symptom'
      ].join(' — '));
    }
    if (hasGuestWishlistAddWithoutStateProof(executable)) {
      fail('wishlist Playwright repro clicks Add to wishlist and then opens /wishlist without proving the guest wishlist state changed through source-backed storage or pagelet state; wait for localStorage/wishlist storage or a guest-pagelet/add response before navigating, because header wishlist counters/links can be stale or inaccessible setup proof');
    }
    if (wishlistHtmlInjectionIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`) && usesWishlistAddSetup(executable)) {
      fail('wishlist HTML/error-injection repros must not use the Add-to-wishlist UI as setup unless the report is about adding. Seed the guest wishlist through source-owned cookie/localStorage state before opening /wishlist, because the add UI adds unrelated consent-modal and trigger preconditions');
    }
    if (usesContextCookiesForGuestWishlist(executable)) {
      fail('guest wishlist Playwright setup must not rely on context.addCookies() for wishlist-enabled/cookie-preference state; Shopware cookie helpers read document.cookie during plugin load. Set wishlist cookies inside page.evaluate/document.cookie before writing localStorage or using wishlist controls');
    }
    if (requiresWishlistCookieBeforeWishlistAction(executable)) {
      fail('guest wishlist Playwright setup must not require the wishlist-enabled cookie before the wishlist interaction that creates or requests it; the generic cookie banner can accept only technical cookies. Either set wishlist-enabled in document.cookie before plugin-owned state setup, or click the wishlist control and handle/prove the wishlist-specific consent/storage afterwards');
    }
    if (requiresGenericCookieBannerForGuestWishlist(executable)) {
      fail('guest wishlist Playwright setup must not make a generic cookie/privacy banner a required precondition after clicking the wishlist control. Source-backed setup should either seed wishlist-enabled/localStorage directly before the source reads it, or interact with a feature-owned consent control proven by source/probe output');
    }
    if (requiresGenericCookieBannerBeforeWishlistStateSetup(executable)) {
      fail('guest wishlist Playwright setup must not require a generic cookie/privacy banner before direct source-owned wishlist state setup. Set wishlist-enabled and wishlist localStorage in page.evaluate, then prove the resulting source-owned state or rendered seeded product');
    }
    if (usesGenericWishlistRemoveSelector(executable)) {
      fail('wishlist Playwright repros must use the source-backed remove control selector such as button.product-wishlist-btn-remove or a remove-named button; generic form.product-wishlist-form or .wishlist-listing-col button selectors can miss the visible X control and create false negative setup timeouts');
    }
    if (waitsForVisibleWishlistFormContainer(executable)) {
      fail('wishlist Playwright repros must not make form.product-wishlist-form itself a visible precondition; form containers can be absent from the accessibility snapshot or not visibly boxed. Gate on the visible source-backed remove button and seeded product marker instead');
    }
    if (wishlistHtmlInjectionIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`) && lacksWishlistHtmlInjectionAssertion(executable)) {
      fail('wishlist HTML/error-injection repros must make the final healthy assertion rule out injected raw/full-page error HTML, such as Oops/404/<html>/error-code markers or equivalent html/head/body DOM injection. A visible wishlist headline alone can pass on the wrong page state');
    }
  }
  if (enableCookbookGuards && usesSeparateBrowserContextForCrossTabSession(executable, `${issue}\n${JSON.stringify(plan.scenario ?? [])}`)) {
    fail('cross-tab/session Playwright repros must open the second tab with page.context().newPage(), not browser.newPage()/browser.newContext(); separate browser contexts do not share customer cookies or session state, so they can create false negative setup failures');
  }
  if (enableCookbookGuards
    && storefrontAccountFormIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
    && usesBrittleStorefrontAccountLabelLocator(executable)) {
    fail('storefront account/login form repro must use scoped getByRole("textbox", { name }) for email/password fields; getByLabel is brittle on older storefront markup even when the label is visible');
  }
  if (enableCookbookGuards
    && storefrontAccountFormIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
    && usesUnscopedStorefrontAccountLoginInput(executable)) {
    fail('storefront account/login repro must scope email/password locators to the intended login or registration form; /account/login renders multiple email/password inputs, so raw page.locator("input[name=email/password]") patterns can be ambiguous or fill the wrong form');
  }
  if (enableCookbookGuards
    && storefrontAccountFormIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
    && usesBrittleStorefrontAuthChromeProof(executable)) {
    fail('storefront account/login repro must not prove authentication with hidden header/account-menu/logout chrome after submit. Use a login-required route response or a visible marker on an account-only page so auth setup does not time out on chrome that is absent until hover/open');
  }

  if (enableCookbookGuards && cartOffcanvasIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)) {
    const assertionLines = executable
      .split('\n')
      .filter((line) => /\bexpect\s*\(/.test(line))
      .join('\n');
    if (!/\b(cart|off[- ]?canvas|dialog|modal|lineItems?|checkout)\b/i.test(assertionLines)) {
      fail('cart/off-canvas Playwright repro must assert the cart/off-canvas/dialog state; a repeated product link can already be visible on the source card and is only a precondition');
    }
  }

  if (adminUiPlan()) {
    const bootstrapIssue = adminBootstrapIssue(issue);
    if (!bootstrapIssue && directlyFillsAdminLoginFields(executable)) {
      fail('non-login Admin Playwright repros must rely on the harness-provided authenticated storageState and must not fill Username/Password directly; on an already-authenticated route those fields are absent and setup times out before the symptom can run');
    }
    if (!bootstrapIssue && /page\.goto\s*\(\s*['"`]\/admin\/?['"`]/.test(executable)) {
      fail('admin-ui Playwright spec navigates only to the generic Administration shell; use the concrete /admin#/sw/... route for the reported module/action, then precondition on that target state');
    }
    if (enableCookbookGuards && bootstrapIssue) {
      if (!/\b(mobile|small viewport|narrow|phone|responsive)\b/i.test(issue)
        && /test\.use\s*\(\s*\{[^}]*viewport\s*:\s*\{[^}]*width\s*:\s*(?:[1-5]\d{2}|600)\b/s.test(executable)) {
        fail('admin bootstrap/login repro must not force a mobile viewport unless the issue is about mobile/responsive behavior; viewport-specific chrome creates false setup failures');
      }
      if (!hasAdminBootstrapPrecondition(executable)) {
        fail('admin bootstrap/login repro must precondition on the login/bootstrap/admin-shell state itself, not on an unrelated downstream module');
      }
      if (adminLoginFlowIssue(issue) && !hasAdminLoginFlow(executable)) {
        fail('admin login/bootstrap repro for a login or authentication report must exercise the login flow itself: clear auth state, navigate to /admin#/login, fill credentials, submit, then assert visible shell usability. Loading an already-authenticated dashboard is not a faithful login reproduction');
      }
      if (hasBootstrapUsabilityAsPrecondition(executable)) {
        fail('admin bootstrap/login repro must assert shell usability as the single healthy expect; do not convert “admin shell did not become usable within the timeout” into PRECONDITION_NOT_FOUND, because that is the reported symptom');
      }
      if (slow3gIssue(issue) && usesTooFastNetworkProfileForSlow3g(executable)) {
        fail('admin slow-3G repro must use a Slow-3G-like network profile, not Fast 3G. Keep download throughput around 500 kbit/s or lower and latency around 300-400ms; a faster profile can create a false not_reproduced verdict');
      }
      if (slow3gIssue(issue) && usesTooLongBootstrapAssertionTimeout(executable)) {
        fail('admin slow-3G repro must keep the shell-usability assertion near the reported 30-second threshold; using a much longer timeout can mask the reported bootstrap failure');
      }
      if (slow3gIssue(issue) && !hasBootstrapElapsedTimeAssertion(executable)) {
        fail('admin slow-3G repro must measure elapsed time from before navigation/login/bootstrap and assert it stays within the reported threshold; a locator timeout alone starts too late and can miss over-30-second bootstrap failures');
      }
      if (slow3gIssue(issue) && !hasBootstrapShellUsabilityAssertion(executable)) {
        fail('admin slow-3G repro must prove the Administration shell is visibly usable after login within the timed flow. URL changes or hiding the login form can still leave a blank shell, so wait for visible shell chrome such as .sw-admin-menu/.sw-page/dashboard/main navigation as the healthy symptom');
      }
      if (slow3gIssue(issue) && hasTimedPrimitiveAssertion(executable) && !hasFailureScreenshotHook(executable)) {
        fail('admin slow-3G repros that use a primitive timed assertion must add a Playwright test.afterEach failure screenshot hook using page.screenshot({ path: testInfo.outputPath("failure-page.png"), ... }); otherwise a reproduced timing failure can lack visual PNG evidence');
      }
      if (hasUnrelatedAdminModulePrecondition(executable, issue)) {
        fail('admin bootstrap/login repro uses an unrelated module/menu link as a precondition; prove the admin shell or reported login/bootstrap state instead');
      }
    }
    if (enableCookbookGuards && adminMobileNavigationIssue(issue)) {
      if (!/test\.use\s*\(\s*\{[^}]*viewport\s*:\s*\{[^}]*width\s*:\s*(?:[1-5]\d{2}|600)\b/s.test(executable)) {
        fail('mobile admin navigation repro must force a narrow viewport before loading the admin route');
      }
      const opensHeaderMenuButton = /getByRole\s*\(\s*['"]banner['"]\s*\)[\s\S]{0,160}getByRole\s*\(\s*['"]button['"]/s.test(executable)
        || /locator\s*\(\s*['"`]\.sw-search-bar__mobile-controls\s+\.sw-search-bar__button['"`]\s*\)/s.test(executable);
      if (!opensHeaderMenuButton) {
        fail('mobile admin navigation repro must open the actual header hamburger/menu button before interacting with sidebar links; use the scoped banner button or the source-backed .sw-search-bar__mobile-controls .sw-search-bar__button locator, not a generic first button or nested menu text');
      }
      if (usesRawAdminMobileToggleSelector(executable)) {
        fail('mobile admin navigation repro must narrow the source-backed mobile toggle selector with .first(): use page.locator(".sw-search-bar__mobile-controls .sw-search-bar__button").first() so setup does not depend on ambiguous matched controls');
      }
      if (adminMobileRouteNavigationIssue(issue)
        && !clicksAdminMobileNavigationLink(executable)) {
        fail('mobile admin route-navigation repro must click the issue-specific link inside the opened off-canvas menu; use an ARIA link locator or the source-backed .sw-admin-menu__navigation-link locator, not an outside click');
      }
      if (adminMobileRouteNavigationIssue(issue)
        && /page\.mouse\.click\s*\(/s.test(executable)) {
        fail('mobile admin route-navigation repro must not replace the reported menu-item/link click with a generic outside click; click the opened menu link and then assert the off-canvas state');
      }
      if (adminMobileRouteNavigationIssue(issue)
        && hasUnboundedClick(executable)) {
        fail('mobile admin route-navigation repro must bound setup clicks with click({ timeout: ... }) and convert failures to PRECONDITION_NOT_FOUND; off-canvas text can be visible while outside the viewport and an unbounded click can waste the full test timeout');
      }
      if (adminMobileRouteNavigationIssue(issue)
        && usesAdminMobileModuleHeadingGate(executable)) {
        fail('mobile admin route-navigation repro must not gate module pages with getByRole("heading", { name: ... }); mobile Admin module titles can be visible without heading semantics. Gate route changes with URL/hash, then assert the off-canvas navigation state');
      }
      if (adminMobileRouteNavigationIssue(issue)
        && usesAdminMobileDestinationContentGate(executable)) {
        fail('mobile admin route-navigation repro must not make destination-page text/content a decisive precondition after the URL/hash changed; for menu/off-canvas bugs, prove the opened menu and clicked link, then assert the off-canvas navigation state');
      }
      if (adminMobileRouteNavigationIssue(issue)
        && usesAdminMenuGroupAsLink(executable)) {
        fail('mobile admin route-navigation repro must not treat top-level Admin menu groups such as Catalogues, Orders, Customers, Content, Marketing, or Extensions as links. Open the group by its visible text/control, then click the nested issue-specific link such as Products');
      }
      if (adminMobileRouteNavigationIssue(issue)
        && usesAdminMobileClassOnlyClosureAssertion(executable)) {
        fail('mobile admin route-navigation repro must assert visual menu closure, for example the navigation/off-canvas is not in the viewport; checking only that is--off-canvas-shown was removed can pass while the menu still visibly covers the page');
      }
    }
    if (!bootstrapIssue && !hasTargetedAdminPrecondition(executable)) {
      fail([
        'admin-ui Playwright spec preconditions are too generic',
        'wait for the issue-specific module/action/entity/control before the symptom expect',
        'dashboard, shell, navigation, toolbar, or Home chrome can prove the admin loaded but cannot prove the reported state is exercisable'
      ].join(' — '));
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && !syncSeedsMediaRows(fixtures)
      && createsOriginalMediaOutsideMediaLibraryForReplacement(executable)
      && specUsesMediaLibraryReplaceFlow(executable)) {
      fail('admin media replacement/upload repro must seed the original media row plus _repro_media_uploads before opening the replace flow. Creating the original media through CMS/editor upload UI is brittle setup drift; the reported symptom belongs to replacing an already referenced Media-library item');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && syncSeedsMediaRows(fixtures)
      && syncSeededMediaRowsMissingUploads(fixtures).length > 0
      && specUsesMediaLibraryReplaceFlow(executable)) {
      fail(`admin media replacement/upload repro must not rely on sync-seeded media rows as visible replaceable files; media row(s) without seed-time uploaded bytes: ${syncSeededMediaRowsMissingUploads(fixtures).join(', ')}. Add _repro_media_uploads entries for those media ids so they have hasFile=true before the browser opens the Media library`);
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && syncSeedsMediaRows(fixtures)
      && specUsesMediaLibraryReplaceFlow(executable)
      && mediaLibraryUploadCountBeforeAssertion(executable) >= 2
      && mediaSelectionCountBeforeAssertion(executable) < 2) {
      fail('admin media replacement/upload repro that uses a two-pass replace flow must reselect the same Media-library item after the first replace modal closes and before opening the second replace modal; the quick-action sidebar can reset to “No media selected” after replacement');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && specUsesMediaLibraryReplaceFlow(executable)
      && productLayoutPreconditionForMediaReplacement(executable)) {
      fail('admin media replacement repro must not make the product layout/CMS assignment screen a decisive PRECONDITION_NOT_FOUND gate before the Media-library replacement flow. Use source-derived fixtures to create the usage relation, optionally sanity-check the marker, then gate the actual setup on the replaceable media item/control in /admin#/sw/media/index');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && specUsesMediaLibraryReplaceFlow(executable)
      && productMediaPreconditionForMediaReplacement(executable)) {
      fail('admin media replacement repro must not make the product detail media tab/upload form a decisive PRECONDITION_NOT_FOUND gate before the Media-library replacement flow. Product detail media routes can render a blank shell or differ across versions; create the usage relation with source-derived fixtures or the owning UI flow, then gate the actual symptom on the replaceable media item/control in /admin#/sw/media/index');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && cmsEditorTextClick(executable)) {
      fail('admin CMS/media editor repro must not click visible CMS block text to select the block; the CMS config overlay intercepts pointer events. If the symptom is Media-library replacement, use the CMS page only as a seeded-state gate, then exercise replacement from /admin#/sw/media/index. If CMS editor controls are the reported target, click a real block overlay/control with a bounded click and convert failure to PRECONDITION_NOT_FOUND');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && usesCmsEditorSlotConfigForMediaReplacement(executable)) {
      fail('admin media replacement repro must not open CMS editor slot settings/config as setup for a Media-library replace flow. Once the seeded CMS page marker/image renders, go directly to /admin#/sw/media/index and exercise the replace modal there; CMS editor controls are too brittle and are not the reported symptom');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && usesCmsCanvasSlotGateForMediaReplacement(executable)) {
      fail('admin media replacement repro must not make CMS canvas slot/image selectors a decisive PRECONDITION_NOT_FOUND gate before the Media-library replace flow. CMS canvas markup is brittle across versions; use source-derived fixtures to create the usage relation, optionally sanity-check a simple seeded CMS page marker, then gate the symptom on the selected Media-library item and replace modal');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && usesCmsMediaFilenameGateForMediaReplacement(executable)) {
      fail('admin media replacement repro must not make CMS detail filename/text visibility a decisive PRECONDITION_NOT_FOUND gate before the Media-library replace flow. CMS canvases usually render images, not source filenames; use fixtures to create the usage relation, optionally sanity-check a simple seeded CMS page marker or image presence, then gate the symptom on the selected Media-library item and replace modal');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && specUsesMediaLibraryReplaceFlow(executable)
      && !hasReplaceModalAnchor(executable)) {
      fail('admin media replacement/upload repro must anchor the final symptom in the visible replace modal with a .sw-media-modal-replace precondition before asserting the Replace action; generic Media page screenshots or stale hidden buttons are not enough visual evidence');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && specUsesMediaLibraryReplaceFlow(executable)
      && mediaReplacementWaitsForUploadCompletionBeforeReplaceCommit(executable)) {
      fail('admin media replacement/upload repro must not wait for upload completion before clicking or asserting the replace modal action. In staged upload modals, file selection can show progress while the explicit Replace button is the commit action; after setInputFiles, gate on the staged file/visible modal and assert or click the Replace action according to the reported symptom');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && specUsesMediaLibraryReplaceFlow(executable)
      && mediaReplacementAllowsOriginalFilenameAsStagingMarker(executable, fixtures)) {
      fail('admin media replacement/upload repro must not use the original media filename as a replacement staging precondition after the final upload. Gate on the newly selected file or a source-backed modal preview state, then assert the Replace action');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && specUsesMediaLibraryReplaceFlow(executable)
      && !mediaReplacementHasFinalUploadCompletionGate(executable)) {
      fail('admin media replacement/upload repro must wait for the final upload to complete before asserting the Replace action. After the last setFiles/setInputFiles/filechooser upload, wait for a source-backed completion marker such as upload-progress disappearance or an upload response; a filename/preview alone can still be visible while the upload is in progress');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && usesUnscopedMediaSearchbox(executable)) {
      fail('admin media replacement/upload repro must not use page.getByRole("searchbox") for Media-library filtering; it can focus the global Admin search overlay. Scope the current-folder Media search from probe-ui/source markup, or avoid search when the seeded media tile is already visible');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && usesTagQualifiedMediaQuickactionReplace(executable)) {
      fail('admin media replacement/upload repro must not tag-qualify the quickaction replace selector such as button.quickaction--replace; the Media sidebar action can render under a different element tag. Use the visible Replace/Ersetzen action locator or the unqualified .quickaction--replace class after proving the selected media item');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && usesMisScopedMediaSearchInput(executable)) {
      fail('admin media replacement/upload repro must not scope the current-folder Media search to main/content containers unless probe-ui printed that exact scope. The search input can render in the header area; use the source/probe-derived Media search locator or avoid search when the seeded media tile is already visible');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && usesMediaQuickinfoHeadingGate(executable)) {
      fail('admin media replacement/upload repro must not require the Media quickinfo sidebar title to be a heading matching the filename. After selecting the media item, gate on the issue-specific selected tile and visible Replace quick action instead; the sidebar can show warnings or metadata without a filename heading');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && mediaReplacementModalWithoutMediaLibraryNavigation(executable)) {
      fail('admin media replacement/upload repro must open the replace modal from the Media library owner surface. Do not infer a generic Replace action from CMS/product detail pages; create the usage relation with fixtures or the owning UI flow, navigate to /admin#/sw/media/index, select the seeded media item, and then open the visible Replace quick action');
    }
    if (enableCookbookGuards && adminMediaReplacementIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`)
      && specUsesMediaLibraryReplaceFlow(executable)
      && !syncSeedsMediaRows(fixtures)) {
      fail('admin media replacement/upload repro must seed the original replace target media row plus _repro_media_uploads instead of relying on built-in CMS/product/demo media. The reported symptom is replacing an already referenced Media-library item, so the original file and its usage relation must be deterministic fixture state before opening the replace modal');
    }
    if (!bootstrapIssue
      && !(enableCookbookGuards && adminMobileNavigationIssue(`${issue}\n${JSON.stringify(plan.scenario ?? [])}`))
      && hasGenericAdminChromeFailure(executable, issue)) {
      fail([
        'admin-ui Playwright spec uses generic Admin chrome as a decisive PRECONDITION_NOT_FOUND gate',
        'Back/Save/dashboard/toolbar waits are version-specific shell checks and must not decide the run unless the issue is about that chrome',
        'gate on the seeded issue target instead, such as the product value, CMS page/block, row, field value, modal action, or media item'
      ].join(' — '));
    }
  }

  const fixtureTerms = normalizeTerms(collectControlledTerms(fixtures));
  if (issueClass === 'visual' && fixtureTerms.length > 0) {
    const preconditions = preconditionActionSnippet(executable);
    const matched = fixtureTerms.filter((term) => snippetContainsTermOrAlias(executable, preconditions, term));
    if (matched.length === 0) {
      fail([
        'visual playwright spec precondition locators do not wait for any controlled seeded fixture marker',
        `derived candidate markers: ${fixtureTerms.slice(0, 20).join(', ')}`,
        'the marker must appear in the locator/control being waited on, not only in comments or PRECONDITION_NOT_FOUND text',
        'precondition on the exact seeded entity/container that makes the symptom possible, not generic page chrome'
      ].join(' — '));
    }
  }
}

if (enableCookbookGuards && executor === 'playwright' && selectedVariantIssue(issue)) {
  const specPath = String(plan.script_path || 'repro.spec.ts');
  const spec = read(specPath);
  if (!spec) fail(`selected/specific variant issue but ${specPath} is missing`);

  const executable = stripComments(sanitizePlaywrightSpec(spec));
  if (cmsProductSliderVariantIssue(issue)) {
    const variantNames = childVariantNamesContainingOptionTerms(fixtures);
    if (variantNames.length > 0) {
      fail([
        'CMS product-slider selected-variant repro encodes option text into the child variant name',
        `child names: ${variantNames.join(', ')}`,
        'this can mask an empty/missing-card bug by changing what the stock product card renders',
        'keep variant names faithful to the source/test-derived product graph and assert the real card/field the reported UI should render'
      ].join(' — '));
    }
  }
  const assertionLines = executable
    .split('\n')
    .filter((line) => /\b(expect|getByText|getByRole|getByLabel|getByTestId|locator|toContainText|toHaveText|textContent)\b/.test(line))
    .join('\n');

  const terms = collectVariantTerms(fixtures);
  const assertedTerms = terms.filter((term) => assertionLines.includes(term));
  const customFieldTerms = normalizeTerms(collectCustomFieldTerms(fixtures));
  const assertedCustomFieldTerms = customFieldTerms.filter((term) => assertionLines.includes(term));
  if (assertedCustomFieldTerms.length > 0) {
    fail([
      'selected/specific variant issue but the Playwright assertion uses seeded customFields text',
      `custom field values found in assertion: ${assertedCustomFieldTerms.join(', ')}`,
      'do not invent hidden sentinel text; assert a variant value the stock storefront/admin actually renders, such as the option name, product number, or real product-card variant characteristic'
    ].join(' — '));
  }
  if (terms.length === 0) {
    fail('selected/specific variant issue but fixtures.json contains no child-variant option name or product number to assert');
  }
  if (assertedTerms.length === 0) {
    fail([
      'selected/specific variant issue but the Playwright spec does not assert any distinguishing selected-variant value',
      `derived candidate values: ${terms.join(', ')}`,
      'assert the selected option/product number/variant marker in executable locator or expect code; a generic parent product card is insufficient'
    ].join(' — '));
  }
}

if (executor === 'http') {
  const assertions = assertionsFromPlan(plan);
  const responseFieldAssertions = assertions.filter((assertion) => (
    String(assertion?.role ?? 'assert') !== 'precondition'
      && (assertion?.field || assertion?.kind === 'response_field')
  ));
  const hasFinalStatusPrecondition = assertions.some((assertion) => (
    assertion?.role === 'precondition'
      && String(assertion?.kind ?? (assertion?.field ? 'response_field' : 'http_status')) === 'http_status'
      && /^2\d\d$/.test(String(assertion?.expect ?? ''))
  ));
  if (responseFieldAssertions.length > 0 && !hasFinalStatusPrecondition) {
    fail('http response-field symptom assertions must include a final 2xx http_status precondition; otherwise a setup/route/auth failure can be misclassified as the reported symptom');
  }

  const requests = Array.isArray(plan.requests) ? plan.requests : [plan.request].filter(Boolean);
  const navigationRequest = requests.some((request) => /^\/store-api\/navigation\//.test(String(request?.path ?? '')));
  if (navigationRequest && !hasSeededNavigationCategory(fixtures)) {
    fail('Store API navigation repros must seed a concrete active category below {{NAV_CAT}} and precondition on that seeded id/name; relying on the default install tree can return an empty HTTP 200 and false inconclusive');
  }
  if (navigationRequest && assertions.some((assertion) => assertion?.role === 'precondition' && String(assertion?.field ?? '') === '.id')) {
    fail('Store API navigation responses can be trees/arrays/wrapped objects; do not use root `.id` as a precondition. Use a recursive/tree-tolerant jq expression such as `[.. | objects | select(has("id"))] | length`.');
  }
  for (const request of requests) {
    const method = String(request?.method ?? 'GET').toUpperCase();
    const path = String(request?.path ?? '');
    if (method === 'GET' && /^\/store-api\/account\/address(?:\?|$)/.test(path)) {
      fail('store-api account address listing uses POST /store-api/account/address, not GET; wrong method returns 405 and makes the repro inconclusive');
    }
    if (method === 'POST' && /^\/store-api\/account\/register(?:\?|$)/.test(path)) {
      let body = null;
      try { body = JSON.parse(String(request?.body ?? '{}')); } catch {}
      const missingRootBillingFields = ['countryId', 'street', 'zipcode', 'city']
        .filter((field) => !body?.[field]);
      if (body?.billingAddress && missingRootBillingFields.length > 0) {
        fail(`store-api account/register payload puts billingAddress in a nested object but omits required top-level billing field(s): ${missingRootBillingFields.join(', ')}; Shopware returns 400 before the symptom can run`);
      }
    }
  }
}

console.log('== validate-bundle: ok ==');
