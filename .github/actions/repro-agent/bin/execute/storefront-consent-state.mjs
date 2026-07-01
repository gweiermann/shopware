#!/usr/bin/env node
import fs from 'node:fs';

const [appUrlArg, outArg = 'storefront-state.json'] = process.argv.slice(2);

if (!appUrlArg) {
  console.error('usage: storefront-consent-state.mjs <APP_URL> [storage-state.json]');
  process.exit(2);
}

const appUrl = new URL(appUrlArg);
const out = outArg;
const groupsUrl = new URL('/cookie/groups', appUrl);

let cookieConfigHash = '{}';
try {
  const response = await fetch(groupsUrl, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    signal: AbortSignal.timeout(3000),
  });
  if (response.ok) {
    const data = await response.json();
    if (data?.languageId && data?.hash) {
      cookieConfigHash = JSON.stringify({ [data.languageId]: data.hash });
    }
  }
} catch {
  cookieConfigHash = '{}';
}

const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
fs.writeFileSync(out, `${JSON.stringify({
  cookies: [
    {
      name: 'cookie-preference',
      value: '1',
      domain: appUrl.hostname,
      path: '/',
      expires,
      httpOnly: false,
      secure: appUrl.protocol === 'https:',
      sameSite: 'Lax',
    },
    {
      name: 'cookie-config-hash',
      value: cookieConfigHash,
      domain: appUrl.hostname,
      path: '/',
      expires,
      httpOnly: false,
      secure: appUrl.protocol === 'https:',
      sameSite: 'Lax',
    },
  ],
  origins: [],
}, null, 2)}\n`);

fs.chmodSync(out, 0o600);
