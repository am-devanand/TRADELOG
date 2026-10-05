// ============================================
// Audit Timeline — audit-history display (presentational only)
// Vanilla ESM, no storage, no network, no business logic.
// SEPARATE concept from the trade execution `events` timeline:
// this module renders AUDIT HISTORY (who did what to which entity)
// and never merges audit entries with trade execution events.
// All entries arrive via props; no auditLog imports.
// ============================================

import { escapeHtml } from '../utils/helpers.js';

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function entryTime(e) {
  const raw = e?.timestamp ?? e?.createdAt ?? e?.at ?? e?.time ?? '';
  const d = new Date(raw);
  return { raw: String(raw ?? ''), ms: Number.isFinite(d.getTime()) ? d.getTime() : 0, date: d };
}

function entryAction(e) {
  const a = e?.action ?? e?.type ?? e?.event ?? '';
  return String(a ?? '').trim() || 'UNKNOWN';
}

function entryEntity(e) {
  const en = e?.entity ?? e?.entityType ?? e?.target ?? '';
  return String(en ?? '').trim() || '—';
}

function entryEntityId(e) {
  const id = e?.entityId ?? e?.id ?? e?.ref ?? '';
  return String(id ?? '').trim();
}

function entryDetail(e) {
  const d = e?.details ?? e?.detail ?? e?.message ?? e?.note ?? '';
  return String(d ?? '').trim();
}

function entryActor(e) {
  const a = e?.actor ?? e?.userId ?? e?.user ?? e?.by ?? '';
  return String(a ?? '').trim();
}

function dayKey(ms) {
  if (!ms) return 'unknown';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDay(ms) {
  if (!ms) return 'Unknown date';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'Unknown date';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(ms, raw) {
  if (!ms) return raw ? String(raw) : '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return raw ? String(raw) : '—';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * Render AUDIT HISTORY for a given entity's audit entries.
 * Grouped by day. Each row shows time + action + entity.
 * Never pass trade execution `events` here — that is the TRADE TIMELINE.
 * @param {Array} entries audit entries [{timestamp|createdAt, action, entity, entityId, ...}]
 * @param {{emptyMessage?:string}} [opts]
 * @returns {string} HTML string (no DOM writes)
 */
export function renderAuditTimeline(entries, { emptyMessage } = {}) {
  const list = toArray(entries);
  if (list.length === 0) {
    return `
    <section class="card p8-audit" aria-label="Audit history">
      <h3 class="p8-title">Audit history</h3>
      <p class="p8-sub">Audit record for this item — distinct from the trade timeline of execution events.</p>
      <div class="empty-state">
        <h3>No audit entries</h3>
        <p>${escapeHtml(emptyMessage || 'No audit history recorded for this item yet.')}</p>
      </div>
    </section>`;
  }

  const sorted = [...list].sort((a, b) => entryTime(b).ms - entryTime(a).ms);
  const groups = new Map();
  for (const e of sorted) {
    const k = dayKey(entryTime(e).ms);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  const groupsHtml = [...groups.entries()].map(([k, items]) => {
    const headMs = entryTime(items[0]).ms;
    const rows = items.map((e, i) => {
      const t = entryTime(e);
      const action = entryAction(e);
      const entity = entryEntity(e);
      const eid = entryEntityId(e);
      const detail = entryDetail(e);
      const actor = entryActor(e);
      const detailId = `p8-audit-${escapeHtml(k)}-${i}`;
      return `<li class="p8-audit-row">
        <span class="p8-audit-time">${escapeHtml(fmtTime(t.ms, t.raw))}</span>
        <span class="badge badge-gold p8-audit-action">${escapeHtml(action)}</span>
        <span class="p8-audit-entity">${escapeHtml(entity)}${eid ? ` <span class="p8-muted">#${escapeHtml(eid)}</span>` : ''}</span>
        ${actor ? `<span class="p8-muted p8-audit-actor">by ${escapeHtml(actor)}</span>` : ''}
        ${detail ? `<details class="p8-details" id="${detailId}">
          <summary>Details</summary>
          <p>${escapeHtml(detail)}</p>
        </details>` : ''}
      </li>`;
    }).join('');
    return `<div class="p8-audit-day">
      <h4 class="p8-audit-dayhead">${escapeHtml(fmtDay(headMs))} <span class="p8-muted">· ${escapeHtml(String(items.length))} entr${items.length === 1 ? 'y' : 'ies'}</span></h4>
      <ul class="p8-audit-list">${rows}</ul>
    </div>`;
  }).join('');

  return `
    <section class="card p8-audit" aria-label="Audit history">
      <div class="p8-lock-head">
        <h3 class="p8-title">Audit history</h3>
        <span class="badge badge-gold">◷ AUDIT HISTORY</span>
      </div>
      <p class="p8-sub">System audit record — who changed what and when. Not the <strong>trade timeline</strong> of execution events; the two sources are never merged.</p>
      ${groupsHtml}
    </section>`;
}

/**
 * Wire expandable audit details. Entries use native &lt;details&gt; (keyboard
 * accessible by default); this is a safe no-op when the timeline is absent.
 * @returns {Function} cleanup
 */
export function bindAuditTimeline() {
  return () => {};
}
