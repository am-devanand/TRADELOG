// ============================================
// Execution modal — Phase 4 entry confirmation (vanilla ESM)
// Reuses showModal / hideModal / showToast + riskEngine. No deps.
// openExecutionModal(setup, { onConfirm }) — CONFIRM ENTRY calls
// onConfirm(executionData); CANCEL closes. Only CONFIRM creates a trade
// (caller invokes executeSetup inside onConfirm).
// ============================================
import { showModal, hideModal, escapeHtml } from '../utils/helpers.js';
import { getFolders } from '../utils/storage.js';
import { calcRiskAmount, calcRR, calcPositionSize, checkRiskGuards } from '../utils/riskEngine.js';

function numOrUndef(v) {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function validateStructure(direction, entry, sl, tp) {
  const e = Number(entry);
  const s = Number(sl);
  const t = Number(tp);
  if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(t)) {
    return 'Execution price / SL / TP must be valid numbers.';
  }
  if (e === s) return `Invalid SL: stop equals entry (${e}). Move SL to create risk distance.`;
  const dir = String(direction || 'LONG').toUpperCase();
  if (dir === 'SHORT') {
    if (!(s > e)) return `Invalid SL side for SHORT: SL ${s} must be above entry ${e}.`;
    if (!(t < e)) return `Invalid TP side for SHORT: TP ${t} must be below entry ${e}.`;
  } else {
    if (!(s < e)) return `Invalid SL side for LONG: SL ${s} must be below entry ${e}.`;
    if (!(t > e)) return `Invalid TP side for LONG: TP ${t} must be above entry ${e}.`;
  }
  return null;
}

function localInputDefault() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function openExecutionModal(setup, opts = {}) {
  const onConfirm = typeof opts.onConfirm === 'function' ? opts.onConfirm : () => {};
  const user = opts.user;
  const s = setup && typeof setup === 'object' ? setup : {};
  const market = s.market && typeof s.market === 'object' ? s.market : {};
  const risk = s.risk && typeof s.risk === 'object' ? s.risk : {};

  const pair = market.pair ?? s.pair ?? '—';
  const direction = String(market.direction ?? s.direction ?? 'LONG').toUpperCase();
  const strategy = market.strategy ?? s.strategy ?? '—';
  const score = s.score ?? s.checklistScore ?? '—';
  const decision = s.state ?? s.decision ?? '';
  const riskPct = risk.riskPercent ?? s.riskPercent ?? '';
  const baseRR = risk.rr ?? 0;
  const baseRiskAmt = risk.riskAmount ?? 0;

  let account = null;
  try {
    const folders = user ? getFolders(user) : [];
    account = folders.find((f) => f.id === (market.accountId ?? s.accountId)) || null;
  } catch { /* offline-safe */ }
  const balance = account ? Number(account.currentBalance) : NaN;

  const prePrice = market.entry ?? s.entry ?? '';
  const preSL = market.sl ?? s.stopLoss ?? '';
  const preTP = market.tp ?? s.takeProfit ?? '';
  const preLot = market.lotSize ?? s.lotSize ?? risk.positionSize ?? '';
  const preNotes = s.notes ?? '';

  showModal(`
    <div class="modal-header">
      <h3 class="modal-title">Confirm Entry</h3>
      <button class="modal-close" id="exec-close-btn" aria-label="Close">×</button>
    </div>
    <div class="card" style="margin-bottom:12px;padding:12px;" aria-label="Setup summary">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between;">
        <strong style="font-size:var(--font-size-lg);">${escapeHtml(String(pair))} <span style="font-size:var(--font-size-xs);color:var(--text-secondary);">${escapeHtml(direction)}</span></strong>
        <span class="badge badge-tp">Score ${escapeHtml(String(score))}${decision ? ` · ${escapeHtml(String(decision))}` : ''}</span>
      </div>
      <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-top:6px;display:flex;gap:12px;flex-wrap:wrap;">
        <span>Strategy: ${escapeHtml(String(strategy || '—'))}</span>
        <span>Risk: ${escapeHtml(String(riskPct === '' ? '—' : `${riskPct}% ($${Number(baseRiskAmt || 0).toFixed(2)})`))}</span>
        <span>R:R ${escapeHtml(String(baseRR))}</span>
      </div>
      <div style="font-size:var(--font-size-xs);color:var(--text-muted);margin-top:4px;">Setup ${escapeHtml(String(s.id ?? ''))} · screenshots transfer display-only (Phase 5)</div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="exec-price">Execution price</label>
        <input type="number" id="exec-price" step="any" value="${escapeHtml(String(prePrice))}">
      </div>
      <div class="form-group">
        <label class="form-label" for="exec-lot">Lot size</label>
        <input type="number" id="exec-lot" step="any" min="0" value="${escapeHtml(String(preLot))}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="exec-sl">Stop loss</label>
        <input type="number" id="exec-sl" step="any" value="${escapeHtml(String(preSL))}">
      </div>
      <div class="form-group">
        <label class="form-label" for="exec-tp">Take profit</label>
        <input type="number" id="exec-tp" step="any" value="${escapeHtml(String(preTP))}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="exec-time">Execution time</label>
        <input type="datetime-local" id="exec-time" value="${escapeHtml(localInputDefault())}">
      </div>
      <div class="form-group">
        <label class="form-label" for="exec-notes">Notes (optional)</label>
        <input type="text" id="exec-notes" value="${escapeHtml(String(preNotes))}" placeholder="Execution context...">
      </div>
    </div>
    <div id="exec-live" aria-live="polite"></div>
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" id="exec-cancel">CANCEL</button>
      <button type="button" class="btn btn-primary" id="exec-confirm">CONFIRM ENTRY</button>
    </div>
  `);

  const read = () => ({
    executionPrice: document.getElementById('exec-price')?.value ?? '',
    lotSize: document.getElementById('exec-lot')?.value ?? '',
    sl: document.getElementById('exec-sl')?.value ?? '',
    tp: document.getElementById('exec-tp')?.value ?? '',
    executionTime: document.getElementById('exec-time')?.value ?? '',
    notes: document.getElementById('exec-notes')?.value.trim() ?? '',
  });

  const repaint = () => {
    const box = document.getElementById('exec-live');
    const btn = document.getElementById('exec-confirm');
    if (!box) return;
    const v = read();
    const entry = numOrUndef(v.executionPrice);
    const sl = numOrUndef(v.sl);
    const tp = numOrUndef(v.tp);
    const lots = numOrUndef(v.lotSize);
    const rp = numOrUndef(riskPct);

    const structErr = validateStructure(direction, v.executionPrice === '' ? NaN : v.executionPrice, v.sl === '' ? NaN : v.sl, v.tp === '' ? NaN : v.tp);
    const rr = entry !== undefined ? calcRR(entry, sl, tp, direction) : 0;
    const riskAmt = Number.isFinite(balance) && rp !== undefined ? calcRiskAmount(balance, rp) : 0;
    const posSize = entry !== undefined && rp !== undefined && Number.isFinite(balance)
      ? calcPositionSize(balance, rp, entry, sl)
      : 0;
    const guards = checkRiskGuards({
      balance,
      riskAmount: rp !== undefined ? riskAmt : undefined,
      riskPercent: rp,
      entry, sl, tp,
      direction: entry !== undefined && sl !== undefined && tp !== undefined ? direction : undefined,
    });
    const blocked = guards.blockers.length > 0;
    const lotInvalid = lots === undefined || !(lots > 0);

    const warnHtml = (guards.warnings || []).map((w) => `<div class="risk-warn">! ${escapeHtml(w)}</div>`).join('');
    const blockHtml = (guards.blockers || []).map((b) => `<div class="risk-block">× ${escapeHtml(b)}</div>`).join('');

    box.innerHTML = `
      <div class="risk-grid" style="margin-top:4px;">
        <div class="risk-item"><div class="risk-label">Live R:R</div><div class="risk-value">${escapeHtml(String(rr))}</div></div>
        <div class="risk-item"><div class="risk-label">Risk amount</div><div class="risk-value">$${escapeHtml(Number(riskAmt || 0).toFixed(2))}</div></div>
        <div class="risk-item"><div class="risk-label">Guide size</div><div class="risk-value">${escapeHtml(String(posSize))}</div></div>
      </div>
      ${structErr ? `<div class="price-error" role="alert">× ${escapeHtml(structErr)}</div>` : ''}
      ${lotInvalid ? `<div class="price-error" role="alert">× Lot size must be a positive number.</div>` : ''}
      ${blocked ? `<div class="price-error" role="alert"><strong>EXECUTION BLOCKED</strong> — current-vs-limit shown above; resolve blockers to continue.</div>` : ''}
      ${warnHtml}${blockHtml}
    `;
    if (btn) btn.disabled = Boolean(structErr || blocked || lotInvalid);
    if (btn) btn.style.opacity = btn.disabled ? '0.5' : '';
  };

  setTimeout(() => {
    document.getElementById('exec-close-btn')?.addEventListener('click', hideModal);
    document.getElementById('exec-cancel')?.addEventListener('click', hideModal);
    for (const id of ['exec-price', 'exec-lot', 'exec-sl', 'exec-tp']) {
      document.getElementById(id)?.addEventListener('input', repaint);
      document.getElementById(id)?.addEventListener('change', repaint);
    }
    document.getElementById('exec-confirm')?.addEventListener('click', () => {
      const v = read();
      const structErr = validateStructure(direction, v.executionPrice, v.sl, v.tp);
      if (structErr) return;
      const lots = Number(v.lotSize);
      if (!Number.isFinite(lots) || lots <= 0) return;
      const entry = Number(v.executionPrice);
      const sl = Number(v.sl);
      const tp = Number(v.tp);
      const rp = numOrUndef(riskPct);
      const riskAmt = Number.isFinite(balance) && rp !== undefined ? calcRiskAmount(balance, rp) : 0;
      const guards = checkRiskGuards({
        balance,
        riskAmount: rp !== undefined ? riskAmt : undefined,
        riskPercent: rp,
        entry, sl, tp, direction,
      });
      if (guards.blockers.length > 0) return; // blocked stays disabled; double-guard
      hideModal();
      onConfirm({
        executionPrice: entry,
        lotSize: lots,
        stopLoss: sl,
        takeProfit: tp,
        executionTime: v.executionTime ? new Date(v.executionTime).toISOString() : new Date().toISOString(),
        notes: v.notes,
        direction,
        riskPercent: rp,
        riskAmount: riskAmt,
        rr: calcRR(entry, sl, tp, direction),
      });
    });
    repaint();
  }, 50);
}

export default { openExecutionModal };
