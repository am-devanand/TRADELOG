// ============================================
// Trade detail — /trade/:id for executed trades (vanilla ESM)
// Header, P/L hero, position grid, original-setup snapshot, SL/TP manage,
// notes, timeline, sticky MANAGE+CLOSE action bar, close confirm modal.
// Entry is immutable here. Screenshots display-only (Phase 5 placeholder).
// ============================================
import '../../css/trade.css';
import '../../css/screenshots.css';
import { getCurrentUser, getFolder } from '../utils/storage.js';
import {
  getExecutedTrade,
  updateSLTP,
  updateTrade,
  addTradeNote,
  closeTrade,
  calcTradePL,
  CLOSE_REASONS,
} from '../utils/executedTrades.js';
import { saveScreenshot, deleteScreenshot } from '../utils/screenshotStore.js';
import { listMeta, addMeta, removeMeta } from '../utils/screenshotMeta.js';
import { renderScreenshotGallery, revokeAllGalleries } from '../components/screenshotViewer.js';
import {
  navigate,
  showModal,
  hideModal,
  showToast,
  escapeHtml,
  formatCurrency,
} from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import { getReviewByTradeId } from '../utils/tradeReviews.js';
import { gradeForTotal } from '../utils/processScore.js';
import { getEntityHistory } from '../utils/auditLog.js';
import { renderAuditTimeline } from '../components/auditTimeline.js';
import {
  getMaxObservedDrawdown,
  getConsecutiveLosses,
  getConsecutiveWins,
} from '../utils/riskAnalytics.js';

let previewPrice = null; // manual current-price preview for unrealized P/L

function statusBadge(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'OPEN') return `<span class="badge badge-tp">● OPEN</span>`;
  if (s === 'PARTIALLY_CLOSED') return `<span class="badge badge-gold">◐ PARTIALLY CLOSED</span>`;
  return `<span class="badge badge-sl">■ CLOSED</span>`;
}

function fmt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

// ---- Review section (read-only; review status never touches trade.status) ----
// CLOSED + no completed review → REVIEW PENDING + REVIEW TRADE button.
// CLOSED + completed review → PROCESS SCORE total/grade + 4 subscores + VIEW REVIEW.
// Open trades never show scores here.
function reviewSectionHtml(user, tradeId) {
  const review = getReviewByTradeId(user, tradeId);
  const completed = review && String(review.status || '').toUpperCase() === 'COMPLETED';
  if (!completed) {
    return `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;">
        <span class="badge badge-gold">○ REVIEW PENDING</span>
        <button class="btn btn-secondary" id="td-review">REVIEW TRADE</button>
      </div>
      <p style="font-size:var(--font-size-xs);color:var(--text-muted);margin-top:6px;">Review status is separate from trade status.</p>
    `;
  }
  const ps = review.processScore && typeof review.processScore === 'object' ? review.processScore : {};
  const total = Number(ps.total);
  const totalTxt = Number.isFinite(total) ? escapeHtml(String(Math.round(total * 100) / 100)) : '—';
  const grade = escapeHtml(String(ps.grade || gradeForTotal(ps.total) || '—'));
  const sub = (label, v) => {
    const n = Number(v);
    return `<div class="risk-item"><div class="risk-label">${escapeHtml(label)}</div><div class="risk-value">${Number.isFinite(n) ? escapeHtml(String(n)) : '—'}</div></div>`;
  };
  return `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;">
      <span class="badge badge-tp">✓ REVIEWED</span>
      <span class="badge badge-gold">PROCESS SCORE ${totalTxt} · ${grade}</span>
      <button class="btn btn-secondary" id="td-view-review">VIEW REVIEW</button>
    </div>
    <div class="risk-grid" style="margin-top:10px;">
      ${sub('Pre-trade', ps.preTradeScore)}${sub('Execution', ps.executionScore)}${sub('Management', ps.managementScore)}${sub('Discipline', ps.disciplineScore)}
    </div>
  `;
}

export function renderTradeDetail(params = {}) {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const id = params.id;
  const trade = getExecutedTrade(user, id);
  const app = document.getElementById('app');

  if (!trade) {
    app.innerHTML = `
      ${renderNavbar()}
      <div class="page">
        <button class="btn btn-ghost btn-sm" id="td-back">← Back to Trade</button>
        <div class="empty-state"><h3>Trade not found</h3><p>No executed trade with id ${escapeHtml(String(id ?? ''))}</p></div>
      </div>`;
    bindNavbar();
    document.getElementById('td-back')?.addEventListener('click', () => navigate('/trade'));
    return;
  }

  previewPrice = null;
  paint(user, trade);
}

function paint(user, trade) {
  const t = getExecutedTrade(user, trade.id) || trade;
  revokeAllGalleries();
  const app = document.getElementById('app');
  const folder = t.accountId ? getFolder(user, t.accountId) : null;
  const cur = folder?.currency || 'USD';
  const isClosed = String(t.status).toUpperCase() === 'CLOSED';
  const orig = t.originalSetup && typeof t.originalSetup === 'object' ? t.originalSetup : {};
  const history = Array.isArray(t.slTpHistory) ? t.slTpHistory : [];
  const events = Array.isArray(t.events) ? [...t.events].reverse() : [];
  const notes = Array.isArray(t.notes) ? [...t.notes].reverse() : [];
  const passedCount = Array.isArray(orig.failed)
    ? `${escapeHtml(String(Object.keys(orig.checklist || {}).length))} checks recorded`
    : '';

  const preview = previewPrice !== null && previewPrice !== ''
    ? calcTradePL(t, Number(previewPrice))
    : null;
  const heroPL = isClosed
    ? { pl: fmt(t.realizedPL), r: fmt(t.realizedR), label: 'Realized P/L' }
    : preview
      ? { pl: preview.pl, r: preview.r, label: 'Unrealized P/L (preview)' }
      : { pl: fmt(t.realizedPL), r: fmt(t.realizedR), label: 'Realized so far — enter a price to preview unrealized' };

  let auditEntries = [];
  try {
    auditEntries = getEntityHistory(user, 'trade', t.id) || [];
  } catch {
    auditEntries = [];
  }
  const auditItems = [...auditEntries].reverse().map((e) => {
    const meta = e && e.metadata && typeof e.metadata === 'object' ? e.metadata : {};
    const keys = Object.keys(meta);
    return {
      ...e,
      detail: keys.length ? keys.map((k) => `${k}: ${String(meta[k])}`).join(' · ') : '',
    };
  });
  const auditHtml = renderAuditTimeline(auditItems, { emptyMessage: 'No audit history recorded for this trade yet.' });

  let riskStrip = '';
  try {
    if (t.accountId) {
      const dd = getMaxObservedDrawdown(t.accountId, { user });
      const losses = getConsecutiveLosses(t.accountId, { user });
      const wins = getConsecutiveWins(t.accountId, { user });
      const ddTxt = dd && Number.isFinite(Number(dd.maxDrawdown)) ? escapeHtml(String(dd.maxDrawdown)) : '—';
      riskStrip = `
      <div class="card" style="margin-bottom:var(--space-lg);" aria-label="Account risk context">
        <div class="trade-section-title"><h2>Risk context</h2><p>Account-level, read-only</p></div>
        <div class="risk-grid">
          <div class="risk-item"><div class="risk-label">Max observed drawdown</div><div class="risk-value">${ddTxt}</div></div>
          <div class="risk-item"><div class="risk-label">Loss streak (current / longest)</div><div class="risk-value">${escapeHtml(String(losses?.currentLossStreak ?? '—'))} / ${escapeHtml(String(losses?.longestLossStreak ?? '—'))}</div></div>
          <div class="risk-item"><div class="risk-label">Win streak (current / longest)</div><div class="risk-value">${escapeHtml(String(wins?.currentWinStreak ?? '—'))} / ${escapeHtml(String(wins?.longestWinStreak ?? '—'))}</div></div>
        </div>
      </div>`;
    }
  } catch {
    riskStrip = '';
  }

  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <button class="btn btn-ghost btn-sm" id="td-back" style="margin-bottom:8px;">← Back to Trade</button>
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(String(t.pair || '—'))} <span style="font-size:var(--font-size-sm);color:var(--text-secondary);">${escapeHtml(String(t.direction || ''))}</span></h1>
          <p class="page-subtitle">Executed ${escapeHtml(String((t.executionTime || t.createdAt || '').slice(0, 16).replace('T', ' ')))} · ${escapeHtml(String(t.id))}</p>
        </div>
        <div>${statusBadge(t.status)}</div>
      </div>

      ${isClosed ? `
      <div class="card" style="border:2px solid var(--color-tp);margin-bottom:var(--space-lg);" role="status">
        <h2>✓ TRADE CLOSED</h2>
        <p style="color:var(--text-secondary);font-size:var(--font-size-sm);margin:6px 0 12px;">Realized ${formatCurrency(fmt(t.realizedPL), cur)} (${escapeHtml(String(fmt(t.realizedR)))}R) via ${escapeHtml(String(t.closeReason || '—'))} @ ${escapeHtml(String(t.exitPrice ?? '—'))}</p>
        ${reviewSectionHtml(user, t.id)}
      </div>` : ''}

      <div class="card" style="margin-bottom:var(--space-lg);border-width:2px;" aria-label="Profit and loss">
        <div class="stat-label">${escapeHtml(heroPL.label)}</div>
        <div class="stat-value ${heroPL.pl >= 0 ? 'positive' : 'negative'}" style="font-size:2rem;">${heroPL.pl >= 0 ? '+' : '−'}${escapeHtml(formatCurrency(Math.abs(heroPL.pl), cur).replace('-', ''))} <span style="font-size:var(--font-size-md);">(${escapeHtml(String(heroPL.r))}R)</span></div>
        ${!isClosed ? `
        <div class="form-row" style="margin-top:12px;">
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label" for="td-cur-price">Current price (manual)</label>
            <input type="number" id="td-cur-price" step="any" value="${previewPrice !== null ? escapeHtml(String(previewPrice)) : ''}" placeholder="e.g. ${escapeHtml(String(t.entry))}">
          </div>
          <div class="form-group" style="margin-bottom:0;display:flex;align-items:flex-end;">
            <button class="btn btn-secondary" id="td-update-preview" style="width:100%;">UPDATE</button>
          </div>
        </div>` : ''}
      </div>

      ${riskStrip}

      <div class="trade-layout">
        <div class="trade-main">
          <section class="card" aria-label="Position">
            <div class="trade-section-title"><h2>Position</h2><p>Entry is immutable — manage SL/TP below</p></div>
            <div class="risk-grid">
              <div class="risk-item"><div class="risk-label">Entry (locked)</div><div class="risk-value">${escapeHtml(String(t.entry))}</div></div>
              <div class="risk-item"><div class="risk-label">SL Initial → Current</div><div class="risk-value">${escapeHtml(String(t.initialSL))} → ${escapeHtml(String(t.currentSL))}</div></div>
              <div class="risk-item"><div class="risk-label">TP Initial → Current</div><div class="risk-value">${escapeHtml(String(t.initialTP))} → ${escapeHtml(String(t.currentTP))}</div></div>
              <div class="risk-item"><div class="risk-label">Lots (closed / remaining)</div><div class="risk-value">${escapeHtml(String(t.lotSize))} (${escapeHtml(String(t.closedLots ?? 0))} / ${escapeHtml(String(t.remainingLots ?? t.lotSize))})</div></div>
              <div class="risk-item"><div class="risk-label">Risk</div><div class="risk-value">${escapeHtml(String(t.riskPercent))}% · $${escapeHtml(fmt(t.riskAmount).toFixed(2))}</div></div>
              <div class="risk-item"><div class="risk-label">R:R at entry</div><div class="risk-value">${escapeHtml(String(t.rrAtEntry))}</div></div>
            </div>
            ${history.length ? `
            <details class="check-why" style="margin-top:8px;" open>
              <summary>SL/TP history (${history.length})</summary>
              ${history.map((h) => `<p>• ${escapeHtml(String((h.at || '').slice(0, 16).replace('T', ' ')))} — SL ${escapeHtml(String(h.oldSL))} → ${escapeHtml(String(h.newSL))}, TP ${escapeHtml(String(h.oldTP))} → ${escapeHtml(String(h.newTP))}${h.note ? ` — ${escapeHtml(String(h.note))}` : ''}</p>`).join('')}
            </details>` : ''}
          </section>

          ${!isClosed ? `
          <section class="card" aria-label="Manage SL TP">
            <div class="trade-section-title"><h2>Manage SL / TP</h2><p>Entry cannot change — only risk levels</p></div>
            <div class="form-row">
              <div class="form-group"><label class="form-label" for="td-sl">New stop loss</label><input type="number" id="td-sl" step="any" value="${escapeHtml(String(t.currentSL))}"></div>
              <div class="form-group"><label class="form-label" for="td-tp">New take profit</label><input type="number" id="td-tp" step="any" value="${escapeHtml(String(t.currentTP))}"></div>
            </div>
            <div class="form-group"><label class="form-label" for="td-sltp-note">Change note (optional)</label><input type="text" id="td-sltp-note" placeholder="Why the adjustment?"></div>
            <button class="btn btn-secondary" id="td-save-sltp">UPDATE SL/TP</button>
          </section>` : ''}

          <section class="card" aria-label="Original setup snapshot">
            <div class="trade-section-title"><h2>Original setup</h2><p>Snapshot at execution — immutable</p></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:var(--font-size-sm);color:var(--text-secondary);">
              <span class="badge badge-gold">Score ${escapeHtml(String(orig.score ?? '—'))}</span>
              <span class="badge badge-gold">${escapeHtml(String(orig.decision || '—'))}</span>
              <span>${passedCount}</span>
              <span>Setup ${escapeHtml(String(orig.setupId ?? t.setupId ?? ''))}</span>
            </div>
            ${(orig.blockers || []).length ? `<div style="margin-top:8px;font-size:var(--font-size-xs);color:var(--text-secondary);">Blockers at entry: ${orig.blockers.map((b) => escapeHtml(b.name || b.id || '')).join(', ')}</div>` : ''}
          </section>

          <section class="card" aria-label="Screenshots">
            <div class="trade-section-title"><h2>📎 SCREENSHOTS</h2><p>Stored on this device only — works offline</p></div>
            <div class="shot-add-row">
              <button class="btn btn-secondary btn-sm" data-shot-add="ENTRY">+ ENTRY</button>
              <button class="btn btn-secondary btn-sm" data-shot-add="MANAGEMENT">+ MANAGEMENT</button>
              <button class="btn btn-secondary btn-sm" data-shot-add="EXIT">+ EXIT</button>
              <input type="file" id="td-shot-file" accept="image/*" multiple hidden>
            </div>
            <div id="td-shots"></div>
            <div class="shot-err" id="td-shot-err" role="alert" hidden></div>
          </section>

          <section class="card" aria-label="Notes">
            <div class="trade-section-title"><h2>Notes</h2></div>
            <div class="form-group"><textarea id="td-note-text" rows="2" placeholder="Add a note..."></textarea></div>
            <button class="btn btn-secondary btn-sm" id="td-add-note">ADD NOTE</button>
            <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px;">
              ${notes.length ? notes.map((n) => `<div class="journal-entry" style="margin:0;"><div class="journal-date">${escapeHtml(String((n.at || '').slice(0, 16).replace('T', ' ')))}</div><div class="journal-text">${escapeHtml(String(n.text || ''))}</div></div>`).join('') : '<p style="color:var(--text-muted);font-size:var(--font-size-sm);">No notes yet.</p>'}
            </div>
          </section>
        </div>

        <div class="trade-side">
          <section class="card" aria-label="Trade timeline">
            <div class="trade-section-title"><h2>Trade timeline</h2><p>${events.length} execution events</p></div>
            <div style="display:flex;flex-direction:column;gap:8px;max-height:420px;overflow-y:auto;">
              ${events.length ? events.map((e) => `<div style="border-left:2px solid var(--accent-gold);padding-left:10px;"><div style="font-size:var(--font-size-xs);color:var(--text-muted);">${escapeHtml(String((e.at || '').slice(0, 16).replace('T', ' ')))} · ${escapeHtml(String(e.type || ''))}</div><div style="font-size:var(--font-size-sm);">${escapeHtml(String(e.message || ''))}</div></div>`).join('') : '<p style="color:var(--text-muted);font-size:var(--font-size-sm);">No events.</p>'}
            </div>
          </section>
          <div style="margin-top:var(--space-md);">${auditHtml}</div>
        </div>
      </div>

      <div id="td-actionbar" class="card" style="position:sticky;bottom:0;z-index:30;margin-top:var(--space-lg);display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-ghost" id="td-manage">${isClosed ? 'VIEW TIMELINE' : 'MANAGE SL/TP'}</button>
        ${!isClosed ? `<button class="btn btn-danger" id="td-close" style="flex:1;justify-content:center;min-height:44px;">CLOSE TRADE</button>` : ''}
      </div>
    </div>
    <style>
      @media (min-width: 901px) {
        #td-actionbar { position: static; }
      }
    </style>
  `;
  bindNavbar();
  document.getElementById('td-back')?.addEventListener('click', () => navigate('/trade'));
  document.getElementById('td-review')?.addEventListener('click', () => navigate(`/trade/${t.id}/review`));
  document.getElementById('td-view-review')?.addEventListener('click', () => navigate(`/trade/${t.id}/review`));
  document.getElementById('td-update-preview')?.addEventListener('click', () => {
    const raw = document.getElementById('td-cur-price')?.value ?? '';
    if (raw === '' || !Number.isFinite(Number(raw))) return showToast('Enter a valid current price', 'error');
    previewPrice = raw;
    paint(user, t);
  });
  document.getElementById('td-save-sltp')?.addEventListener('click', () => {
    const sl = document.getElementById('td-sl')?.value ?? '';
    const tp = document.getElementById('td-tp')?.value ?? '';
    const note = document.getElementById('td-sltp-note')?.value ?? '';
    const res = updateSLTP(user, t.id, { stopLoss: sl, takeProfit: tp, note });
    if (!res.success) return showToast(res.error || 'SL/TP update failed', 'error');
    showToast('SL/TP updated — history recorded');
    paint(user, t);
  });
  document.getElementById('td-add-note')?.addEventListener('click', () => {
    const text = document.getElementById('td-note-text')?.value ?? '';
    const res = addTradeNote(user, t.id, text);
    if (!res.success) return showToast(res.error || 'Note failed', 'error');
    showToast('Note added');
    paint(user, t);
  });
  document.getElementById('td-manage')?.addEventListener('click', () => {
    const el = document.querySelector('[aria-label="Manage SL TP"]');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.getElementById('td-close')?.addEventListener('click', () => openCloseModal(user, t));
  bindShotButtons(user, t);
  paintShots(user, t);
}

let pendingShotType = 'ENTRY';

function bindShotButtons(user, trade) {
  const input = document.getElementById('td-shot-file');
  document.querySelectorAll('[data-shot-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingShotType = btn.getAttribute('data-shot-add') || 'ENTRY';
      input?.click();
    });
  });
  input?.addEventListener('change', () => {
    handleShotFiles(user, trade, input.files, pendingShotType);
  });
}

async function handleShotFiles(user, trade, files, type) {
  const list = [...(files || [])];
  if (list.length === 0) return;
  const fresh = getExecutedTrade(user, trade.id) || trade;
  const existing = Array.isArray(fresh.screenshotIds) ? [...fresh.screenshotIds] : [];
  let added = 0;
  for (const file of list) {
    const saved = await saveScreenshot(file, { tradeId: trade.id, type });
    if (!saved.success) {
      showToast(saved.error || 'Could not save screenshot', 'error');
      continue;
    }
    const mirrored = addMeta(user, saved.meta);
    if (!mirrored.success) {
      await deleteScreenshot(saved.id);
      showToast(mirrored.error || 'Could not record screenshot', 'error');
      continue;
    }
    existing.push(saved.id);
    added += 1;
  }
  if (added > 0) {
    const up = updateTrade(user, trade.id, { screenshotIds: existing });
    if (!up.success) showToast(up.error || 'Could not link screenshots to trade', 'error');
    else showToast(`${added} screenshot${added > 1 ? 's' : ''} saved on this device`);
  }
  const input = document.getElementById('td-shot-file');
  if (input) input.value = '';
  paint(user, trade);
}

async function paintShots(user, trade) {
  const box = document.getElementById('td-shots');
  if (!box) return;
  const fresh = getExecutedTrade(user, trade.id) || trade;
  const ids = Array.isArray(fresh.screenshotIds) ? fresh.screenshotIds.map(String) : [];
  const meta = ids.length > 0 ? listMeta(user, { ids }) : [];
  const missing = ids.length - meta.length;
  const err = document.getElementById('td-shot-err');
  if (err) {
    if (missing > 0) {
      err.hidden = false;
      err.textContent = `${missing} screenshot${missing > 1 ? 's' : ''} referenced but not on this device (blobs never sync).`;
    } else {
      err.hidden = true;
      err.textContent = '';
    }
  }
  await renderScreenshotGallery(box, meta, {
    onDelete: async (id) => {
      const del = await deleteScreenshot(id);
      if (!del.success) {
        showToast(del.error || 'Could not delete screenshot', 'error');
        return;
      }
      removeMeta(user, id);
      const cur = getExecutedTrade(user, trade.id) || trade;
      const remaining = (Array.isArray(cur.screenshotIds) ? cur.screenshotIds : [])
        .map(String)
        .filter((x) => x !== String(id));
      const up = updateTrade(user, trade.id, { screenshotIds: remaining });
      if (!up.success) showToast(up.error || 'Could not update trade', 'error');
      else showToast('Screenshot deleted');
      paint(user, trade);
    },
    onPreviewError: (error) => showToast(error || 'Could not preview screenshot', 'error'),
  });
}

function openCloseModal(user, trade) {
  const t = getExecutedTrade(user, trade.id) || trade;
  const remaining = Number(t.remainingLots ?? t.lotSize);
  showModal(`
    <div class="modal-header">
      <h3 class="modal-title">Close Trade</h3>
      <button class="modal-close" id="close-x">×</button>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="close-price">Exit price</label>
        <input type="number" id="close-price" step="any" value="${escapeHtml(String(t.currentTP ?? t.entry))}">
      </div>
      <div class="form-group">
        <label class="form-label" for="close-lot">Lot (remaining ${escapeHtml(String(remaining))})</label>
        <input type="number" id="close-lot" step="any" min="0" value="${escapeHtml(String(remaining))}">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="close-reason">Reason</label>
      <select id="close-reason">
        <option value="">— Select reason —</option>
        ${CLOSE_REASONS.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}
      </select>
    </div>
    <div id="close-est" aria-live="polite"></div>
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" id="close-cancel">CANCEL</button>
      <button type="button" class="btn btn-danger" id="close-confirm">CLOSE</button>
    </div>
  `);

  const repaint = () => {
    const box = document.getElementById('close-est');
    const btn = document.getElementById('close-confirm');
    if (!box) return;
    const px = Number(document.getElementById('close-price')?.value);
    const lot = Number(document.getElementById('close-lot')?.value);
    const reason = document.getElementById('close-reason')?.value || '';
    const totalLots = Number(t.lotSize) || 0;
    let html = '';
    let ok = true;
    if (!Number.isFinite(px)) { html += `<div class="price-error" role="alert">× Exit price must be a valid number.</div>`; ok = false; }
    if (!Number.isFinite(lot) || lot <= 0) { html += `<div class="price-error" role="alert">× Close lot must be positive.</div>`; ok = false; }
    else if (lot - remaining > 1e-9) { html += `<div class="price-error" role="alert">× Close lot ${escapeHtml(String(lot))} exceeds remaining ${escapeHtml(String(remaining))}.</div>`; ok = false; }
    if (!CLOSE_REASONS.includes(reason)) { html += `<div class="price-error" role="alert">× Select a close reason.</div>`; ok = false; }
    if (Number.isFinite(px) && Number.isFinite(lot) && lot > 0 && lot - remaining <= 1e-9) {
      const { pl, r } = calcTradePL(t, px);
      const frac = totalLots > 0 ? lot / totalLots : 0;
      const partPL = Math.round(pl * frac * 100) / 100;
      const partR = Math.round(r * frac * 100) / 100;
      html += `<div class="risk-grid" style="margin-top:8px;"><div class="risk-item"><div class="risk-label">Est P/L</div><div class="risk-value">${partPL >= 0 ? '+' : ''}${escapeHtml(String(partPL))}</div></div><div class="risk-item"><div class="risk-label">Est R</div><div class="risk-value">${escapeHtml(String(partR))}R</div></div></div>`;
    }
    box.innerHTML = html;
    if (btn) btn.disabled = !ok;
    if (btn) btn.style.opacity = btn.disabled ? '0.5' : '';
  };

  setTimeout(() => {
    document.getElementById('close-x')?.addEventListener('click', hideModal);
    document.getElementById('close-cancel')?.addEventListener('click', hideModal);
    for (const id of ['close-price', 'close-lot', 'close-reason']) {
      document.getElementById(id)?.addEventListener('input', repaint);
      document.getElementById(id)?.addEventListener('change', repaint);
    }
    document.getElementById('close-confirm')?.addEventListener('click', () => {
      const px = document.getElementById('close-price')?.value ?? '';
      const lot = document.getElementById('close-lot')?.value ?? '';
      const reason = document.getElementById('close-reason')?.value ?? '';
      const res = closeTrade(user, t.id, { exitPrice: px, lot, reason });
      if (!res.success) return showToast(res.error || 'Close failed', 'error');
      hideModal();
      showToast(`Trade closed: ${res.partPL >= 0 ? '+' : ''}${res.partPL} (${res.partR}R)`);
      paint(user, t);
    });
    repaint();
  }, 50);
}

export default { renderTradeDetail };
