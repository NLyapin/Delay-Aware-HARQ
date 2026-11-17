'use strict';
window.HarqHardwarePlots = (() => {
  const esc = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const W = 640,
    H = 270,
    L = 67,
    R = 18,
    T = 22,
    B = 44;
  const number = (v) => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
  function plot(series, { title, xLabel, yLabel, xMin, xMax, yMin, yMax, dots = false, categories }) {
    const points = series
      .flatMap((s) => s.points)
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!points.length)
      return '<p class="chart-explanation">Отсчёты не получены или синхронизация не захвачена. Проверьте SNR, искажения и таймаут.</p>';
    xMin ??= Math.min(...points.map((p) => p.x));
    xMax ??= Math.max(...points.map((p) => p.x));
    yMin ??= Math.min(...points.map((p) => p.y));
    yMax ??= Math.max(...points.map((p) => p.y));
    if (xMax === xMin) xMax = xMin + 1;
    if (yMax === yMin) yMax = yMin + 1;
    const x = (v) => L + ((v - xMin) / (xMax - xMin)) * (W - L - R),
      y = (v) => H - B - ((v - yMin) / (yMax - yMin)) * (H - T - B);
    const meta = { left: L, right: W - R, top: T, bottom: H - B, xMin, xMax, yMin, yMax, xLabel, yLabel };
    if (categories) meta.categories = categories.map((c) => ({ y: y(c.value), label: c.label }));
    let svg = `<svg viewBox="0 0 ${W} ${H}" data-chart="${esc(JSON.stringify(meta))}" role="img" aria-label="${esc(title)}">`;
    for (let i = 0; i <= 4; i++) {
      const xx = xMin + ((xMax - xMin) * i) / 4;
      svg += `<path class="chart-gridline" d="M${x(xx)} ${T}V${H - B}"/><text class="chart-label" x="${x(xx)}" y="${H - B + 17}" text-anchor="middle">${number(xx)}</text>`;
    }
    const levels =
      categories ||
      Array.from({ length: 5 }, (_, i) => ({
        value: yMin + ((yMax - yMin) * i) / 4,
        label: number(yMin + ((yMax - yMin) * i) / 4),
      }));
    for (const level of levels) {
      svg += `<path class="chart-gridline" d="M${L} ${y(level.value)}H${W - R}"/><text class="chart-label" x="${L - 8}" y="${y(level.value) + 4}" text-anchor="end">${esc(level.label)}</text>`;
    }
    for (const [index, s] of series.entries()) {
      const color = index ? 'var(--fg)' : 'var(--accent)';
      if (!dots)
        svg += `<polyline data-series="${esc(s.name)}" points="${s.points.map((p) => `${x(p.x)},${y(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.3"/>`;
      else
        for (const p of s.points)
          svg += `<circle tabindex="0" cx="${x(p.x)}" cy="${y(p.y)}" r="2.5" fill="${color}"><title>${esc(s.name)}: ${number(p.x)}, ${number(p.y)}</title></circle>`;
    }
    return (
      svg +
      `<text class="chart-label" text-anchor="middle" x="${W / 2}" y="${H - 5}">${esc(xLabel)}</text><text class="chart-label" x="${L}" y="13">${esc(yLabel)}</text></svg>`
    );
  }
  function card(title, help, svg) {
    return `<section class="analytics-card"><h3>${esc(title)}</h3><div class="plot-container">${svg}</div><p class="chart-explanation">${esc(help)}</p></section>`;
  }
  function render(container, data, client) {
    const section = document.createElement('section');
    section.className = 'runtime-diagnostics';
    const roles = { tx: 'Передатчик', rx: 'Приёмник', channel: 'Программный канал' };
    let html =
      '<h2>Измерения процессов CPU</h2><div class="runtime-table"><table><thead><tr><th>Процесс</th><th>PID</th><th>Время, с</th><th>CPU, с</th><th>CPU, % одного ядра</th><th>Пик RSS, МиБ</th></tr></thead><tbody>';
    for (const [role, r] of Object.entries(data.runtime))
      html += `<tr><td>${esc(roles[role] || role)}</td><td>${r.pid}</td><td>${client.fmt(r.elapsed_s, 3)}</td><td>${client.fmt(r.cpu_s, 3)}</td><td>${client.fmt((100 * r.cpu_s) / Math.max(r.elapsed_s, 0.001), 1)}</td><td>${r.peak_rss_mb == null ? 'н/д' : client.fmt(r.peak_rss_mb, 1)}</td></tr>`;
    html += '</tbody></table></div>';
    const channel = data.channel_metrics || {},
      transport = data.receiver_transport || {};
    const activeTime = (transport.rx_samples || 0) / data.config.sample_rate;
    const ratio = activeTime ? transport.acquisition_cpu_wall_s / activeTime : null;
    const details = {
      'SNR по преамбуле RX, дБ': data.signal?.snr_estimate_db,
      'Оценка сдвига несущей при захвате, Гц': data.signal?.carrier_acquisition_hz,
      'Опоздание выдачи I/Q: среднее, мс': channel.scheduler_lag_mean_ms,
      'Опоздание выдачи I/Q: максимум, мс': channel.scheduler_lag_max_ms,
      'Пиковая очередь одного направления, отсчётов': channel.metrics?.peak_queue_samples || 0,
      'Отсчётов потеряно из-за заполнения очереди': channel.metrics?.overflow_samples || 0,
      'Отсчётов потеряно в буфере синхронизации RX': transport.sync_overflow_samples || 0,
      'Заголовков не прошло CRC/проверку': transport.rejected_headers || 0,
      'Максимальное время одного вызова синхронизации, мс': transport.max_acquisition_call_ms,
      'Время синхронизации / длительность принятых отсчётов': ratio,
    };
    html += '<table><tbody>';
    for (const [label, value] of Object.entries(details))
      html += `<tr><td>${esc(label)}</td><td>${value == null ? 'н/д' : client.fmt(value, 3)}</td></tr>`;
    html +=
      '</tbody></table><p class="chart-explanation">Отношение времени синхронизации к длительности отсчётов выше 1 означает, что этот тракт не успевает обрабатывать непрерывный поток данной частоты. Кадры здесь передаются порциями, с промежутками. Реальная устойчивость также зависит от очередей и нагрузки ОС.</p>';
    const signal = data.signal || {},
      iq = signal.iq || [],
      symbols = signal.symbols || [],
      spectrum = signal.spectrum_db || [];
    const series = [
      { name: 'I', points: iq.map((z, i) => ({ x: (i * 1000) / data.config.sample_rate, y: z[0] })) },
      { name: 'Q', points: iq.map((z, i) => ({ x: (i * 1000) / data.config.sample_rate, y: z[1] })) },
    ];
    html += '<div class="hardware-signal-grid">';
    html += card(
      'Принятые I/Q-отсчёты',
      'Фрагмент последних принятых отсчётов до синхронизации. Зелёный: I, чёрный/белый: Q. Амплитуда нормирована относительно переданного BPSK.',
      plot(series, { title: 'Принятые I/Q-отсчёты', xLabel: 'Время фрагмента, мс', yLabel: 'Амплитуда' })
    );
    const fs = data.config.sample_rate;
    html += card(
      'Спектр принятого фрагмента',
      'FFT с окном Hann по последним отсчётам RX. Относительный уровень амплитуды, не калиброванная мощность и не измерение dBm.',
      plot(
        [
          {
            name: 'FFT',
            points: spectrum.map((y, i) => ({
              x: ((i - spectrum.length / 2) * fs) / spectrum.length / 1000,
              y,
            })),
          },
        ],
        { title: 'Спектр RX', xLabel: 'Частота, кГц', yLabel: 'Относительный уровень, дБ' }
      )
    );
    const limit = Math.max(1.5, ...symbols.flatMap((z) => z.map(Math.abs)));
    html += card(
      'Созвездие после восстановления несущей',
      'Мягкие символы последнего кадра с корректным заголовком, до проверки CRC полезной нагрузки. Два скопления соответствуют BPSK; полноценный адаптивный эквалайзер и контур тактовой синхронизации не реализованы.',
      plot([{ name: 'BPSK', points: symbols.map((z) => ({ x: z[0], y: z[1] })) }], {
        title: 'Созвездие BPSK',
        xLabel: 'I',
        yLabel: 'Q',
        xMin: -limit,
        xMax: limit,
        yMin: -limit,
        yMax: limit,
        dots: true,
      })
    );
    const events = [
      ...(data.trace || []).map((e) => ({ ...e, role: 'TX' })),
      ...(data.receiver_trace || []).map((e) => ({ ...e, role: 'RX' })),
    ].sort((a, b) => a.time_ms - b.time_ms);
    const eventSeries = [
      {
        name: 'TX',
        points: events.filter((e) => e.role === 'TX').map((e) => ({ x: e.time_ms, y: e.process })),
      },
      {
        name: 'RX',
        points: events.filter((e) => e.role === 'RX').map((e) => ({ x: e.time_ms, y: e.process })),
      },
    ];
    let eventSvg = plot(eventSeries, {
      title: 'События HARQ по часам хоста',
      categories: [...new Set(events.map((e) => e.process))]
        .sort((a, b) => a - b)
        .map((value) => ({ value, label: 'P' + value })),
      xLabel: 'Время от старта, мс',
      yLabel: 'HARQ-процесс',
      xMin: 0,
      yMin: -0.5,
      yMax: Math.max(0.5, ...events.map((e) => e.process + 0.5)),
      dots: true,
    });
    let index = 0;
    // plot emits TX points first, then RX, so match descriptions to that same order.
    const ordered = [...events.filter((e) => e.role === 'TX'), ...events.filter((e) => e.role === 'RX')];
    eventSvg = eventSvg.replace(/<title>[^<]*<\/title>/g, () => {
      const e = ordered[index++];
      return `<title>${esc(`${e.role}: ${e.event}; пакет ${e.packet}; процесс P${e.process}; попытка ${e.attempt}; ${number(e.time_ms)} мс`)}</title>`;
    });
    html += card(
      'Фактические события HARQ',
      'Времена измерены общими монотонными часами компьютера. Зелёный: события передатчика; чёрный/белый: приёмника. Наведите курсор на точку для типа события и номера пакета.',
      eventSvg
    );
    html += '</div>';
    section.innerHTML = html;
    container.append(section);
  }
  return { render };
})();
