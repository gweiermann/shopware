#!/usr/bin/env node
// Register the proxy URLs as sales-channel domains so the Storefront resolves when the agent reaches
// the shop through the sandbox proxy (host.docker.internal:18080) rather than localhost:8000. Clones
// an existing domain row's language/currency/snippet set for each missing URL.
//
// Env: ADMIN_API_URL (or REPRO_HOST_APP_URL/APP_URL), STOREFRONT_DOMAIN_URLS (comma-separated),
//      ADMIN_USER (admin), ADMIN_PASS (shopware).
import crypto from 'node:crypto';

const base = (process.env.ADMIN_API_URL || process.env.REPRO_HOST_APP_URL || process.env.APP_URL || '').replace(/\/$/, '');
const urls = (process.env.STOREFRONT_DOMAIN_URLS || '').split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);
const fail = (m) => { console.error(`::error::${m}`); process.exit(1); };
if (!base) fail('ADMIN_API_URL / REPRO_HOST_APP_URL / APP_URL is required');
if (!urls.length) fail('STOREFRONT_DOMAIN_URLS is required');

async function request(path, options = {}) {
  const res = await fetch(`${base}${path}`, { ...options, headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 700)}`);
  return text ? JSON.parse(text) : {};
}

const { access_token: token } = await request('/api/oauth/token', { method: 'POST', body: JSON.stringify({ grant_type: 'password', client_id: 'administration', username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'shopware', scopes: 'write' }) });
if (!token) fail('Admin OAuth response did not include an access_token');
const admin = (path, options = {}) => request(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });

const rowUrl = (row) => String(row?.url || '').replace(/\/$/, '');
const domains = (await admin('/api/search/sales-channel-domain', { method: 'POST', body: JSON.stringify({ limit: 50, associations: { salesChannel: {} } }) })).data || [];
const template = domains.find((r) => r.salesChannel?.active !== false) || domains[0];
if (!template) fail('no sales_channel_domain row to clone for sandbox storefront access');

const cloned = { salesChannelId: template.salesChannelId, languageId: template.languageId, currencyId: template.currencyId, snippetSetId: template.snippetSetId };
for (const [name, value] of Object.entries(cloned)) if (!value) fail(`could not read ${name} from an existing sales_channel_domain row`);

const existing = new Set(domains.map(rowUrl));
const payload = urls.filter((u) => !existing.has(u)).map((url) => ({ id: crypto.randomUUID().replace(/-/g, ''), url, ...cloned }));
if (payload.length) {
  const result = await admin('/api/_action/sync', { method: 'POST', body: JSON.stringify({ 'repro-sales-channel-domain': { entity: 'sales_channel_domain', action: 'upsert', payload } }) });
  if (result.errors && Object.keys(result.errors).length) fail(`sync reported errors: ${JSON.stringify(result.errors).slice(0, 1000)}`);
}

const verified = new Set(((await admin('/api/search/sales-channel-domain', { method: 'POST', body: JSON.stringify({ limit: 100, filter: [{ type: 'equalsAny', field: 'url', value: urls }] }) })).data || []).map(rowUrl));
const missing = urls.filter((u) => !verified.has(u));
if (missing.length) fail(`sales_channel_domain upsert did not persist: ${missing.join(', ')}`);
console.log(`storefront domains present: ${urls.join(', ')}`);
