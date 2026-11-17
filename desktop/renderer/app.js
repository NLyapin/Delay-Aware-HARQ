'use strict';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const colors = {
  stop_wait: '#555555',
  parallel: '#929292',
  chase: '#ffffff',
  ir: '#cccccc',
  adaptive: '#b6ff00',
};
const themeColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function updatePalette() {
  const light = document.documentElement.dataset.theme === 'light';
  Object.assign(colors, {
    stop_wait: light ? '#aaaaaa' : '#555555',
    parallel: light ? '#777777' : '#929292',
    chase: light ? '#000000' : '#ffffff',
    ir: light ? '#444444' : '#cccccc',
    adaptive: '#b6ff00',
  });
}
const short = {
  stop_wait: 'Stop-and-Wait',
  parallel: 'Parallel',
  chase: 'Chase CC',
  ir: 'HARQ IR',
  adaptive: 'Adaptive',
};
const descriptions = {
  stop_wait: ['Один процесс · без комбинирования', 'BASELINE', '↔'],
  parallel: ['N процессов · независимые повторы', 'TYPE I', '▥'],
  chase: ['Накопление SNR · повтор кодового блока', 'SOFT', '⊕'],
  ir: ['Новая избыточность · накопление информации', 'SOFT', '⌘'],
  adaptive: ['RTT + CSI · выбор режима и burst', 'PROPOSED', '✧'],
};
const state = {
  defaults: null,
  presets: {},
  algorithms: [],
  job: null,
  result: null,
  traceResult: null,
  view: 'overview',
  polling: null,
  pending: false,
};
const titles = {
  hardware: [
    'Аппаратный стенд',
    'Физический уровень и аппаратные стенды',
    'Два PlutoSDR или отдельная плата LX2160A; результаты отделены от имитационных.',
  ],
  overview: [
    'Обзор эксперимента',
    'Сравнение алгоритмов HARQ',
    'Настройка радиолинии, запуск моделирования и анализ результатов.',
  ],
  sweep: [
    'Параметрические серии',
    'Параметрические исследования',
    'Зависимость характеристик HARQ от RTT, SNR, числа процессов, памяти и лимита передач.',
  ],
  timeline: [
    'Диаграмма передач',
    'Временная диаграмма передач',
    'Передачи, декодирование и ACK/NACK для каждого HARQ-процесса.',
  ],
  history: [
    'История запусков',
    'История экспериментов',
    'Сохранённые конфигурации и результаты моделирования.',
  ],
  method: [
    'Модель и методика',
    'Модель и методика',
    'Математические допущения, определения метрик и ограничения симуляции.',
  ],
};
const fmt = (value, digits = 2) =>
  value == null ? 'н/д' : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
const pct = (value) => (value == null ? 'н/д' : `${fmt(value * 100)}%`);
const escapeHTML = (str) =>
  String(str ?? '')
    .replaceAll('\u2014', ':')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = String(message).replaceAll('\u2014', ':');
  el.classList.toggle('error', error);
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), error ? 16000 : 4500);
}
async function api(endpoint, method = 'GET', body = null) {
  if (window.harq) {
    const result = await window.harq.request(endpoint, method, body);
    if (result?.__harq_error) throw new Error(result.__harq_error);
    return result;
  }
  const response = await fetch(endpoint, {
    method,
    ...(body !== null ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(await response.text());
  return endpoint.includes('/export/') ? response.text() : response.json();
}
function readable(error) {
  try {
    const text = error.message || String(error);
    const start = text.indexOf('{');
    const value = JSON.parse(start < 0 ? text : text.slice(start, text.lastIndexOf('}') + 1));
    if (Array.isArray(value.detail))
      return value.detail
        .map((e) => {
          const field = (e.loc || []).slice(1).join('.');
          return `${field ? field + ': ' : ''}${e.msg.replace(/^Value error, /, '')}`;
        })
        .join('\n');
    return value.detail || error.message;
  } catch {
    return error.message;
  }
}
function setView(view, scroll = true) {
  state.view = view;
  document.documentElement.dataset.activeView = view;
  updateStandLabel();
  window.HarqInteractions?.hide();
  $$('.view').forEach((el) => el.classList.toggle('hidden', el.id !== `view-${view}`));
  $$('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
    if (el.dataset.view === view) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  $('#crumb').textContent = titles[view][0];
  $('#page-title').innerHTML = titles[view][1];
  $('#page-description').textContent = titles[view][2];
  window.labUI?.enterView(view);
  if (view === 'history') refreshHistory();
  if (scroll) window.scrollTo({ top: 0 });
}
function updateStandLabel() {
  const profile = $('#hw-profile').value;
  $('#stand-label').textContent =
    state.view === 'hardware'
      ? { software_iq: 'ФИЗИЧЕСКИЙ I/Q', pluto_pair: 'PLUTO SDR ×2', lx2160: 'LX-2160A' }[profile] ||
        'АППАРАТНЫЙ СТЕНД'
      : 'ИМИТАЦИЯ';
}
function populate(config) {
  for (const input of $('#config-form').elements)
    if (input.name && config[input.name] !== undefined) input.value = config[input.name];
  updateCapacity();
  updateExperimentEstimates();
}
function config() {
  const invalid = [...$('#config-form').elements].find((el) => el.willValidate && !el.checkValidity());
  if (invalid) {
    setView('overview');
    if (invalid.closest('details')) invalid.closest('details').open = true;
    invalid.reportValidity();
    throw new Error(`${invalid.closest('label').textContent.trim()}: ${invalid.validationMessage}`);
  }
  const value = { ...state.defaults };
  for (const input of $('#config-form').elements)
    if (input.name) value[input.name] = input.type === 'number' ? Number(input.value) : input.value;
  return value;
}
function updateCapacity() {
  const f = $('#config-form').elements,
    slot = Number(f.slot_ms.value),
    rtt = Number(f.rtt_ms.value),
    n = Number(f.harq_processes.value);
  const needed = Math.ceil((rtt + slot) / slot);
  $('#needed-processes').textContent = `${fmt(needed, 0)} процессов`;
  $('#capacity-caption').textContent =
    `Текущий теоретический предел загрузки: ${pct(Math.min(1, (n * slot) / (rtt + slot)))}`;
  const selected = $('.preset.selected');
  $('#live-scenario').textContent =
    `${selected ? { terrestrial: 'GROUND', leo: 'LEO', geo: 'GEO', fading: 'FADING' }[selected.dataset.preset] : 'CUSTOM'} / ${fmt(rtt)} MS RTT`;
}
function renderAlgorithms() {
  $('#algorithm-list').innerHTML = state.algorithms
    .map((a) => {
      const d = descriptions[a.id];
      return `<label class="algorithm-row"><input type="checkbox" name="algorithm" value="${a.id}" checked><span class="algorithm-icon color-${a.id}">${d[2]}</span><span class="algorithm-text"><strong>${escapeHTML(a.label)}</strong><small>${d[0]}</small></span><span class="algo-tag">${d[1]}</span></label>`;
    })
    .join('');
  $$('input[name="algorithm"]').forEach((el) =>
    el.addEventListener('change', () => {
      $('#algorithm-count').textContent = `${$$('input[name="algorithm"]:checked').length} ВЫБРАНО`;
      updateExperimentEstimates();
    })
  );
}
function experimentEstimate(sweep = false) {
  const algorithms = $$('input[name="algorithm"]:checked').length;
  const repeats = Number($('#repetitions').value);
  const text = $('#sweep-values').value.trim();
  const values = sweep ? text.split(',').map((s) => s.trim()) : ['single'];
  const form = $('#config-form').elements;
  const slots =
    Number(form.simulation_time_ms.value) / (Number(form.slot_ms.value) * Number(form.ir_fraction.value));
  const runs = values.length * algorithms * repeats;
  const potential = slots * runs;
  const limits = state.limits || { max_runs: 400, max_potential_transmissions: 20000000 };
  let error = '';
  if (!algorithms) error = 'Выберите хотя бы один алгоритм.';
  else if (!Number.isInteger(repeats) || repeats < 1 || repeats > 30)
    error = 'Число повторений должно быть от 1 до 30.';
  else if (sweep && (!text || values.some((v) => !v || !Number.isFinite(Number(v)))))
    error = 'Введите числовые значения оси через запятую.';
  else if (sweep && new Set(values.map(Number)).size !== values.length)
    error = 'Значения оси не должны повторяться.';
  else if (values.length > 25) error = 'Допустимо не более 25 значений оси.';
  else if (!Number.isFinite(slots) || slots <= 0)
    error = 'Проверьте длительность прогона и передачи в конфигурации.';
  else if (runs > limits.max_runs)
    error = `Запрошено ${runs} прогонов; лимит: ${limits.max_runs}. Уменьшите число значений, алгоритмов или повторений.`;
  else if (potential > limits.max_potential_transmissions)
    error = `Бюджет ${fmt(potential / 1e6)} млн превышает лимит ${fmt(limits.max_potential_transmissions / 1e6)} млн потенциальных передач. Уменьшите длительность прогона или число повторений.`;
  return {
    runs,
    potential,
    error,
    description: `${sweep ? `${values.length} значений × ` : ''}${algorithms} алгоритмов × ${repeats} повторений = ${runs} прогонов · ${fmt(potential / 1e6)} / ${fmt(limits.max_potential_transmissions / 1e6)} млн потенциальных передач. Лимит: ${limits.max_runs} прогонов.`,
  };
}
function updateExperimentEstimates() {
  if (!state.defaults) return;
  for (const [sweep, id, button] of [
    [false, '#comparison-estimate', '#run'],
    [true, '#sweep-estimate', '#run-sweep'],
  ]) {
    const estimate = experimentEstimate(sweep);
    $(id).textContent = estimate.error || estimate.description;
    $(id).classList.toggle('estimate-error', Boolean(estimate.error));
    $(button).disabled = state.pending || Boolean(estimate.error);
  }
}
function busy(value) {
  state.pending = value;
  $('#run').disabled = value;
  $('#run-sweep').disabled = value;
  $('#run').setAttribute('aria-busy', String(value));
  $('#floating-status').classList.toggle('hidden', !value);
  $('#run').innerHTML = value
    ? '<span class="busy-glyph">↗</span> Выполняется расчёт <span>···</span>'
    : '<span>▶</span> Запустить сравнение <span>↗</span>';
  updateExperimentEstimates();
}
async function launch(sweep = false) {
  try {
    const algorithms = $$('input[name="algorithm"]:checked').map((el) => el.value);
    if (!algorithms.length) throw new Error('Выберите хотя бы один алгоритм.');
    if (!$('#repetitions').reportValidity()) return;
    const request = {
      name: `${sweep ? 'Серия' : 'Сравнение'} · ${new Date().toLocaleString('ru-RU')}`,
      config: config(),
      algorithms,
      repetitions: Number($('#repetitions').value),
    };
    if (sweep) {
      request.axis = $('#sweep-axis').value;
      const text = $('#sweep-values').value.trim();
      if (!text || text.split(',').some((v) => !v.trim() || !Number.isFinite(Number(v))))
        throw new Error('Введите числовые значения через запятую. Десятичный разделитель: точка.');
      request.values = text.split(',').map((v) => Number(v.trim()));
    }
    const estimate = experimentEstimate(sweep);
    if (estimate.error) throw new Error(estimate.error);
    busy(true);
    const job = await api('/api/jobs', 'POST', request);
    state.job = job.id;
    $('#job-status').classList.remove('hidden');
    $('#job-message').textContent = 'В очереди на расчёт…';
    $('#job-progress').value = 0;
    $('#cancel').classList.remove('hidden');
    setView('overview', false);
    $('#results-anchor').scrollIntoView({
      behavior: window.labUI?.reducedMotion() ? 'instant' : 'smooth',
      block: 'start',
    });
    poll();
  } catch (error) {
    busy(false);
    toast(readable(error), true);
  }
}
async function poll() {
  clearTimeout(state.polling);
  if (!state.job) return;
  try {
    const job = await api(`/api/jobs/${state.job}`);
    $('#job-status').classList.remove('hidden');
    $('#job-message').textContent = job.message || job.status;
    $('#job-progress').value = job.progress;
    $('#floating-message').textContent = job.message || 'Выполняется расчёт';
    if (job.status === 'completed') {
      busy(false);
      $('#cancel').classList.add('hidden');
      state.result = job.result;
      renderResults();
      refreshHistory();
      toast('Эксперимент завершён. Результаты сохранены.');
      if (job.result.request.axis) setView('sweep');
      return;
    }
    if (['failed', 'cancelled', 'interrupted'].includes(job.status)) {
      busy(false);
      $('#cancel').classList.add('hidden');
      toast(job.message, job.status !== 'cancelled');
      refreshHistory();
      return;
    }
    state.polling = setTimeout(poll, 600);
  } catch (error) {
    busy(false);
    toast(`Не удалось получить статус: ${readable(error)}`, true);
  }
}
function configureAnalytics() {
  window.HarqAnalytics.configure({ colors, themeColor, fmt, short });
}
function applyChartFilter(filter = state.chartFilter || 'all') {
  state.chartFilter = filter;
  $$('[data-chart-filter]').forEach((button) =>
    button.setAttribute('aria-pressed', String(button.dataset.chartFilter === filter))
  );
  $$('#comparison-charts [data-chart-group]').forEach((card) =>
    card.classList.toggle('hidden', filter !== 'all' && !card.dataset.chartGroup.split(' ').includes(filter))
  );
}
function renderComparisonCharts(result) {
  configureAnalytics();
  $('#comparison-charts').innerHTML = window.HarqAnalytics.comparison(result);
  $('#result-insights').innerHTML = window.HarqAnalytics.insights(result);
  applyChartFilter();
}
function metricCard(label, value, unit, caption) {
  return `<div class="metric-card"><label>${label}</label><div class="metric-value"><span data-counter>${value}</span><small>${unit}</small></div><p>${caption}</p></div>`;
}
function renderResults() {
  const result = state.result;
  if (!result) return;
  if (result.request.axis) {
    state.sweepResult = result;
    state.sweepJob = state.job;
    renderSweep();
    return;
  }
  state.overviewJob = state.job;
  state.traceResult = result;
  $('#empty-results').classList.add('hidden');
  $('#result-content').classList.remove('hidden');
  const rows = result.summary,
    best = rows.reduce((a, b) => (a.metrics.goodput_kbps.mean > b.metrics.goodput_kbps.mean ? a : b));
  const adaptive = rows.find((r) => r.algorithm === 'adaptive'),
    base = rows.find((r) => r.algorithm === 'parallel');
  const delta =
    adaptive && base && base.metrics.goodput_kbps.mean > 0
      ? (adaptive.metrics.goodput_kbps.mean / base.metrics.goodput_kbps.mean - 1) * 100
      : null;
  const cfg = result.request.config;
  $('#result-context').textContent =
    `Рассчитано: RTT ${fmt(cfg.rtt_ms)} мс · SNR ${fmt(cfg.snr_db)} дБ · ${cfg.harq_processes} процессов · ${cfg.channel} · ${fmt(cfg.simulation_time_ms / 1000)} с · ${result.request.repetitions} seed. Текущие поля конфигурации не изменяют сохранённый результат.`;
  $('#metric-cards').innerHTML =
    metricCard('ЛУЧШИЙ GOODPUT', fmt(best.metrics.goodput_kbps.mean), 'кбит/с', short[best.algorithm]) +
    metricCard(
      'ADAPTIVE К PARALLEL',
      delta == null ? 'н/д' : `${delta > 0 ? '+' : ''}${fmt(delta, 1)}`,
      '%',
      'По средним goodput · не тест значимости'
    ) +
    metricCard(
      'ЗАГРУЗКА ЛУЧШЕЙ СТРАТЕГИИ',
      pct(best.metrics.utilization.mean),
      '',
      'Доля занятого эфирного времени'
    ) +
    metricCard(
      'P95 ЛУЧШЕЙ СТРАТЕГИИ',
      fmt(best.metrics.p95_latency_ms.mean, 0),
      'мс',
      'Первый успешный приём'
    );
  renderComparisonCharts(result);
  $('#metrics-table').innerHTML = rows
    .map((r) => {
      const m = r.metrics;
      return `<tr><td><span class="table-dot color-${r.algorithm}">●</span>${escapeHTML(short[r.algorithm])}</td><td>${fmt(m.goodput_kbps.mean)}</td><td>${pct(m.bler.mean)}</td><td>${pct(m.resolved_loss_rate.mean)}</td><td>${fmt(m.p95_latency_ms.mean, 1)}</td><td>${pct(m.utilization.mean)}</td><td>${fmt(m.peak_memory_kb.mean)}</td><td>${fmt(m.censored.mean)}</td></tr>`;
    })
    .join('');
  $('#trace-algorithm').innerHTML = result.request.algorithms
    .map((a) => `<option value="${a}">${short[a]}</option>`)
    .join('');
  $('#trace-algorithm').value = result.request.algorithms.includes('adaptive')
    ? 'adaptive'
    : result.request.algorithms[0];
  renderTrace();
  window.labUI?.counters($('#metric-cards'));
}
function renderSweep(result = state.result) {
  configureAnalytics();
  const spec =
    window.HarqAnalytics.specs.find((s) => s.key === $('#sweep-metric').value) ||
    window.HarqAnalytics.specs[0];
  $('#sweep-chart-title').textContent = `${spec.title}: ${window.HarqAnalytics.axes[result.request.axis]}`;
  $('#sweep-metric-help').textContent =
    `${spec.direction}. ${spec.help} Усы: 95% ДИ по seed.${spec.factor === 100 ? ' Границы ДИ долей отображаются в пределах 0–100%, исходные значения доступны в подсказке и экспорте.' : ''}`;
  $('#sweep-chart').classList.remove('empty-state');
  $('#sweep-chart').innerHTML = window.HarqAnalytics.sweep(result, spec);
  $('#sweep-legend').innerHTML = window.HarqAnalytics.legend(result.request.algorithms);
  $('#sweep-metric-grid').innerHTML = window.HarqAnalytics.sweepGrid(result, spec.key);
  $('#sweep-table').innerHTML = result.summary
    .map((r) => {
      const m = r.metrics,
        g = m.goodput_kbps;
      return `<tr><td>${short[r.algorithm]}</td><td>${r.axis_value}</td><td>${fmt(g.mean)}</td><td>[${fmt(g.ci_low)}; ${fmt(g.ci_high)}]</td><td>${pct(m.resolved_loss_rate.mean)}</td><td>${fmt(m.p95_latency_ms.mean)}</td></tr>`;
    })
    .join('');
}
function renderTrace() {
  if (!state.traceResult) return;
  const run = state.traceResult.runs.find(
    (r) => r.algorithm === $('#trace-algorithm').value && r.repetition === 0
  );
  if (!run) return;
  const selectedPacket = $('#trace-packet').value;
  const packets = [...new Set(run.trace.filter((e) => e.event === 'TX_START').map((e) => e.packet))];
  $('#trace-packet').innerHTML = packets.map((p) => `<option value="${p}">Пакет ${p}</option>`).join('');
  if (selectedPacket !== '' && packets.includes(Number(selectedPacket)))
    $('#trace-packet').value = selectedPacket;
  $('#packet-flow').innerHTML = packets.length
    ? window.HarqTrace.packetFlow(run, Number($('#trace-packet').value))
    : '<p class="muted">Трасса не сохранена: задайте лимит событий больше нуля и выполните одиночное сравнение.</p>';
  const offset = Math.max(0, Number($('#trace-offset').value) || 0),
    span = Math.max(10, Number($('#trace-window').value) || 1600);
  const trace = run.trace.filter((e) => e.time_ms >= offset && e.time_ms <= offset + span);
  const processes = [...new Set(trace.filter((e) => e.process != null).map((e) => e.process))]
    .sort((a, b) => a - b)
    .slice(0, 16);
  const width = 1100,
    left = 65,
    top = 35,
    height = Math.max(130, processes.length * 42 + 70),
    x = (t) => left + ((t - offset) / span) * (width - left - 30);
  const meta = {
    left,
    right: width - 30,
    top: 20,
    bottom: height - 25,
    xMin: offset,
    xMax: offset + span,
    xLabel: 'Время',
    xUnit: 'мс',
    yLabel: 'Процесс',
    categories: processes.map((p, i) => ({ y: top + i * 42, label: `P${p}` })),
  };
  let svg = `<svg data-chart="${escapeHTML(JSON.stringify(meta))}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Временная диаграмма HARQ"><title>Реальные события симуляции, первые 16 процессов в окне</title>`;
  for (let i = 0; i <= 5; i++) {
    const xx = x(offset + (i * span) / 5);
    svg += `<line class="chart-gridline" x1="${xx}" x2="${xx}" y1="20" y2="${height - 25}"/><text class="chart-label" x="${xx}" y="${height - 5}" text-anchor="middle">${fmt(offset + (i * span) / 5, 0)} ms</text>`;
  }
  processes.forEach((p, i) => {
    const yy = top + i * 42;
    svg += `<text class="chart-label" x="0" y="${yy + 4}">P${p}</text><line x1="${left}" x2="${width - 30}" y1="${yy}" y2="${yy}" stroke="${themeColor('--line')}" stroke-dasharray="3 4"/>`;
    for (const e of trace.filter((e) => e.process === p)) {
      const xx = x(e.time_ms);
      if (e.event === 'TX_START')
        svg += `<rect x="${xx}" y="${yy - 8}" width="${Math.max(3, (e.duration_ms / span) * (width - left - 30))}" height="16" rx="2" fill="${e.attempt > 1 ? '#b6ff00' : themeColor('--fg')}"><title>Передача: процесс P${p}; пакет ${e.packet}; попытка ${e.attempt}; начало ${fmt(e.time_ms)} мс; длительность ${fmt(e.duration_ms)} мс</title></rect>`;
      else if (e.event.startsWith('RX_'))
        svg += `<circle cx="${xx}" cy="${yy}" r="4" fill="${e.event === 'RX_NACK' ? themeColor('--muted') : '#b6ff00'}" stroke="${themeColor('--fg')}" stroke-width=".5"><title>${escapeHTML(window.HarqTrace.labels[e.event] || e.event)}: ${fmt(e.time_ms)} мс; пакет ${e.packet}; процесс P${p}; попытка ${e.attempt}</title></circle>`;
      else if (['ACK', 'NACK', 'TIMEOUT', 'DROP'].includes(e.event))
        svg += `<path d="M${xx},${yy - 5} l5,5 l-5,5 l-5,-5 Z" fill="${e.event === 'ACK' ? '#b6ff00' : themeColor('--muted')}"><title>${escapeHTML(window.HarqTrace.labels[e.event] || e.event)}: ${fmt(e.time_ms)} мс; пакет ${e.packet}; процесс P${p}; попытка ${e.attempt}</title></path>`;
    }
  });
  $('#timeline-chart').classList.remove('empty-state');
  $('#timeline-chart').innerHTML = svg + '</svg>';
  $('#trace-count').textContent =
    `${trace.length} в окне · сохранено ${run.trace.length}${run.trace_truncated ? ' · трасса ограничена' : ''} · до 16 процессов`;
  $('#trace-table').innerHTML = trace
    .slice(0, 400)
    .map(
      (e) =>
        `<tr><td>${fmt(e.time_ms, 3)}</td><td>${escapeHTML(window.HarqTrace.labels[e.event] || e.event)} <small>${escapeHTML(e.event)}</small></td><td>${e.process ?? 'н/д'}</td><td>${e.packet ?? 'н/д'}</td><td>${e.attempt ?? 'н/д'}</td><td>${escapeHTML(e.mode ?? 'н/д')}</td></tr>`
    )
    .join('');
}
async function refreshHistory() {
  try {
    const jobs = await api('/api/jobs');
    $('#history-count').textContent = jobs.length;
    const labels = {
      completed: 'Завершён',
      running: 'Выполняется',
      queued: 'В очереди',
      failed: 'Ошибка',
      cancelled: 'Остановлен',
      interrupted: 'Прерван',
    };
    $('#history-table').innerHTML = jobs.length
      ? jobs
          .map(
            (j) =>
              `<tr><td>${escapeHTML(j.name)}</td><td>${new Date(j.created).toLocaleString('ru-RU')}</td><td class="status-${j.status}">${labels[j.status] || j.status}</td><td>${pct(j.progress)}</td><td><button class="secondary-button" data-open="${j.id}">Открыть ↗</button></td></tr>`
          )
          .join('')
      : '<tr><td colspan="5">Пока нет сохранённых экспериментов</td></tr>';
    $$('[data-open]').forEach((el) => el.addEventListener('click', () => openJob(el.dataset.open)));
  } catch (error) {
    toast(readable(error), true);
  }
}
async function openJob(id) {
  try {
    if (state.pending) throw new Error('Дождитесь завершения текущего расчёта или остановите его.');
    const job = await api(`/api/jobs/${id}`);
    state.job = id;
    populate(job.request.config);
    $('#repetitions').value = job.request.repetitions;
    $$('input[name="algorithm"]').forEach((input) => {
      input.checked = job.request.algorithms.includes(input.value);
    });
    $('#algorithm-count').textContent = `${job.request.algorithms.length} ВЫБРАНО`;
    if (job.request.axis) {
      $('#sweep-axis').value = job.request.axis;
      $('#sweep-values').value = job.request.values.join(', ');
    }
    updateExperimentEstimates();
    $$('.preset').forEach((el) => el.classList.remove('selected'));
    if (job.result) {
      state.result = job.result;
      renderResults();
      setView(job.request.axis ? 'sweep' : 'overview');
    } else if (['queued', 'running'].includes(job.status)) {
      busy(true);
      setView('overview');
      poll();
    } else toast(job.message, job.status === 'failed');
  } catch (error) {
    toast(readable(error), true);
  }
}
async function save(format, content) {
  if (window.harq) {
    const saved = await window.harq.save(format, content);
    if (saved) toast('Файл сохранён.');
    return;
  }
  const blob = new Blob([content], { type: format === 'svg' ? 'image/svg+xml' : 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `harq-experiment.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function exportResult(format) {
  try {
    if (!state.job || !state.result || state.pending) throw new Error('Сначала завершите эксперимент.');
    const id = state.view === 'sweep' ? state.sweepJob : state.overviewJob;
    if (!id) throw new Error('Нет результатов для этого раздела.');
    const content = await api(`/api/jobs/${id}/export/${format}`);
    await save(format, content);
  } catch (error) {
    toast(readable(error), true);
  }
}
async function init() {
  updatePalette();
  window.addEventListener('harq:profile', updateStandLabel);
  updateStandLabel();
  window.HarqHardware.init({ api, readable, toast, save, fmt });
  configureAnalytics();
  $('#config-form').addEventListener('input', updateExperimentEstimates);
  $('#config-form').addEventListener('change', updateExperimentEstimates);
  $('#repetitions').addEventListener('input', updateExperimentEstimates);
  $('#sweep-values').addEventListener('input', updateExperimentEstimates);
  $('#sweep-metric').innerHTML = window.HarqAnalytics.specs
    .map((s) => `<option value="${s.key}">${s.title}, ${s.unit}</option>`)
    .join('');
  $('#sweep-metric').addEventListener('change', () => {
    if (state.sweepResult) renderSweep(state.sweepResult);
  });
  $$('[data-chart-filter]').forEach((button) =>
    button.addEventListener('click', () => applyChartFilter(button.dataset.chartFilter))
  );
  window.addEventListener('harq:theme', () => {
    updatePalette();
    if (state.traceResult) {
      renderComparisonCharts(state.traceResult);
      renderTrace();
    }
    if (state.sweepResult) renderSweep(state.sweepResult);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !state.pending && state.defaults) {
      event.preventDefault();
      launch(state.view === 'sweep');
    }
  });
  $('#show-progress').addEventListener('click', () => {
    setView('overview', false);
    $('#results-anchor').scrollIntoView({
      behavior: window.labUI?.reducedMotion() ? 'instant' : 'smooth',
      block: 'start',
    });
  });
  $$('.nav-item').forEach((el) => el.addEventListener('click', () => setView(el.dataset.view)));
  $('#config-form').addEventListener('submit', (e) => e.preventDefault());
  $('#config-form').addEventListener('input', () => {
    $$('.preset').forEach((el) => {
      el.classList.remove('selected');
      el.setAttribute('aria-pressed', 'false');
    });
    updateCapacity();
  });
  $('#run').addEventListener('click', () => launch());
  $('#run-sweep').addEventListener('click', () => launch(true));
  $('#cancel').addEventListener('click', async () => {
    try {
      await api(`/api/jobs/${state.job}/cancel`, 'POST');
    } catch (error) {
      toast(readable(error), true);
    }
  });
  $('#refresh-history').addEventListener('click', refreshHistory);
  $('#trace-update').addEventListener('click', renderTrace);
  $('#trace-packet').addEventListener('change', renderTrace);
  $('#trace-focus').addEventListener('click', () => {
    const run = state.traceResult?.runs.find(
      (r) => r.algorithm === $('#trace-algorithm').value && r.repetition === 0
    );
    const events = run?.trace.filter((e) => e.packet === Number($('#trace-packet').value)) || [];
    if (!events.length) return;
    $('#trace-offset').value = Math.max(0, Math.floor(events[0].time_ms - 5));
    $('#trace-window').value = Math.max(
      10,
      Math.min(10000, Math.ceil(events[events.length - 1].time_ms - events[0].time_ms + 20))
    );
    renderTrace();
  });
  $('#trace-algorithm').addEventListener('change', renderTrace);
  $$('[data-export]').forEach((el) => el.addEventListener('click', () => exportResult(el.dataset.export)));
  $('#export-svg').addEventListener('click', async () => {
    try {
      const svg = $('#sweep-chart svg');
      if (!svg) throw new Error('Сначала выполните серию.');
      await save('svg', new XMLSerializer().serializeToString(svg));
    } catch (error) {
      toast(readable(error), true);
    }
  });
  const recipes = {
    rtt_ms: [5, 20, 50, 100, 200, 500, 600],
    snr_db: [-6, -4, -2, 0, 2, 4, 6, 8],
    harq_processes: [1, 8, 16, 32, 64, 128, 256, 512],
    max_transmissions: [1, 2, 3, 4, 6, 8],
    memory_mb: [0.01, 0.05, 0.1, 0.5, 1, 4, 16],
  };
  $('#sweep-axis').addEventListener('change', () => {
    $('#sweep-values').value = recipes[$('#sweep-axis').value].join(', ');
    updateExperimentEstimates();
  });
  $$('[data-recipe]').forEach((el) =>
    el.addEventListener('click', () => {
      $('#sweep-axis').value = el.dataset.recipe;
      $('#sweep-values').value = recipes[el.dataset.recipe].join(', ');
      updateExperimentEstimates();
    })
  );
  try {
    const data = await api('/api/bootstrap');
    Object.assign(state, {
      defaults: data.defaults,
      presets: data.presets,
      algorithms: data.algorithms,
      limits: data.limits,
    });
    populate(state.defaults);
    renderAlgorithms();
    updateExperimentEstimates();
    $('#connection-text').textContent = 'Python engine подключён';
    $$('.preset').forEach((el) =>
      el.addEventListener('click', () => {
        $$('.preset').forEach((p) => {
          p.classList.toggle('selected', p === el);
          p.setAttribute('aria-pressed', String(p === el));
        });
        const current = { ...state.defaults };
        for (const input of $('#config-form').elements)
          if (input.name) current[input.name] = input.type === 'number' ? Number(input.value) : input.value;
        populate({ ...current, ...state.presets[el.dataset.preset] });
      })
    );
    $('#reset').addEventListener('click', () => {
      $$('.preset').forEach((p) => {
        p.classList.toggle('selected', p.dataset.preset === 'geo');
        p.setAttribute('aria-pressed', String(p.dataset.preset === 'geo'));
      });
      populate(state.defaults);
      toast('Параметры сброшены к сценарию GEO.');
    });
    await refreshHistory();
  } catch (error) {
    $('#connection-text').textContent = 'Симулятор недоступен';
    $('#connection-dot').classList.add('offline');
    busy(true);
    toast(readable(error), true);
  }
}
init();
