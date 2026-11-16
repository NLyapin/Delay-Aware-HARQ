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

test('720-run series is accepted, cancellable, and errors do not expose IPC or request JSON', async () => {
  const { app, profile } = await launchLab();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#connection-text')).toHaveText('Python engine подключён');
    await page.locator('#repetitions').fill('18');
    await page.locator('[data-view=sweep]').click();
    await page.locator('#sweep-axis').selectOption('snr_db');
    await expect(page.locator('#sweep-estimate')).toContainText('720 прогонов');
    await expect(page.locator('#sweep-estimate')).toContainText('14,4 / 20 млн');
    await expect(page.locator('#run-sweep')).toBeEnabled();
    await page.locator('#run-sweep').click();
    await expect(page.locator('#job-status')).toBeVisible();
    await page.locator('#cancel').click();
    await expect(page.locator('#job-message')).toHaveText('Остановлено пользователем', { timeout: 15000 });
    await page.locator('[data-view=overview]').click();
    await page.locator('#repetitions').fill('26');
    await page.locator('[data-view=sweep]').click();
    await expect(page.locator('#sweep-estimate')).toContainText('Бюджет 20,8 млн превышает лимит 20 млн');
    await expect(page.locator('#run-sweep')).toBeDisabled();
    const serverError = await page.evaluate(async () => {
      try {
        await api('/api/jobs', 'POST', {
          axis: 'snr_db',
          values: [-6, -4, -2, 0, 2, 4, 6, 8],
          repetitions: 26,
        });
      } catch (error) {
        return readable(error);
      }
    });
    expect(serverError).toContain('Бюджет эксперимента');
    expect(serverError).not.toMatch(/remote method|harq:request|"input"|"detail"/);
    const legacyError = await page.evaluate(() =>
      readable(
        new Error(
          'Error invoking remote method: Error: {"detail":[{"loc":["body"],"msg":"Value error, Не более 400 прогонов"}]}'
        )
      )
    );
    expect(legacyError).toBe('Не более 400 прогонов');
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('Electron launches Python, computes results, saves history, and draws real traces', async () => {
  const { app, profile } = await launchLab();
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('#connection-text')).toHaveText('Python engine подключён');
    await expect(page.locator('.preset.selected')).toContainText('Геостационарная');
    await page.screenshot({ path: 'results/desktop-overview.png', fullPage: true });
    await page.locator('[name=simulation_time_ms]').fill('2000');
    await page.locator('#repetitions').fill('2');
    await page.locator('#run').click();
    await expect(page.locator('#result-content')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#metrics-table tr')).toHaveCount(5);
    await expect(page.locator('#goodput-chart svg')).toBeVisible();
    await expect(page.locator('#comparison-charts .analytics-card')).toHaveCount(12);
    await expect(page.locator('#latency-cdf-chart > svg')).toBeVisible();
    await expect(page.locator('#result-insights')).toContainText('Разница Adaptive − Parallel');
    await expect(page.locator('#page-title')).toHaveText('Сравнение алгоритмов HARQ');
    await page.locator('[data-chart-filter="resources"]').click();
    await expect(page.locator('#comparison-charts .analytics-card:not(.hidden)')).toHaveCount(4);
    await page.locator('[data-chart-filter="all"]').click();
    expect(await page.locator('#comparison-charts').innerHTML()).not.toMatch(/NaN|Infinity/);
    await expect(page.locator('[data-counter]').first()).toHaveText('32,77');
    await page.screenshot({ path: 'results/desktop-results.png', fullPage: true });
    await page
      .locator('#result-content')
      .screenshot({ path: 'results/design-results-dark.png', animations: 'disabled' });
    await page.locator('[data-view=timeline]').click();
    await expect(page.locator('#packet-flow > svg')).toBeVisible();
    await expect(page.locator('#trace-packet')).toHaveValue('0');
    await expect(page.locator('#packet-flow')).toContainText('Передатчик');
    await expect(page.locator('#packet-flow')).toContainText('Приёмник');
    await page.locator('#trace-focus').click();
    await expect(page.locator('#timeline-chart svg')).toBeVisible();
    await expect(page.locator('#trace-table tr').first()).toBeVisible();
    await page.screenshot({ path: 'results/desktop-timeline.png', fullPage: true });
    await page.locator('[data-view=sweep]').click();
    await page.locator('#sweep-values').fill('10, 500');
    await page.locator('#run-sweep').click();
    await expect(page.locator('#sweep-chart svg')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#sweep-table tr')).toHaveCount(10);
    await expect(page.locator('#sweep-metric-grid .analytics-card')).toHaveCount(7);
    await page.locator('#sweep-metric').selectOption('peak_memory_kb');
    await expect(page.locator('#sweep-chart-title')).toContainText('Пиковая память');
    await expect(page.locator('#sweep-goodput-chart svg')).toBeVisible();
    await page.locator('#sweep-metric').selectOption('goodput_kbps');
    await page.screenshot({ path: 'results/desktop-sweep.png', fullPage: true });
    await page.getByRole('button', { name: 'Светлая тема', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#sweep-chart svg > rect').first()).toHaveAttribute('fill', '#fff');
    await expect(page.locator('#goodput-chart .chart-bar').nth(2)).toHaveAttribute('fill', '#000000');
    await page
      .locator('#sweep-result')
      .screenshot({ path: 'results/design-sweep-light.png', animations: 'disabled' });
    await page.locator('[data-view=history]').click();
    await expect(page.locator('#history-table tr').first()).toContainText('Завершён');
    expect(errors).toEqual([]);
    const settings = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const p = w.webContents.getLastWebPreferences();
      return { isolation: p.contextIsolation, node: p.nodeIntegration, sandbox: p.sandbox };
    });
    expect(settings).toEqual({ isolation: true, node: false, sandbox: true });
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('hardware profiles are separate and a real IQ reference job runs without RF', async () => {
  const { app, profile } = await launchLab();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#connection-text')).toHaveText('Python engine подключён');
    await page.locator('[data-view=hardware]').click();
    await expect(page.locator('#view-hardware')).toBeVisible();
    await page.locator('#hw-profile').selectOption('pluto_pair');
    await expect(page.locator('#hw-profile-note')).toContainText('Два отдельных PlutoSDR');
    await page.locator('#hw-run').click();
    await expect(page.locator('#hw-status')).toContainText('Разрешите TX');
    await page.locator('#hw-profile').selectOption('lx2160');
    await expect(page.locator('#hw-agent')).toBeEnabled();
    await expect(page.locator('#hw-profile-note')).toContainText('RF/DMA');
    await page.locator('#hw-profile').selectOption('software_iq');
    await page.locator('#hw-packets').fill('2');
    await page.locator('#hw-snr').fill('20');
    await page.locator('#hw-run').click();
    await expect(page.locator('#hw-status')).toContainText('завершён', { timeout: 15000 });
    await expect(page.locator('#hw-result')).toContainText('software_iq_physical_reference');
    await expect(page.locator('#hw-result')).toContainText('Подтверждено ACK');
    await page.screenshot({ path: 'results/hardware-workspace.png', fullPage: true });
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('themes persist, all scales fit, narrow layouts work, reduced motion is respected', async () => {
  const { app, profile } = await launchLab();
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('#connection-text')).toHaveText('Python engine подключён');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe('rgb(0, 0, 0)');
    await page.screenshot({ path: 'results/design-dark.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Светлая тема', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe('rgb(255, 255, 255)');
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
    expect(await page.locator('#view-overview').evaluate((el) => getComputedStyle(el).animationName)).toBe(
      'none'
    );
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setMinimumSize(360, 500);
      w.setContentSize(390, 844);
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'results/design-mobile.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Параметрические серии', exact: true }).click();
    await expect(page.locator('#view-sweep')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'Модель и методика', exact: true }).click();
    await expect(page.locator('#view-method')).toBeVisible();
    await page.screenshot({ path: 'results/design-mobile-method.png', animations: 'disabled' });
    for (const scale of ['85', '100', '115', '130']) {
      await page.locator('#ui-scale').selectOption(scale);
      for (const view of ['overview', 'sweep', 'timeline', 'history', 'method']) {
        await page.locator(`[data-view="${view}"]`).click();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          `${view} at ${scale}%`
        ).toBe(true);
      }
    }
    await page.locator('#ui-scale').selectOption('100');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 800));
    await page.getByRole('button', { name: 'Обзор эксперимента', exact: true }).click();
    await page.screenshot({ path: 'results/design-compact.png', animations: 'disabled' });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
