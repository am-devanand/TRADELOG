// ============================================
// Sample Badge — data-quality indicator (presentational only)
// Renders "N = x" always, plus "Small sample" when n < minimumSample.
// This flags low statistical confidence, never trader performance.
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

/**
 * Render a sample-size badge.
 * @param {number} sampleSize
 * @param {{ minimumSample?: number }} [opts]
 * @returns {string} HTML string
 */
export function renderSampleBadge(sampleSize, { minimumSample = 30 } = {}) {
  const n = toCount(sampleSize);
  const min = Number(minimumSample);
  const threshold = Number.isFinite(min) && min > 0 ? Math.floor(min) : 30;
  const small = n < threshold;
  return `<span class="badge ${small ? 'badge-gold' : 'badge-tp'} analytics-sample" role="status" aria-label="${escapeHtml(`Sample size ${n} of minimum ${threshold}. ${small ? 'Small sample — treat with caution.' : 'Sufficient sample.'}`)}" title="${escapeHtml(
    small
      ? `Only ${n} trade${n === 1 ? '' : 's'} in this slice (minimum ${threshold}). Averages may swing with one result — descriptive only.`
      : `${n} trades in this slice (minimum ${threshold}).`,
  )}">N = ${escapeHtml(String(n))}${small ? ' · Small sample' : ''}</span>`;
}

if (typeof window !== 'undefined') {
  window.TradeLogComponents = {
    ...(window.TradeLogComponents || {}),
    renderSampleBadge,
  };
}
