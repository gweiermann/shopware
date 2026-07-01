import { defineConfig } from '@playwright/test';
import { cwd } from 'node:process';

// Config for a single generated repro spec. The playwright executor copies the spec next to this
// file and runs it, so `testDir: '.'` collects exactly that one spec. baseURL is the leg's running
// shop; the json report drives the machine verdict, the html report is uploaded for humans.
// PW_VIDEO is set per-run by the executor: 'off' for the verdict run, 'on' for the separate trunk
// video pass (which also slows actions down so the recording is followable).
const video = process.env['PW_VIDEO'] === 'on';

export default defineConfig({
  testDir: '.',
  testIgnore: ['**/demo/**'],
  timeout: 120_000, // a repro is a multi-step flow on a fresh shop; 30s default aborts mid-flow
  outputDir: process.env['PW_OUTPUT_DIR'] || `${cwd()}/test-results`,
  reporter: [
    ['json', { outputFile: process.env['PW_JSON_REPORT'] || `${cwd()}/pw-report.json` }],
    ['html', { outputFolder: process.env['PW_HTML_REPORT'] || `${cwd()}/playwright-report`, open: 'never' }],
  ],
  use: {
    baseURL: process.env['APP_URL'],
    // Admin specs start authenticated (login-state.mjs); storefront specs start consented
    // (consent-state.mjs). Either is passed here so specs never author their own auth.
    storageState: process.env['PW_STORAGE'] || undefined,
    trace: 'on',
    video: video ? 'on' : 'off',
    screenshot: 'on',
    launchOptions: { slowMo: video ? Number(process.env['REPRO_VIDEO_SLOWMO'] || 400) : 0 },
  },
});
