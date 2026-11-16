'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const colors = { stop_wait: '#8c9bb5', parallel: '#e6b477', chase: '#7fa4ff', ir: '#cc9bea', adaptive: '#6ed9b8' };
const short = { stop_wait: 'Stop-and-Wait', parallel: 'Parallel', chase: 'Chase CC', ir: 'HARQ IR', adaptive: 'Adaptive' };
const descriptions = { stop_wait: ['Один процесс · без комбинирования', 'BASELINE', '↔'], parallel: ['N процессов · независимые повторы', 'TYPE I', '▥'], chase: ['Накопление SNR · повтор кодового блока', 'SOFT', '⊕'], ir: ['Новая избыточность · накопление информации', 'SOFT', '⌘'], adaptive: ['RTT + CSI · выбор режима и burst', 'PROPOSED', '✧'] };
const state = { defaults: null, presets: {}, algorithms: [], job: null, result: null, traceResult: null, view: 'overview', polling: null, pending: false };
const titles = { overview: ['Обзор эксперимента', 'Исследуйте связь.<br><span>Управляйте задержкой.</span>', 'Моделирование HARQ-ретрансмиссий в радиолиниях с большим временем распространения.'], sweep: ['Параметрические серии', 'Изменяйте параметры.<br><span>Находите закономерности.</span>', 'Серии независимых экспериментов с доверительными интервалами.'], timeline: ['Диаграмма передач', 'Каждая передача.<br><span>Каждое подтверждение.</span>', 'Наблюдайте события и состояние независимых HARQ-процессов.'], history: ['История запусков', 'Ваши эксперименты.<br><span>Всегда под рукой.</span>', 'Сохранённые конфигурации, результаты и воспроизводимые сравнения.'], method: ['Модель и методика', 'Прозрачная модель.<br><span>Проверяемые выводы.</span>', 'Математические допущения, исследовательский протокол и ограничения.'] };
const fmt = (value, digits = 2) => value == null ? '—' : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
const pct = value => value == null ? '—' : `${fmt(value * 100)}%`;
const escapeHTML = str => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add('hidden'), error ? 16000 : 4500); }
async function api(endpoint, method = 'GET', body = null) {
  if (window.harq) return window.harq.request(endpoint, method, body);
  const response = await fetch(endpoint, { method, ...(body !== null ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(await response.text());
  return endpoint.includes('/export/') ? response.text() : response.json();
}
function readable(error) { try { const value = JSON.parse(error.message); if (Array.isArray(value.detail)) return value.detail.map(e => `${e.loc.slice(1).join('.')}: ${e.msg}`).join('\n'); return value.detail || error.message; } catch { return error.message; } }
function setView(view, scroll = true) {
  state.view = view;
  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== `view-${view}`));
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  $('#crumb').textContent = titles[view][0]; $('#page-title').innerHTML = titles[view][1]; $('#page-description').textContent = titles[view][2];
  if (view === 'history') refreshHistory();
  if (scroll) window.scrollTo({ top: 0 });
}
function populate(config) { for (const input of $('#config-form').elements) if (input.name && config[input.name] !== undefined) input.value = config[input.name]; updateCapacity(); }
function config() {
  const invalid = [...$('#config-form').elements].find(el => el.willValidate && !el.checkValidity());
  if (invalid) {
    setView('overview');
    if (invalid.closest('details')) invalid.closest('details').open = true;
    invalid.reportValidity();
    throw new Error(`${invalid.closest('label').textContent.trim()}: ${invalid.validationMessage}`);
  }
  const value = { ...state.defaults };
  for (const input of $('#config-form').elements) if (input.name) value[input.name] = input.type === 'number' ? Number(input.value) : input.value;
  return value;
}
function updateCapacity() {
  const f = $('#config-form').elements, slot = Number(f.slot_ms.value), rtt = Number(f.rtt_ms.value), n = Number(f.harq_processes.value);
  const needed = Math.ceil((rtt + slot) / slot);
  $('#needed-processes').textContent = `${fmt(needed, 0)} процессов`;
  $('#capacity-caption').textContent = `Текущий теоретический предел загрузки: ${pct(Math.min(1, n * slot / (rtt + slot)))}`;
}
function renderAlgorithms() {
  $('#algorithm-list').innerHTML = state.algorithms.map(a => { const d = descriptions[a.id]; return `<label class="algorithm-row"><input type="checkbox" name="algorithm" value="${a.id}" checked><span class="algorithm-icon color-${a.id}">${d[2]}</span><span class="algorithm-text"><strong>${escapeHTML(a.label)}</strong><small>${d[0]}</small></span><span class="algo-tag">${d[1]}</span></label>`; }).join('');
  $$('input[name="algorithm"]').forEach(el => el.addEventListener('change', () => { $('#algorithm-count').textContent = `${$$('input[name="algorithm"]:checked').length} ВЫБРАНО`; }));
}
function busy(value) { state.pending = value; $('#run').disabled = value; $('#run-sweep').disabled = value; }
async function launch(sweep = false) {
  try {
    const algorithms = $$('input[name="algorithm"]:checked').map(el => el.value);
    if (!algorithms.length) throw new Error('Выберите хотя бы один алгоритм.');
    if (!$('#repetitions').reportValidity()) return;
    const request = { name: `${sweep ? 'Серия' : 'Сравнение'} · ${new Date().toLocaleString('ru-RU')}`, config: config(), algorithms, repetitions: Number($('#repetitions').value) };
    if (sweep) {
      request.axis = $('#sweep-axis').value;
      const text = $('#sweep-values').value.trim();
      if (!text || text.split(',').some(v => !v.trim() || !Number.isFinite(Number(v)))) throw new Error('Введите числовые значения через запятую. Десятичный разделитель — точка.');
      request.values = text.split(',').map(v => Number(v.trim()));
    }
    busy(true);
    const job = await api('/api/jobs', 'POST', request);
    state.job = job.id;
    $('#job-status').classList.remove('hidden');
    $('#job-message').textContent = 'В очереди на расчёт…'; $('#job-progress').value = 0;
    $('#cancel').classList.remove('hidden');
    setView('overview', false); $('#results-anchor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    poll();
  } catch (error) { busy(false); toast(readable(error), true); }
}
async function poll() {
  clearTimeout(state.polling);
  if (!state.job) return;
  try {
    const job = await api(`/api/jobs/${state.job}`);
    $('#job-status').classList.remove('hidden'); $('#job-message').textContent = job.message || job.status; $('#job-progress').value = job.progress;
    if (job.status === 'completed') {
      busy(false); $('#cancel').classList.add('hidden'); state.result = job.result; renderResults(); refreshHistory();
      toast('Эксперимент завершён. Результаты сохранены.');
      if (job.result.request.axis) setView('sweep');
      return;
    }
    if (['failed', 'cancelled', 'interrupted'].includes(job.status)) { busy(false); $('#cancel').classList.add('hidden'); toast(job.message, job.status !== 'cancelled'); refreshHistory(); return; }
    state.polling = setTimeout(poll, 600);
  } catch (error) { busy(false); toast(`Не удалось получить статус: ${readable(error)}`, true); }
}
function barChart(rows, metric) {
  const width = 550, left = 112, right = 60, top = 12, rowH = 45, height = top + rows.length * rowH + 28;
  const values = rows.map(r => r.metrics[metric]);
  const max = Math.max(1, ...values.map(v => v.ci_high ?? v.mean ?? 0)) * 1.08;
  const scale = v => left + (v / max) * (width - left - right);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(metric)}"><title>${escapeHTML(metric)} с 95% доверительными интервалами</title>`;
  for (let i = 0; i <= 4; i++) { const x = scale(max * i / 4); svg += `<line class="chart-gridline" x1="${x}" x2="${x}" y1="0" y2="${height - 25}"/><text class="chart-label" text-anchor="middle" x="${x}" y="${height - 4}">${fmt(max * i / 4, 0)}</text>`; }
  rows.forEach((r, i) => {
    const v = values[i], y = top + i * rowH;
    svg += `<text class="chart-label" x="0" y="${y + 18}">${short[r.algorithm]}</text>`;
    if (v.mean == null) { svg += `<text class="chart-value" x="${left + 5}" y="${y + 18}">Нет доставок</text>`; return; }
    svg += `<rect x="${left}" y="${y + 3}" width="${Math.max(0.8, scale(v.mean) - left)}" height="23" rx="3" fill="${colors[r.algorithm]}" opacity="0.85"><title>${short[r.algorithm]}: ${fmt(v.mean)}; ДИ [${fmt(v.ci_low)}; ${fmt(v.ci_high)}]</title></rect>`;
    if (v.ci_low != null) { const low = scale(Math.max(0, v.ci_low)), high = scale(v.ci_high), mid = y + 14; svg += `<path class="chart-ci" d="M${low},${mid} H${high} M${low},${mid - 5} v10 M${high},${mid - 5} v10"/>`; }
    svg += `<text class="chart-value" x="${scale(v.ci_high ?? v.mean) + 7}" y="${y + 19}">${fmt(v.mean, 1)}</text>`;
  });
  return svg + '</svg>';
}
function metricCard(label, value, unit, caption) { return `<div class="metric-card"><label>${label}</label><div class="metric-value">${value}<small>${unit}</small></div><p>${caption}</p></div>`; }
function renderResults() {
  const result = state.result; if (!result) return;
  if (result.request.axis) { renderSweep(); return; }
  state.traceResult = result;
  $('#empty-results').classList.add('hidden'); $('#result-content').classList.remove('hidden');
  const rows = result.summary, best = rows.reduce((a, b) => a.metrics.goodput_kbps.mean > b.metrics.goodput_kbps.mean ? a : b);
  const adaptive = rows.find(r => r.algorithm === 'adaptive'), base = rows.find(r => r.algorithm === 'parallel');
  const delta = adaptive && base && base.metrics.goodput_kbps.mean > 0 ? (adaptive.metrics.goodput_kbps.mean / base.metrics.goodput_kbps.mean - 1) * 100 : null;
  const cfg = result.request.config;
  $('#result-context').textContent = `Рассчитано: RTT ${fmt(cfg.rtt_ms)} мс · SNR ${fmt(cfg.snr_db)} дБ · ${cfg.harq_processes} процессов · ${cfg.channel} · ${fmt(cfg.simulation_time_ms / 1000)} с · ${result.request.repetitions} seed. Текущие поля конфигурации не изменяют сохранённый результат.`;
  $('#metric-cards').innerHTML = metricCard('ЛУЧШИЙ GOODPUT', fmt(best.metrics.goodput_kbps.mean), 'кбит/с', short[best.algorithm]) + metricCard('ADAPTIVE К PARALLEL', delta == null ? '—' : `${delta > 0 ? '+' : ''}${fmt(delta, 1)}`, '%', 'По средним goodput · не тест значимости') + metricCard('ЗАГРУЗКА ЛУЧШЕЙ СТРАТЕГИИ', pct(best.metrics.utilization.mean), '', 'Доля занятого эфирного времени') + metricCard('P95 ЛУЧШЕЙ СТРАТЕГИИ', fmt(best.metrics.p95_latency_ms.mean, 0), 'мс', 'Первый успешный приём');
  $('#goodput-chart').innerHTML = barChart(rows, 'goodput_kbps'); $('#latency-chart').innerHTML = barChart(rows, 'p95_latency_ms');
  $('#metrics-table').innerHTML = rows.map(r => { const m = r.metrics; return `<tr><td><span class="table-dot color-${r.algorithm}">●</span>${escapeHTML(short[r.algorithm])}</td><td>${fmt(m.goodput_kbps.mean)}</td><td>${pct(m.bler.mean)}</td><td>${pct(m.resolved_loss_rate.mean)}</td><td>${fmt(m.p95_latency_ms.mean, 1)}</td><td>${pct(m.utilization.mean)}</td><td>${fmt(m.peak_memory_kb.mean)}</td><td>${fmt(m.censored.mean)}</td></tr>`; }).join('');
  $('#trace-algorithm').innerHTML = result.request.algorithms.map(a => `<option value="${a}">${short[a]}</option>`).join('');
  $('#trace-algorithm').value = result.request.algorithms.includes('adaptive') ? 'adaptive' : result.request.algorithms[0]; renderTrace();
}
function renderSweep() {
  const result = state.result, rows = result.summary;
  const width = 1100, height = 420, left = 70, right = 35, top = 25, bottom = 55;
  const xs = result.request.values, minX = Math.min(...xs), maxX = Math.max(...xs), span = maxX - minX || 1;
  const maxY = Math.max(1, ...rows.map(r => r.metrics.goodput_kbps.ci_high ?? r.metrics.goodput_kbps.mean)) * 1.1;
  const x = v => left + (v - minX) / span * (width - left - right), y = v => height - bottom - v / maxY * (height - top - bottom);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Зависимость goodput от ${result.request.axis}"><rect width="100%" height="100%" fill="#111825"/><text x="${left}" y="15" fill="#8c9eba" font-size="11">Goodput, kbit/s · 95% CI</text>`;
  for (let i = 0; i <= 5; i++) { const v = maxY * i / 5, yy = y(v); svg += `<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" stroke="#29354a"/><text x="${left - 12}" y="${yy + 4}" text-anchor="end" fill="#8193b0" font-size="11">${fmt(v, 0)}</text>`; }
  xs.forEach(v => { svg += `<text x="${x(v)}" y="${height - 30}" text-anchor="middle" fill="#8193b0" font-size="11">${v}</text>`; });
  for (const algorithm of result.request.algorithms) {
    const points = rows.filter(r => r.algorithm === algorithm).sort((a, b) => a.axis_value - b.axis_value);
    svg += `<polyline points="${points.map(p => `${x(p.axis_value)},${y(p.metrics.goodput_kbps.mean)}`).join(' ')}" fill="none" stroke="${colors[algorithm]}" stroke-width="2.5"/>`;
    for (const p of points) { const v = p.metrics.goodput_kbps, xx = x(p.axis_value); if (v.ci_low != null) { const lo = y(Math.max(0, v.ci_low)), hi = y(v.ci_high); svg += `<path d="M${xx},${lo} V${hi} M${xx - 4},${lo} h8 M${xx - 4},${hi} h8" stroke="${colors[algorithm]}" opacity=".7"/>`; } svg += `<circle cx="${xx}" cy="${y(v.mean)}" r="4" fill="${colors[algorithm]}"><title>${short[algorithm]} · ${p.axis_value}: ${fmt(v.mean)} [${fmt(v.ci_low)}; ${fmt(v.ci_high)}]</title></circle>`; }
  }
  svg += `<text x="${width / 2}" y="${height - 7}" text-anchor="middle" fill="#9bacc6" font-size="12">${result.request.axis}</text></svg>`;
  $('#sweep-chart').classList.remove('empty-state'); $('#sweep-chart').innerHTML = svg;
  $('#sweep-legend').replaceChildren(...result.request.algorithms.map(a => { const span = document.createElement('span'); const dot = document.createElement('i'); dot.style.backgroundColor = colors[a]; span.append(dot, short[a]); return span; }));
  $('#sweep-table').innerHTML = rows.map(r => { const m = r.metrics, g = m.goodput_kbps; return `<tr><td>${short[r.algorithm]}</td><td>${r.axis_value}</td><td>${fmt(g.mean)}</td><td>[${fmt(g.ci_low)}; ${fmt(g.ci_high)}]</td><td>${pct(m.resolved_loss_rate.mean)}</td><td>${fmt(m.p95_latency_ms.mean)}</td></tr>`; }).join('');
}
function renderTrace() {
  if (!state.traceResult) return;
  const run = state.traceResult.runs.find(r => r.algorithm === $('#trace-algorithm').value && r.repetition === 0);
  if (!run) return;
  const offset = Math.max(0, Number($('#trace-offset').value) || 0), span = Math.max(10, Number($('#trace-window').value) || 1600);
  const trace = run.trace.filter(e => e.time_ms >= offset && e.time_ms <= offset + span);
  const processes = [...new Set(trace.filter(e => e.process != null).map(e => e.process))].sort((a, b) => a - b).slice(0, 16);
  const width = 1100, left = 65, top = 35, height = Math.max(130, processes.length * 42 + 70), x = t => left + (t - offset) / span * (width - left - 30);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Временная диаграмма HARQ"><title>Реальные события симуляции, первые 16 процессов в окне</title>`;
  for (let i = 0; i <= 5; i++) { const xx = x(offset + i * span / 5); svg += `<line class="chart-gridline" x1="${xx}" x2="${xx}" y1="20" y2="${height - 25}"/><text class="chart-label" x="${xx}" y="${height - 5}" text-anchor="middle">${fmt(offset + i * span / 5, 0)} ms</text>`; }
  processes.forEach((p, i) => { const yy = top + i * 42; svg += `<text class="chart-label" x="0" y="${yy + 4}">P${p}</text><line x1="${left}" x2="${width - 30}" y1="${yy}" y2="${yy}" stroke="#26364e" stroke-dasharray="3 4"/>`; for (const e of trace.filter(e => e.process === p)) { const xx = x(e.time_ms); if (e.event === 'TX_START') svg += `<rect x="${xx}" y="${yy - 8}" width="${Math.max(3, e.duration_ms / span * (width - left - 30))}" height="16" rx="2" fill="${e.attempt > 1 ? '#d0a0ed' : '#7fa4ff'}"><title>TX P${p} packet ${e.packet} attempt ${e.attempt} @ ${e.time_ms}ms</title></rect>`; else if (e.event.startsWith('RX_')) svg += `<circle cx="${xx}" cy="${yy}" r="4" fill="${e.event === 'RX_NACK' ? '#f1848e' : '#6ed9b8'}"><title>${e.event} ${e.time_ms}ms</title></circle>`; else if (['ACK', 'NACK', 'TIMEOUT', 'DROP'].includes(e.event)) svg += `<path d="M${xx},${yy - 5} l5,5 l-5,5 l-5,-5 Z" fill="${e.event === 'ACK' ? '#6ed9b8' : '#ed9b9c'}"><title>${e.event} ${e.time_ms}ms</title></path>`; } });
  $('#timeline-chart').classList.remove('empty-state'); $('#timeline-chart').innerHTML = svg + '</svg>';
  $('#trace-count').textContent = `${trace.length} в окне · сохранено ${run.trace.length}${run.trace_truncated ? ' · трасса ограничена' : ''} · до 16 процессов`;
  $('#trace-table').innerHTML = trace.slice(0, 400).map(e => `<tr><td>${fmt(e.time_ms, 3)}</td><td>${escapeHTML(e.event)}</td><td>${e.process ?? '—'}</td><td>${e.packet ?? '—'}</td><td>${e.attempt ?? '—'}</td><td>${escapeHTML(e.mode ?? '—')}</td></tr>`).join('');
}
async function refreshHistory() {
  try {
    const jobs = await api('/api/jobs'); $('#history-count').textContent = jobs.length;
    const labels = { completed: 'Завершён', running: 'Выполняется', queued: 'В очереди', failed: 'Ошибка', cancelled: 'Остановлен', interrupted: 'Прерван' };
    $('#history-table').innerHTML = jobs.length ? jobs.map(j => `<tr><td>${escapeHTML(j.name)}</td><td>${new Date(j.created).toLocaleString('ru-RU')}</td><td class="status-${j.status}">${labels[j.status] || j.status}</td><td>${pct(j.progress)}</td><td><button class="secondary-button" data-open="${j.id}">Открыть ↗</button></td></tr>`).join('') : '<tr><td colspan="5">Пока нет сохранённых экспериментов</td></tr>';
    $$('[data-open]').forEach(el => el.addEventListener('click', () => openJob(el.dataset.open)));
  } catch (error) { toast(readable(error), true); }
}
async function openJob(id) {
  try {
    if (state.pending) throw new Error('Дождитесь завершения текущего расчёта или остановите его.');
    const job = await api(`/api/jobs/${id}`); state.job = id;
    populate(job.request.config); $('#repetitions').value = job.request.repetitions;
    $$('input[name="algorithm"]').forEach(input => { input.checked = job.request.algorithms.includes(input.value); });
    $('#algorithm-count').textContent = `${job.request.algorithms.length} ВЫБРАНО`;
    $$('.preset').forEach(el => el.classList.remove('selected'));
    if (job.result) { state.result = job.result; renderResults(); setView(job.request.axis ? 'sweep' : 'overview'); }
    else if (['queued', 'running'].includes(job.status)) { busy(true); setView('overview'); poll(); }
    else toast(job.message, job.status === 'failed');
  } catch (error) { toast(readable(error), true); }
}
async function save(format, content) {
  if (window.harq) { const saved = await window.harq.save(format, content); if (saved) toast('Файл сохранён.'); return; }
  const blob = new Blob([content], { type: format === 'svg' ? 'image/svg+xml' : 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `harq-experiment.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function exportResult(format) { try { if (!state.job || !state.result || state.pending) throw new Error('Сначала завершите эксперимент.'); const content = await api(`/api/jobs/${state.job}/export/${format}`); await save(format, content); } catch (error) { toast(readable(error), true); } }
async function init() {
  $$('.nav-item').forEach(el => el.addEventListener('click', () => setView(el.dataset.view)));
  $('#config-form').addEventListener('submit', e => e.preventDefault());
  $('#config-form').addEventListener('input', () => { updateCapacity(); $$('.preset').forEach(el => el.classList.remove('selected')); });
  $('#run').addEventListener('click', () => launch()); $('#run-sweep').addEventListener('click', () => launch(true));
  $('#cancel').addEventListener('click', async () => { try { await api(`/api/jobs/${state.job}/cancel`, 'POST'); } catch (error) { toast(readable(error), true); } });
  $('#refresh-history').addEventListener('click', refreshHistory);
  $('#trace-update').addEventListener('click', renderTrace); $('#trace-algorithm').addEventListener('change', renderTrace);
  $$('[data-export]').forEach(el => el.addEventListener('click', () => exportResult(el.dataset.export)));
  $('#export-svg').addEventListener('click', async () => { try { const svg = $('#sweep-chart svg'); if (!svg) throw new Error('Сначала выполните серию.'); await save('svg', new XMLSerializer().serializeToString(svg)); } catch (error) { toast(readable(error), true); } });
  const recipes = { rtt_ms: [5, 20, 50, 100, 200, 500, 600], snr_db: [-6, -4, -2, 0, 2, 4, 6, 8], harq_processes: [1, 8, 16, 32, 64, 128, 256, 512], max_transmissions: [1, 2, 3, 4, 6, 8], memory_mb: [0.01, 0.05, 0.1, 0.5, 1, 4, 16] };
  $('#sweep-axis').addEventListener('change', () => { $('#sweep-values').value = recipes[$('#sweep-axis').value].join(', '); });
  $$('[data-recipe]').forEach(el => el.addEventListener('click', () => { $('#sweep-axis').value = el.dataset.recipe; $('#sweep-values').value = recipes[el.dataset.recipe].join(', '); }));
  try {
    const data = await api('/api/bootstrap'); Object.assign(state, { defaults: data.defaults, presets: data.presets, algorithms: data.algorithms });
    populate(state.defaults); renderAlgorithms(); $('#connection-text').textContent = 'Python engine подключён';
    $$('.preset').forEach(el => el.addEventListener('click', () => { populate({ ...config(), ...state.presets[el.dataset.preset] }); $$('.preset').forEach(p => p.classList.toggle('selected', p === el)); }));
    $('#reset').addEventListener('click', () => { populate(state.defaults); $$('.preset').forEach(p => p.classList.toggle('selected', p.dataset.preset === 'geo')); });
    await refreshHistory();
  } catch (error) { $('#connection-text').textContent = 'Симулятор недоступен'; $('#connection-dot').classList.add('offline'); busy(true); toast(readable(error), true); }
}
init();
