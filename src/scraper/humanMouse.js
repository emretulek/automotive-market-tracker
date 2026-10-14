/**
 * Human-like mouse movement and Cloudflare Turnstile handler
 */

export async function humanMove(page, startX, startY, endX, endY) {
  // Cubic Bezier curve with natural randomized control points
  const cp1x = startX + (endX - startX) * 0.25 + (Math.random() - 0.5) * 80;
  const cp1y = startY + (endY - startY) * 0.25 + (Math.random() - 0.5) * 80;
  const cp2x = startX + (endX - startX) * 0.75 + (Math.random() - 0.5) * 50;
  const cp2y = startY + (endY - startY) * 0.75 + (Math.random() - 0.5) * 50;

  const steps = Math.floor(Math.random() * 12) + 25; // 25 to 37 micro-steps
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.pow(1 - t, 3) * startX +
              3 * Math.pow(1 - t, 2) * t * cp1x +
              3 * (1 - t) * Math.pow(t, 2) * cp2x +
              Math.pow(t, 3) * endX;
    const y = Math.pow(1 - t, 3) * startY +
              3 * Math.pow(1 - t, 2) * t * cp1y +
              3 * (1 - t) * Math.pow(t, 2) * cp2y +
              Math.pow(t, 3) * endY;

    await page.mouse.move(Math.round(x), Math.round(y));
    await page.waitForTimeout(Math.floor(Math.random() * 6) + 6); // 6-12ms per step
  }
}

export async function humanClick(page, targetX, targetY) {
  const startX = page._mousePos?.x ?? (Math.floor(Math.random() * 300) + 150);
  const startY = page._mousePos?.y ?? (Math.floor(Math.random() * 200) + 150);

  await humanMove(page, startX, startY, targetX, targetY);
  page._mousePos = { x: targetX, y: targetY };

  // Natural human pause before press
  await page.waitForTimeout(Math.floor(Math.random() * 120) + 90);
  await page.mouse.down();
  // Press duration
  await page.waitForTimeout(Math.floor(Math.random() * 50) + 70);
  await page.mouse.up();
}

export async function initHumanMouse(page) {
  const randomX = Math.floor(Math.random() * 400) + 150;
  const randomY = Math.floor(Math.random() * 300) + 150;
  page._mousePos = { x: randomX, y: randomY };
  await page.mouse.move(randomX, randomY).catch(() => {});
}

export async function solveCloudflareIfPresent(page) {
  if (page._isSolvingCf) return false;

  try {
    // 1. Quick check if Cloudflare challenge is present
    const isCloudflare = await page.evaluate(() => {
      const title = document.title || '';
      const text = document.body ? document.body.innerText : '';
      return title.includes('Just a moment') ||
             title.includes('Attention Required') ||
             text.includes('Verify you are human') ||
             text.includes('Güvenlik doğrulaması yapılıyor') ||
             document.querySelector('iframe[src*="cloudflare"], iframe[src*="turnstile"]') !== null;
    }).catch(() => false);

    if (!isCloudflare) return false;

    page._isSolvingCf = true;
    console.log('🛡️ [Cloudflare Detected] Waiting for widget and page to settle...');
    
    // Give the Turnstile widget time to fully render its DOM & listeners (2.5 - 3.5s)
    await page.waitForTimeout(Math.floor(Math.random() * 800) + 2500);

    // 2. Locate the interactive checkbox inside frames or widget
    let clickCoords = null;

    // Check all subframes (Turnstile renders inside an iframe)
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const checkbox = frame.locator('input[type="checkbox"], [aria-label*="Verify you are human"], .ctp-checkbox-label, label');
        if (await checkbox.first().isVisible({ timeout: 2500 }).catch(() => false)) {
          // Wait briefly until element position is completely stable
          await checkbox.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(600);

          const box = await checkbox.first().boundingBox();
          if (box && box.width > 10 && box.height > 10) {
            clickCoords = {
              x: Math.round(box.x + box.width / 2 + (Math.random() * 4 - 2)),
              y: Math.round(box.y + box.height / 2 + (Math.random() * 4 - 2))
            };
            break;
          }
        }
      } catch (fErr) {}
    }

    // Fallback: check main document Turnstile iframe container
    if (!clickCoords) {
      const cfIframe = page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').first();
      if (await cfIframe.isVisible({ timeout: 3000 }).catch(() => false)) {
        await page.waitForTimeout(800);
        const box = await cfIframe.boundingBox();
        if (box && box.width > 20 && box.height > 20) {
          clickCoords = {
            x: Math.round(box.x + 30 + (Math.random() * 6 - 3)),
            y: Math.round(box.y + box.height / 2 + (Math.random() * 4 - 2))
          };
        }
      }
    }

    if (clickCoords) {
      // Natural human reaction time before reaching for mouse (700ms - 1300ms)
      console.log('👀 [Human Pause] Checkbox is visible and settled. Preparing to click...');
      await page.waitForTimeout(Math.floor(Math.random() * 600) + 700);

      const startX = page._mousePos?.x ?? (Math.floor(Math.random() * 300) + 150);
      const startY = page._mousePos?.y ?? (Math.floor(Math.random() * 200) + 150);

      console.log(`🖱️ [Human Move] Moving smoothly to checkbox at (${clickCoords.x}, ${clickCoords.y})...`);
      await humanMove(page, startX, startY, clickCoords.x, clickCoords.y);
      page._mousePos = { x: clickCoords.x, y: clickCoords.y };

      // Hover over the checkbox before pressing down (250ms - 450ms)
      await page.waitForTimeout(Math.floor(Math.random() * 200) + 250);

      await page.mouse.down();
      // Click hold duration (80ms - 150ms)
      await page.waitForTimeout(Math.floor(Math.random() * 70) + 80);
      await page.mouse.up();

      console.log('👆 [Cloudflare] Clicked! Waiting 6s for token validation & redirect...');
      await page.waitForTimeout(6000);

      page._isSolvingCf = false;
      return true;
    } else {
      console.log('⚠️ [Cloudflare] Widget detected but checkbox coordinates not ready yet.');
    }
  } catch (err) {
    console.warn('⚠️ Cloudflare solver notice:', err.message);
  } finally {
    page._isSolvingCf = false;
  }

  return false;
}
