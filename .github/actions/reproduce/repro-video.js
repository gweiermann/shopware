// Optional narrated-video helpers for Playwright specs. They are NO-OPS unless REPRO_VIDEO_MODE is
// set (the trunk-only narrated pass), and `repro validate`/the executor strip them before the
// deterministic run — so a spec reads cleanly and behaves identically with or without them. Use
// `narrate(page, "…")` for on-screen subtitles and `clickMarked`/`fillMarked` for highlighted actions.
function videoModeEnabled() {
  return process.env.REPRO_VIDEO_MODE === '1' || process.env.REPRO_VIDEO_MODE === 'true';
}

function envNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? value : fallback;
}

async function stepDelay(page, ms = envNumber('REPRO_STEP_DELAY', 500)) {
  if (videoModeEnabled() && ms > 0) await page.waitForTimeout(ms);
}

async function showStep(page, text, ms = envNumber('REPRO_SUBTITLE_DELAY', 1300)) {
  if (!videoModeEnabled()) return;
  await page.evaluate((message) => {
    let subtitle = document.querySelector('[data-repro-subtitle]');
    if (!subtitle) {
      subtitle = document.createElement('div');
      subtitle.setAttribute('data-repro-subtitle', 'true');
      Object.assign(subtitle.style, {
        position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)',
        zIndex: '2147483647', maxWidth: 'min(900px, calc(100vw - 48px))', padding: '12px 16px',
        borderRadius: '6px', background: 'rgba(10, 18, 32, 0.92)', color: '#fff',
        font: '600 18px/1.35 Arial, sans-serif', textAlign: 'center',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.28)', pointerEvents: 'none',
      });
      document.body.appendChild(subtitle);
    }
    subtitle.textContent = message;
  }, text);
  await stepDelay(page, ms);
}

// `narrate` is the friendly alias for a subtitle that lingers, used in the guides.
async function narrate(page, text) { await showStep(page, text); }
async function showFinalStep(page, text) { await showStep(page, text, 0); }

async function clearStep(page) {
  if (!videoModeEnabled()) return;
  await page.evaluate(() => document.querySelectorAll('[data-repro-subtitle]').forEach((n) => n.remove()));
}

async function markLocator(locator, label = 'target') {
  if (!videoModeEnabled()) return;
  await locator.scrollIntoViewIfNeeded();
  const handle = await locator.elementHandle();
  if (!handle) throw new Error(`Cannot mark locator "${label}" — it did not resolve to an element.`);
  await handle.evaluate((element, markerLabel) => {
    const rect = element.getBoundingClientRect();
    const marker = document.createElement('div');
    marker.setAttribute('data-repro-click-marker', markerLabel);
    marker.setAttribute('aria-label', markerLabel);
    Object.assign(marker.style, {
      position: 'fixed', left: `${Math.max(8, rect.left + rect.width / 2 - 20)}px`,
      top: `${Math.max(8, rect.top + rect.height / 2 - 20)}px`, zIndex: '2147483647',
      width: '40px', height: '40px', border: '4px solid #ff3d00', borderRadius: '999px',
      background: 'transparent', boxShadow: '0 0 0 6px rgba(255, 61, 0, 0.22)', pointerEvents: 'none',
    });
    document.body.appendChild(marker);
  }, label);
}

async function clearMarkers(page) {
  if (!videoModeEnabled()) return;
  await page.evaluate(() => document.querySelectorAll('[data-repro-click-marker]').forEach((n) => n.remove()));
}

async function clickMarked(page, locator, label = 'click') {
  await markLocator(locator, label);
  await stepDelay(page, envNumber('REPRO_MARKER_DELAY', 800));
  await locator.click();
  await stepDelay(page);
  await clearMarkers(page);
}

async function fillMarked(page, locator, value, label = 'type') {
  await markLocator(locator, label);
  await stepDelay(page, envNumber('REPRO_MARKER_DELAY', 800));
  await locator.fill(value);
  await stepDelay(page);
  await clearMarkers(page);
}

module.exports = { videoModeEnabled, narrate, showStep, showFinalStep, clearStep, markLocator, clearMarkers, clickMarked, fillMarked, stepDelay };
