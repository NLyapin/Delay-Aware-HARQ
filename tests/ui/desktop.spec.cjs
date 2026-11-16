const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

async function launchLab() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'harq-ui-'));
  const env = { ...process.env, HARQ_PYTHON: path.resolve('.venv/bin/python'), HARQ_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve(__dirname, '../..')], env });
  return { app, profile };
}

test('Electron launches Python, computes results, saves history, and draws real traces', async () => {
  const { app, profile } = await launchLab();
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#connection-text')).toHaveText('Python engine подключён');
    await expect(page.locator('.preset.selected')).toContainText('Геостационарная');
    await page.screenshot({ path: 'results/desktop-overview.png', fullPage: true });
    await page.locator('[name=simulation_time_ms]').fill('2000');
    await page.locator('#repetitions').fill('2');
    await page.locator('#run').click();
    await expect(page.locator('#result-content')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#metrics-table tr')).toHaveCount(5);
    await expect(page.locator('#goodput-chart svg')).toBeVisible();
    await page.screenshot({ path: 'results/desktop-results.png', fullPage: true });
    await page.locator('[data-view=timeline]').click();
    await expect(page.locator('#timeline-chart svg')).toBeVisible();
    await expect(page.locator('#trace-table tr').first()).toBeVisible();
    await page.screenshot({ path: 'results/desktop-timeline.png', fullPage: true });
    await page.locator('[data-view=sweep]').click();
    await page.locator('#sweep-values').fill('10, 500');
    await page.locator('#run-sweep').click();
    await expect(page.locator('#sweep-chart svg')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#sweep-table tr')).toHaveCount(10);
    await page.screenshot({ path: 'results/desktop-sweep.png', fullPage: true });
    await page.locator('[data-view=history]').click();
    await expect(page.locator('#history-table tr').first()).toContainText('Завершён');
    expect(errors).toEqual([]);
    const settings = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const p = w.webContents.getLastWebPreferences();
      return { isolation: p.contextIsolation, node: p.nodeIntegration, sandbox: p.sandbox };
    });
    expect(settings).toEqual({ isolation: true, node: false, sandbox: true });
  } finally { await app.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('themes persist, all scales fit, narrow layouts work, reduced motion is respected', async () => {
  const { app, profile } = await launchLab();
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#connection-text')).toHaveText('Python engine подключён');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
    await page.screenshot({ path: 'results/design-dark.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Светлая тема', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 255, 255)');
    await page.screenshot({ path: 'results/design-light.png', animations: 'disabled' });
    await page.reload();
    await expect(page.locator('#connection-text')).toHaveText('Python engine подключён');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    for (const scale of ['85', '100', '115', '130']) {
      await page.locator('#ui-scale').selectOption(scale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await page.locator('#ui-scale').selectOption('115');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-scale', '115');
    await page.locator('#ui-scale').selectOption('100');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.locator('.signal-wave').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(360, 500); w.setContentSize(390, 844); });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'results/design-mobile.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Параметрические серии', exact: true }).click();
    await expect(page.locator('#view-sweep')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'Модель и методика', exact: true }).click();
    await expect(page.locator('#view-method')).toBeVisible();
    await page.screenshot({ path: 'results/design-mobile-method.png', animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 800));
    await page.getByRole('button', { name: 'Обзор эксперимента', exact: true }).click();
    await page.screenshot({ path: 'results/design-compact.png', animations: 'disabled' });
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
