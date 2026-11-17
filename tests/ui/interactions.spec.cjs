const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

async function moveToPlot(page, selector, fx = 0.5, fy = 0.5) {
  const svg = page.locator(selector);
  await svg.scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  const p = await svg.evaluate(
    (el, { fx, fy }) => {
      const m = JSON.parse(el.dataset.chart);
      const point = el.createSVGPoint();
      point.x = m.left + (m.right - m.left) * fx;
      point.y = m.top + (m.bottom - m.top) * fy;
      const screen = point.matrixTransform(el.getScreenCTM());
      return { x: screen.x, y: screen.y };
    },
    { fx, fy }
  );
  await page.mouse.move(p.x, p.y);
  await expect(page.locator('#chart-tooltip')).toBeVisible();
  await expect(svg.locator('.chart-crosshair')).toHaveAttribute('visibility', 'visible');
  const geometry = await svg.evaluate((el) => {
    const dot = el.querySelector('.crosshair-dot'),
      [h, v] = el.querySelectorAll('.crosshair-guide');
    return {
      x: dot.getAttribute('cx'),
      y: dot.getAttribute('cy'),
      hx: h.getAttribute('x2'),
      hy: h.getAttribute('y1'),
      vx: v.getAttribute('x1'),
      vy: v.getAttribute('y2'),
    };
  });
  expect(geometry.hx).toBe(geometry.x);
  expect(geometry.vx).toBe(geometry.x);
  expect(geometry.hy).toBe(geometry.y);
  expect(geometry.vy).toBe(geometry.y);
}

test('plots, packet diagrams and timelines expose cursor coordinates and source observations', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'harq-interactions-'));
  const env = { ...process.env, HARQ_USER_DATA: profile, HARQ_PYTHON: path.resolve('.venv/bin/python') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve(__dirname, '../..')], env });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('#connection-text')).toHaveText('Python engine подключён');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[name=simulation_time_ms]').fill('2000');
    await page.locator('#repetitions').fill('2');
    await page.locator('#run').click();
    await expect(page.locator('#result-content')).toBeVisible({ timeout: 15000 });
    await moveToPlot(page, '#goodput-chart > svg', 0.5, 0.5);
    await expect(page.locator('#chart-tooltip')).toContainText('Курсор: Полезная скорость');
    await page.locator('#goodput-chart .chart-bar').last().hover();
    await expect(page.locator('#chart-tooltip')).toContainText('Adaptive');
    await expect(page.locator('#chart-tooltip')).toContainText('95% ДИ');
    await page.screenshot({ path: 'results/interactive-bars.png', animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#chart-tooltip')).toBeHidden();
    await page.locator('#goodput-chart .chart-bar').last().focus();
    await expect(page.locator('#chart-tooltip')).toBeVisible();
    await moveToPlot(page, '#latency-cdf-chart > svg');
    await expect(page.locator('#chart-tooltip')).toContainText('задержки');
    await page.getByRole('button', { name: 'Светлая тема', exact: true }).click();
    await moveToPlot(page, '#goodput-chart > svg', 0.3, 0.4);
    await expect(page.locator('#chart-tooltip')).toBeVisible();
    await page.locator('[data-view=timeline]').click();
    await moveToPlot(page, '#timeline-chart > svg', 0.45, 0.25);
    await expect(page.locator('#chart-tooltip')).toContainText('Время');
    await expect(page.locator('#chart-tooltip')).toContainText('Процесс');
    await page.screenshot({ path: 'results/interactive-timeline.png', animations: 'disabled' });
    await moveToPlot(page, '#packet-flow > svg', 0.5, 0.2);
    await expect(page.locator('#chart-tooltip')).toContainText('Схема этапов');
    for (const scale of ['85', '100', '130']) {
      await page.locator('#ui-scale').selectOption(scale);
      const arrow = page.locator('#packet-flow [data-tip]').first().locator('path').first();
      await arrow.scrollIntoViewIfNeeded();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      await arrow.hover();
      await expect(page.locator('#chart-tooltip')).toContainText('Пакет');
      await expect(page.locator('#chart-tooltip')).toContainText('Начало TX');
    }
    await page.locator('#ui-scale').selectOption('100');
    await page.locator('[data-view=sweep]').click();
    await page.locator('#sweep-values').fill('10, 500');
    await page.locator('#run-sweep').click();
    await expect(page.locator('#sweep-chart > svg')).toBeVisible({ timeout: 15000 });
    await moveToPlot(page, '#sweep-chart > svg');
    await page.locator('#sweep-metric').selectOption('bler');
    await moveToPlot(page, '#sweep-chart > svg');
    await expect(page.locator('#chart-tooltip')).toContainText('BLER');
    await page.locator('#ui-scale').selectOption('130');
    await moveToPlot(page, '#sweep-chart > svg', 0.6, 0.4);
    await page.locator('[data-view=hardware]').click();
    await page.locator('#hw-profile').selectOption('lx2160');
    await expect(page.locator('#stand-label')).toHaveText('LX-2160A');
    await page.locator('[data-view=overview]').click();
    await expect(page.locator('#stand-label')).toHaveText('ИМИТАЦИЯ');
    await page.locator('[data-view=hardware]').click();
    await expect(page.locator('#stand-label')).toHaveText('LX-2160A');
    expect(await page.locator('body').innerText()).not.toContain('\u2014');
    await page.mouse.move(2, 2);
    await expect(page.locator('#chart-tooltip')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
