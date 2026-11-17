'use strict';
window.HarqHardware = (() => {
  const $ = (s) => document.querySelector(s);
  let client,
    active = null,
    result = null,
    timer;
  const notes = {
    realtime_iq:
      'Только компьютер: TX, RX и I/Q-канал выполняются в отдельных процессах. Реальные CRC/FEC, синхронизация, мягкие буферы и ACK/NACK. Радиосреда программная; это не RF-измерение и не система жёсткого реального времени.',
    software_iq:
      'Без оборудования: реальные биты → CRC/FEC → BPSK I/Q → шум → синхронизация → LLR → Витерби → ACK/NACK через тот же I/Q-тракт. Это физический программный стенд, а не измерение RF.',
    pluto_pair:
      'Два отдельных PlutoSDR. Первый передаёт данные, второй декодирует и передаёт ACK/NACK обратно по радио. Профиль использует штатную IIO-прошивку; пользовательская FPGA-прошивка не загружается.',
    lx2160:
      'Отдельный режим платы: сервис HARQ выполняется на Linux/aarch64. Доступ через SSH-туннель. Для реального радио нужен RF/DMA-сервис, реализующий описанный UDP/IQ-контракт; без него проверяется только программный тракт на CPU платы.',
  };
  const keys = {
    started: 'Начато пакетов',
    transmissions: 'Передач',
    acknowledged: 'Подтверждено ACK',
    unacknowledged: 'Без ACK после лимита',
    timeouts: 'Таймаутов',
    nacks: 'Получено NACK',
    censored: 'Не завершено',
    tx_samples: 'Отправлено IQ-отсчётов',
    data_frames: 'Принято DATA-кадров',
    decoded: 'Декодирований',
    decode_errors: 'Ошибок CRC/FEC',
    delivered: 'Уникальных доставок RX',
    feedback_sent: 'Отправлено ACK/NACK',
    duplicates: 'Дубликатов',
    peak_soft_buffer_bytes: 'Пиковая память мягких буферов, байт',
    iq_samples: 'IQ-отсчётов',
    mean_power_dbfs: 'Средняя мощность, dBFS (оценка)',
  };
  function status(message) {
    $('#hw-status').textContent = message;
  }
  function profile() {
    const name = $('#hw-profile').value;
    window.dispatchEvent(new CustomEvent('harq:profile', { detail: name }));
    $('#hw-profile-note').textContent = notes[name];
    $('#hw-probe').disabled = name !== 'pluto_pair' || Boolean(active);
    $('#hw-run').textContent =
      name === 'realtime_iq'
        ? 'Запустить стенд CPU'
        : name === 'software_iq'
          ? 'Запустить I/Q-тест'
          : name === 'pluto_pair'
            ? 'Запустить стенд из двух Pluto'
            : 'Запустить на плате LX2160A';
    for (const id of [
      'hw-agent',
      'hw-token',
      'hw-board-action',
      'hw-board-host',
      'hw-board-port',
      'hw-local-port',
    ])
      $('#' + id).disabled = name !== 'lx2160';
    for (const id of ['hw-uri', 'hw-peer-uri']) $('#' + id).disabled = name !== 'pluto_pair';
    for (const id of ['hw-center', 'hw-bandwidth', 'hw-rx-gain', 'hw-tx-gain'])
      $('#' + id).disabled = name !== 'pluto_pair';
    $('#hw-realtime-fields').classList.toggle('hidden', name !== 'realtime_iq');
    for (const input of $('#hw-realtime-fields').querySelectorAll('input'))
      input.disabled = name !== 'realtime_iq';
    $('#hw-allow-tx').disabled = name === 'software_iq' || name === 'realtime_iq';
    $('#hw-snr').disabled =
      !['software_iq', 'realtime_iq'].includes(name) &&
      !(name === 'lx2160' && $('#hw-board-action').value === 'reference');
  }
  function config() {
    const name = $('#hw-profile').value,
      action = $('#hw-board-action').value;
    const remote = name === 'lx2160';
    return {
      backend: remote ? (action === 'reference' ? 'software_iq' : 'board_udp') : name,
      action: !remote || action === 'reference' ? 'link_test' : action,
      uri: $('#hw-uri').value.trim(),
      peer_uri: $('#hw-peer-uri').value.trim(),
      sample_rate: Number($('#hw-rate').value),
      center_hz: Number($('#hw-center').value),
      bandwidth_hz: Number($('#hw-bandwidth').value),
      rx_gain_db: Number($('#hw-rx-gain').value),
      tx_gain_db: Number($('#hw-tx-gain').value),
      samples_per_symbol: Number($('#hw-sps').value),
      rx_buffer_size: 2 ** Math.ceil(Math.log2(Math.max(32768, Number($('#hw-sps').value) * 1100))),
      packets: Number($('#hw-packets').value),
      processes: Number($('#hw-processes').value),
      max_transmissions: Number($('#hw-attempts').value),
      payload_bytes: Number($('#hw-payload').value),
      ack_timeout_ms: Number($('#hw-timeout').value),
      duration_s: Number($('#hw-duration').value),
      snr_db: Number($('#hw-snr').value),
      feedback_delay_ms: Number($('#hw-delay').value),
      algorithm: $('#hw-algorithm').value,
      allow_tx: $('#hw-allow-tx').checked,
      ...($('#hw-profile').value === 'realtime_iq'
        ? {
            propagation_ms: Number($('#hw-propagation').value),
            jitter_ms: Number($('#hw-jitter').value),
            carrier_offset_hz: Number($('#hw-cfo').value),
            clock_offset_ppm: Number($('#hw-clock').value),
            echo_delay_samples: Number($('#hw-echo-delay').value),
            echo_gain_db: Number($('#hw-echo-gain').value),
            iq_chunk_samples: Number($('#hw-chunk').value),
            iq_queue_samples: Number($('#hw-queue').value),
          }
        : {}),
      board_host: $('#hw-board-host').value.trim(),
      board_port: Number($('#hw-board-port').value),
      local_port: Number($('#hw-local-port').value),
    };
  }
  function destination() {
    const remote = $('#hw-profile').value === 'lx2160';
    const target = { remote, base_url: $('#hw-agent').value.trim(), token: $('#hw-token').value };
    if (remote && target.token.length < 24)
      throw new Error('Для агента платы требуется HARQ_AGENT_TOKEN длиной не менее 24 символов.');
    return target;
  }
  async function call(target, operation, config = null, id = null) {
    if (target.remote)
      return client.api('/api/hardware/remote', 'POST', {
        base_url: target.base_url,
        token: target.token,
        operation,
        ...(config ? { config } : {}),
        ...(id ? { job_id: id } : {}),
      });
    const paths = {
      capabilities: '/api/hardware/capabilities',
      probe: '/api/hardware/probe',
      start: '/api/hardware/jobs',
      status: `/api/hardware/jobs/${id}`,
      cancel: `/api/hardware/jobs/${id}/cancel`,
    };
    return client.api(
      paths[operation],
      ['capabilities', 'status'].includes(operation) ? 'GET' : 'POST',
      config ? { config } : null
    );
  }
  function drawResult(data) {
    result = data;
    $('#hw-result').replaceChildren();
    const source = document.createElement('p');
    source.className = 'hardware-note';
    source.textContent = `Источник: ${data.source}. Время: ${client.fmt(data.elapsed_total_s)} с. ${['software_iq_physical_reference', 'cpu_realtime_iq'].includes(data.source) ? 'RF-оборудование не использовалось.' : 'Результат аппаратного адаптера; аппаратные временные метки ADC/DAC не доступны.'}`;
    $('#hw-result').append(source);
    const table = document.createElement('table');
    const caption = document.createElement('caption');
    caption.textContent = 'Метрики физического запуска';
    table.append(caption);
    const metrics = {
      ...data.metrics,
      ...(data.acked_goodput_kbps != null ? { acked_goodput_kbps: data.acked_goodput_kbps } : {}),
      ...(data.ack_p95_host_ms != null ? { ack_p95_host_ms: data.ack_p95_host_ms } : {}),
    };
    for (const [key, value] of Object.entries(metrics)) {
      const row = table.insertRow();
      row.insertCell().textContent =
        keys[key] ||
        {
          acked_goodput_kbps: 'Подтверждённая скорость, кбит/с',
          ack_p95_host_ms: 'P95 создание пакета → ACK по часам хоста, мс',
        }[key] ||
        key;
      row.insertCell().textContent = client.fmt(value);
    }
    if (data.receiver_metrics)
      for (const [key, value] of Object.entries(data.receiver_metrics)) {
        const row = table.insertRow();
        row.insertCell().textContent = 'Приёмник: ' + (keys[key] || key);
        row.insertCell().textContent = client.fmt(value);
      }
    $('#hw-result').append(table);
    const note = document.createElement('p');
    note.className = 'chart-explanation';
    note.textContent =
      data.measurement_note || 'Измерения не смешиваются с результатами имитационной модели.';
    $('#hw-result').append(note);
    if (data.runtime) window.HarqHardwarePlots.render($('#hw-result'), data, client);
  }
  async function poll() {
    if (!active) return;
    try {
      const job = await call(active, 'status', null, active.id);
      const label =
        {
          queued: 'в очереди',
          running: 'выполняется',
          completed: 'завершён',
          failed: 'ошибка',
          cancelled: 'остановлен',
        }[job.status] || job.status;
      status(`Запуск стенда: ${label}${job.error ? ': ' + job.error : ''}`);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        if (job.result) drawResult(job.result);
        if (job.error) client.toast(job.error, true);
        else if (job.status === 'completed')
          client.toast('Физический запуск завершён. Результат можно сохранить в JSON.');
        active = null;
        $('#hw-run').disabled = false;
        $('#hw-cancel').classList.add('hidden');
        profile();
      } else timer = setTimeout(poll, 700);
    } catch (error) {
      status(
        client.readable(error) +
          ' Запуск на узле мог продолжиться; восстановите соединение и нажмите «Остановить».'
      );
      // Keep the job identity so cancellation is possible after a transient connection failure.
      timer = setTimeout(poll, 3000);
    }
  }
  function init(context) {
    client = context;
    if ($('#hw-profile').value === 'realtime_iq') $('#hw-timeout').value = '2000';
    profile();
    $('#hw-profile').addEventListener('change', () => {
      if ($('#hw-profile').value === 'realtime_iq' && Number($('#hw-timeout').value) < 2000)
        $('#hw-timeout').value = '2000';
      profile();
    });
    $('#hw-board-action').addEventListener('change', profile);
    $('#hw-check').addEventListener('click', async () => {
      try {
        const caps = await call(destination(), 'capabilities');
        status(
          $('#hw-profile').value === 'realtime_iq'
            ? `Узел: ${caps.platform}/${caps.machine}. Доступен локальный стенд CPU: TX, RX и программный I/Q-канал в трёх процессах. RF-оборудование не требуется.`
            : `Узел: ${caps.platform}/${caps.machine}. IIO-драйвер: ${caps.pluto_driver_installed ? 'установлен' : 'не установлен'}. Аппаратная проверка проекта: ${caps.hardware_verified ? 'выполнена' : 'ещё не выполнена'}.`
        );
      } catch (error) {
        status(client.readable(error));
      }
    });
    $('#hw-probe').addEventListener('click', async () => {
      try {
        const p = await call(destination(), 'probe', {
          backend: 'pluto',
          action: 'capture',
          uri: $('#hw-uri').value.trim(),
        });
        status(`IIO-контекст: ${p.description}. Устройств: ${p.devices.length}. TX не запускался.`);
      } catch (error) {
        status(client.readable(error));
      }
    });
    $('#hardware-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (active) return;
      try {
        const c = config(),
          target = destination();
        if (!['software_iq', 'realtime_iq'].includes(c.backend) && c.action !== 'capture' && !c.allow_tx)
          throw new Error('Разрешите TX для этого стенда. Приёмник HARQ тоже передаёт ACK/NACK.');
        const job = await call(target, 'start', c);
        active = { ...target, id: job.id };
        $('#hw-run').disabled = true;
        $('#hw-cancel').classList.remove('hidden');
        status('Физический запуск принят. Ожидаются реальные кадры, CRC и обратная связь.');
        poll();
      } catch (error) {
        status(client.readable(error));
        client.toast(client.readable(error), true);
      }
    });
    $('#hw-cancel').addEventListener('click', async () => {
      if (active)
        try {
          await call(active, 'cancel', null, active.id);
        } catch (error) {
          status(client.readable(error));
        }
    });
    $('#hw-export').addEventListener('click', async () => {
      if (!result) {
        client.toast('Сначала завершите физический запуск.');
        return;
      }
      await client.save('json', JSON.stringify(result, null, 2));
    });
  }
  return { init };
})();
