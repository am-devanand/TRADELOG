import { escapeHtml } from '../../utils/helpers.js';
import { statusBadge, normalizeStatus } from './propStatus.js';

// Props: { pct, limit, enabled, status, reason }
export function renderConsistencyCard({ pct = null, limit = null, enabled = true, status = 'SAFE', reason = '' } = {}) {
  const norm = normalizeStatus(status, enabled);
  const pctTxt = enabled === false ? 'Disabled'
    : (pct === null || pct === undefined || !Number.isFinite(Number(pct)) ? '—' : `${Number(pct).toFixed(1)}%`);
  const limTxt = limit === null || limit === undefined || !Number.isFinite(Number(limit)) ? '—' : `${Number(limit).toFixed(1)}%`;
  return `
    <div class="card prop-consistency prop-status-${norm.toLowerCase()}" aria-label="Consistency">
      <div class="prop-card-head">
        <h3>CONSISTENCY</h3>
        ${statusBadge(norm)}
      </div>
      <div class="prop-card-vals">
        <strong>${escapeHtml(pctTxt)}</strong>
        <span> / ${escapeHtml(limTxt)}${enabled === false ? '' : ' limit'}</span>
      </div>
      ${enabled === false
        ? `<p class="prop-card-note">Disabled</p>`
        : (reason ? `<p class="prop-card-note">${escapeHtml(String(reason))}</p>` : '')}
    </div>
  `;
}
