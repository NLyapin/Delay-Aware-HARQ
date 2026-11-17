const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync('desktop/renderer/analytics.js', 'utf8'), sandbox);
const charts = sandbox.window.HarqAnalytics;
charts.configure({
  colors: { parallel: '#929292' },
  short: { parallel: 'Parallel' },
  themeColor: (name) =>
    ({ '--fg': '#fff', '--bg': '#000', '--line': '#ffffff29', '--muted': '#929292' })[name],
  fmt: (v, digits = 2) => (v == null ? 'н/д' : Number(v).toFixed(digits)),
});

function metric(mean, low = null, high = null) {
  return { mean, ci_low: low, ci_high: high, n: 3 };
}
function row(value = 2) {
  return {
    algorithm: 'parallel',
    metrics: Object.fromEntries(charts.specs.map((s) => [s.key, metric(value)])),
  };
}

test('small error probabilities are displayed in percent without rounding them to zero', () => {
  const r = row();
  r.metrics.bler = metric(0.0002, 0.0001, 0.0003);
  const svg = charts.bar(
    [r],
    charts.specs.find((s) => s.key === 'bler')
  );
  assert.match(svg, /0\.0200 %/);
  assert.match(svg, /0\.0100; 0\.0300/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('undefined observations are labeled and not turned into zero', () => {
  const r = row();
  r.metrics.p95_latency_ms = metric(null);
  const svg = charts.bar(
    [r],
    charts.specs.find((s) => s.key === 'p95_latency_ms')
  );
  assert.match(svg, /Нет данных/);
  assert.doesNotMatch(svg, /class="chart-bar"/);
});

test('missing sweep points split the line into independent segments', () => {
  const summary = [0, 1, 2].map((v, i) => ({ ...row(i === 1 ? null : 3), axis_value: v }));
  const result = { request: { algorithms: ['parallel'], axis: 'snr_db' }, summary };
  const svg = charts.sweep(result, charts.specs[0]);
  assert.equal((svg.match(/<polyline /g) || []).length, 2);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('CDF is an empirical step, and all-zero losses remain visible as a numeric zero', () => {
  const r = row();
  r.metrics.started = r.metrics.delivered = metric(4);
  r.metrics.dropped = r.metrics.censored = r.metrics.resolved_loss_rate = metric(0);
  const result = {
    request: { algorithms: ['parallel'], config: { seed: 42 } },
    summary: [r],
    runs: [
      {
        algorithm: 'parallel',
        repetition: 0,
        latencies_ms: [10, 10, 10, 10],
        series: [
          { time_ms: 0, goodput_kbps: 0, active: 1 },
          { time_ms: 100, goodput_kbps: 2, active: 1 },
        ],
      },
    ],
  };
  const html = charts.comparison(result);
  assert.equal((html.match(/class="panel chart-panel analytics-card"/g) || []).length, 12);
  const cdf = html.split('id="latency-cdf-chart"')[1].split('id="outcomes-chart"')[0];
  assert.match(cdf, /points="62,252 636,252 636,25"/);
  assert.match(html, /0\.0000 %/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});
