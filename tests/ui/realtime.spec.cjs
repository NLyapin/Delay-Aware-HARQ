const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
test('CPU realtime mode runs independent DSP processes and exposes measured signals without RF permission', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'harq-realtime-'));
  const env = { ...process.env, HARQ_USER_DATA: profile, HARQ_PYTHON: path.resolve('.venv/bin/python') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve(__dirname, '../..')], env });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('#connection-text')).toHaveText('Python engine подключён');
    await page.locator('[data-view=hardware]').click();
    await expect(page.locator('#hw-profile')).toHaveValue('realtime_iq');
    await expect(page.locator('#stand-label')).toHaveText('CPU · РЕАЛЬНОЕ ВРЕМЯ');
    await expect(page.locator('#hw-realtime-fields')).toBeVisible();
    await expect(page.locator('#hw-uri')).toBeDisabled();
    await expect(page.locator('#hw-allow-tx')).toBeDisabled();
    await page.locator('#hw-packets').fill('3');
    await page.locator('#hw-snr').fill('20');
    await page.locator('#hw-propagation').fill('30');
    await page.locator('#hw-run').click();
    await expect(page.locator('#hw-status')).toContainText('завершён', { timeout: 20000 });
    await expect(page.locator('#hw-result')).toContainText('cpu_realtime_iq');
    await expect(page.locator('.runtime-table tbody tr')).toHaveCount(3);
    await expect(page.locator('.hardware-signal-grid > section')).toHaveCount(4);
    await expect(page.locator('.hardware-signal-grid svg')).toHaveCount(4);
    const first = page.locator('.hardware-signal-grid svg').first();
    await first.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const point = await first.evaluate((e) => {
      const m = JSON.parse(e.dataset.chart);
      const p = e.createSVGPoint();
      p.x = (m.left + m.right) / 2;
      p.y = (m.top + m.bottom) / 2;
      const v = p.matrixTransform(e.getScreenCTM());
      return { x: v.x, y: v.y };
    });
    await page.mouse.move(point.x, point.y);
    await expect(page.locator('#chart-tooltip')).toBeVisible();
    await expect(first.locator('.chart-crosshair')).toHaveAttribute('visibility', 'visible');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Светлая тема', exact: true }).click();
    await page.locator('.runtime-diagnostics').evaluate((e) => {
      e.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -90);
    });
    await page.screenshot({ path: 'results/realtime-cpu-light.png', animations: 'disabled' });
    await page.locator('.hardware-signal-grid').evaluate((e) => {
      e.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -90);
    });
    await expect(page.locator('#toast')).toHaveClass(/hidden/);
    await page.screenshot({
      path: 'results/realtime-signals-light.png',
      animations: 'disabled',
      scale: 'css',
    });
    await expect(page.locator('#hw-result')).toContainText('DSP');
    await page.locator('#hw-profile').selectOption('pluto_pair');
    await expect(page.locator('#hw-realtime-fields')).toBeHidden();
    await expect(page.locator('#stand-label')).toHaveText('PLUTO SDR ×2');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
