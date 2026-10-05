// ============================================
// Integrity Report — data-integrity display (presentational only)
// Vanilla ESM, no storage, no network, no business logic.
// All results arrive via props (dataIntegrity output supplied by the page
// through handlers). This module never imports auditLog/dataIntegrity.
// Status is always symbol + text, never colour alone. A domain that was
// not checked renders as N/A — never as passing.
// ============================================

import { escapeHtml } from '../utils/helpers.js';

export const INTEGRITY_DOMAINS = [
  'Accounts',
  'Trades',
  'Setups',
  'Reviews',
  'Rules',
  'Prop Config',
  'Improvements',
];

const STATUS_META = {
  pass: { icon: '✓', badge: 'badge-tp', label: 'PASS' },
  warning: { icon: '!', badge: 'badge-gold', label: 'WARNING' },
  error: { icon: '×', badge: 'badge-sl', label: 'ERROR' },
  na: { icon: '?', badge: 'badge', label: 'N/A' },
};

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

/** Normalize any caller status spelling to pass|warning|error|na. Unknown → na (never passing). */
function normalizeStatus(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['PASS', 'PASSED', 'OK', 'HEALTHY', 'VALID'].includes(s)) return 'pass';
  if (['WARNING', 'WARN', 'CAUTION', 'HIGH_RISK'].includes(s)) return 'warning';
  if (['ERROR', 'FAIL', 'FAILED', 'INVALID', 'BREACH', 'CRITICAL'].includes(s)) return 'error';
  return 'na';
}

function normalizeDomainEntry(domain, raw) {
  if (raw == null) return { domain, status: 'na', errors: [], warnings: [], note: 'Check could not run.' };
  if (typeof raw === 'string') return { domain, status: normalizeStatus(raw), errors: [], warnings: [], note: '' };
  if (typeof raw !== 'object') return { domain, status: 'na', errors: [], warnings: [], note: 'Check could not run.' };
  const errors = toArray(raw.errors ?? raw.failures ?? raw.issues);
  const warnings = toArray(raw.warnings ?? raw.cautions);
  let status = normalizeStatus(raw.status ?? raw.state ?? raw.result ?? raw.health);
  if ((raw.checked === false || raw.ran === false || raw.skipped === true) && status === 'pass') status = 'na';
  // Derive from issue lists when no explicit status was supplied.
  const hasExplicit = raw.status ?? raw.state ?? raw.result ?? raw.health;
  if (!hasExplicit) {
    if (errors.length > 0) status = 'error';
    else if (warnings.length > 0) status = 'warning';
    else if (status === 'na' && (raw.checked === true || raw.ran === true)) status = 'pass';
  }
  return {
    domain,
    status,
    errors,
    warnings,
    note: String(raw.note ?? raw.message ?? raw.reason ?? ''),
  };
}

function toDomainList(report) {
  const r = report && typeof report === 'object' ? report : {};
  const src = r.domains ?? r.results ?? r.checks ?? null;
  if (Array.isArray(src)) {
    const byName = new Map();
    for (const d of src) {
      const name = String(d?.domain ?? d?.name ?? d?.key ?? '').trim();
      if (name) byName.set(name.toLowerCase(), d);
    }
    return INTEGRITY_DOMAINS.map((name) => normalizeDomainEntry(name, byName.get(name.toLowerCase()) ?? null));
  }
  if (src && typeof src === 'object') {
    const lower = {};
    for (const k of Object.keys(src)) lower[String(k).toLowerCase()] = src[k];
    const aliases = { 'prop config': ['prop config', 'propconfig', 'prop', 'prop_config', 'propconfig'] };
    return INTEGRITY_DOMAINS.map((name) => {
      const key = name.toLowerCase();
      const candidates = aliases[key] || [key, key.replace(/\s+/g, '_'), key.replace(/\s+/g, '')];
      let found = null;
      for (const c of candidates) {
        if (lower[c] !== undefined) { found = lower[c]; break; }
      }
      return normalizeDomainEntry(name, found);
    });
  }
  return INTEGRITY_DOMAINS.map((name) => normalizeDomainEntry(name, null));
}

function lastCheckedText(report) {
  const r = report && typeof report === 'object' ? report : {};
  const raw = r.checkedAt ?? r.lastChecked ?? r.lastCheckedAt ?? r.timestamp ?? r.ranAt ?? '';
  if (!raw) return 'Never checked';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return 'Never checked';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function issueText(issue) {
  if (typeof issue === 'string') return { entity: '', message: issue };
  if (issue && typeof issue === 'object') {
    return {
      entity: String(issue.entity ?? issue.entityId ?? issue.id ?? issue.target ?? '').trim(),
      message: String(issue.message ?? issue.reason ?? issue.detail ?? issue.error ?? '').trim() || JSON.stringify(issue),
    };
  }
  return { entity: '', message: String(issue ?? '') };
}

function issuesHtml(items, kind) {
  const arr = toArray(items);
  if (arr.length === 0) return '';
  const symbol = kind === 'error' ? '×' : '!';
  return `<ul class="p8-issues p8-issues-${escapeHtml(kind)}">${arr.map((it) => {
    const { entity, message } = issueText(it);
    return `<li><span aria-hidden="true">${symbol}</span> ${entity ? `<strong>${escapeHtml(entity)}</strong> — ` : ''}${escapeHtml(message)}</li>`;
  }).join('')}</ul>`;
}

/**
 * Render the per-domain integrity report. Returns an HTML string (no DOM writes).
 * @param {Object} [report] {checkedAt|lastChecked, domains: Object|Array}
 */
export function renderIntegrityReport(report = {}) {
  const domains = toDomainList(report);
  let errorCount = 0;
  let warningCount = 0;
  for (const d of domains) {
    errorCount += d.errors.length + (d.status === 'error' && d.errors.length === 0 ? 1 : 0);
    warningCount += d.warnings.length + (d.status === 'warning' && d.warnings.length === 0 ? 1 : 0);
  }
  const counts = `${warningCount} WARNING${warningCount === 1 ? '' : 'S'} · ${errorCount} ERROR${errorCount === 1 ? '' : 'S'}`;

  const rows = domains.map((d) => {
    const meta = STATUS_META[d.status] || STATUS_META.na;
    const detailCount = d.errors.length + d.warnings.length;
    const rowId = `p8-int-${d.domain.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    return `<li class="p8-domain" data-domain="${escapeHtml(d.domain)}" data-status="${escapeHtml(d.status)}">
      <span class="badge ${escapeHtml(meta.badge)}">${escapeHtml(meta.icon)} ${escapeHtml(meta.label)}</span>
      <span class="p8-domain-name">${escapeHtml(d.domain)}</span>
      ${d.status === 'na'
        ? `<span class="p8-muted">Not checked — did not run.</span>`
        : detailCount > 0
          ? `<details class="p8-details" id="${escapeHtml(rowId)}">
              <summary>Details (${escapeHtml(String(detailCount))})</summary>
              ${issuesHtml(d.errors, 'error')}
              ${issuesHtml(d.warnings, 'warning')}
            </details>`
          : `<span class="p8-muted">No issues found.</span>`}
      ${d.status === 'na' && d.note ? `<span class="p8-muted">${escapeHtml(d.note)}</span>` : ''}
    </li>`;
  }).join('');

  return `
    <section class="card p8-integrity" aria-live="polite" aria-label="Data integrity report">
      <div class="p8-lock-head">
        <h3 class="p8-title">Integrity report</h3>
        <span class="badge badge-gold" role="status">${escapeHtml(counts)}</span>
      </div>
      <p class="p8-sub">Last checked: ${escapeHtml(lastCheckedText(report))}</p>
      <ul class="p8-domains">${rows}</ul>
      <div class="p8-actions">
        <button type="button" class="btn btn-secondary" id="p8-integrity-run">Run integrity check</button>
      </div>
    </section>`;
}

/**
 * Render the reconciliation-check list. Returns an HTML string (no DOM writes).
 * A check that could not run renders as N/A — never as passing.
 * @param {Array} reconciliations [{key|name|label, status, message|detail}]
 */
export function renderReconciliationList(reconciliations) {
  const list = toArray(reconciliations);
  if (list.length === 0) {
    return `
    <section class="card p8-recon" aria-label="Reconciliation checks">
      <h3 class="p8-title">Reconciliation</h3>
      <div class="empty-state"><h3>No reconciliation checks</h3><p>Run an integrity check to populate reconciliation results.</p></div>
    </section>`;
  }
  const rows = list.map((r) => {
    const name = String(r?.label ?? r?.name ?? r?.key ?? r?.id ?? 'Unnamed check').trim() || 'Unnamed check';
    const status = normalizeStatus(r?.status ?? r?.state ?? r?.result);
    const meta = STATUS_META[status] || STATUS_META.na;
    const msg = String(r?.message ?? r?.detail ?? r?.note ?? '').trim();
    const notRun = status === 'na';
    return `<li class="p8-domain" data-status="${escapeHtml(status)}">
      <span class="badge ${escapeHtml(meta.badge)}">${escapeHtml(meta.icon)} ${escapeHtml(meta.label)}</span>
      <span class="p8-domain-name">${escapeHtml(name)}</span>
      ${notRun
        ? `<span class="p8-muted">N/A — check could not run.${msg ? ` ${escapeHtml(msg)}` : ''}</span>`
        : msg ? `<span class="p8-muted">${escapeHtml(msg)}</span>` : ''}
    </li>`;
  }).join('');
  return `
    <section class="card p8-recon" aria-label="Reconciliation checks">
      <h3 class="p8-title">Reconciliation</h3>
      <ul class="p8-domains">${rows}</ul>
    </section>`;
}

/**
 * Wire the integrity report's run-check button. No-ops when absent.
 * @param {{onRunCheck?:Function}} handlers
 * @returns {Function} cleanup
 */
export function bindIntegrityReport({ onRunCheck } = {}) {
  const el = document.getElementById('p8-integrity-run');
  if (!el || typeof onRunCheck !== 'function') return () => {};
  const listener = (e) => onRunCheck(e);
  el.addEventListener('click', listener);
  return () => el.removeEventListener('click', listener);
}
