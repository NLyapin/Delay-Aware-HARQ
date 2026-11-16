'use strict';

// All charts consume stored simulator output. No synthetic observations or interpolated statistics.
window.HarqAnalytics = (() => {
  const specs = [
    {
      key: 'goodput_kbps',
      id: 'goodput-chart',
      title: 'Полезная скорость',
      unit: 'кбит/с',
      group: 'performance',
      direction: 'Выше лучше',
      help: 'Уникальные доставленные биты / время моделирования. Повторные копии не увеличивают полезную скорость.',
    },
    {
      key: 'p95_latency_ms',
      id: 'latency-chart',
      title: 'Задержка доставки P95',
      unit: 'мс',
      group: 'performance',
      direction: 'Ниже лучше',
      help: '95% успешно доставленных пакетов приняты не позже этого времени. Отсчёт от первой передачи; потерянные пакеты не включены.',
    },
    {
      key: 'resolved_loss_rate',
      id: 'loss-chart',
      title: 'Окончательные потери пакетов',
      unit: '%',
      factor: 100,
      group: 'reliability',
      direction: 'Ниже лучше',
      help: 'Потерянные / (доставленные + потерянные). Пакеты без решения на горизонте исключены. Наблюдаемый ноль не доказывает отсутствие редких потерь.',
    },
    {
      key: 'bler',
      id: 'bler-chart',
      title: 'Ошибки декодирования — BLER',
      unit: '%',
      factor: 100,
      group: 'reliability',
      direction: 'Ниже лучше',
      help: 'Доля неудачных попыток декодирования. HARQ может исправить эти ошибки повторными передачами, поэтому BLER отличается от потерь пакетов.',
    },
    {
      key: 'utilization',
      id: 'utilization-chart',
      title: 'Загрузка радиоканала',
      unit: '%',
      factor: 100,
      group: 'resources',
      direction: 'Оценивать вместе со скоростью',
      help: 'Доля времени, занятая передачей. Высокая загрузка при низкой полезной скорости может означать много повторов.',
    },
    {
      key: 'peak_memory_kb',
      id: 'memory-chart',
      title: 'Пиковая память буферов',
      unit: 'КиБ',
      group: 'resources',
      direction: 'Ниже — меньше ресурсов',
      help: 'Максимальный зарезервированный объём буферов активных процессов. IR резервирует память под дополнительную избыточность.',
    },
    {
      key: 'mean_attempts_started',
      id: 'attempts-chart',
      title: 'Передачи на начатый пакет',
      unit: 'передач/пакет',
      group: 'resources',
      direction: 'Ниже — меньше повторов',
      help: 'Все начатые передачи / число начатых пакетов. Включает первую передачу, упреждающие копии и незавершённые пакеты.',
    },
    {
      key: 'symbols_per_delivered_bit',
      id: 'resource-chart',
      title: 'Стоимость доставки',
      unit: 'символов/бит',
      group: 'resources',
      direction: 'Ниже лучше',
      help: 'Все переданные кодовые символы / уникальные доставленные информационные биты. Учитывает кодирование, IR и повторы; при нуле доставок не определена.',
    },
  ];
  const axes = {
    rtt_ms: 'RTT, мс',
    snr_db: 'SNR, дБ',
    harq_processes: 'Число HARQ-процессов',
    max_transmissions: 'Максимальное число передач',
    memory_mb: 'Память, МиБ',
  };
  let ctx;
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const get = (row, key) => row.metrics[key] || { mean: null, ci_low: null, ci_high: null, n: 0 };
  const dash = ['0', '8 4', '2 3', '10 3 2 3', '0'];
  function configure(context) {
    ctx = context;
  }
  function number(value, digits = 2) {
    return value != null && value !== 0 && Math.abs(value) < 0.001
      ? value.toExponential(2)
      : ctx.fmt(value, digits);
  }
  function card(id, title, unit, help, group, body) {
    return `<section class="panel chart-panel analytics-card" data-chart-group="${group}"><div class="chart-title"><h3>${title}</h3><span>${unit}</span></div><div id="${id}" class="plot-container">${body}</div><p class="chart-explanation">${help}</p></section>`;
  }
  function legend(algorithms) {
    return `<div class="plot-legend">${algorithms.map((a, i) => `<span><svg width="24" height="9" aria-hidden="true"><line x1="0" x2="24" y1="4" y2="4" stroke="${ctx.colors[a]}" stroke-width="2" stroke-dasharray="${dash[i % 5]}"/></svg>${ctx.short[a]}</span>`).join('')}</div>`;
  }
  function empty(message = 'Нет наблюдений для этой метрики') {
    return `<div class="chart-no-data">${message}</div>`;
  }
  function bar(rows, spec) {
    const factor = spec.factor || 1;
    const values = rows.map((r) => get(r, spec.key));
    const dataMax = Math.max(
      0,
      ...values.flatMap((v) => [v.mean, v.ci_high].filter((x) => x != null).map((x) => x * factor))
    );
    const upperBound = spec.factor === 100 ? 100 : Infinity;
    const max = Math.min(upperBound, dataMax > 0 ? dataMax * 1.16 : 1);
    const width = 620,
      left = 116,
      right = 75,
      top = 12,
      rowH = 37,
      height = top + rows.length * rowH + 32;
    const x = (v) => left + (Math.min(upperBound, Math.max(0, v)) / max) * (width - left - right);
    let out = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${spec.title}, ${spec.unit}"><title>${spec.title}: средние и 95% ДИ по seed</title>`;
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      out += `<line class="chart-gridline" x1="${x(v)}" x2="${x(v)}" y1="0" y2="${height - 25}"/><text class="chart-label" text-anchor="middle" x="${x(v)}" y="${height - 5}">${number(v, dataMax < 5 ? 2 : 1)}</text>`;
    }
    rows.forEach((row, i) => {
      const value = values[i],
        y = top + i * rowH;
      out += `<text class="chart-label" x="0" y="${y + 16}">${ctx.short[row.algorithm]}</text>`;
      if (value.mean == null) {
        out += `<text class="chart-label" x="${left + 6}" y="${y + 16}">Нет данных</text>`;
        return;
      }
      const mean = value.mean * factor;
      out += `<rect class="chart-bar" tabindex="0" x="${left}" y="${y}" width="${Math.max(mean > 0 ? 0.8 : 0, x(mean) - left)}" height="22" fill="${ctx.colors[row.algorithm]}" stroke="${ctx.themeColor('--fg')}" stroke-width=".3"><title>${ctx.short[row.algorithm]}: ${ctx.fmt(mean, 4)} ${spec.unit}; 95% ДИ [${ctx.fmt(value.ci_low == null ? null : value.ci_low * factor, 4)}; ${ctx.fmt(value.ci_high == null ? null : value.ci_high * factor, 4)}]; n=${value.n}</title></rect>`;
      if (value.ci_low != null) {
        const low = x(Math.max(0, value.ci_low * factor)),
          high = x(value.ci_high * factor);
        out += `<path class="chart-ci" d="M${low},${y + 11}H${high}M${low},${y + 6}v10M${high},${y + 6}v10"/>`;
      }
      out += `<text class="chart-value" x="${x((value.ci_high ?? value.mean) * factor) + 7}" y="${y + 16}">${number(mean, 2)}</text>`;
    });
    return out + '</svg>';
  }
  function line(series, options) {
    const points = series.flatMap((s) => s.points).filter((p) => p.y != null && Number.isFinite(p.y));
    if (!points.length) return empty();
    const width = options.width || 660,
      height = 300,
      left = 62,
      right = 24,
      top = 25,
      bottom = 48;
    const loX = options.minX ?? points.reduce((v, p) => Math.min(v, p.x), Infinity);
    const hiX = options.maxX ?? points.reduce((v, p) => Math.max(v, p.x), -Infinity);
    const spanX = hiX - loX || 1;
    const upperBound = options.upperBound || Infinity;
    const hiY =
      options.maxY ||
      Math.min(upperBound, points.reduce((v, p) => Math.max(v, p.y, p.high ?? 0), 0.001) * 1.12);
    const x = (v) => left + ((v - loX) / spanX) * (width - left - right),
      y = (v) => height - bottom - (Math.min(upperBound, Math.max(0, v)) / hiY) * (height - top - bottom);
    let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(options.title)}"><rect width="100%" height="100%" fill="${ctx.themeColor('--bg')}"/><text x="${left}" y="13" fill="${ctx.themeColor('--muted')}" font-size="10">${esc(options.unit)}</text>`;
    for (let i = 0; i <= 4; i++) {
      const value = (hiY * i) / 4;
      out += `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="${ctx.themeColor('--line')}"/><text x="${left - 9}" y="${y(value) + 4}" text-anchor="end" fill="${ctx.themeColor('--muted')}" font-size="10">${ctx.fmt(value, hiY < 5 ? 2 : 1)}</text>`;
      const vx = loX + (spanX * i) / 4;
      out += `<text x="${x(vx)}" y="${height - 25}" text-anchor="middle" fill="${ctx.themeColor('--muted')}" font-size="10">${ctx.fmt(vx, 1)}</text>`;
    }
    if (options.reference != null)
      out += `<path d="M${left},${y(options.reference)}H${width - right}" stroke="${ctx.themeColor('--muted')}" stroke-dasharray="3 4"/><text x="${width - right}" y="${y(options.reference) - 5}" text-anchor="end" fill="${ctx.themeColor('--muted')}" font-size="10">${options.reference}%</text>`;
    series.forEach((s, i) => {
      // Split at missing observations instead of drawing a false zero or bridging gaps.
      let segment = [];
      const segments = [];
      for (const p of s.points) {
        if (p.y == null) {
          if (segment.length) segments.push(segment);
          segment = [];
        } else segment.push(p);
      }
      if (segment.length) segments.push(segment);
      for (const seg of segments)
        out += `<polyline points="${seg.map((p) => `${x(p.x)},${y(p.y)}`).join(' ')}" fill="none" stroke="${ctx.colors[s.algorithm]}" stroke-width="2" stroke-dasharray="${dash[i % 5]}"/>`;
      const valid = s.points.filter((p) => p.y != null);
      valid.forEach((p, j) => {
        if (p.low != null) {
          const low = y(Math.max(0, p.low)),
            high = y(p.high),
            xx = x(p.x);
          out += `<path d="M${xx},${low}V${high}M${xx - 3},${low}h6M${xx - 3},${high}h6" stroke="${ctx.colors[s.algorithm]}" stroke-width=".8"/>`;
        }
        if (options.dots || j % Math.max(1, Math.floor(valid.length / 10)) === 0)
          out += `<circle tabindex="0" cx="${x(p.x)}" cy="${y(p.y)}" r="${options.dots ? 3.5 : 2}" fill="${ctx.colors[s.algorithm]}" stroke="${ctx.themeColor('--fg')}" stroke-width=".5"><title>${ctx.short[s.algorithm]}: ${ctx.fmt(p.x)} ${options.xLabel}; ${ctx.fmt(p.y, 4)} ${options.unit}${p.low == null ? '' : `; 95% ДИ [${ctx.fmt(p.low, 4)}; ${ctx.fmt(p.high, 4)}]`}</title></circle>`;
      });
    });
    out += `<text x="${width / 2}" y="${height - 5}" text-anchor="middle" fill="${ctx.themeColor('--muted')}" font-size="11">${esc(options.xLabel)}</text></svg>`;
    return out;
  }
  function timeSeries(result, field) {
    return result.request.algorithms.map((algorithm) => {
      const runs = result.runs.filter((r) => r.algorithm === algorithm && r.series?.length);
      const times = [...new Set(runs.flatMap((r) => r.series.map((p) => p.time_ms)))].sort((a, b) => a - b);
      return {
        algorithm,
        points: times.map((t) => {
          const values = runs
            .map((r) => r.series.find((p) => p.time_ms === t)?.[field])
            .filter((v) => v != null);
          return { x: t / 1000, y: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
        }),
      };
    });
  }
  function outcomes(result) {
    const width = 660,
      left = 115,
      right = 25,
      rowH = 38,
      height = rowsHeight(result.summary.length);
    const keys = ['delivered', 'dropped', 'censored'],
      fills = ['#b6ff00', ctx.themeColor('--fg'), ctx.themeColor('--muted')];
    const max = Math.max(1, ...result.summary.map((r) => get(r, 'started').mean || 0));
    let out = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Доставленные, потерянные и незавершённые пакеты">`;
    result.summary.forEach((row, i) => {
      const y = 12 + i * rowH;
      let x = left;
      out += `<text class="chart-label" x="0" y="${y + 16}">${ctx.short[row.algorithm]}</text>`;
      keys.forEach((key, j) => {
        const value = get(row, key).mean || 0,
          w = (value / max) * (width - left - right);
        out += `<rect x="${x}" y="${y}" width="${w}" height="23" fill="${fills[j]}" opacity="${key === 'censored' ? 0.4 : 1}" stroke="${ctx.themeColor('--bg')}" stroke-width="1"><title>${ctx.short[row.algorithm]}: ${key} = ${ctx.fmt(value)} пакетов в среднем</title></rect>`;
        if (w > 35)
          out += `<text x="${x + w / 2}" y="${y + 16}" text-anchor="middle" font-size="11" fill="${j === 0 ? '#000' : ctx.themeColor('--bg')}">${ctx.fmt(value, 1)}</text>`;
        x += w;
      });
    });
    return (
      out +
      '</svg><div class="plot-legend">' +
      ['Доставлено', 'Потеряно', 'Незавершено']
        .map(
          (label, i) =>
            `<span><svg width="12" height="9" aria-hidden="true"><rect width="12" height="9" fill="${fills[i]}" opacity="${i === 2 ? 0.4 : 1}"/></svg>${label}</span>`
        )
        .join('') +
      '</div>'
    );
  }
  const rowsHeight = (count) => 12 + count * 38 + 25;
  function comparison(result) {
    let html = specs
      .map((spec) =>
        card(
          spec.id,
          spec.title,
          `${spec.unit} · ${spec.direction}`,
          spec.help +
            ' Среднее и 95% ДИ по seed.' +
            (spec.factor === 100
              ? ' Для наглядности ДИ долей отображаются в пределах 0–100%; исходные границы — в подсказке и экспорте.'
              : ''),
          spec.group,
          bar(result.summary, spec)
        )
      )
      .join('');
    const algorithms = result.request.algorithms;
    html += card(
      'goodput-time-chart',
      'Полезная скорость во времени',
      'кбит/с',
      'Накопленная полезная скорость от начала прогона. Линии — средние по seed, не мгновенная скорость. Первые доставки задержаны временем распространения.',
      'dynamics',
      line(timeSeries(result, 'goodput_kbps'), {
        title: 'Полезная скорость во времени',
        unit: 'кбит/с',
        xLabel: 'Время, с',
      }) + legend(algorithms)
    );
    html += card(
      'occupancy-chart',
      'Активные HARQ-процессы',
      'процессов',
      'Число занятых процессов во времени, усреднённое по seed. Процесс может ожидать ACK/NACK, даже если канал в этот момент свободен.',
      'dynamics',
      line(timeSeries(result, 'active'), {
        title: 'Активные HARQ-процессы',
        unit: 'процессов',
        xLabel: 'Время, с',
      }) + legend(algorithms)
    );
    const seed = result.request.config.seed;
    const cdf = algorithms.map((algorithm) => {
      const values = [
        ...(result.runs.find((r) => r.algorithm === algorithm && r.repetition === 0)?.latencies_ms || []),
      ].sort((a, b) => a - b);
      const points = [];
      if (values.length) points.push({ x: 0, y: 0 });
      let previous = 0;
      for (let i = 0; i < values.length; i++)
        if (i === values.length - 1 || values[i] !== values[i + 1]) {
          points.push({ x: values[i], y: previous });
          previous = ((i + 1) / values.length) * 100;
          points.push({ x: values[i], y: previous });
        }
      return { algorithm, points };
    });
    const truncated = result.runs.some((r) => r.repetition === 0 && r.latencies_truncated);
    html += card(
      'latency-cdf-chart',
      'Распределение задержки доставки',
      'CDF, %',
      `Ось X — задержка; Y — доля доставленных пакетов с задержкой не больше X. Пересечение уровня 95% соответствует P95. Только первый seed (${seed}), ${truncated ? 'сохранённая выборка до 20 000 задержек' : 'все сохранённые доставки'}; потерянные пакеты исключены.`,
      'performance dynamics',
      line(cdf, {
        title: 'Эмпирическая CDF задержки',
        unit: 'Доставленных пакетов, %',
        xLabel: 'Задержка, мс',
        maxY: 100,
        minX: 0,
        reference: 95,
      }) + legend(algorithms)
    );
    html += card(
      'outcomes-chart',
      'Исходы начатых пакетов',
      'пакетов',
      'Среднее число пакетов по seed. Сумма трёх частей равна числу начатых пакетов. Незавершённые не объявляются потерями.',
      'reliability',
      outcomes(result)
    );
    return html;
  }
  function sweep(result, spec, width = 1000) {
    const factor = spec.factor || 1;
    const series = result.request.algorithms.map((algorithm) => ({
      algorithm,
      points: result.summary
        .filter((r) => r.algorithm === algorithm)
        .sort((a, b) => a.axis_value - b.axis_value)
        .map((r) => {
          const v = get(r, spec.key);
          return {
            x: r.axis_value,
            y: v.mean == null ? null : v.mean * factor,
            low: v.ci_low == null ? null : v.ci_low * factor,
            high: v.ci_high == null ? null : v.ci_high * factor,
          };
        }),
    }));
    return line(series, {
      title: spec.title,
      unit: spec.unit,
      xLabel: axes[result.request.axis] || result.request.axis,
      width,
      dots: true,
      upperBound: spec.factor === 100 ? 100 : undefined,
    });
  }
  function sweepGrid(result, excludedKey = 'goodput_kbps') {
    return specs
      .filter((s) => s.key !== excludedKey)
      .map((spec) =>
        card(
          `sweep-${spec.id}`,
          spec.title,
          `${spec.unit} · 95% ДИ`,
          spec.help,
          spec.group,
          sweep(result, spec, 660)
        )
      )
      .join('');
  }
  function insights(result) {
    const rows = result.summary;
    const best = rows.reduce((a, b) => (get(a, 'goodput_kbps').mean > get(b, 'goodput_kbps').mean ? a : b));
    const messages = [
      `Максимальная средняя полезная скорость: ${ctx.short[best.algorithm]} — ${ctx.fmt(get(best, 'goodput_kbps').mean)} кбит/с. Это максимум среди выбранных стратегий в данной конфигурации.`,
    ];
    const pair = result.paired?.find((p) => p.axis_value == null)?.goodput_delta_kbps;
    if (pair)
      messages.push(
        `Разница Adaptive − Parallel: ${ctx.fmt(pair.mean)} кбит/с; 95% ДИ [${ctx.fmt(pair.ci_low)}; ${ctx.fmt(pair.ci_high)}]. ${pair.ci_low == null ? 'Для оценки неопределённости требуется больше одного seed.' : pair.ci_low > 0 ? 'В этом эксперименте интервал целиком выше нуля.' : pair.ci_high < 0 ? 'В этом эксперименте интервал целиком ниже нуля.' : 'Интервал включает ноль: направление разницы статистически не определено по этому интервалу.'}`
      );
    const totalCensored = rows.reduce((sum, r) => sum + (get(r, 'censored').mean || 0), 0);
    if (totalCensored > 0)
      messages.push(
        'Есть незавершённые пакеты. Для проверки устойчивости выводов увеличьте длительность прогона; незавершённые пакеты показаны отдельно от потерь.'
      );
    const a = rows.find((r) => r.algorithm === 'adaptive'),
      b = rows.find((r) => r.algorithm === 'parallel');
    const costA = a && get(a, 'symbols_per_delivered_bit').mean,
      costB = b && get(b, 'symbols_per_delivered_bit').mean;
    if (costA != null && costB > 0)
      messages.push(
        `Стоимость доставки Adaptive: ${ctx.fmt(costA)} против ${ctx.fmt(costB)} символов/бит у Parallel. ${costA > costB ? 'Adaptive расходует больше символов на каждый доставленный бит.' : 'В этом прогоне дополнительного расхода символов на доставленный бит относительно Parallel не наблюдается.'}`
      );
    return `<h3>Пояснения к результатам</h3><ul>${messages.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`;
  }
  return { configure, specs, axes, comparison, sweep, sweepGrid, legend, insights, bar };
})();
