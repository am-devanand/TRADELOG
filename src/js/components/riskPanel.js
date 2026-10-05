// ============================================
// Risk Panel — pre-trade position math display (presentational only)
// Vanilla ESM, no storage, no network, no business logic.
// All numbers arrive precomputed (riskEngine output) via props; this
// module only formats + renders. No guard evaluation here.
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v, currency) {
  const n = num(v);
  if (n === null) return '—';
  const symbols = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹' };
  const sym = symbols[String(currency || 'USD').toUpperCase()] || '$';
  const sign = n < 0 ? '-' : '';
  return `${sign}${sym}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(v, digits = 2) {
  const n = num(v);
  if (n === null) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(v) {
  const n = num(v);
  if (n === null) return '—';
  return `${n}%`;
}

function fmtRR(v) {
  const n = num(v);
  if (n === null || n <= 0) return '—';
  return `${n}R`;
}

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Display-only status mapping from caller-supplied guard output.
 * Does NOT evaluate guards — maps {safe, warnings, blockers} to a badge.
 */
function statusMeta(risk) {
  const blockers = toArray(risk?.blockers);
  const warnings = toArray(risk?.warnings);
  const rawStatus = String(risk?.status ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (rawStatus === 'INVALID' || rawStatus === 'BLOCKED') {
    return { icon: '✕', badge: 'badge-sl', label: 'INVALID' };
  }
  if (rawStatus === 'HIGH_RISK' || rawStatus === 'HIGH-RISK' || rawStatus === 'CAUTION') {
    return { icon: '⚠', badge: 'badge-gold', label: 'HIGH RISK' };
  }
  if (rawStatus === 'SAFE' || rawStatus === 'OK') {
    return { icon: '✓', badge: 'badge-tp', label: 'SAFE' };
  }
  const safe = risk?.safe !== undefined ? risk.safe === true : blockers.length === 0;
  if (!safe || blockers.length > 0) return { icon: '✕', badge: 'badge-sl', label: 'INVALID' };
  if (warnings.length > 0) return { icon: '⚠', badge: 'badge-gold', label: 'HIGH RISK' };
  return { icon: '✓', badge: 'badge-tp', label: 'SAFE' };
}

function kvRow(label, value, opts = {}) {
  return `<div style="display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--border-color);font-size:var(--font-size-sm);">
    <span style="color:var(--text-secondary);">${escapeHtml(label)}</span>
    <strong style="${opts.color ? `color:${opts.color};` : ''}text-align:right;">${value}</strong>
  </div>`;
}

/**
 * Render the risk panel. Returns an HTML string (no DOM writes).
 * @param {Object} input
 * @param {{balance?:number,currency?:string}} [input.account]
 * @param {Object} [input.risk] precomputed riskEngine-style output:
 *   {riskPercent,riskAmount,entry,sl,tp,direction,positionSize,
 *    lossAmount,profitAmount,rr,safe,status,warnings,blockers}
 * @returns {string}
 */
export function renderRiskPanel({ account, risk } = {}) {
  const r = (risk && typeof risk === 'object') ? risk : {};
  const a = (account && typeof account === 'object') ? account : {};
  const currency = a.currency ?? r.currency ?? 'USD';
  const balance = num(a.balance ?? r.balance);
  const riskPercent = num(r.riskPercent ?? r.riskPct ?? a.riskPercent);
  const riskAmount = num(r.riskAmount ?? r.amount ?? r.lossAmount);
  const entry = num(r.entry);
  const sl = num(r.sl ?? r.stopLoss ?? r.stop);
  const tp = num(r.tp ?? r.takeProfit ?? r.target);
  const loss = num(r.lossAmount ?? r.riskAmount ?? r.amount);
  const profit = num(r.profitAmount ?? r.rewardAmount);
  const rr = num(r.rr ?? r.rewardRisk ?? r.ratio);
  const size = num(r.positionSize ?? r.size ?? r.units);
  const direction = r.direction ? String(r.direction).toUpperCase() : '';
  const meta = statusMeta(r);
  const warnings = toArray(r.warnings);
  const blockers = toArray(r.blockers);

  const warnHtml = warnings.length
    ? `<ul style="list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:6px;">${warnings.map((w) => `
        <li style="font-size:var(--font-size-xs);color:var(--text-secondary);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:6px 8px;">⚠ ${escapeHtml(typeof w === 'string' ? w : (w.reason ?? w.message ?? JSON.stringify(w)))}</li>`).join('')}</ul>`
    : '';
  const blockerHtml = blockers.length
    ? `<ul style="list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:6px;">${blockers.map((b) => `
        <li style="font-size:var(--font-size-xs);color:var(--color-sl);border:1px solid var(--color-sl-border);border-radius:var(--radius-md);padding:6px 8px;background:var(--color-sl-bg);">✕ ${escapeHtml(typeof b === 'string' ? b : (b.reason ?? b.message ?? JSON.stringify(b)))}</li>`).join('')}</ul>`
    : '';

  return `
    <section class="card" id="risk-panel-root" aria-live="polite" aria-label="Risk panel: ${escapeHtml(meta.label)}">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
        <h3 style="margin:0;flex:1;min-width:120px;">Risk</h3>
        <span class="badge ${meta.badge}">${escapeHtml(meta.icon)} ${escapeHtml(meta.label)}</span>
        ${direction ? `<span class="badge badge-gold">${escapeHtml(direction)}</span>` : ''}
      </div>
      <div>
        ${kvRow('Balance', escapeHtml(money(balance, currency)))}
        ${kvRow('Risk', escapeHtml(`${fmtPct(riskPercent)} · ${money(riskAmount, currency)}`))}
        ${kvRow('Entry', escapeHtml(entry === null ? '—' : fmtNum(entry, 5)))}
        ${kvRow('Stop loss', `<span>${escapeHtml(sl === null ? '—' : fmtNum(sl, 5))}</span>`, { color: 'var(--color-sl)' })}
        ${kvRow('Take profit', `<span>${escapeHtml(tp === null ? '—' : fmtNum(tp, 5))}</span>`, { color: 'var(--color-tp)' })}
        ${kvRow('Loss if stopped', escapeHtml(money(loss, currency)), { color: loss !== null && loss > 0 ? 'var(--color-sl)' : undefined })}
        ${kvRow('Profit if target', escapeHtml(money(profit, currency)), { color: profit !== null && profit > 0 ? 'var(--color-tp)' : undefined })}
        ${kvRow('Reward : Risk', escapeHtml(fmtRR(rr)))}
        ${kvRow('Position size', escapeHtml(size === null ? '—' : `${fmtNum(size)} units`))}
      </div>
      ${blockerHtml}
      ${warnHtml}
      <p style="font-size:var(--font-size-xs);color:var(--text-muted);margin:12px 0 0;line-height:1.7;">
        Calc hints: amount = balance × risk% · size = amount ÷ |entry − SL| ·
        RR = |TP − entry| ÷ |entry − SL|. LONG needs SL below entry and TP above;
        SHORT the reverse. Invalid side or zero stop distance → INVALID.
      </p>
    </section>`;
}

if (typeof window !== 'undefined') {
  window.TradeLogComponents = {
    ...(window.TradeLogComponents || {}),
    renderRiskPanel,
  };
}
