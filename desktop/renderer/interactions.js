'use strict';

// One delegated controller also handles SVGs inserted after jobs, filters and theme changes.
window.HarqInteractions = (() => {
  const ns = 'http://www.w3.org/2000/svg';
  const cache = new WeakMap();
  const titles = new WeakMap();
  let current, pending, frame, tooltip;
  const fmt = (value) =>
    Number.isFinite(value)
      ? value !== 0 && Math.abs(value) < 0.0001
        ? value.toExponential(3)
        : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 4 })
      : 'нет данных';
  function node(tag, attrs = {}, text) {
    const el = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    if (text != null) el.textContent = text;
    return el;
  }
  function metadata(svg) {
    if (cache.has(svg)) return cache.get(svg);
    let meta;
    try {
      meta = JSON.parse(svg.dataset.chart);
    } catch {
      return null;
    }
    if (![meta.left, meta.right, meta.top, meta.bottom].every(Number.isFinite)) return null;
    const overlay = node('g', { class: 'chart-crosshair', 'aria-hidden': 'true', visibility: 'hidden' });
    const horizontal = node('line', { class: 'crosshair-guide' });
    const vertical = node('line', { class: 'crosshair-guide' });
    const dot = node('circle', { class: 'crosshair-dot', r: 3 });
    const xBg = node('rect', { class: 'crosshair-label-bg', height: 18 });
    const yBg = node('rect', { class: 'crosshair-label-bg', height: 18 });
    const xText = node('text', { class: 'crosshair-label', 'text-anchor': 'middle' });
    const yText = node('text', { class: 'crosshair-label', 'text-anchor': 'end' });
    overlay.append(horizontal, vertical, dot, xBg, yBg, xText, yText);
    svg.append(overlay);
    const lines = [...svg.querySelectorAll('polyline[data-series]')].map((el) => ({
      name: el.dataset.series,
      points: [...el.points].map((p) => ({ x: p.x, y: p.y })),
    }));
    const value = { meta, overlay, horizontal, vertical, dot, xBg, yBg, xText, yText, lines };
    cache.set(svg, value);
    return value;
  }
  function coordinates(p, meta) {
    const nearest = (values, axis) =>
      values.reduce((a, b) => (Math.abs(a[axis] - p[axis]) < Math.abs(b[axis] - p[axis]) ? a : b));
    return {
      x: Array.isArray(meta.xCategories)
        ? meta.xCategories.length
          ? nearest(meta.xCategories, 'x').label
          : 'нет данных'
        : fmt(meta.xMin + ((p.x - meta.left) / (meta.right - meta.left)) * (meta.xMax - meta.xMin)),
      y: Array.isArray(meta.categories)
        ? meta.categories.length
          ? nearest(meta.categories, 'y').label
          : 'нет данных'
        : fmt(meta.yMin + ((meta.bottom - p.y) / (meta.bottom - meta.top)) * (meta.yMax - meta.yMin)),
    };
  }
  function tipFor(target, svg) {
    for (let el = target; el && el !== svg; el = el.parentElement) {
      if (el.dataset?.tip) return el.dataset.tip;
      if (titles.has(el)) return titles.get(el);
      const title = [...el.children].find((child) => child.tagName.toLowerCase() === 'title');
      if (title) {
        const text = title.textContent;
        titles.set(el, text);
        el.setAttribute('aria-label', text);
        title.remove(); // Avoid a second delayed native browser tooltip over the custom one.
        return text;
      }
    }
    return '';
  }
  function closestObservation(state, p, target) {
    let found = null,
      distance = Infinity;
    const series = target.closest?.('polyline[data-series]')?.dataset.series;
    for (const line of state.lines) {
      if (series && line.name !== series) continue;
      const points = line.points;
      let lo = 0,
        hi = points.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid].x < p.x) lo = mid + 1;
        else hi = mid;
      }
      for (let i = Math.max(0, lo - 2); i < Math.min(points.length, lo + 3); i++) {
        const d = Math.hypot(points[i].x - p.x, points[i].y - p.y);
        if (d < distance) {
          distance = d;
          found = { ...points[i], name: line.name };
        }
      }
    }
    const scale = current?.svg.getScreenCTM()?.a || 1;
    if (!found || distance * scale > 18) return '';
    const actual = coordinates(found, state.meta);
    return `Наблюдение: ${found.name}\nX: ${actual.x} ${state.meta.xUnit || ''}\nY: ${actual.y} ${state.meta.yUnit || ''}`;
  }
  function hide() {
    pending = null;
    if (current) current.state.overlay.setAttribute('visibility', 'hidden');
    current = null;
    if (tooltip) tooltip.hidden = true;
  }
  function paint(request) {
    const { svg, clientX, clientY, target } = request;
    if (!svg.isConnected) return hide();
    const state = metadata(svg),
      matrix = svg.getScreenCTM();
    if (!state || !matrix) return hide();
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const p = point.matrixTransform(matrix.inverse()),
      m = state.meta;
    if (p.x < m.left || p.x > m.right || p.y < m.top || p.y > m.bottom) return hide();
    if (current?.svg !== svg) hide();
    current = { svg, state };
    const values = coordinates(p, m);
    state.overlay.setAttribute('visibility', 'visible');
    for (const [name, value] of Object.entries({ x1: m.left, x2: p.x, y1: p.y, y2: p.y }))
      state.horizontal.setAttribute(name, value);
    for (const [name, value] of Object.entries({ x1: p.x, x2: p.x, y1: m.bottom, y2: p.y }))
      state.vertical.setAttribute(name, value);
    state.dot.setAttribute('cx', p.x);
    state.dot.setAttribute('cy', p.y);
    state.xText.textContent = values.x;
    state.yText.textContent = values.y;
    state.xText.setAttribute('x', p.x);
    state.xText.setAttribute('y', m.bottom + 15);
    state.yText.setAttribute('x', m.left - 5);
    state.yText.setAttribute('y', p.y + 4);
    const xWidth = state.xText.getComputedTextLength() + 10,
      yWidth = state.yText.getComputedTextLength() + 10;
    for (const [name, value] of Object.entries({ x: p.x - xWidth / 2, y: m.bottom + 2, width: xWidth }))
      state.xBg.setAttribute(name, value);
    for (const [name, value] of Object.entries({ x: m.left - yWidth - 1, y: p.y - 9, width: yWidth }))
      state.yBg.setAttribute(name, value);
    const detail = tipFor(target, svg) || closestObservation(state, p, target);
    const lines = [
      detail,
      `Курсор: ${m.xLabel}: ${values.x}${m.xUnit ? ' ' + m.xUnit : ''}`,
      `${m.yLabel}: ${values.y}${m.yUnit ? ' ' + m.yUnit : ''}`,
      m.notice,
    ].filter(Boolean);
    tooltip.textContent = lines.join('\n').replaceAll('\u2014', ':');
    tooltip.hidden = false;
    const rect = tooltip.getBoundingClientRect();
    let x = clientX + 16,
      y = clientY + 16;
    if (x + rect.width > innerWidth - 8) x = clientX - rect.width - 16;
    if (y + rect.height > innerHeight - 8) y = clientY - rect.height - 16;
    tooltip.style.left = `${Math.max(8, x)}px`;
    tooltip.style.top = `${Math.max(8, y)}px`;
  }
  function init() {
    tooltip = document.createElement('div');
    tooltip.id = 'chart-tooltip';
    tooltip.className = 'chart-tooltip';
    tooltip.role = 'tooltip';
    tooltip.hidden = true;
    document.body.append(tooltip);
    document.addEventListener(
      'pointermove',
      (event) => {
        const svg = event.target.closest?.('svg[data-chart]');
        if (!svg) {
          pending = null;
          return hide();
        }
        pending = { svg, clientX: event.clientX, clientY: event.clientY, target: event.target };
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = null;
            if (pending) paint(pending);
          });
      },
      { passive: true }
    );
    document.addEventListener(
      'pointerout',
      (event) => {
        if (current && (!event.relatedTarget || !current.svg.contains(event.relatedTarget))) {
          pending = null;
          hide();
        }
      },
      { passive: true }
    );
    document.addEventListener('focusin', (event) => {
      const svg = event.target.closest?.('svg[data-chart]');
      if (!svg || event.target === svg) return;
      const b = event.target.getBoundingClientRect();
      paint({ svg, target: event.target, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 });
    });
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        pending = null;
        hide();
      }
    });
    document.addEventListener(
      'scroll',
      () => {
        pending = null;
        hide();
      },
      true
    );
    window.addEventListener('resize', hide);
    window.addEventListener('harq:theme', hide);
  }
  document.addEventListener('DOMContentLoaded', init);
  return { hide };
})();
