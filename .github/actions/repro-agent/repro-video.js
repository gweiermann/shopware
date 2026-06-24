function videoModeEnabled() {
    return process.env.REPRO_VIDEO_MODE === '1' || process.env.REPRO_VIDEO_MODE === 'true';
}

function envNumber(name, fallback) {
    const value = Number(process.env[name] || fallback);
    return Number.isFinite(value) ? value : fallback;
}

async function stepDelay(page, ms = envNumber('REPRO_STEP_DELAY', 500)) {
    if (!videoModeEnabled() || ms <= 0) {
        return;
    }

    await page.waitForTimeout(ms);
}

async function showStep(page, text, ms = envNumber('REPRO_SUBTITLE_DELAY', 1300)) {
    if (!videoModeEnabled()) {
        return;
    }

    await page.evaluate((message) => {
        let subtitle = document.querySelector('[data-repro-subtitle]');

        if (!subtitle) {
            subtitle = document.createElement('div');
            subtitle.setAttribute('data-repro-subtitle', 'true');
            subtitle.style.position = 'fixed';
            subtitle.style.left = '50%';
            subtitle.style.bottom = '24px';
            subtitle.style.transform = 'translateX(-50%)';
            subtitle.style.zIndex = '2147483647';
            subtitle.style.maxWidth = 'min(900px, calc(100vw - 48px))';
            subtitle.style.padding = '12px 16px';
            subtitle.style.borderRadius = '6px';
            subtitle.style.background = 'rgba(10, 18, 32, 0.92)';
            subtitle.style.color = '#fff';
            subtitle.style.font = '600 18px/1.35 Arial, sans-serif';
            subtitle.style.textAlign = 'center';
            subtitle.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.28)';
            subtitle.style.pointerEvents = 'none';
            document.body.appendChild(subtitle);
        }

        subtitle.textContent = message;
    }, text);

    await stepDelay(page, ms);
}

async function showFinalStep(page, text) {
    await showStep(page, text, 0);
}

async function clearStep(page) {
    if (!videoModeEnabled()) {
        return;
    }

    await page.evaluate(() => {
        document.querySelectorAll('[data-repro-subtitle]').forEach((subtitle) => subtitle.remove());
    });
}

async function markLocator(locator, label = 'target') {
    if (!videoModeEnabled()) {
        return;
    }

    await locator.scrollIntoViewIfNeeded();

    const handle = await locator.elementHandle();
    if (!handle) {
        throw new Error(`Cannot mark locator "${label}" because it did not resolve to an element.`);
    }

    await handle.evaluate((element, markerLabel) => {
        const rect = element.getBoundingClientRect();
        const marker = document.createElement('div');
        marker.setAttribute('data-repro-click-marker', markerLabel);
        marker.setAttribute('aria-label', markerLabel);
        marker.style.position = 'fixed';
        marker.style.left = `${Math.max(8, rect.left + rect.width / 2 - 20)}px`;
        marker.style.top = `${Math.max(8, rect.top + rect.height / 2 - 20)}px`;
        marker.style.zIndex = '2147483647';
        marker.style.width = '40px';
        marker.style.height = '40px';
        marker.style.border = '4px solid #ff3d00';
        marker.style.borderRadius = '999px';
        marker.style.background = 'transparent';
        marker.style.boxShadow = '0 0 0 6px rgba(255, 61, 0, 0.22)';
        marker.style.pointerEvents = 'none';
        document.body.appendChild(marker);
    }, label);
}

async function clearMarkers(page) {
    if (!videoModeEnabled()) {
        return;
    }

    await page.evaluate(() => {
        document.querySelectorAll('[data-repro-click-marker]').forEach((marker) => marker.remove());
    });
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

module.exports = {
    clearMarkers,
    clearStep,
    clickMarked,
    fillMarked,
    markLocator,
    showFinalStep,
    showStep,
    stepDelay,
    videoModeEnabled,
};
