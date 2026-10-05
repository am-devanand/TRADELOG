import { escapeHtml } from '../../utils/helpers.js';
import { meterClass, normalizeStatus } from './propStatus.js';

// Props: { value, max, status, enabled, label, ariaLabel }
// Progress bar with status colors (class only; colors live in prop.css tokens).
export function renderDrawdownMeter({ value = 0, max = 100, status = 'SAFE', enabled = true, label = '', ariaLabel = 'Progress' } = {}) {
  const hi = Number(max) > 0 ? Number(max) : 100;
  const v = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const pct = Math.min(100, Math.max(0, (v / hi) * 100));
  const cls = meterClass(status, enabled);
  const norm = normalizeStatus(status, enabled);
  return `
    <div class="progress prop-meter ${cls}" role="progressbar"
      aria-label="${escapeHtml(String(ariaLabel))}"
      aria-valuenow="${escapeHtml(pct.toFixed(1))}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-fill" style="width:${escapeHtml(pct.toFixed(1))}%"></div>
    </div>
    ${label ? `<div class="prop-meter-label">${escapeHtml(String(label))} · ${escapeHtml(norm === 'DISABLED' ? '○ DISABLED' : pct.toFixed(1) + '%')}</div>` : ''}
  `;
}
