// ============================================
// Trade pages — /trade (dashboard) + /trade/new (analysis form)
// Vanilla ESM, reuses ruleManager / decisionEngine / riskEngine.
// Setups persist per user in localStorage key tradelog_setups_{user}.
// Phase 3: statuses DRAFT / WAITING / READY / NO_TRADE. No ENTERED marking.
// Phase 4 (execution) + Phase 5 (screenshots) + Phase 6 intentionally absent.
// ============================================
import '../../css/trade.css';
import { getCurrentUser, getFolders, getTrades, updateTrade } from '../utils/storage.js';
import { DEFAULT_THRESHOLDS } from '../utils/models.js';
import { getApplicableRules, evaluateRule } from '../utils/ruleManager.js';
import { evaluateChecklist } from '../utils/decisionEngine.js';
import {
  calcRiskAmount,
  calcRR,
  calcPositionSize,
  checkRiskGuards,
} from '../utils/riskEngine.js';
import {
  navigate,
  showModal,
  hideModal,
  showToast,
  showConfirm,
  generateId,
  escapeHtml,
} from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import { openExecutionModal } from '../components/executionModal.js';
import { executeSetup } from '../utils/executedTrades.js';
import { getReviewByTradeId } from '../utils/tradeReviews.js';
import { appendAudit } from '../utils/auditLog.js';

function safeAudit(user, entry) {
  try {
    appendAudit(user, entry);
  } catch {
    /* audit must never break setup operations */
  }
}

function auditSetupWrite(user, setupId, isNew, oldStatus, newStatus) {
  if (isNew) {
    safeAudit(user, {
      entityType: 'setup',
      entityId: String(setupId),
      action: 'SETUP_CREATED',
      metadata: { status: String(newStatus ?? '') },
    });
    return;
  }
  if (String(oldStatus ?? '') !== String(newStatus ?? '')) {
    safeAudit(user, {
      entityType: 'setup',
      entityId: String(setupId),
      action: 'SETUP_STATUS_CHANGED',
      metadata: { oldValue: String(oldStatus ?? ''), newValue: String(newStatus ?? '') },
    });
  }
}

// ---- Optional Phase-shared decision card (inline fallback when absent) ----
// @vite-ignore keeps the bundler from failing when the file doesn't exist.
let externalDecisionCard = null;
try {
  import(/* @vite-ignore */ '../components/decisionCard.js')
    .then((m) => {
      if (m && typeof m.renderDecisionCard === 'function') externalDecisionCard = m.renderDecisionCard;
    })
    .catch(() => { /* inline fallback below */ });
} catch { /* inline fallback below */ }

// ---- Constants (models.js has no PAIRS; dashboard list + 4 majors = 14) ----
const FALLBACK_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD', 'NAS100', 'US30',
  'BTCUSD', 'ETH/USD', 'AUD/USD', 'USD/CAD',
  'EUR/GBP', 'GBP/JPY', 'USD/CHF', 'EUR/JPY',
];
const SESSIONS = ['London', 'New York', 'Asia', 'Overlap London-NewYork', 'Custom'];
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', 'Daily', 'Custom'];
const STRATEGY_SUGGESTIONS = ['Breakout', 'Reversal', 'Scalp', 'Trend Following', 'Range', 'News', 'Supply & Demand', 'Smart Money'];
const MANUAL_TYPES = new Set(['CHECKBOX', 'BOOLEAN']);
const REOPEN_KEY = 'tradelog_reopen_setup';
const STATUSES = ['DRAFT', 'WAITING', 'READY', 'NO_TRADE'];

// ---- Setups storage (localStorage fallback; no setups.js module exists) ----
function setupsKey(user) {
  return `tradelog_setups_${String(user || '').trim().toLowerCase()}`;
}
function safeParse(raw, fallback) {
  try {
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function getSetups(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(setupsKey(user)), []);
}
function writeSetups(user, list) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(setupsKey(user), JSON.stringify(list));
}
function saveSetup(user, setup) {
  const list = getSetups(user);
  list.push(setup);
  writeSetups(user, list);
  return setup;
}
function updateSetup(user, id, updates) {
  const list = getSetups(user);
  const idx = list.findIndex((s) => s && String(s.id) === String(id));
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...updates, updatedAt: new Date().toISOString() };
  writeSetups(user, list);
  return list[idx];
}
function deleteSetup(user, id) {
  const list = getSetups(user);
  const next = list.filter((s) => !s || String(s.id) !== String(id));
  if (next.length === list.length) return false;
  writeSetups(user, next);
  return true;
}

// ---- Central analysis state ----
function blankAnalysis() {
  return {
    id: generateId(),
    accountId: '',
    pair: '',
    direction: 'LONG',
    strategy: '',
    session: '',
    timeframe: '',
    setupType: '',
    entry: '',
    sl: '',
    tp: '',
    riskPercent: '',
    lotSize: '',
    notes: '',
    manualChecks: {},
    status: 'DRAFT',
  };
}
let analysis = blankAnalysis();
let lastResult = null; // { applicable, checks, decision, risk, priceError }

function numOrUndef(v) {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Session value mapped for rule scoping: TIME_RESTRICTION templates only
// know London/New York/Asia/Overlap — Custom means "unknown, skip".
function ruleSession(session) {
  if (!session) return undefined;
  if (session === 'Custom') return undefined;
  if (session === 'Overlap London-NewYork') return 'Overlap';
  return session;
}

function tradesTodayCount(user) {
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  try {
    for (const f of getFolders(user)) {
      for (const t of getTrades(f.id)) {
        if (String(t?.date || '').slice(0, 10) === today) n += 1;
      }
    }
  } catch { /* offline-safe */ }
  return n;
}

// ---- Price structure validation (LONG: SL < Entry < TP, SHORT mirrored) ----
function validatePriceStructure(direction, entry, sl, tp) {
  const e = Number(entry);
  const s = Number(sl);
  const t = Number(tp);
  if (entry === '' || sl === '' || tp === '') return null; // incomplete — not an error yet
  if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(t)) {
    return 'Entry / SL / TP must be valid numbers before the setup can be READY.';
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

// ---- Full evaluation (pure, delegates to utils — no duplicated logic) ----
function evaluateAnalysis(user) {
  const entry = numOrUndef(analysis.entry);
  const sl = numOrUndef(analysis.sl);
  const tp = numOrUndef(analysis.tp);
  const riskPercent = numOrUndef(analysis.riskPercent);
  const rr = entry !== undefined ? calcRR(entry, sl, tp, analysis.direction) : 0;

  const account = getFolders(user).find((f) => f.id === analysis.accountId);
  const balance = account ? Number(account.currentBalance) : NaN;
  const riskAmount = Number.isFinite(balance) && riskPercent !== undefined
    ? calcRiskAmount(balance, riskPercent)
    : 0;
  const positionSize = entry !== undefined && riskPercent !== undefined && Number.isFinite(balance)
    ? calcPositionSize(balance, riskPercent, entry, sl)
    : 0;

  const guards = checkRiskGuards({
    balance,
    riskAmount: riskPercent !== undefined ? riskAmount : undefined,
    riskPercent,
    entry, sl, tp,
    direction: entry !== undefined && sl !== undefined && tp !== undefined ? analysis.direction : undefined,
  });

  const ctx = {
    riskPercent,
    rr,
    session: ruleSession(analysis.session),
    tradesToday: tradesTodayCount(user),
    pair: analysis.pair || undefined,
    strategy: analysis.strategy || undefined,
  };
  const applicable = getApplicableRules(user, {
    session: ctx.session,
    strategy: ctx.strategy,
    pair: ctx.pair,
  });

  const checks = {};
  for (const rule of applicable) {
    const type = String(rule?.type || '').trim().toUpperCase();
    const checked = analysis.manualChecks[rule.id] === true;
    const evalCtx = MANUAL_TYPES.has(type) ? { ...ctx, checked } : ctx;
    let res;
    try {
      res = evaluateRule(rule, evalCtx);
    } catch {
      res = { pass: false, reason: 'Evaluation error', source: 'My Trading Rules' };
    }
    checks[rule.id] = {
      pass: res.pass === true,
      reason: res.reason || '',
      source: res.source || 'My Trading Rules',
    };
  }

  const decisionRules = applicable.map((r) => {
    const w = Number(r?.weight);
    return {
      id: r?.id,
      name: r?.name ?? r?.title ?? 'Unnamed rule',
      category: r?.category,
      weight: r?.weight === undefined || r?.weight === null || r?.weight === '' || !Number.isFinite(w) || w < 0 ? 1 : w,
      required: r?.required === true,
      enabled: r?.enabled !== false,
    };
  });
  const decision = evaluateChecklist({
    rules: decisionRules,
    checks,
    thresholds: { ...DEFAULT_THRESHOLDS },
  });

  // Price structure violation blocks READY: force NO_TRADE with explanation.
  const priceError = validatePriceStructure(analysis.direction, analysis.entry, analysis.sl, analysis.tp);
  let finalState = decision.state;
  const blockers = [...decision.blockers];
  if (priceError) {
    finalState = 'NO_TRADE';
    blockers.push({
      id: '__price_structure__',
      name: 'Price structure invalid',
      category: 'ENTRY',
      weight: 0,
      required: true,
      reason: priceError,
      source: 'Price validation',
    });
  }

  return {
    applicable,
    checks,
    decision: { ...decision, state: finalState, blockers },
    risk: { rr, riskAmount, positionSize, balance, guards },
    priceError,
  };
}

// ---- State symbols (color + text, never color alone) ----
function stateBadge(state) {
  if (state === 'READY') return `<span class="badge badge-tp">✓ READY</span>`;
  if (state === 'WAITING') return `<span class="badge badge-gold">○ WAITING</span>`;
  return `<span class="badge badge-sl">× NO_TRADE</span>`;
}
function statusBadge(status) {
  if (status === 'READY') return `<span class="badge badge-tp">✓ READY</span>`;
  if (status === 'WAITING') return `<span class="badge count-waiting badge">○ WAITING</span>`;
  if (status === 'NO_TRADE') return `<span class="badge badge-sl">× NO_TRADE</span>`;
  return `<span class="badge badge-gold">! DRAFT</span>`;
}

// ============================================================
// /trade — dashboard: SETUPS (WAITING/READY) + TRADES (ACTIVE/CLOSED TODAY)
// Phase 4: setups feed execution feeds OPEN feeds CLOSED feeds balance.
// SETUPS vs TRADES are never mixed: separate sections + Setup/Trade labels.
// Counts are read from live storage on every refresh. READY count (setups)
// is never merged with ACTIVE count (executed OPEN trades).
// Filter ALL/OPEN/CLOSED re-renders list sections only (no full rebuild).
// ============================================================
let tradeFilter = 'ALL'; // ALL | OPEN | CLOSED — executed-trades visibility only
let tradeDashboardBound = false;

// ---- Executed trades (storage-backed; API-compatible with utils/executedTrades.js)
// Optional Phase 4 module shape (when present):
//   getOpenTrades(user) / getClosedTrades(user) over OPEN/PARTIALLY_CLOSED/CLOSED.
// This file must not change execution/close APIs, so it only READS here and
// persists closes via storage.updateTrade. If utils/executedTrades.js ever
// lands, its readers are preferred via lazy override below.
let externalExecutedReaders = null;
try {
  import(/* @vite-ignore */ '../utils/executedTrades.js')
    .then((m) => {
      if (m && (typeof m.getOpenTrades === 'function' || typeof m.getClosedTrades === 'function')) {
        externalExecutedReaders = m;
        try {
          const u = getCurrentUser();
          if (u && document.getElementById('trade-dashboard')) refreshTradeLists(u);
        } catch { /* dashboard may be unmounted */ }
      }
    })
    .catch(() => { /* local storage fallback below */ });
} catch { /* local storage fallback below */ }

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// Normalize any stored trade (Phase 4 executed shape OR legacy TP/SL log)
// into one executed-trade view model. Never mutates storage.
function normalizeExecutedTrade(raw, folderId) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const id = String(t.id ?? '');
  const rawStatus = String(t.status ?? '').trim().toUpperCase();
  let status = 'CLOSED';
  if (rawStatus === 'OPEN' || rawStatus === 'PARTIALLY_CLOSED') status = rawStatus;
  else if (rawStatus === 'CLOSED') status = 'CLOSED';
  else if (t.status == null || t.status === '') {
    // Legacy journal-style trades (type TP/SL, no status) are closed history.
    status = 'CLOSED';
  }

  const pair = pickFirst(t.pair, t.symbol, '—');
  const direction = String(pickFirst(t.direction, t.side, 'LONG')).trim().toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const entry = numOrNull(pickFirst(t.entry, t.entryPrice, t.openPrice, t.open));
  const sl = numOrNull(pickFirst(t.sl, t.stopLoss, t.stop));
  const tp = numOrNull(pickFirst(t.tp, t.takeProfit, t.target));
  const lot = numOrNull(pickFirst(t.lot, t.lotSize, t.size, t.volume, t.quantity));
  const riskPercent = numOrNull(pickFirst(t.riskPercent, t.risk));
  const riskAmount = numOrNull(pickFirst(t.riskAmount, t.riskValue));
  let rr = numOrNull(pickFirst(t.rr, t.rMultiple));
  if (rr === null && entry !== null && sl !== null && tp !== null) {
    const riskDist = Math.abs(entry - sl);
    const rewardDist = Math.abs(tp - entry);
    rr = riskDist > 0 ? Math.round((rewardDist / riskDist) * 100) / 100 : null;
  }
  const openedAt = pickFirst(t.openedAt, t.opened, t.openTime, t.createdAt, t.date, t.timestamp);
  const closedAt = pickFirst(t.closedAt, t.closeTime, t.exitTime, status === 'CLOSED' ? pickFirst(t.date, t.updatedAt) : undefined);
  const exitPrice = numOrNull(pickFirst(t.exitPrice, t.exit, t.closePrice, t.close));
  const currentPrice = numOrNull(pickFirst(t.currentPrice, t.livePrice, t.markPrice));
  const strategy = pickFirst(t.strategy, t.strategyId, t.setupType, '');

  // P/L signed: prefer explicit fields, else legacy amount+type.
  let pnl = numOrNull(pickFirst(t.pnl, t.profit, t.netPnl, t.realizedPnl));
  if (pnl === null && t.amount !== undefined && t.amount !== null && t.amount !== '') {
    const amt = Number(t.amount);
    if (Number.isFinite(amt)) {
      const type = String(t.type || '').toUpperCase();
      pnl = type === 'SL' ? -Math.abs(amt) : type === 'TP' ? Math.abs(amt) : amt;
    }
  }
  let rMult = numOrNull(pickFirst(t.rMultiple, t.r, t.returnR));
  if (rMult === null && pnl !== null && riskAmount !== null && riskAmount !== 0) {
    rMult = Math.round((pnl / Math.abs(riskAmount)) * 100) / 100;
  }

  const timeline = Array.isArray(t.timeline) ? t.timeline
    : Array.isArray(t.events) ? t.events
    : Array.isArray(t.history) ? t.history
    : null;

  return {
    id, folderId,
    pair: String(pair ?? '—'),
    direction, status,
    entry, sl, tp, lot, riskPercent, riskAmount, rr,
    openedAt: openedAt || '',
    closedAt: closedAt || '',
    exitPrice, currentPrice, strategy: String(strategy ?? ''),
    pnl, rMultiple: rMult,
    notes: String(t.notes ?? ''),
    timeline,
    raw: t,
  };
}

function getAllExecutedTrades(user) {
  if (externalExecutedReaders && typeof externalExecutedReaders.getOpenTrades === 'function'
    && typeof externalExecutedReaders.getClosedTrades === 'function') {
    try {
      const open = externalExecutedReaders.getOpenTrades(user) || [];
      const closed = externalExecutedReaders.getClosedTrades(user) || [];
      const seen = new Set();
      const out = [];
      for (const t of [...open, ...closed]) {
        const nt = t && t.folderId !== undefined ? t : normalizeExecutedTrade(t, t?.folderId ?? t?.accountId ?? '');
        const key = `${nt.folderId}::${nt.id}`;
        if (nt.id && !seen.has(key)) { seen.add(key); out.push(nt); }
      }
      if (out.length || open.length || closed.length) return out;
    } catch { /* fall through to storage scan */ }
  }
  let out = [];
  try {
    for (const f of getFolders(user)) {
      for (const t of getTrades(f.id)) {
        const nt = normalizeExecutedTrade(t, f.id);
        if (nt.id) out.push(nt);
      }
    }
  } catch { /* offline-safe */ }
  return out;
}

function getOpenTradesLocal(user) {
  return getAllExecutedTrades(user).filter((t) => t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED');
}

function getClosedTradesLocal(user) {
  return getAllExecutedTrades(user).filter((t) => t.status === 'CLOSED');
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

// Live unrealized hint when currentPrice is known, else null (card stays static).
function unrealizedHint(t) {
  if (t.currentPrice === null || t.entry === null) return null;
  const dirSign = t.direction === 'SHORT' ? -1 : 1;
  const diff = (t.currentPrice - t.entry) * dirSign;
  const riskDist = t.entry !== null && t.sl !== null ? Math.abs(t.entry - t.sl) : 0;
  const rNow = riskDist > 0 ? diff / riskDist : null;
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  const abs = fmtNum(Math.abs(diff), 4);
  const rTxt = rNow === null || !Number.isFinite(rNow) ? '' : ` (${rNow >= 0 ? '+' : '−'}${Math.abs(rNow).toFixed(2)}R)`;
  const cls = diff > 0 ? 'pl-positive' : diff < 0 ? 'pl-negative' : '';
  return { text: `${sign}${abs}${rTxt}`, cls };
}

function tradeStatusBadge(status) {
  if (status === 'OPEN') return `<span class="badge badge-tp">● OPEN</span>`;
  if (status === 'PARTIALLY_CLOSED') return `<span class="badge badge-gold">◐ PARTIAL</span>`;
  return `<span class="badge badge-sl">■ CLOSED</span>`;
}

function kindLabel(kind) {
  return `<span class="kind-label kind-${kind === 'Trade' ? 'trade' : 'setup'}">${kind === 'Trade' ? 'TRADE' : 'SETUP'}</span>`;
}

function timelinePreviewHtml(t) {
  let items = [];
  if (Array.isArray(t.timeline)) {
    items = t.timeline.slice(-3).map((e) => {
      if (e == null) return null;
      if (typeof e === 'string') return { label: e, when: '' };
      return { label: String(e.label ?? e.title ?? e.event ?? e.note ?? 'Event'), when: e.when ?? e.at ?? e.time ?? e.date ?? '' };
    }).filter(Boolean);
  }
  if (!items.length) {
    items.push({ label: `Opened${t.entry !== null ? ` @ ${fmtNum(t.entry, 5)}` : ''}`, when: t.openedAt });
    if (t.status === 'CLOSED') items.push({ label: `Closed${t.exitPrice !== null ? ` @ ${fmtNum(t.exitPrice, 5)}` : ''}`, when: t.closedAt });
    else if (t.status === 'PARTIALLY_CLOSED') items.push({ label: 'Partially closed', when: t.closedAt || '' });
  }
  if (!items.length) return '';
  return `
    <ol class="trade-timeline" aria-label="Recent trade events">
      ${items.map((e) => `<li><span class="tl-dot" aria-hidden="true"></span><span>${escapeHtml(e.label)}${e.when ? ` <time>${escapeHtml(fmtWhen(e.when))}</time>` : ''}</span></li>`).join('')}
    </ol>
  `;
}

function activeTradeCardHtml(t) {
  const id = escapeHtml(t.id);
  const hint = unrealizedHint(t);
  const opened = escapeHtml(fmtWhen(t.openedAt));
  return `
    <article class="card trade-card trade-card-active" data-trade-id="${id}" data-folder-id="${escapeHtml(t.folderId)}">
      <div class="tc-pair">
        <span class="setup-card-pair">${escapeHtml(t.pair)} <span class="trade-dir trade-dir-${t.direction === 'SHORT' ? 'short' : 'long'}">${t.direction === 'SHORT' ? '▼ SHORT' : '▲ LONG'}</span></span>
        <span class="tc-badges">${kindLabel('Trade')}${tradeStatusBadge(t.status)}</span>
      </div>
      <div class="tc-pl">
        ${hint
          ? `<span class="pl-hint ${hint.cls}">≈ live ${escapeHtml(hint.text)} @ ${escapeHtml(fmtNum(t.currentPrice, 5))}</span>`
          : `<span class="pl-static">Risk ${t.riskAmount !== null ? `$${escapeHtml(fmtNum(t.riskAmount))}` : t.riskPercent !== null ? `${escapeHtml(fmtNum(t.riskPercent))}%` : '—'} · RR ${t.rr !== null ? escapeHtml(String(t.rr)) : '—'}</span>`}
      </div>
      <div class="tc-levels">
        <span>Entry <strong>${t.entry !== null ? escapeHtml(fmtNum(t.entry, 5)) : '—'}</strong></span>
        <span>SL <strong>${t.sl !== null ? escapeHtml(fmtNum(t.sl, 5)) : '—'}</strong></span>
        <span>TP <strong>${t.tp !== null ? escapeHtml(fmtNum(t.tp, 5)) : '—'}</strong></span>
      </div>
      <div class="tc-risk">
        <span>Lot <strong>${t.lot !== null ? escapeHtml(fmtNum(t.lot)) : '—'}</strong></span>
        <span>Risk <strong>${t.riskPercent !== null ? `${escapeHtml(fmtNum(t.riskPercent))}%` : '—'}</strong></span>
        <span>RR <strong>${t.rr !== null ? escapeHtml(String(t.rr)) : '—'}</strong></span>
        <span>Opened <strong>${opened}</strong></span>
      </div>
      <div class="tc-manage trade-card-actions trade-action-bar">
        <button class="btn btn-primary btn-sm" data-action="manage-trade" data-id="${id}" data-folder="${escapeHtml(t.folderId)}">MANAGE</button>
        <button class="btn btn-secondary btn-sm" data-action="close-trade" data-id="${id}" data-folder="${escapeHtml(t.folderId)}">CLOSE</button>
      </div>
      <div class="tc-timeline">${timelinePreviewHtml(t)}</div>
      ${t.notes ? `<div class="tc-notes">${escapeHtml(t.notes)}</div>` : ''}
    </article>
  `;
}

function closedTradeCardHtml(t) {
  const id = escapeHtml(t.id);
  const pnlCls = t.pnl === null ? '' : t.pnl > 0 ? 'pl-positive' : t.pnl < 0 ? 'pl-negative' : '';
  const pnlTxt = t.pnl === null ? '—' : `${t.pnl > 0 ? '+' : t.pnl < 0 ? '−' : ''}$${fmtNum(Math.abs(t.pnl))}`;
  return `
    <article class="card trade-card trade-card-closed" data-trade-id="${id}" data-folder-id="${escapeHtml(t.folderId)}">
      <div class="tc-pair">
        <span class="setup-card-pair">${escapeHtml(t.pair)} <span class="trade-dir trade-dir-${t.direction === 'SHORT' ? 'short' : 'long'}">${t.direction === 'SHORT' ? '▼ SHORT' : '▲ LONG'}</span></span>
        <span class="tc-badges">${kindLabel('Trade')}${tradeStatusBadge('CLOSED')}</span>
      </div>
      <div class="tc-pl"><span class="pl-value ${pnlCls}">${escapeHtml(pnlTxt)}</span>
        <span class="pl-r">${t.rMultiple !== null ? `${t.rMultiple >= 0 ? '+' : '−'}${Math.abs(t.rMultiple).toFixed(2)}R` : ''}</span>
        ${t.strategy ? `<span class="pl-strat">${escapeHtml(t.strategy)}</span>` : ''}
      </div>
      <div class="tc-levels">
        <span>Entry <strong>${t.entry !== null ? escapeHtml(fmtNum(t.entry, 5)) : '—'}</strong></span>
        <span>Exit <strong>${t.exitPrice !== null ? escapeHtml(fmtNum(t.exitPrice, 5)) : '—'}</strong></span>
        <span>Closed <strong>${escapeHtml(fmtWhen(t.closedAt))}</strong></span>
      </div>
      <div class="tc-manage trade-card-actions">
        <button class="btn btn-ghost btn-sm" data-action="manage-trade" data-id="${id}" data-folder="${escapeHtml(t.folderId)}">VIEW</button>
      </div>
      <div class="tc-timeline">${timelinePreviewHtml(t)}</div>
      ${t.notes ? `<div class="tc-notes">${escapeHtml(t.notes)}</div>` : ''}
    </article>
  `;
}

function setupLevelsLine(s) {
  const m = s?.market || {};
  const entry = pickFirst(m.entry, s?.entry);
  const sl = pickFirst(m.sl, s?.sl);
  const tp = pickFirst(m.tp, s?.tp);
  if (entry === undefined && sl === undefined && tp === undefined) return '';
  const f = (v) => (v === undefined || v === null || v === '' ? '—' : escapeHtml(String(v)));
  return `<div class="setup-card-meta"><span>Entry ${f(entry)}</span><span>SL ${f(sl)}</span><span>TP ${f(tp)}</span></div>`;
}

function emptyStateHtml(title, hint) {
  return `<div class="empty-state"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(hint)}</p></div>`;
}

function signedRHtml(t) {
  const r = t.rMultiple;
  if (r === null || r === undefined || !Number.isFinite(Number(r))) return '—';
  const n = Number(r);
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}R`;
}

function reviewQueueCardHtml(t) {
  const id = escapeHtml(String(t.id ?? ''));
  return `
    <article class="card trade-card trade-card-closed" data-trade-id="${id}" data-folder-id="${escapeHtml(String(t.folderId ?? ''))}">
      <div class="tc-pair">
        <span class="setup-card-pair">${escapeHtml(String(t.pair ?? '—'))} <span class="trade-dir trade-dir-${t.direction === 'SHORT' ? 'short' : 'long'}">${t.direction === 'SHORT' ? '▼ SHORT' : '▲ LONG'}</span></span>
        <span class="tc-badges">${kindLabel('Trade')}<span class="badge badge-gold">○ REVIEW PENDING</span></span>
      </div>
      <div class="tc-pl"><span class="pl-r">${escapeHtml(signedRHtml(t))}</span>
        ${t.strategy ? `<span class="pl-strat">${escapeHtml(String(t.strategy))}</span>` : ''}
      </div>
      <div class="tc-manage trade-card-actions">
        <button class="btn btn-secondary btn-sm" data-action="review-trade" data-id="${id}">REVIEW</button>
        <button class="btn btn-ghost btn-sm" data-action="manage-trade" data-id="${id}" data-folder="${escapeHtml(String(t.folderId ?? ''))}">VIEW</button>
      </div>
    </article>
  `;
}

function getReviewQueue(user) {
  try {
    return getClosedTradesLocal(user).filter((t) => {
      if (!t || !t.id) return false;
      const r = getReviewByTradeId(user, t.id);
      return !r || String(r.status || '').toUpperCase() !== 'COMPLETED';
    });
  } catch {
    return [];
  }
}

// ============================================================
// /trade — dashboard shell (rendered once; lists refresh in place)
// ============================================================
export function renderTrade() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  tradeDashboardBound = false;

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page" id="trade-dashboard">
      <div class="page-header trade-order-header">
        <div>
          <h1 class="page-title">Trade Analysis</h1>
          <p class="page-subtitle">Pre-trade discipline check — analyze before you execute</p>
        </div>
        <button class="btn btn-primary" id="start-analysis-btn">+ START NEW ANALYSIS</button>
      </div>
      <div class="trade-filter-bar" role="tablist" aria-label="Trade visibility filter" id="trade-filter-bar">
        <button class="tab trade-filter-tab" role="tab" data-action="trade-filter" data-filter="ALL" aria-selected="${tradeFilter === 'ALL'}">ALL</button>
        <button class="tab trade-filter-tab" role="tab" data-action="trade-filter" data-filter="OPEN" aria-selected="${tradeFilter === 'OPEN'}">OPEN</button>
        <button class="tab trade-filter-tab" role="tab" data-action="trade-filter" data-filter="CLOSED" aria-selected="${tradeFilter === 'CLOSED'}">CLOSED</button>
      </div>
      <div class="trade-counts" role="status" aria-label="Setup and trade status counts" id="trade-counts"></div>
      <div id="trade-lists">
        <section aria-label="Waiting setups" id="section-waiting">
          <div class="trade-section-head"><h2>Waiting setups</h2><span class="trade-section-count" id="count-waiting"></span></div>
          <div class="setup-grid" id="waiting-grid"></div>
        </section>
        <section aria-label="Ready setups" id="section-ready" style="margin-top:var(--space-xl);">
          <div class="trade-section-head"><h2>Ready setups</h2><span class="trade-section-count" id="count-ready"></span></div>
          <div class="setup-grid" id="ready-grid"></div>
        </section>
        <section aria-label="Active trades" id="section-active" style="margin-top:var(--space-xl);">
          <div class="trade-section-head"><h2>Active trades</h2><span class="trade-section-count" id="count-active"></span></div>
          <div class="setup-grid trade-grid" id="active-grid"></div>
        </section>
        <section aria-label="Closed today" id="section-closed" style="margin-top:var(--space-xl);">
          <div class="trade-section-head"><h2>Closed today</h2><span class="trade-section-count" id="count-closed"></span></div>
          <div class="setup-grid trade-grid" id="closed-grid"></div>
        </section>
        <section aria-label="Review queue" id="section-review-queue" style="margin-top:var(--space-xl);">
          <div class="trade-section-head"><h2>Review queue</h2><span class="trade-section-count" id="count-review-queue"></span></div>
          <div class="setup-grid trade-grid" id="review-queue-grid"></div>
        </section>
      </div>
    </div>
  `;
  bindNavbar();
  document.getElementById('start-analysis-btn')?.addEventListener('click', () => {
    try { sessionStorage.removeItem(REOPEN_KEY); } catch { /* noop */ }
    navigate('/trade/new');
  });
  // Single delegated listener: filters + all card actions. Survives list re-renders.
  const root = document.getElementById('trade-dashboard');
  if (root && !tradeDashboardBound) {
    tradeDashboardBound = true;
    root.addEventListener('click', (e) => onTradeDashboardClick(e, user));
  }
  bindReviewQueueRefresh();
  refreshTradeLists(user);
}

function snapshotTradeData(user) {
  const setups = getSetups(user);
  const waiting = setups.filter((s) => s?.status === 'WAITING');
  const ready = setups.filter((s) => s?.status === 'READY');
  const open = getOpenTradesLocal(user);
  const closedToday = getClosedTradesLocal(user).filter((t) => isToday(t.closedAt));
  const reviewQueue = getReviewQueue(user);
  return { waiting, ready, open, closedToday, reviewQueue };
}

// Re-render counts + list sections only (filter changes never rebuild the page).
function refreshTradeLists(user) {
  const u = user || getCurrentUser();
  if (!u || !document.getElementById('trade-dashboard')) return;
  const { waiting, ready, open, closedToday, reviewQueue } = snapshotTradeData(u);

  const counts = document.getElementById('trade-counts');
  if (counts) {
    counts.innerHTML = `
      <span class="badge count-waiting">○ SETUP WAITING · ${waiting.length}</span>
      <span class="badge count-ready">✓ SETUP READY · ${ready.length}</span>
      <span class="badge count-open">● TRADE OPEN · ${open.length}</span>
      <span class="badge count-closed">■ TRADE CLOSED TODAY · ${closedToday.length}</span>
      <span class="badge count-notrade">○ REVIEW QUEUE · ${reviewQueue.length}</span>
    `;
  }

  const waitingGrid = document.getElementById('waiting-grid');
  if (waitingGrid) {
    waitingGrid.innerHTML = waiting.length ? waiting.map(setupCardHtml).join('')
      : emptyStateHtml('No waiting setups', 'Click "START NEW ANALYSIS" to evaluate your next idea');
  }
  const readyGrid = document.getElementById('ready-grid');
  if (readyGrid) {
    readyGrid.innerHTML = ready.length ? ready.map(setupCardHtml).join('')
      : emptyStateHtml('No ready setups', 'Setups that pass every required check appear here with ENTER TRADE');
  }
  const activeGrid = document.getElementById('active-grid');
  if (activeGrid) {
    activeGrid.innerHTML = open.length ? open.map(activeTradeCardHtml).join('')
      : emptyStateHtml('No active trades', 'Executed OPEN trades appear here for management');
  }
  const closedGrid = document.getElementById('closed-grid');
  if (closedGrid) {
    closedGrid.innerHTML = closedToday.length ? closedToday.map(closedTradeCardHtml).join('')
      : emptyStateHtml('Nothing closed today', 'Trades closed today appear here with signed P/L');
  }

  const setCount = (id, n, label) => {
    const el = document.getElementById(id);
    if (el) el.textContent = `${n} ${label}`;
  };
  setCount('count-waiting', waiting.length, 'waiting');
  setCount('count-ready', ready.length, 'ready');
  setCount('count-active', open.length, 'active');
  setCount('count-closed', closedToday.length, 'closed today');
  setCount('count-review-queue', reviewQueue.length, reviewQueue.length === 1 ? 'trade awaiting review' : 'trades awaiting review');

  const queueGrid = document.getElementById('review-queue-grid');
  if (queueGrid) {
    queueGrid.innerHTML = reviewQueue.length ? reviewQueue.map(reviewQueueCardHtml).join('')
      : emptyStateHtml('Review queue clear', 'Closed trades without a completed review appear here');
  }
  const secQueue = document.getElementById('section-review-queue');
  if (secQueue) secQueue.style.display = reviewQueue.length ? '' : 'none';

  // Filter visibility: setups always visible; executed sections follow the filter.
  const showActive = tradeFilter === 'ALL' || tradeFilter === 'OPEN';
  const showClosed = tradeFilter === 'ALL' || tradeFilter === 'CLOSED';
  const secActive = document.getElementById('section-active');
  const secClosed = document.getElementById('section-closed');
  if (secActive) secActive.style.display = showActive ? '' : 'none';
  if (secClosed) secClosed.style.display = showClosed ? '' : 'none';

  document.querySelectorAll('.trade-filter-tab').forEach((tab) => {
    const active = tab.dataset.filter === tradeFilter;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function onTradeDashboardClick(e, user) {
  const el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'trade-filter') {
    const f = String(el.dataset.filter || 'ALL').toUpperCase();
    tradeFilter = f === 'OPEN' || f === 'CLOSED' ? f : 'ALL';
    refreshTradeLists(user);
    return;
  }
  if (action === 'open-setup') {
    try { sessionStorage.setItem(REOPEN_KEY, el.dataset.id); } catch { /* noop */ }
    navigate('/trade/new');
    return;
  }
  if (action === 'delete-setup') {
    showConfirm('Delete this analysis? This cannot be undone.', () => {
      if (deleteSetup(user, el.dataset.id)) {
        showToast('Analysis deleted', 'error');
        refreshTradeLists(user);
      }
    });
    return;
  }
  if (action === 'enter-trade') {
    try { sessionStorage.setItem(REOPEN_KEY, el.dataset.id); } catch { /* noop */ }
    navigate('/trade/new');
    return;
  }
  if (action === 'manage-trade') {
    navigate(`/trade/${el.dataset.id}`);
    return;
  }
  if (action === 'review-trade') {
    navigate(`/trade/${el.dataset.id}/review`);
    return;
  }
  if (action === 'close-trade') {
    openCloseTradeModal(user, el.dataset.folder, el.dataset.id);
    return;
  }
}

let reviewQueueRefreshBound = false;
function bindReviewQueueRefresh() {
  if (reviewQueueRefreshBound) return;
  reviewQueueRefreshBound = true;
  const reread = () => {
    try {
      const u = getCurrentUser();
      if (u && document.getElementById('trade-dashboard')) refreshTradeLists(u);
    } catch { /* offline-safe */ }
  };
  window.addEventListener('hashchange', reread);
  window.addEventListener('pageshow', reread);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reread();
  });
  window.addEventListener('focus', reread);
}

function setupCardHtml(s) {
  const id = escapeHtml(String(s.id ?? ''));
  const pair = escapeHtml(s?.market?.pair || s?.pair || '—');
  const dir = escapeHtml(s?.market?.direction || s?.direction || '');
  const score = s?.score !== undefined && s.score !== null ? `${escapeHtml(String(s.score))}%` : '—';
  const when = s?.timestamp ? escapeHtml(new Date(s.timestamp).toLocaleString()) : '';
  const isReady = (s?.status || 'DRAFT') === 'READY';
  return `
    <div class="card setup-card" data-id="${id}">
      <div class="setup-card-head">
        <span class="setup-card-pair">${pair} ${dir ? `<span style="font-size:var(--font-size-xs);color:var(--text-secondary);">${dir}</span>` : ''}</span>
        <span class="tc-badges">${kindLabel('Setup')}${statusBadge(s?.status || 'DRAFT')}</span>
      </div>
      <div class="setup-card-meta">
        <span>Score ${score}</span>
        ${when ? `<span>${when}</span>` : ''}
      </div>
      ${setupLevelsLine(s)}
      <div class="setup-card-actions">
        <button class="btn btn-primary btn-sm" data-action="open-setup" data-id="${id}">OPEN</button>
        ${isReady ? `<button class="btn btn-primary btn-sm" data-action="enter-trade" data-id="${id}">ENTER TRADE</button>` : ''}
        <button class="btn btn-danger btn-sm" data-action="delete-setup" data-id="${id}">Delete</button>
      </div>
    </div>
  `;
}

// Inline close flow: prefers a shared close modal from tradeDetail when it
// exists, otherwise navigates to the detail route for the full close flow.
async function openCloseTradeModal(user, folderId, tradeId) {
  try {
    const mod = await import(/* @vite-ignore */ '../pages/tradeDetail.js');
    if (mod && typeof mod.openCloseModal === 'function') {
      mod.openCloseModal(user, folderId, tradeId, () => refreshTradeLists(user));
      return;
    }
    if (mod && typeof mod.renderTradeDetail === 'function') {
      navigate(`/trade/${tradeId}`);
      return;
    }
  } catch { /* no detail module — inline fallback below */ }

  const trades = (() => { try { return getTrades(folderId); } catch { return []; } })();
  const t = trades.find((x) => x && String(x.id) === String(tradeId));
  if (!t) return showToast('Trade not found', 'error');
  const nt = normalizeExecutedTrade(t, folderId);
  showModal(`
    <div class="modal-header">
      <h3 class="modal-title">Close ${escapeHtml(nt.pair)} ${escapeHtml(nt.direction)}</h3>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <p style="color:var(--text-secondary);margin-bottom:var(--space-md);line-height:1.6;">
      Entry ${nt.entry !== null ? escapeHtml(fmtNum(nt.entry, 5)) : '—'} ·
      SL ${nt.sl !== null ? escapeHtml(fmtNum(nt.sl, 5)) : '—'} ·
      TP ${nt.tp !== null ? escapeHtml(fmtNum(nt.tp, 5)) : '—'}
    </p>
    <div class="form-group">
      <label class="form-label" for="close-exit">Exit price</label>
      <input type="number" id="close-exit" step="any" placeholder="e.g. ${nt.entry !== null ? escapeHtml(fmtNum(nt.entry, 5)) : '1.0850'}">
    </div>
    <div class="form-group">
      <label class="form-label" for="close-notes">Close notes (optional)</label>
      <textarea id="close-notes" rows="2" placeholder="Why close now?"></textarea>
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" id="close-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="close-manage">MANAGE IN DETAIL</button>
      <button type="button" class="btn btn-danger" id="close-confirm">CLOSE TRADE</button>
    </div>
  `);
  setTimeout(() => {
    document.getElementById('modal-close-btn')?.addEventListener('click', hideModal);
    document.getElementById('close-cancel')?.addEventListener('click', hideModal);
    document.getElementById('close-manage')?.addEventListener('click', () => {
      hideModal();
      navigate(`/trade/${tradeId}`);
    });
    document.getElementById('close-confirm')?.addEventListener('click', () => {
      const exitRaw = document.getElementById('close-exit')?.value ?? '';
      const notes = (document.getElementById('close-notes')?.value ?? '').trim();
      const exit = exitRaw === '' ? null : Number(exitRaw);
      if (exitRaw !== '' && !Number.isFinite(exit)) return showToast('Exit price must be a number', 'error');
      const now = new Date().toISOString();
      const updates = { status: 'CLOSED', closedAt: now, updatedAt: now };
      if (exit !== null) { updates.exitPrice = exit; updates.exit = exit; updates.closePrice = exit; }
      if (notes) updates.notes = [t.notes, notes].filter(Boolean).join('\n');
      try {
        updateTrade(folderId, tradeId, updates);
      } catch {
        return showToast('Could not close trade', 'error');
      }
      hideModal();
      showToast('Trade closed');
      refreshTradeLists(user);
    });
  }, 50);
}

// ============================================================
// /trade/new — analysis form
// ============================================================
export function renderTradeNew() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');

  // Reopen: restore full state from a saved WAITING/DRAFT/READY setup.
  analysis = blankAnalysis();
  let reopenId = null;
  try { reopenId = sessionStorage.getItem(REOPEN_KEY); } catch { /* noop */ }
  if (reopenId) {
    const saved = getSetups(user).find((s) => s && String(s.id) === String(reopenId));
    if (saved) {
      analysis = {
        ...blankAnalysis(),
        id: saved.id,
        accountId: saved.market?.accountId || saved.accountId || '',
        pair: saved.market?.pair || saved.pair || '',
        direction: saved.market?.direction || saved.direction || 'LONG',
        strategy: saved.market?.strategy || saved.strategy || '',
        session: saved.market?.session || saved.session || '',
        timeframe: saved.market?.timeframe || saved.timeframe || '',
        setupType: saved.market?.setupType || saved.setupType || '',
        entry: saved.market?.entry ?? saved.entry ?? '',
        sl: saved.market?.sl ?? saved.sl ?? '',
        tp: saved.market?.tp ?? saved.tp ?? '',
        riskPercent: saved.risk?.riskPercent ?? saved.riskPercent ?? '',
        lotSize: saved.market?.lotSize ?? saved.lotSize ?? '',
        notes: saved.notes || '',
        manualChecks: { ...(saved.checklist || {}) },
        status: saved.status || 'DRAFT',
      };
    }
    try { sessionStorage.removeItem(REOPEN_KEY); } catch { /* noop */ }
  }

  const folders = getFolders(user);
  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <div class="page-header trade-order-header">
        <div>
          <button class="btn btn-ghost btn-sm" id="back-trade">← Back to Trade</button>
          <h1 class="page-title">New Trade Analysis</h1>
          <p class="page-subtitle">Fill the setup — checklist, score and decision update live</p>
        </div>
      </div>
      <div class="trade-layout">
        <div class="trade-main">
          <section class="card trade-order-account" aria-label="Account">
            <div class="trade-section-title"><h2>Account</h2></div>
            <div class="form-group">
              <label class="form-label" for="ta-account">Account</label>
              <select id="ta-account">
                <option value="">— Select account —</option>
                ${folders.map((f) => `<option value="${escapeHtml(f.id)}" ${analysis.accountId === f.id ? 'selected' : ''}>${escapeHtml(f.name)} (${escapeHtml(f.currency || 'USD')})</option>`).join('')}
              </select>
            </div>
          </section>

          <section class="card trade-order-market" aria-label="Market setup">
            <div class="trade-section-title"><h2>Market setup</h2></div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="ta-pair">Pair</label>
                <select id="ta-pair">
                  <option value="">— Select pair —</option>
                  ${FALLBACK_PAIRS.map((p) => `<option value="${escapeHtml(p)}" ${analysis.pair === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" id="ta-dir-label">Direction</label>
                <div class="dir-toggle" role="group" aria-labelledby="ta-dir-label">
                  <button type="button" class="btn dir-btn dir-long" id="ta-long" aria-pressed="${analysis.direction !== 'SHORT'}">▲ LONG</button>
                  <button type="button" class="btn dir-btn dir-short" id="ta-short" aria-pressed="${analysis.direction === 'SHORT'}">▼ SHORT</button>
                </div>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="ta-strategy">Strategy</label>
                <input list="ta-strategy-list" id="ta-strategy" value="${escapeHtml(analysis.strategy)}" placeholder="No strategy selected — free text (Phase 7: linked strategies)">
                <datalist id="ta-strategy-list">${STRATEGY_SUGGESTIONS.map((s) => `<option value="${escapeHtml(s)}">`).join('')}</datalist>
              </div>
              <div class="form-group">
                <label class="form-label" for="ta-setupType">Setup type</label>
                <input type="text" id="ta-setupType" value="${escapeHtml(analysis.setupType)}" placeholder="e.g. Breakout retest">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="ta-session">Session</label>
                <select id="ta-session">
                  <option value="">— Select session —</option>
                  ${SESSIONS.map((s) => `<option value="${escapeHtml(s)}" ${analysis.session === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" for="ta-timeframe">Timeframe</label>
                <select id="ta-timeframe">
                  <option value="">— Select timeframe —</option>
                  ${TIMEFRAMES.map((t) => `<option value="${escapeHtml(t)}" ${analysis.timeframe === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="ta-entry">Entry price</label>
                <input type="number" id="ta-entry" step="any" value="${escapeHtml(String(analysis.entry))}" placeholder="e.g. 1.0850">
              </div>
              <div class="form-group">
                <label class="form-label" for="ta-sl">Stop loss</label>
                <input type="number" id="ta-sl" step="any" value="${escapeHtml(String(analysis.sl))}" placeholder="e.g. 1.0800">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="ta-tp">Take profit</label>
                <input type="number" id="ta-tp" step="any" value="${escapeHtml(String(analysis.tp))}" placeholder="e.g. 1.0950">
              </div>
              <div class="form-group">
                <label class="form-label" for="ta-risk">Risk %</label>
                <input type="number" id="ta-risk" step="any" min="0" value="${escapeHtml(String(analysis.riskPercent))}" placeholder="e.g. 1">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="ta-lotsize">Lot size (optional)</label>
                <input type="number" id="ta-lotsize" step="any" min="0" value="${escapeHtml(String(analysis.lotSize))}" placeholder="Optional">
              </div>
              <div class="form-group">
                <label class="form-label" for="ta-notes">Notes</label>
                <textarea id="ta-notes" rows="2" placeholder="Trade idea, confluence, concerns...">${escapeHtml(analysis.notes)}</textarea>
              </div>
            </div>
            <div class="shot-placeholder" aria-label="Screenshot placeholder">
              📷 Screenshot upload — Coming in Phase 5
            </div>
          </section>

          <section class="card trade-order-risk" aria-label="Risk">
            <div class="trade-section-title"><h2>Risk</h2><p>Calculated live via risk engine</p></div>
            <div id="trade-risk"></div>
          </section>

          <section class="card trade-order-checklist" aria-label="Checklist">
            <div class="trade-section-title"><h2>Pre-trade checklist</h2><p>Auto rules evaluate from your inputs · manual rules need your tick</p></div>
            <div id="trade-checklist"></div>
          </section>
        </div>

        <div class="trade-side">
          <section class="card decision-card trade-order-decision" aria-label="Decision" aria-live="polite">
            <div id="trade-decision"></div>
          </section>
          <section class="card trade-order-action" aria-label="Actions">
            <div class="trade-actions">
              <button class="btn btn-secondary" id="save-analysis-btn">SAVE ANALYSIS</button>
              <button class="btn btn-secondary" id="save-waiting-btn">SAVE AS WAITING</button>
            </div>
            <div id="enter-trade-slot" style="margin-top:8px;"></div>
          </section>
        </div>
      </div>
    </div>
  `;
  bindNavbar();
  document.getElementById('back-trade')?.addEventListener('click', () => navigate('/trade'));
  bindAnalysisForm(user);
  recalc(user); // initial paint
}

// ---- Form wiring: debounced recalc, section-only re-render ----
let recalcTimer = null;
function scheduleRecalc(user) {
  if (recalcTimer) clearTimeout(recalcTimer);
  recalcTimer = setTimeout(() => recalc(user), 150);
}

function readFormIntoState() {
  const v = (id) => document.getElementById(id)?.value ?? '';
  analysis.accountId = v('ta-account');
  analysis.pair = v('ta-pair');
  analysis.strategy = v('ta-strategy').trim();
  analysis.session = v('ta-session');
  analysis.timeframe = v('ta-timeframe');
  analysis.setupType = v('ta-setupType').trim();
  analysis.entry = v('ta-entry');
  analysis.sl = v('ta-sl');
  analysis.tp = v('ta-tp');
  analysis.riskPercent = v('ta-risk');
  analysis.lotSize = v('ta-lotsize');
  analysis.notes = v('ta-notes').trim();
}

function bindAnalysisForm(user) {
  const formIds = ['ta-account', 'ta-pair', 'ta-strategy', 'ta-setupType', 'ta-session', 'ta-timeframe', 'ta-entry', 'ta-sl', 'ta-tp', 'ta-risk', 'ta-lotsize', 'ta-notes'];
  for (const id of formIds) {
    document.getElementById(id)?.addEventListener('input', () => {
      readFormIntoState();
      scheduleRecalc(user);
    });
    document.getElementById(id)?.addEventListener('change', () => {
      readFormIntoState();
      scheduleRecalc(user);
    });
  }
  document.getElementById('ta-long')?.addEventListener('click', () => {
    analysis.direction = 'LONG';
    document.getElementById('ta-long')?.setAttribute('aria-pressed', 'true');
    document.getElementById('ta-short')?.setAttribute('aria-pressed', 'false');
    scheduleRecalc(user);
  });
  document.getElementById('ta-short')?.addEventListener('click', () => {
    analysis.direction = 'SHORT';
    document.getElementById('ta-short')?.setAttribute('aria-pressed', 'true');
    document.getElementById('ta-long')?.setAttribute('aria-pressed', 'false');
    scheduleRecalc(user);
  });
  // Manual checklist ticks (delegated — survives section re-render).
  document.getElementById('trade-checklist')?.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('ta-manual')) {
      analysis.manualChecks[t.dataset.id] = t.checked === true;
      scheduleRecalc(user);
    }
  });
  document.getElementById('save-analysis-btn')?.addEventListener('click', () => persistSetup(user, 'DRAFT'));
  document.getElementById('save-waiting-btn')?.addEventListener('click', () => persistSetup(user, 'WAITING'));
  document.getElementById('enter-trade-slot')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'enter-trade-btn') openEnterTradeModal(user);
  });
}

function recalc(user) {
  lastResult = evaluateAnalysis(user);
  renderRiskSection(lastResult.risk, lastResult.priceError);
  renderChecklistSection(lastResult);
  renderDecisionSection(lastResult);
  const slot = document.getElementById('enter-trade-slot');
  if (slot) {
    slot.innerHTML = lastResult.decision.state === 'READY'
      ? `<button class="btn btn-primary" id="enter-trade-btn" style="width:100%;">ENTER TRADE</button>`
      : '';
  }
}

// ---- Section renders (checklist + decision + risk only) ----
function renderRiskSection(risk, priceError) {
  const el = document.getElementById('trade-risk');
  if (!el) return;
  const warnHtml = (risk.guards.warnings || []).map((w) => `<div class="risk-warn">! ${escapeHtml(w)}</div>`).join('');
  const blockHtml = (risk.guards.blockers || []).map((b) => `<div class="risk-block">× ${escapeHtml(b)}</div>`).join('');
  el.innerHTML = `
    <div class="risk-grid">
      <div class="risk-item"><div class="risk-label">R:R</div><div class="risk-value">${escapeHtml(String(risk.rr))}</div></div>
      <div class="risk-item"><div class="risk-label">Risk amount</div><div class="risk-value">$${escapeHtml(Number(risk.riskAmount || 0).toFixed(2))}</div></div>
      <div class="risk-item"><div class="risk-label">Position size</div><div class="risk-value">${escapeHtml(String(risk.positionSize))}</div></div>
    </div>
    ${priceError ? `<div class="price-error" role="alert">× ${escapeHtml(priceError)}</div>` : ''}
    ${warnHtml}${blockHtml}
  `;
}

function ruleWhyText(rule) {
  return String(rule?.description ?? rule?.text ?? '');
}

function renderChecklistSection(result) {
  const el = document.getElementById('trade-checklist');
  if (!el) return;
  const { applicable, checks, decision } = result;
  if (!applicable.length) {
    el.innerHTML = `<div class="empty-state"><h3>No applicable rules</h3><p>Add rules under <a href="#/rules">Rules</a> — they apply here automatically.</p></div>`;
    return;
  }
  const failedIds = new Set(decision.failedRules.map((r) => r.id));
  const missingIds = new Set(decision.missingRules.map((r) => r.id));
  el.innerHTML = applicable.map((rule) => {
    const c = checks[rule.id] || {};
    const type = String(rule?.type || '').trim().toUpperCase();
    const isManual = MANUAL_TYPES.has(type);
    const checked = analysis.manualChecks[rule.id] === true;
    const required = rule?.required === true;
    const weight = rule?.weight ?? 1;
    const name = escapeHtml(String(rule?.name ?? rule?.title ?? 'Unnamed rule'));
    const category = escapeHtml(String(rule?.category ?? 'GENERAL'));
    const source = escapeHtml(String(c.source || 'My Trading Rules'));
    const reason = escapeHtml(String(c.reason || '—'));
    const why = escapeHtml(ruleWhyText(rule) || c.reason || '—');
    let verdict;
    if (missingIds.has(rule.id)) verdict = `<span class="verdict-missing" title="Missing">○ MISSING</span>`;
    else if (failedIds.has(rule.id)) verdict = `<span class="verdict-fail" title="Failed">× FAIL</span>`;
    else verdict = `<span class="verdict-pass" title="Passed">✓ PASS</span>`;
    const control = isManual
      ? `<input type="checkbox" class="ta-manual" data-id="${escapeHtml(String(rule.id))}" ${checked ? 'checked' : ''} aria-label="Confirm: ${name}">`
      : `<span class="check-auto-tag" title="Evaluated automatically from your inputs">○ auto</span>`;
    return `
      <div class="check-row">
        <div class="check-row-top">
          ${control}
          <span class="check-name">${name}</span>
          ${verdict}
        </div>
        <div class="check-meta">
          <span class="badge badge-cat">${category}</span>
          <span class="badge badge-weight">W ${escapeHtml(String(weight))}</span>
          ${required ? '<span class="badge badge-required">REQUIRED</span>' : ''}
          <span class="check-auto-tag">Source: ${source}</span>
        </div>
        <details class="check-why">
          <summary>Why</summary>
          <p>${why}</p>
          <p style="color:var(--text-muted);">Check: ${reason}</p>
        </details>
      </div>
    `;
  }).join('');
}

function decisionExplanation(decision, priceError) {
  if (priceError) return `× NO_TRADE — price structure is invalid: ${priceError} Fix entry/SL/TP before this setup can become READY.`;
  if (decision.state === 'READY') {
    return `✓ READY — all required rules passed, score ${decision.score}% is above the ${DEFAULT_THRESHOLDS.ready}% threshold, and risk checks are clear. You may proceed per plan.`;
  }
  if (decision.state === 'WAITING') {
    const missing = decision.missingRules.length;
    return `○ WAITING — no blocker failed, but the setup is incomplete${missing ? ` (${missing} check${missing === 1 ? '' : 's'} still missing)` : ''}. Score ${decision.score}% is below the ${DEFAULT_THRESHOLDS.ready}% READY threshold. Save as WAITING and revisit.`;
  }
  const first = decision.blockers[0];
  const reason = first ? first.reason : 'A required rule failed.';
  return `× NO_TRADE — blocked: ${reason} Resolve the blocker (current vs limit is shown above) before reconsidering this setup.`;
}

function fallbackDecisionHtml(result) {
  const { decision, priceError } = result;
  const state = decision.state;
  const cls = state === 'READY' ? 'ready' : state === 'WAITING' ? 'waiting' : 'no-trade';
  const icon = state === 'READY' ? '✓' : state === 'WAITING' ? '○' : '×';
  const pct = Math.max(0, Math.min(100, Number(decision.score) || 0));
  const barColor = state === 'READY' ? 'var(--color-tp)' : state === 'WAITING' ? 'var(--color-warning)' : 'var(--color-sl)';
  const blockers = (decision.blockers || []).map((b) => `<li>× <strong>${escapeHtml(b.name)}</strong> — ${escapeHtml(b.reason)}</li>`).join('');
  const warnings = (decision.warnings || []).map((w) => `<li>! <strong>${escapeHtml(w.name)}</strong> — ${escapeHtml(w.reason)}</li>`).join('');
  return `
    <div class="decision-state ${cls}">${icon} ${state}</div>
    <div class="decision-score">${escapeHtml(String(decision.score))}%</div>
    <div class="decision-bar"><div style="width:${pct}%;background:${barColor};"></div></div>
    <div style="font-size:var(--font-size-xs);color:var(--text-muted);">
      ${decision.passedRules.length} ✓ passed · ${decision.failedRules.length} × failed · ${decision.missingRules.length} ○ missing · READY ≥ ${DEFAULT_THRESHOLDS.ready} · WAITING ≥ ${DEFAULT_THRESHOLDS.waiting}
    </div>
    <p class="decision-explain">${escapeHtml(decisionExplanation(decision, priceError))}</p>
    ${blockers ? `<ul class="decision-list"><strong>Blockers</strong>${blockers}</ul>` : ''}
    ${warnings ? `<ul class="decision-list"><strong>Warnings</strong>${warnings}</ul>` : ''}
  `;
}

function renderDecisionSection(result) {
  const el = document.getElementById('trade-decision');
  if (!el) return;
  const card = el.closest('.decision-card');
  if (card) {
    card.classList.remove('decision-ready', 'decision-waiting', 'decision-no-trade');
    card.classList.add(result.decision.state === 'READY' ? 'decision-ready' : result.decision.state === 'WAITING' ? 'decision-waiting' : 'decision-no-trade');
  }
  if (externalDecisionCard) {
    try {
      el.innerHTML = externalDecisionCard(result.decision);
      return;
    } catch { /* fall through to inline */ }
  }
  el.innerHTML = fallbackDecisionHtml(result);
}

// ---- Persistence ----
function buildSetupRecord(status) {
  const r = lastResult || { applicable: [], checks: {}, decision: { score: 0, state: 'NO_TRADE', failedRules: [], warnings: [], blockers: [], missingRules: [], passedRules: [] }, risk: {}, priceError: null };
  return {
    id: analysis.id,
    status,
    score: r.decision.score,
    state: r.decision.state,
    checklist: { ...analysis.manualChecks },
    failed: r.decision.failedRules,
    warnings: r.decision.warnings,
    blockers: r.decision.blockers,
    market: {
      accountId: analysis.accountId,
      pair: analysis.pair,
      direction: analysis.direction,
      strategy: analysis.strategy,
      session: analysis.session,
      timeframe: analysis.timeframe,
      setupType: analysis.setupType,
      entry: analysis.entry,
      sl: analysis.sl,
      tp: analysis.tp,
      lotSize: analysis.lotSize,
    },
    risk: {
      riskPercent: analysis.riskPercent === '' ? undefined : Number(analysis.riskPercent),
      rr: r.risk.rr,
      riskAmount: r.risk.riskAmount,
      positionSize: r.risk.positionSize,
    },
    notes: analysis.notes,
    timestamp: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function persistSetup(user, status) {
  readFormIntoState();
  recalc(user);
  if (!analysis.accountId) return showToast('Select an account first', 'error');
  if (!analysis.pair) return showToast('Select a pair first', 'error');
  const record = buildSetupRecord(status);
  const existing = getSetups(user).find((s) => s && String(s.id) === String(analysis.id));
  if (existing) {
    const oldStatus = existing.status;
    updateSetup(user, analysis.id, record);
    auditSetupWrite(user, analysis.id, false, oldStatus, status);
  } else {
    saveSetup(user, record);
    auditSetupWrite(user, analysis.id, true, '', status);
  }
  showToast(status === 'WAITING' ? 'Saved as WAITING — reopen it from /trade' : 'Analysis saved!');
  if (status === 'WAITING') navigate('/trade');
}

function openEnterTradeModal(user) {
  // READY-only entry: WAITING / NO_TRADE never reach here (no ENTER button rendered).
  readFormIntoState();
  recalc(user);
  const result = lastResult;
  if (!result || result.decision.state !== 'READY') {
    showToast('Only READY setups can be executed', 'error');
    return;
  }
  // Persist the READY setup first so executeSetup can mark it ENTERED on success.
  const record = buildSetupRecord('READY');
  const savedExisting = getSetups(user).find((s) => s && String(s.id) === String(analysis.id));
  if (savedExisting) {
    const oldStatus = savedExisting.status;
    updateSetup(user, analysis.id, record);
    auditSetupWrite(user, analysis.id, false, oldStatus, 'READY');
  } else {
    saveSetup(user, record);
    auditSetupWrite(user, analysis.id, true, '', 'READY');
  }
  const saved = getSetups(user).find((s) => s && String(s.id) === String(analysis.id)) || record;
  openExecutionModal(saved, {
    user,
    onConfirm: (executionData) => {
      const res = executeSetup(user, saved, executionData);
      if (!res.success) {
        showToast(res.error || 'Execution failed', 'error');
        return;
      }
      showToast('✓ Trade executed');
      navigate(`/trade/${res.trade.id}`);
    },
  });
}
