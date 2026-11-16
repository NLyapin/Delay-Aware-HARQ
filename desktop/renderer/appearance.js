'use strict';
// Applied before the stylesheet to avoid flashing the wrong theme on startup.
(() => {
  const root = document.documentElement;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let settings = {};
  try {
    settings = JSON.parse(localStorage.getItem('harq.appearance') || '{}');
  } catch {}
  root.dataset.theme = ['dark', 'light'].includes(settings.theme) ? settings.theme : 'dark';
  root.dataset.scale = ['85', '100', '115', '130'].includes(settings.scale) ? settings.scale : '100';

  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    wave: '<path d="M2 12h4l3-7 5 14 3-7h5"/>',
    timeline: '<path d="M3 5h18M3 12h18M3 19h18"/><path d="M7 2v6m10 1v6M9 16v6"/>',
    history: '<path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7M12 7v5l3 2"/>',
    book: '<path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15"/>',
    moon: '<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4.2 4.2l1.5 1.5m12.6 12.6 1.5 1.5M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5"/>',
    scale: '<path d="M4 5h16M12 5v15M7 20h10M2 2v6m20-6v6"/>',
    antenna:
      '<path d="m7 21 5-12 5 12M9 17h6M6 13a8 8 0 0 1 0-11m12 11a8 8 0 0 0 0-11M9 10a4 4 0 0 1 0-5m6 5a4 4 0 0 0 0-5"/><circle cx="12" cy="8" r="1"/>',
    orbit:
      '<circle cx="12" cy="12" r="7"/><ellipse cx="12" cy="12" rx="12" ry="4" transform="rotate(-35 12 12)"/><circle cx="20" cy="6" r="2"/>',
    satellite:
      '<path d="m9 8 7 7-4 4-7-7 4-4Zm-1-1 4-4 3 3-4 4m4 5 4-4 3 3-4 4M3 16l5 5m-7-1 3 3m11-15 4-4"/>',
  };
  function icons(scope = document) {
    scope.querySelectorAll('[data-icon]').forEach((el) => {
      el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${paths[el.dataset.icon] || paths.wave}</svg>`;
    });
  }
  function persist() {
    try {
      localStorage.setItem(
        'harq.appearance',
        JSON.stringify({ theme: root.dataset.theme, scale: root.dataset.scale })
      );
    } catch {}
  }
  function sync() {
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === root.dataset.theme));
    });
    document.querySelector('#ui-scale').value = root.dataset.scale;
  }
  function setTheme(theme) {
    if (root.dataset.theme === theme) return;
    const update = () => {
      root.dataset.theme = theme;
      sync();
      persist();
      window.dispatchEvent(new CustomEvent('harq:theme', { detail: theme }));
    };
    if (document.startViewTransition && !motion.matches && !document.hidden) {
      document.startViewTransition(update);
    } else update();
  }
  function enterView(view) {
    if (motion.matches) return;
    const heading = document.querySelector('.hero-copy h1');
    heading?.getAnimations().forEach((animation) => animation.cancel());
    heading?.animate(
      [
        { opacity: 0, transform: 'translateY(12px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 550, easing: 'cubic-bezier(.22,1,.36,1)' }
    );
  }
  function counters(scope) {
    if (motion.matches) return;
    scope.querySelectorAll('[data-counter]').forEach((el) => {
      const original = el.textContent;
      const number = Number(original.replace(/\s/g, '').replace('%', '').replace(',', '.'));
      if (!Number.isFinite(number)) return;
      const decimals = original.includes(',') ? original.split(',')[1].match(/^\d*/)?.[0].length || 0 : 0;
      const suffix = original.includes('%') ? '%' : '';
      const prefix = original.startsWith('+') ? '+' : '';
      const start = performance.now();
      function frame(time) {
        if (!el.isConnected) return;
        const t = Math.min(1, (time - start) / 1000);
        el.textContent =
          t === 1
            ? original
            : prefix +
              (number * (1 - (1 - t) ** 4)).toLocaleString('ru-RU', { maximumFractionDigits: decimals }) +
              suffix;
        if (t < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }
  window.labUI = { icons, setTheme, enterView, counters, reducedMotion: () => motion.matches };
  document.addEventListener('DOMContentLoaded', () => {
    icons();
    sync();
    document
      .querySelectorAll('[data-theme-choice]')
      .forEach((button) => button.addEventListener('click', () => setTheme(button.dataset.themeChoice)));
    document.querySelector('#ui-scale').addEventListener('change', (event) => {
      root.dataset.scale = event.target.value;
      persist();
    });
    document.querySelector('.brand').addEventListener('click', (event) => {
      event.preventDefault();
      document.querySelector('[data-view="overview"]').click();
    });
  });
})();
