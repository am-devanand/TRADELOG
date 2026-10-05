import { escapeHtml } from '../../utils/helpers.js';
import { statusBadge, fmtMoney } from './propStatus.js';

// Props: { rule: { id, name, status, current, limit, currentLabel, limitLabel, reason, enabled } }
// Single rule row with status dot + name + current/limit + click-to-expand reason.
export function renderPropRuleCard({ rule } = {}) {
  const r = rule && typeof rule === 'object' ? rule : {};
  const id = escapeHtml(String(r.id ?? ''));
  const name = escapeHtml(String(r.name ?? r.label ?? 'Unnamed rule'));
  const cur = r.currentLabel != null ? String(r.currentLabel)
    : (r.current != null && Number.isFinite(Number(r.current)) ? fmtMoney(r.current) : '—');
  const lim = r.limitLabel != null ? String(r.limitLabel)
    : (r.limit != null && Number.isFinite(Number(r.limit)) ? fmtMoney(r.limit) : '—');
  const reason = String(r.reason ?? '').trim();
  const status = String(r.status ?? (r.enabled === false ? 'DISABLED' : 'SAFE')).toUpperCase();
  return `
    <div class="card prop-rule-row prop-status-${status.toLowerCase()}" data-prop-rule="${id}">
      <button type="button" class="prop-rule-head" data-action="prop-toggle-rule" data-id="${id}" aria-expanded="false">
        <span class="prop-dot" aria-hidden="true"></span>
        ${statusBadge(status)}
        <span class="prop-rule-name">${name}</span>
        <span class="prop-rule-vals">${escapeHtml(cur)} / ${escapeHtml(lim)}</span>
        <span class="prop-rule-caret" aria-hidden="true">▾</span>
      </button>
      ${reason ? `<div class="prop-rule-reason" hidden><p>${escapeHtml(reason)}</p></div>` : ''}
    </div>
  `;
}
