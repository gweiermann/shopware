// Deterministic admin login → Playwright storageState.
//
// Generated specs kept re-inventing the login preamble and intermittently fumbling it
// (getByLabel(/password/i) strict-mode violations, un-waited isVisible, ...). Login is
// HARNESS work, not repro work: do it once here with proven locators, save the session
// (cookies + localStorage, where the admin keeps its bearer token), and let every
// generated admin spec start authenticated.
//
// Usage: node login-state.mjs <APP_URL> <out-state.json>   (exit 0 = state saved)
import { chromium } from '@playwright/test';

const [appUrl, out] = process.argv.slice(2);
if (!appUrl || !out) { console.error('usage: login-state.mjs <APP_URL> <out.json>'); process.exit(2); }
const adminUser = process.env.SW_ADMIN_USER ?? process.env.ADMIN_USER ?? 'admin';
const adminPass = process.env.SW_ADMIN_PASS ?? process.env.ADMIN_PASS ?? 'shopware';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`${appUrl}/admin`, { waitUntil: 'domcontentloaded' });

  // Prefer semantic locators, but fall back to stable input attributes because older
  // Admin versions expose different translated/compound labels for the username field.
  const user = page.getByRole('textbox', { name: /username|email/i })
    .or(page.locator('input[name="username"], input[name="email"], input[type="text"]').first())
    .first();
  await user.waitFor({ state: 'visible', timeout: 60_000 });
  await user.fill(adminUser);
  const password = page.getByRole('textbox', { name: /password/i })
    .or(page.locator('input[type="password"], input[name="password"]').first())
    .first();
  await password.fill(adminPass);
  await page.getByRole('button', { name: /log in|sign in/i })
    .or(page.locator('button[type="submit"]').first())
    .first()
    .click();

  // Authenticated shell is up when the global searchbox renders (stable across versions).
  await page.getByRole('searchbox')
    .or(page.locator('.sw-search-bar, .sw-admin-menu, .sw-desktop').first())
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 });

  await page.context().storageState({ path: out });
  console.log(`admin storageState saved to ${out}`);
  process.exit(0);
} catch (e) {
  console.error(`admin login failed: ${e.message?.split('\n')[0]}`);
  process.exit(1);
} finally {
  await browser.close();
}
