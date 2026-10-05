import { escapeHtml, formatCurrency } from '../../utils/helpers.js';

// Props: { size, balance, equity, equityAvailable, currency }
// Never fabricates equity: when equityAvailable is false shows N/A line.
export function renderPropSummary({ size, balance, equity, equityAvailable, currency = 'USD' } = {}) {
  const cur = currency || 'USD';
  const sizeTxt = size == null || !Number.isFinite(Number(size)) ? '—' : formatCurrency(size, cur);
  const balTxt = balance == null || !Number.isFinite(Number(balance)) ? '—' : formatCurrency(balance, cur);
  const eqTxt = equityAvailable && equity != null && Number.isFinite(Number(equity))
    ? formatCurrency(equity, cur)
    : 'N/A — no open positions';
  return `
    <div class="stat-card" aria-label="Account size">
      <div class="stat-label">Account size</div>
      <div class="stat-value">${escapeHtml(sizeTxt)}</div>
    </div>
    <div class="stat-card" aria-label="Balance">
      <div class="stat-label">Balance</div>
      <div class="stat-value">${escapeHtml(balTxt)}</div>
    </div>
    <div class="stat-card" aria-label="Equity">
      <div class="stat-label">Equity</div>
      <div class="stat-value${equityAvailable ? '' : ' prop-muted'}">${escapeHtml(eqTxt)}</div>
    </div>
  `;
}
