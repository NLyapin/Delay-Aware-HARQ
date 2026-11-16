const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');

test('Electron launches Python, computes results, saves history, and draws real traces', async () => {
  const env = { ...process.env, HARQ_PYTHON: path.resolve('.venv/bin/python') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve(__dirname, '../..')],
    env });
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
  } finally { await app.close(); }
});
