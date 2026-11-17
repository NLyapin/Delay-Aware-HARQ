'use strict';
window.HarqTrace = (() => {
  const labels = {
    NEW: 'Создан пакет',
    TX_START: 'Начало передачи',
    TX_END: 'Передача закончена',
    RX_ACK: 'Пакет принят успешно',
    RX_NACK: 'Ошибка декодирования',
    RX_DUPLICATE: 'Повторная копия уже принятого пакета',
    ACK: 'ACK получен передатчиком',
    NACK: 'NACK получен передатчиком',
    TIMEOUT: 'Истёк таймаут ожидания',
    FEEDBACK_LOST: 'Потеря обратной связи',
    DEADLINE: 'Дедлайн пакета',
    DROP: 'Пакет потерян',
  };
  const f = (v) => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
  const esc = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  function packetFlow(run, packet) {
    const events = run.trace.filter((e) => e.packet === packet);
    const tx = events.filter((e) => e.event === 'TX_START');
    if (!tx.length) return '<p class="muted">В сохранённой трассе нет передач этого пакета.</p>';
    const receivers = events.filter((e) => e.event.startsWith('RX_'));
    const responses = events.filter((e) => ['ACK', 'NACK', 'TIMEOUT', 'FEEDBACK_LOST'].includes(e.event));
    const first = tx[0],
      success = receivers.find((e) => e.event === 'RX_ACK'),
      ack = responses.find((e) => e.event === 'ACK');
    const width = 900,
      left = 180,
      right = 700,
      row = 65;
    const height = 75 + (tx.length + responses.length) * row;
    const ordered = [...tx, ...responses].sort(
      (a, b) => a.time_ms - b.time_ms || Number(a.event === 'TX_START') - Number(b.event === 'TX_START')
    );
    const position = new Map(ordered.map((event, i) => [event, i]));
    const meta = {
      left,
      right,
      top: 40,
      bottom: height - 10,
      xLabel: 'Узел',
      xCategories: [
        { x: left, label: 'Передатчик' },
        { x: right, label: 'Приёмник' },
      ],
      yLabel: 'Этап',
      categories: ordered.map((e, i) => ({ y: 70 + i * row, label: `${i + 1}: ${f(e.time_ms)} мс` })),
      notice: 'Схема этапов: расстояния не соответствуют масштабу времени.',
    };
    let svg = `<svg data-chart="${esc(JSON.stringify(meta))}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Обмен пакета ${packet} между передатчиком и приёмником"><text class="chart-value" x="${left}" y="22" text-anchor="middle">Передатчик</text><text class="chart-value" x="${right}" y="22" text-anchor="middle">Приёмник</text><path class="chart-gridline" d="M${left},35V${height - 10}M${right},35V${height - 10}"/>`;
    tx.forEach((t, i) => {
      const y = 70 + position.get(t) * row;
      // Old saved traces had a mutable attempt number; match observed receive time instead.
      const expected = t.time_ms + t.duration_ms + run.config.rtt_ms / 2;
      const received = receivers.find((e) => Math.abs(e.time_ms - expected) < 0.01);
      const result = received
        ? received.event === 'RX_NACK'
          ? 'ошибка, нужен повтор'
          : received.event === 'RX_DUPLICATE'
            ? 'дубликат'
            : 'успешный приём'
        : 'приём не записан в трассе';
      svg += `<g data-tip="${esc(`Пакет ${packet}; процесс P${t.process}; передача ${t.attempt}\nНачало TX: ${f(t.time_ms)} мс; длительность TX: ${f(t.duration_ms)} мс\nRX: ${received ? f(received.time_ms) + ' мс' : 'не зафиксирован'}; ${result}`)}">`;
      svg += `<path d="M${left},${y}H${right}m-8-5 8 5-8 5" stroke="var(--accent)" fill="none" stroke-width="1.5"/><text class="chart-label" x="${left - 12}" y="${y - 12}" text-anchor="end">${f(t.time_ms)} мс</text><text class="chart-label" x="${right + 12}" y="${y - 12}">${received ? f(received.time_ms) + ' мс' : 'н/д'}</text><text class="chart-value" x="440" y="${y - 13}" text-anchor="middle">Передача ${t.attempt} · TX ${f(t.duration_ms)} мс + путь ${f(run.config.rtt_ms / 2)} мс</text><text class="chart-label" x="440" y="${y + 19}" text-anchor="middle">Пакет ${packet}, процесс P${t.process}: ${result}</text>`;
      svg += '</g>';
    });
    responses.forEach((e, i) => {
      const y = 70 + position.get(e) * row;
      svg += `<g data-tip="${esc(`${labels[e.event]}\nВремя: ${f(e.time_ms)} мс; пакет ${packet}; процесс P${e.process}; попытка ${e.attempt}`)}">`;
      if (e.event === 'TIMEOUT') {
        svg += `<circle cx="${left}" cy="${y}" r="6" fill="none" stroke="var(--fg)"/><text class="chart-value" x="440" y="${y - 10}" text-anchor="middle">Локальный таймер передатчика: timeout</text><text class="chart-label" x="${left - 12}" y="${y + 4}" text-anchor="end">${f(e.time_ms)} мс</text><text class="chart-label" x="440" y="${y + 12}" text-anchor="middle">Сообщение от приёмника не получено</text>`;
      } else {
        svg += `<path d="M${right},${y}H${left}m8-5-8 5 8 5" stroke="var(--fg)" fill="none" stroke-width="1.3" stroke-dasharray="${e.event === 'FEEDBACK_LOST' ? '4 4' : '0'}"/><text class="chart-value" x="440" y="${y - 12}" text-anchor="middle">${labels[e.event]}</text><text class="chart-label" x="${left - 12}" y="${y + 4}" text-anchor="end">${f(e.time_ms)} мс</text><text class="chart-label" x="440" y="${y + 19}" text-anchor="middle">${e.event === 'ACK' ? 'Процесс освобождён для нового пакета' : e.event === 'NACK' ? 'Можно передать повтор' : 'Обратная связь потеряна; передатчик ждёт таймаут'}</text>`;
      }
      svg += '</g>';
    });
    svg += '</svg>';
    const summary = `<div class="packet-summary"><strong>Пакет ${packet} · процесс P${first.process}</strong><span>Передач в трассе: ${tx.length}</span><span>${success ? 'Доставлен за ' + f(success.time_ms - first.time_ms) + ' мс' : 'Успешный приём не зафиксирован'}</span><span>${ack ? 'ACK через ' + f(ack.time_ms - first.time_ms) + ' мс' : 'ACK не зафиксирован'}</span></div>`;
    const note =
      '<p class="chart-explanation">Это схема этапов, не временной масштаб. Подписанные времена взяты из трассы. Успешный приём и получение ACK: разные моменты. При упреждающем burst несколько копий уходят до первого ACK; обратная связь формируется по последней копии burst.</p>';
    return summary + svg + note;
  }
  return { labels, packetFlow };
})();
