// ============================================
// Metric Card — single KPI tile (presentational only)
// Always shows sample size (N = x). Null/undefined/NaN renders an "N/A"
// state visually distinct from 0. Status uses symbol + text, never
// color alone. All data arrives via props; no computation here.
// ============================================

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function toCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function isMissingValue(v) {
  if (v === null || v === undefined || v === '') return true;
  if (typeof v === 'number') return !Number.isFinite(v);
  return false;
}

const STATUS_META = {
  good: { icon: '✓', badge: 'badge-tp', label: 'Good' },
  warn: { icon: '!', badge: 'badge-gold', label: 'Watch' },
  bad: { icon: '×', badge: 'badge-sl', label: 'Weak' },
  neutral: { icon: '—', badge: 'badge-gold', label: 'Neutral' },
};

function statusOf(status) {
  const s = String(status ?? '').trim().toLowerCase();
  if (s === 'good' || s === 'positive' || s === 'tp' || s === 'pass') return 'good';
  if (s === 'warn' || s === 'warning' || s === 'caution' || s === 'ok') return 'warn';
  if (s === 'bad' || s === 'poor' || s === 'negative' || s === 'sl' || s === 'fail') return 'bad';
  if (s === '' || s === 'none' || s === 'neutral') return '';
  return '';
}

/**
 * Render a KPI metric card.
 * @param {Object} input
 * @param {string} input.label KPI name
 * @param {string|number} input.value preformatted display value (null → N/A)
 * @param {number} [input.n] sample size, always rendered
 * @param {string} [input.sub] secondary caption line
 * @param {string} [input.status] 'good' | 'warn' | 'bad' | '' (no badge when empty)
 * @param {string} [input.statusLabel] overrides default status text
 * @returns {string} HTML string
 */
export function renderMetricCard({ label, value, n, sub, status, statusLabel } = {}) {
  const name = String(label ?? 'Metric').trim() || 'Metric';
  const count = toCount(n);
  const missing = isMissingValue(value);
  const shown = missing ? 'N/A' : String(value);
  const st = statusOf(status);
  const meta = st ? STATUS_META[st] : null;
  const text = String(statusLabel ?? meta?.label ?? '').trim();
  const badge = meta
    ? `<span class="badge ${meta.badge}">${escapeHtml(meta.icon)} ${escapeHtml(text || meta.label)}</span>`
    : '';

  return `
    <div class="card analytics-metric${missing ? ' analytics-metric--na' : ''}" role="group" aria-label="${escapeHtml(`${name}: ${shown}. Sample size ${count}.`)}">
      <div class="analytics-metric-top">
        <span class="stat-label">${escapeHtml(name)}</span>
        <span class="badge badge-gold analytics-n" aria-label="Sample size ${escapeHtml(String(count))}">N = ${escapeHtml(String(count))}</span>
      </div>
      <div class="stat-value${missing ? ' analytics-na-value' : ''}" aria-label="${escapeHtml(missing ? 'Not available — not enough data' : shown)}">${escapeHtml(shown)}</div>
      ${sub ? `<p class="analytics-metric-sub">${escapeHtml(String(sub))}</p>` : ''}
      ${badge ? `<div class="analytics-metric-status">${badge}</div>` : ''}
    </div>`;
}

if (typeof window !== 'undefined') {
  window.TradeLogComponents = {
    ...(window.TradeLogComponents || {}),
    renderMetricCard,
  };
}
