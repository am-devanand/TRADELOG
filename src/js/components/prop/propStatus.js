import { escapeHtml } from '../../utils/helpers.js';

// Shared prop status helpers — symbol + text, never color alone.
export function normalizeStatus(s, enabled = true) {
  const v = String(s ?? '').trim().toUpperCase();
  if (enabled === false || v === 'DISABLED' || v === 'OFF') return 'DISABLED';
  if (v === 'BREACH' || v === 'FAILED' || v === 'VIOLATED') return 'BREACH';
  if (v === 'CRITICAL') return 'CRITICAL';
  if (v === 'WARNING') return 'WARNING';
  return 'SAFE';
}

export function statusBadge(status, enabled = true) {
  const s = normalizeStatus(status, enabled);
  if (s === 'BREACH') return `<span class="badge badge-sl">× BREACH</span>`;
  if (s === 'CRITICAL') return `<span class="badge prop-badge-critical">! CRITICAL</span>`;
  if (s === 'WARNING') return `<span class="badge prop-badge-warning">! WARNING</span>`;
  if (s === 'DISABLED') return `<span class="badge prop-badge-disabled">○ DISABLED</span>`;
  return `<span class="badge badge-tp">✓ SAFE</span>`;
}

export function fmtMoney(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function meterClass(status, enabled = true) {
  const s = normalizeStatus(status, enabled);
  if (s === 'BREACH') return 'is-breach';
  if (s === 'CRITICAL') return 'is-critical';
  if (s === 'WARNING') return 'is-warning';
  if (s === 'DISABLED') return 'is-disabled';
  return 'is-safe';
}

export function escapeAttr(v) {
  return escapeHtml(String(v ?? ''));
}
