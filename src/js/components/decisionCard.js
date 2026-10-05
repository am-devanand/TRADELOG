// ============================================
// Decision Card — pre-trade discipline verdict (presentational only)
// Vanilla ESM, no storage, no network, no business logic.
// All data arrives via props (decisionEngine output). This module only
// renders HTML strings + wires button callbacks supplied by trade.js.
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

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function fmtScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return '0.0';
  return (Math.round(n * 10) / 10).toFixed(1);
}

function entryName(e, fallback = 'Unnamed rule') {
  if (!e || typeof e !== 'object') return fallback;
  const v = e.name ?? e.title ?? e.id ?? e.ruleId ?? e.key;
  const s = String(v ?? '').trim();
  return s || fallback;
}

function stateOf(state) {
  const s = String(state ?? '').trim().toUpperCase();
  if (s === 'READY' || s === 'WAITING' || s === 'NO_TRADE') return s;
  return 'NO_TRADE';
}

const EXPLAIN = {
  READY: 'Process conditions satisfied — discipline checks passed. This is not a prediction of profit.',
  WAITING: 'No blocker, but the checklist is incomplete — review the missing items before deciding.',
  NO_TRADE: 'A required blocker is present (see current-vs-limit reason below). No trade until it clears.',
};

const STATE_META = {
  READY: { icon: '✓', badge: 'badge-tp', label: 'READY', border: 'var(--color-tp-border)' },
  WAITING: { icon: '◷', badge: 'badge-gold', label: 'WAITING', border: 'var(--color-warning-border, rgba(250,173,20,0.35))' },
  NO_TRADE: { icon: '✕', badge: 'badge-sl', label: 'NO_TRADE', border: 'var(--color-sl-border)' },
};

/**
 * Strictest-wins RR banner. Pure display of caller-supplied numbers.
 * @param {{personalRR?: number|null, strategyRR?: number|null, effective?: number|null}} input
 * @returns {string} HTML string (empty when nothing to show)
 */
export function renderEffectiveRR({ personalRR, strategyRR, effective } = {}) {
  const p = personalRR === undefined || personalRR === null || personalRR === '' ? null : Number(personalRR);
  const s = strategyRR === undefined || strategyRR === null || strategyRR === '' ? null : Number(strategyRR);
  const e = effective === undefined || effective === null || effective === '' ? null : Number(effective);
  if ((p === null || !Number.isFinite(p)) && (s === null || !Number.isFinite(s)) && (e === null || !Number.isFinite(e))) {
    return '';
  }
  const fmt = (n) => (n === null || !Number.isFinite(n) ? '—' : `${n}R`);
  return `
    <div role="note" aria-label="Effective reward-to-risk requirement"
      style="display:flex;gap:8px;align-items:flex-start;background:var(--accent-gold-dim);border:1px solid var(--accent-gold-glow);border-radius:var(--radius-md);padding:10px 12px;margin-bottom:12px;font-size:var(--font-size-sm);">
      <span aria-hidden="true" style="font-weight:700;color:var(--accent-gold);">⚖</span>
      <span>
        <strong>Effective RR ≥ ${escapeHtml(fmt(e))}</strong>
        <span style="color:var(--text-secondary);"> (strictest-wins: personal ${escapeHtml(fmt(p))} · strategy ${escapeHtml(fmt(s))}). Trade RR must meet the effective limit.</span>
      </span>
    </div>`;
}

function listHtml(items, emptyText) {
  const arr = toArray(items);
  if (arr.length === 0) {
    return `<p style="color:var(--text-muted);font-size:var(--font-size-sm);margin:0;">${escapeHtml(emptyText)}</p>`;
  }
  return `<ul style="list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:8px;">${arr.map((e) => {
    const name = entryName(e);
    const reason = e && typeof e === 'object' && e.reason ? String(e.reason) : '';
    const source = e && typeof e === 'object' && e.source ? String(e.source) : '';
    const req = e && typeof e === 'object' && e.required === true
      ? `<span class="badge badge-sl" style="margin-left:6px;">REQUIRED</span>` : '';
    return `<li style="border:1px solid var(--border-color);border-radius:var(--radius-md);padding:8px 10px;font-size:var(--font-size-sm);">
      <span style="font-weight:600;">✕ ${escapeHtml(name)}</span>${req}
      ${reason ? `<br><span style="color:var(--text-secondary);">Current vs limit: ${escapeHtml(reason)}</span>` : ''}
      ${source ? `<br><span style="color:var(--text-muted);font-size:var(--font-size-xs);">Source: ${escapeHtml(source)}</span>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

function missingListHtml(items) {
  const arr = toArray(items);
  if (arr.length === 0) {
    return `<p style="color:var(--text-muted);font-size:var(--font-size-sm);margin:0;">Nothing missing.</p>`;
  }
  return `<ul style="list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:8px;">${arr.map((e) => {
    const name = entryName(e);
    const reason = e && typeof e === 'object' && e.reason ? String(e.reason) : '';
    const source = e && typeof e === 'object' && e.source ? String(e.source) : '';
    const req = e && typeof e === 'object' && e.required === true
      ? `<span class="badge badge-sl" style="margin-left:6px;">REQUIRED</span>` : '';
    return `<li style="border:1px solid var(--border-color);border-radius:var(--radius-md);padding:8px 10px;font-size:var(--font-size-sm);">
      <span style="font-weight:600;">◷ ${escapeHtml(name)}</span>${req}
      ${reason ? `<br><span style="color:var(--text-secondary);">${escapeHtml(reason)}</span>` : ''}
      ${source ? `<br><span style="color:var(--text-muted);font-size:var(--font-size-xs);">Source: ${escapeHtml(source)}</span>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

function riskStatusHtml(risk) {
  if (!risk || typeof risk !== 'object') return '';
  const blockers = toArray(risk.blockers);
  const warnings = toArray(risk.warnings);
  const safe = risk.safe !== undefined ? risk.safe === true : blockers.length === 0;
  if (!safe || blockers.length > 0) {
    return `<p role="status" style="font-size:var(--font-size-sm);margin:8px 0 0;">
      <span class="badge badge-sl">✕ RISK BLOCKED</span>
      <span style="color:var(--text-secondary);margin-left:6px;">${escapeHtml(`${blockers.length} risk blocker${blockers.length === 1 ? '' : 's'}`)} — resolve before entering.</span>
    </p>`;
  }
  if (warnings.length > 0) {
    return `<p role="status" style="font-size:var(--font-size-sm);margin:8px 0 0;">
      <span class="badge badge-gold">⚠ RISK CAUTION</span>
      <span style="color:var(--text-secondary);margin-left:6px;">${escapeHtml(`${warnings.length} risk warning${warnings.length === 1 ? '' : 's'}`)} — size carefully.</span>
    </p>`;
  }
  return `<p role="status" style="font-size:var(--font-size-sm);margin:8px 0 0;">
    <span class="badge badge-tp">✓ RISK OK</span>
    <span style="color:var(--text-secondary);margin-left:6px;">No risk blockers reported.</span>
  </p>`;
}

/**
 * Render the decision card. Returns an HTML string (no DOM writes).
 * Accepts decisionEngine output aliases (passedRules/failedRules/…).
 *
 * @param {Object} input
 * @param {number} input.score
 * @param {'READY'|'WAITING'|'NO_TRADE'} input.state
 * @param {Array} [input.passed] | [input.passedRules]
 * @param {Array} [input.failed] | [input.failedRules]
 * @param {Array} [input.missing] | [input.missingRules]
 * @param {Array} [input.blockers]
 * @param {Array} [input.warnings]
 * @param {{ready:number,waiting:number}} [input.thresholds]
 * @param {{safe:boolean,warnings:Array,blockers:Array}} [input.risk]
 * @param {{personalRR:number,strategyRR:number,effective:number}} [input.effectiveRR]
 * @returns {string}
 */
export function renderDecisionCard({
  score,
  state,
  passed,
  failed,
  missing,
  blockers,
  warnings,
  passedRules,
  failedRules,
  missingRules,
  thresholds,
  risk,
  effectiveRR,
} = {}) {
  const st = stateOf(state);
  const meta = STATE_META[st];
  const passedList = toArray(passed ?? passedRules);
  const failedList = toArray(failed ?? failedRules);
  const missingList = toArray(missing ?? missingRules);
  const blockerList = toArray(blockers);
  const warningList = toArray(warnings);
  const ready = thresholds && Number.isFinite(Number(thresholds.ready)) ? Number(thresholds.ready) : 80;
  const waiting = thresholds && Number.isFinite(Number(thresholds.waiting)) ? Number(thresholds.waiting) : 60;
  const requiredPassed = passedList.filter((e) => e && e.required === true).length;
  const requiredTotal = requiredPassed + blockerList.filter((e) => e && (e.required !== false)).length;

  const rrBanner = effectiveRR ? renderEffectiveRR(effectiveRR) : '';
  const riskHtml = riskStatusHtml(risk);

  let body = '';
  if (st === 'READY') {
    body = `
      <p style="font-size:var(--font-size-sm);color:var(--text-secondary);margin:0 0 8px;">${escapeHtml(EXPLAIN.READY)}</p>
      <p style="font-size:var(--font-size-sm);margin:0 0 8px;">
        <span class="badge badge-tp">✓ REQUIRED ${escapeHtml(String(requiredPassed))}/${escapeHtml(String(requiredTotal))} PASSED</span>
        <span style="color:var(--text-secondary);margin-left:8px;">Score ${escapeHtml(fmtScore(score))} ≥ ready ${escapeHtml(String(ready))}</span>
      </p>
      ${riskHtml}
      ${warningList.length ? `<div style="margin-top:8px;"><strong style="font-size:var(--font-size-sm);">⚠ Advisory warnings (${escapeHtml(String(warningList.length))}):</strong>${listHtml(warningList, '')}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;">
        <button type="button" class="btn btn-primary" id="decision-enter" data-action="enter"
          style="min-height:40px;min-width:40px;padding:10px 22px;" aria-label="Enter trade — all checks passed">
          ✓ ENTER TRADE
        </button>
      </div>`;
  } else if (st === 'WAITING') {
    body = `
      <p style="font-size:var(--font-size-sm);color:var(--text-secondary);margin:0 0 8px;">${escapeHtml(EXPLAIN.WAITING)}</p>
      <p style="font-size:var(--font-size-sm);margin:0 0 4px;">
        <span class="badge badge-gold">◷ SCORE ${escapeHtml(fmtScore(score))}</span>
        <span style="color:var(--text-secondary);margin-left:8px;">waiting ≥ ${escapeHtml(String(waiting))} · ready ≥ ${escapeHtml(String(ready))}</span>
      </p>
      ${riskHtml}
      <div style="margin-top:8px;">
        <strong style="font-size:var(--font-size-sm);">◷ Missing (${escapeHtml(String(missingList.length))}):</strong>
        ${missingListHtml(missingList)}
      </div>
      ${warningList.length ? `<div style="margin-top:8px;"><strong style="font-size:var(--font-size-sm);">⚠ Advisory warnings (${escapeHtml(String(warningList.length))}):</strong>${listHtml(warningList, '')}</div>` : ''}
      ${failedList.length ? `<div style="margin-top:8px;"><strong style="font-size:var(--font-size-sm);">Failed optional (${escapeHtml(String(failedList.length))}):</strong>${listHtml(failedList, '')}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;">
        <button type="button" class="btn btn-secondary" id="decision-save-waiting" data-action="save-waiting"
          style="min-height:40px;min-width:40px;padding:10px 22px;" aria-label="Save as waiting — no blocker, checklist incomplete">
          ◷ SAVE AS WAITING
        </button>
      </div>`;
  } else {
    body = `
      <p style="font-size:var(--font-size-sm);color:var(--text-secondary);margin:0 0 8px;">${escapeHtml(EXPLAIN.NO_TRADE)}</p>
      <p style="font-size:var(--font-size-sm);margin:0 0 4px;">
        <span class="badge badge-sl">✕ SCORE ${escapeHtml(fmtScore(score))}</span>
        <span style="color:var(--text-secondary);margin-left:8px;">waiting ≥ ${escapeHtml(String(waiting))} · ready ≥ ${escapeHtml(String(ready))}</span>
      </p>
      ${riskHtml}
      <div style="margin-top:8px;">
        <strong style="font-size:var(--font-size-sm);">✕ Blockers (${escapeHtml(String(blockerList.length))}):</strong>
        ${listHtml(blockerList, 'No blocker details supplied.')}
      </div>
      ${missingList.length ? `<div style="margin-top:8px;"><strong style="font-size:var(--font-size-sm);">◷ Also missing (${escapeHtml(String(missingList.length))}):</strong>${missingListHtml(missingList)}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;">
        <button type="button" class="btn btn-danger" id="decision-save" data-action="save"
          style="min-height:40px;min-width:40px;padding:10px 22px;" aria-label="Save analysis — trade blocked">
          ✕ SAVE ANALYSIS
        </button>
      </div>`;
  }

  return `
    <section class="card" id="decision-card" data-state="${escapeHtml(st)}" data-score="${escapeHtml(fmtScore(score))}"
      aria-live="polite" aria-label="Trade decision: ${escapeHtml(st)}"
      style="border-color:${meta.border};">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
        <span class="badge ${meta.badge}">${escapeHtml(meta.icon)} ${escapeHtml(meta.label)}</span>
        <span style="font-size:var(--font-size-xl);font-weight:700;" aria-label="Discipline score ${escapeHtml(fmtScore(score))} out of 100">${escapeHtml(fmtScore(score))}</span>
        <span style="color:var(--text-muted);font-size:var(--font-size-sm);">/ 100</span>
      </div>
      ${rrBanner}
      ${body}
    </section>`;
}

/**
 * Wire decision-card buttons. Safe to call after innerHTML insert; no-ops
 * when the card is absent. Returns a cleanup function.
 * @param {{onEnter?:Function,onSaveWaiting?:Function,onSave?:Function}} handlers
 * @returns {Function} cleanup
 */
export function bindDecisionCard({ onEnter, onSaveWaiting, onSave } = {}) {
  const cleanups = [];
  const wire = (id, fn) => {
    const el = document.getElementById(id);
    if (!el || typeof fn !== 'function') return;
    const listener = (e) => fn(e);
    el.addEventListener('click', listener);
    cleanups.push(() => el.removeEventListener('click', listener));
  };
  wire('decision-enter', onEnter);
  wire('decision-save-waiting', onSaveWaiting);
  wire('decision-save', onSave);
  return () => { cleanups.forEach((fn) => { try { fn(); } catch { /* noop */ } }); };
}

if (typeof window !== 'undefined') {
  window.TradeLogComponents = {
    ...(window.TradeLogComponents || {}),
    renderDecisionCard,
    bindDecisionCard,
    renderEffectiveRR,
  };
}
