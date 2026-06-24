#!/usr/bin/env node
import crypto from 'node:crypto';

const adminBaseUrl = (process.env.ADMIN_API_URL || process.env.REPRO_HOST_APP_URL || process.env.APP_URL || '').replace(/\/$/, '');
const adminUser = process.env.ADMIN_USER || 'admin';
const adminPass = process.env.ADMIN_PASS || 'shopware';
const urls = (process.env.STOREFRONT_DOMAIN_URLS || '')
  .split(',')
  .map((url) => url.trim().replace(/\/$/, ''))
  .filter(Boolean);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (!adminBaseUrl) fail('ADMIN_API_URL, REPRO_HOST_APP_URL, or APP_URL is required');
if (urls.length === 0) fail('STOREFRONT_DOMAIN_URLS is required');

async function request(path, options = {}) {
  const response = await fetch(`${adminBaseUrl}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 700)}`);
  }
  return text ? JSON.parse(text) : {};
}

const tokenResponse = await request('/api/oauth/token', {
  method: 'POST',
  body: JSON.stringify({
    grant_type: 'password',
    client_id: 'administration',
    username: adminUser,
    password: adminPass,
    scopes: 'write',
  }),
});
const token = tokenResponse.access_token;
if (!token) fail('Admin OAuth response did not include an access_token');

async function admin(path, options = {}) {
  return request(path, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
}

const domains = await admin('/api/search/sales-channel-domain', {
  method: 'POST',
  body: JSON.stringify({
    limit: 50,
    associations: {
      salesChannel: {},
    },
  }),
});

const rows = domains.data || [];
function field(row, name) {
  return row?.[name] ?? row?.attributes?.[name] ?? null;
}

function rowUrl(row) {
  return String(field(row, 'url') || '').replace(/\/$/, '');
}

const template = rows.find((row) => (row.salesChannel?.active ?? row.attributes?.salesChannel?.active) !== false) || rows[0];
if (!template) fail('No sales_channel_domain row exists to clone for sandbox storefront access');

const templateFields = {
  salesChannelId: field(template, 'salesChannelId'),
  languageId: field(template, 'languageId'),
  currencyId: field(template, 'currencyId'),
  snippetSetId: field(template, 'snippetSetId'),
};
for (const [name, value] of Object.entries(templateFields)) {
  if (!value) fail(`Could not read ${name} from existing sales_channel_domain row`);
}

const existing = new Set(rows.map(rowUrl));
const payload = urls
  .filter((url) => !existing.has(url))
  .map((url) => ({
    id: crypto.randomUUID().replace(/-/g, ''),
    url,
    ...templateFields,
  }));

if (payload.length > 0) {
  const syncResult = await admin('/api/_action/sync', {
    method: 'POST',
    body: JSON.stringify({
      'repro-sales-channel-domain': {
        entity: 'sales_channel_domain',
        action: 'upsert',
        payload,
      },
    }),
  });
  if (syncResult.errors && Object.keys(syncResult.errors).length > 0) {
    fail(`Sync API reported sales_channel_domain errors: ${JSON.stringify(syncResult.errors).slice(0, 1000)}`);
  }
}

const verified = await admin('/api/search/sales-channel-domain', {
  method: 'POST',
  body: JSON.stringify({
    limit: 100,
    filter: [{ type: 'equalsAny', field: 'url', value: urls }],
  }),
});
const verifiedUrls = new Set((verified.data || []).map(rowUrl));
const missing = urls.filter((url) => !verifiedUrls.has(url));
if (missing.length > 0) {
  fail(`Sales channel domain upsert did not persist: ${missing.join(', ')}`);
}

console.log(`Storefront domains present: ${urls.join(', ')}`);
