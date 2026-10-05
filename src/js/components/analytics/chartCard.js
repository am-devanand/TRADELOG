// ============================================
// Chart Card — Chart.js wrapper (presentational only)
// Renders a titled card with a <canvas> or an empty state, and keeps a
// module-level registry of live Chart.js instances so pages can destroy
// them before re-render (fixes the historic leak where old charts kept
// animating/listeners after innerHTML replacement).
// ============================================
import { renderSampleBadge } from './sampleBadge.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);
}

/** canvasId -> Chart.js instance */
const registry = new Map();

/**
 * Register a created Chart.js instance for later cleanup. Pages call this
 * right after `new Chart(canvas, config)`.
 * @param {string} canvasId
 * @param {{ destroy?: Function }} chart
 */
export function registerChart(canvasId, chart) {
  if (!isValidId(canvasId) || !chart || typeof chart.destroy !== 'function') return;
  const prev = registry.get(canvasId);
  if (prev && prev !== chart) {
    try {
      prev.destroy();
    } catch {
      /* already dead */
    }
  }
  registry.set(canvasId, chart);
}

function destroyInstance(chart) {
  try {
    chart.destroy();
  } catch {
    /* ignore double-destroy */
  }
}

function lookupFallback(canvasId) {
  // Chart.js v3/v4 exposes Chart.getChart(canvas|id). Use it when a page
  // created a chart without calling registerChart().
  try {
    const C = typeof window !== 'undefined' ? window.Chart : undefined;
    if (C && typeof C.getChart === 'function') {
      const canvas = typeof document !== 'undefined' ? document.getElementById(canvasId) : null;
      const found = C.getChart(canvas || canvasId);
      if (found && typeof found.destroy === 'function') return found;
    }
  } catch {
    /* noop */
  }
  return null;
}

/**
 * Destroy charts for the given canvas ids (unknown ids ignored).
 * @param {Array<string>} canvasIds
 */
export function destroyCharts(canvasIds) {
  const ids = Array.isArray(canvasIds) ? canvasIds : [canvasIds];
  for (const raw of ids) {
    const id = String(raw ?? '');
    if (!id) continue;
    const known = registry.get(id);
    if (known) {
      destroyInstance(known);
      registry.delete(id);
      continue;
    }
    const fallback = lookupFallback(id);
    if (fallback) destroyInstance(fallback);
  }
}

/** Destroy every registered chart (call before full analytics re-render). */
export function destroyAllCharts() {
  for (const [, chart] of registry) destroyInstance(chart);
  registry.clear();
  // Sweep stragglers created without registerChart().
  try {
    const C = typeof window !== 'undefined' ? window.Chart : undefined;
    if (C && typeof C.getChart === 'function') {
      for (const canvas of document.querySelectorAll('canvas[data-chart-card]')) {
        const stray = C.getChart(canvas);
        if (stray && typeof stray.destroy === 'function') destroyInstance(stray);
      }
    }
  } catch {
    /* noop */
  }
}

/**
 * Render a chart card wrapper. The page creates the Chart.js instance
 * inside `requestAnimationFrame`/after insert, then calls registerChart().
 * @param {Object} input
 * @param {string} input.title card heading
 * @param {string} input.canvasId <canvas> id (must be a valid HTML id)
 * @param {boolean} [input.empty] show emptyMessage instead of canvas
 * @param {string} [input.emptyMessage]
 * @param {number} [input.n] sample size for the header badge
 * @param {number} [input.minimumSample] forwarded to renderSampleBadge
 * @returns {string} HTML string
 */
export function renderChartCard({ title, canvasId, empty, emptyMessage, n, minimumSample } = {}) {
  const heading = String(title ?? 'Chart').trim() || 'Chart';
  const id = isValidId(canvasId) ? canvasId : 'analytics-chart';
  const showEmpty = empty === true;
  const msg = String(emptyMessage ?? 'Not enough data for this chart yet.').trim() || 'Not enough data for this chart yet.';
  const badge = n === undefined || n === null || n === '' ? '' : renderSampleBadge(n, { minimumSample });

  return `
    <section class="card chart-card analytics-chart-card" aria-label="${escapeHtml(heading)}">
      <div class="analytics-chart-head">
        <h3>${escapeHtml(heading)}</h3>
        ${badge}
      </div>
      ${
        showEmpty
          ? `<div class="empty-state" role="status"><h3>No data yet</h3><p>${escapeHtml(msg)}</p></div>`
          : `<div class="analytics-canvas-wrap"><canvas id="${escapeHtml(id)}" data-chart-card aria-label="${escapeHtml(heading)} chart" role="img"></canvas></div>`
      }
    </section>`;
}

if (typeof window !== 'undefined') {
  window.TradeLogComponents = {
    ...(window.TradeLogComponents || {}),
    renderChartCard,
    registerChart,
    destroyCharts,
    destroyAllCharts,
  };
  window.TradeLogCharts = {
    register: registerChart,
    destroy: destroyCharts,
    destroyAll: destroyAllCharts,
  };
}
