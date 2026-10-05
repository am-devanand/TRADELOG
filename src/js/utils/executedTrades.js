// ============================================
// Executed Trades — live-trade data layer
// Vanilla ESM, offline-first (localStorage-first).
// No side effects on import. No network. No live prices.
// Entry is immutable after execution: only SL/TP/notes/
// currentPrice may change (via events), plus close fields.
// Balance only changes on CLOSE (entry is a no-op).
//
// Canonical store: tradelog_exectrades_{user} (spec key).
// The previous key tradelog_executed_{user} is migrated
// forward once, on first read. Legacy positional APIs are
// kept as thin wrappers for existing pages (tradeDetail).
// ============================================
import { DEFAULT_TRADE, TRADE_STATUSES, CLOSE_REASONS, makeTrade } from './models.js';
import { getSetup, updateSetup } from './setups.js';
import { calcRiskAmount, calcRR, checkRiskGuards } from './riskEngine.js';
import { generateId } from './helpers.js';
import { appendAudit } from './auditLog.js';

// Audit-only helper: failures here must never break a trade operation.
function safeAudit(user, entry) {
  try {
    appendAudit(user, entry);
  } catch {
    /* audit is append-only telemetry — never blocks trading */
  }
}

export { DEFAULT_TRADE, TRADE_STATUSES, CLOSE_REASONS };

export function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function exectradesKey(user) {
  return `tradelog_exectrades_${normalizeUser(user)}`;
}

function legacyExectradesKey(user) {
  return `tradelog_executed_${normalizeUser(user)}`;
}

function safeParse(raw, fallback) {
  try {
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function round2(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function deepCopy(v) {
  try {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  } catch {
    return Array.isArray(v) ? [...v] : v;
  }
}

function normalizeDirection(raw) {
  const d = String(raw ?? 'LONG').trim().toUpperCase();
  if (d === 'BUY' || d === 'LONG') return 'LONG';
  if (d === 'SELL' || d === 'SHORT') return 'SHORT';
  return 'LONG';
}

function dirSign(direction) {
  return normalizeDirection(direction) === 'SHORT' ? -1 : 1;
}

function normalizeStatus(raw) {
  const s = String(raw ?? 'OPEN').trim().toUpperCase();
  return TRADE_STATUSES.includes(s) ? s : 'OPEN';
}

function normalizeCloseReason(raw) {
  const r = String(raw ?? '').trim().toUpperCase();
  return CLOSE_REASONS.includes(r) ? r : '';
}

const LEGACY_REASON_MAP = {
  'TAKE PROFIT': 'TP_HIT',
  'STOP LOSS': 'SL_HIT',
  'MANUAL EXIT': 'MANUAL_EXIT',
  BREAKEVEN: 'BREAKEVEN',
  'TIME-BASED EXIT': 'OTHER',
  'RULE VIOLATION': 'OTHER',
};

function mapCloseReason(raw) {
  const direct = normalizeCloseReason(raw);
  if (direct) return direct;
  const key = String(raw ?? '').trim().toUpperCase();
  return LEGACY_REASON_MAP[key] || '';
}

function makeEvent(type, user, data = {}, message = '') {
  const d = deepCopy(data) ?? {};
  if (message && d.message == null) d.message = message;
  return {
    id: generateId(),
    type: String(type || 'INFO'),
    at: new Date().toISOString(),
    by: normalizeUser(user),
    data: d && typeof d === 'object' ? d : {},
    message: String(message || d.message || ''),
  };
}

function normalizeTrade(raw, user) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const now = new Date().toISOString();
  const base = makeTrade({}, normalizeUser(src.userId ?? user));
  const merged = { ...base, ...src };
  const factorRaw = Number(src.contractFactor);
  const factorKnown = Number.isFinite(factorRaw) && factorRaw > 0;
  return {
    ...merged,
    id: src.id || base.id,
    userId: normalizeUser(src.userId ?? user),
    accountId: src.accountId ?? '',
    setupId: src.setupId ?? '',
    pair: src.pair ?? '',
    direction: normalizeDirection(src.direction),
    strategyId: src.strategyId ?? src.strategy ?? '',
    session: src.session ?? '',
    timeframe: src.timeframe ?? '',
    setupType: src.setupType ?? '',
    lotSize: toFinite(src.lotSize ?? src.lot, 0),
    entryPrice: toFinite(src.entryPrice ?? src.entry, 0),
    exitPrice: toFinite(src.exitPrice, 0),
    stopLoss: toFinite(src.stopLoss ?? src.currentSL ?? src.sl, 0),
    takeProfit: toFinite(src.takeProfit ?? src.currentTP ?? src.tp, 0),
    initialSL: toFinite(src.initialSL ?? src.stopLoss ?? src.currentSL, 0),
    initialTP: toFinite(src.initialTP ?? src.takeProfit ?? src.currentTP, 0),
    riskAmount: toFinite(src.riskAmount, 0),
    riskPercent: toFinite(src.riskPercent, 0),
    potentialLoss: toFinite(src.potentialLoss, 0),
    potentialProfit: toFinite(src.potentialProfit, 0),
    rr: toFinite(src.rr ?? src.rrAtEntry, 0),
    pnl: toFinite(src.pnl ?? src.realizedPL ?? src.realizedPnl, 0),
    pnlPercent: toFinite(src.pnlPercent, 0),
    rMultiple: toFinite(src.rMultiple ?? src.realizedR, 0),
    status: normalizeStatus(src.status),
    openedAt: src.openedAt || src.executionTime || src.createdAt || now,
    closedAt: src.closedAt ?? (src.exitTime || ''),
    closeReason: src.closeReason ? mapCloseReason(src.closeReason) : '',
    entryReason: src.entryReason ?? '',
    notes: typeof src.notes === 'string' ? src.notes : '',
    checklistScore: toFinite(src.checklistScore, 0),
    checklistResults: Array.isArray(src.checklistResults) ? [...src.checklistResults] : [],
    rulesSnapshot: Array.isArray(src.rulesSnapshot) ? [...src.rulesSnapshot] : [],
    events: Array.isArray(src.events) ? [...src.events] : [],
    screenshotIds: Array.isArray(src.screenshotIds) ? [...src.screenshotIds] : [],
    createdAt: src.createdAt || now,
    updatedAt: src.updatedAt || now,
    closedLot: toFinite(src.closedLot ?? src.closedLots, 0),
    contractFactor: factorKnown ? factorRaw : 1,
    contractFactorSource: src.contractFactorSource ?? (factorKnown ? 'provided' : 'default-estimate'),
    pnlEstimated: src.pnlEstimated ?? !factorKnown,
    setupSnapshot: src.setupSnapshot ?? src.originalSetup ?? null,
    strategySnapshot: src.strategySnapshot ?? null,
    notesLog: Array.isArray(src.notesLog)
      ? [...src.notesLog]
      : Array.isArray(src.notes)
        ? [...src.notes]
        : [],
    slTpHistory: Array.isArray(src.slTpHistory) ? [...src.slTpHistory] : [],
  };
}

function remainingLot(trade) {
  const rem = round2(toFinite(trade.lotSize, 0) - toFinite(trade.closedLot, 0));
  return rem > 0 ? rem : 0;
}

// ---- Legacy store one-way migration ----

function migrateLegacyTrade(t, user) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const entry = Number(t.entry ?? t.entryPrice);
  if (!Number.isFinite(entry)) return null;
  const notesLog = Array.isArray(t.notes)
    ? t.notes.filter((n) => n && typeof n === 'object')
    : [];
  const notes = notesLog.map((n) => `[${n.at || ''}] ${n.text || ''}`.trim()).join('\n');
  const history = Array.isArray(t.slTpHistory) ? [...t.slTpHistory] : [];
  const synthEvents = (Array.isArray(t.events) ? t.events : []).map((e) => {
    const type = String(e?.type || 'info').toUpperCase();
    const mapped =
      type === 'OPENED' ? 'ENTRY' : type === 'CLOSE' ? 'CLOSE' : type === 'SLTP' ? 'SL_UPDATE' : type === 'NOTE' ? 'NOTE' : type;
    return makeEvent(mapped, e?.by ?? user, { message: e?.message || '' }, e?.message || '');
  });
  for (const h of history) {
    synthEvents.push(
      makeEvent('SL_UPDATE', user, { from: h.oldSL, to: h.newSL, note: h.note || '' }, `SL ${h.oldSL} → ${h.newSL}`),
      makeEvent('TP_UPDATE', user, { from: h.oldTP, to: h.newTP, note: h.note || '' }, `TP ${h.oldTP} → ${h.newTP}`),
    );
  }
  return normalizeTrade(
    {
      id: t.id,
      userId: normalizeUser(t.userId ?? user),
      accountId: t.accountId ?? '',
      setupId: t.setupId ?? '',
      pair: t.pair ?? '',
      direction: normalizeDirection(t.direction),
      strategyId: t.strategy ?? t.strategyId ?? '',
      session: t.session ?? '',
      timeframe: t.timeframe ?? '',
      setupType: t.setupType ?? '',
      lotSize: Number(t.lotSize) || 0,
      closedLot: Number(t.closedLots) || 0,
      entryPrice: entry,
      exitPrice: t.exitPrice ?? 0,
      stopLoss: Number(t.currentSL ?? t.initialSL) || 0,
      takeProfit: Number(t.currentTP ?? t.initialTP) || 0,
      initialSL: Number(t.initialSL) || 0,
      initialTP: Number(t.initialTP) || 0,
      riskAmount: Number(t.riskAmount) || 0,
      riskPercent: Number(t.riskPercent) || 0,
      rr: Number(t.rrAtEntry) || 0,
      pnl: Number(t.realizedPL) || 0,
      rMultiple: Number(t.realizedR) || 0,
      status: normalizeStatus(t.status),
      openedAt: t.executionTime || t.createdAt,
      closedAt: t.exitTime || t.closedAt || '',
      closeReason: mapCloseReason(t.closeReason),
      notes,
      notesLog,
      checklistScore: 0,
      checklistResults: [],
      rulesSnapshot: [],
      setupSnapshot: t.originalSetup ?? null,
      events: synthEvents,
      screenshotIds: Array.isArray(t.screenshotIds) ? [...t.screenshotIds] : [],
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      slTpHistory: history,
      contractFactor: 1,
      contractFactorSource: 'default-estimate',
      pnlEstimated: true,
    },
    user,
  );
}

function readCanonicalRaw(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(exectradesKey(user)), []);
}

function writeAll(user, trades) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(exectradesKey(user), JSON.stringify(trades));
}

function readRaw(user) {
  const canonical = readCanonicalRaw(user);
  if (canonical.length > 0) return canonical;
  if (typeof localStorage === 'undefined') return [];
  const legacy = safeParse(localStorage.getItem(legacyExectradesKey(user)), []);
  if (legacy.length === 0) return canonical;
  const migrated = legacy.map((t) => migrateLegacyTrade(t, user)).filter(Boolean);
  if (migrated.length > 0) writeAll(user, migrated);
  return migrated;
}

// ---- Folder access (direct localStorage; no firebase import, no import side effects) ----

function readFolders(user) {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`tradelog_folders_${normalizeUser(user)}`);
    if (raw == null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeFolders(user, folders) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(`tradelog_folders_${normalizeUser(user)}`, JSON.stringify(folders));
}

function getAccountBalance(user, accountId) {
  if (!accountId) return NaN;
  const folder = readFolders(user).find((f) => f && f.id === accountId);
  if (!folder) return NaN;
  const current = Number(folder.currentBalance);
  if (Number.isFinite(current)) return current;
  const start = Number(folder.startingBalance);
  return Number.isFinite(start) ? start : NaN;
}

function legacyTradesFor(accountId) {
  if (typeof localStorage === 'undefined' || !accountId) return [];
  try {
    const raw = localStorage.getItem(`tradelog_trades_${accountId}`);
    if (raw == null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---- Reads ----

export function getExecutedTrades(user, accountId) {
  const all = readRaw(user).map((t) => normalizeTrade(t, user));
  const filtered =
    accountId == null || accountId === '' ? all : all.filter((t) => t.accountId === accountId);
  filtered.sort((a, b) => {
    const da = new Date(a.createdAt).getTime();
    const db = new Date(b.createdAt).getTime();
    if (Number.isFinite(db) && Number.isFinite(da) && db !== da) return db - da;
    return 0;
  });
  return filtered;
}

export function getOpenTrades(user, accountId) {
  return getExecutedTrades(user, accountId).filter(
    (t) => t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED',
  );
}

export function getClosedTrades(user, accountId) {
  return getExecutedTrades(user, accountId).filter((t) => t.status === 'CLOSED');
}

export function getTradeById(tradeId, user) {
  if (!tradeId) return undefined;
  return getExecutedTrades(user).find((t) => t && t.id === tradeId);
}

function toLegacyView(t) {
  if (!t) return t;
  const notesLog = Array.isArray(t.notesLog) ? t.notesLog : [];
  return {
    ...t,
    entry: t.entryPrice,
    currentSL: t.stopLoss,
    currentTP: t.takeProfit,
    remainingLots: remainingLot(t),
    closedLots: toFinite(t.closedLot, 0),
    realizedPL: t.pnl,
    realizedR: t.rMultiple,
    rrAtEntry: t.rr,
    executionTime: t.openedAt,
    exitTime: t.closedAt || null,
    notes: [...notesLog],
    originalSetup: t.setupSnapshot ?? {},
  };
}

export function getExecutedTrade(user, id) {
  if (!id) return undefined;
  const t = getExecutedTrades(user).find((x) => x && String(x.id) === String(id));
  return t ? toLegacyView(t) : undefined;
}

export function findSetupForTrade(user, trade) {
  const setupId = trade?.setupId;
  if (!setupId) return null;
  try {
    return getSetup(normalizeUser(user), setupId) || null;
  } catch {
    return null;
  }
}

// ---- PnL ----

export function computePnl({ direction, entryPrice, exitPrice, lot, contractFactor } = {}) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  const size = Number(lot);
  const factor = Number(contractFactor);
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return { pnl: 0, estimated: true };
  if (!Number.isFinite(size) || size <= 0) return { pnl: 0, estimated: true };
  const known = Number.isFinite(factor) && factor > 0;
  const f = known ? factor : 1;
  return { pnl: round2((exit - entry) * dirSign(direction) * size * f), estimated: !known };
}

export function calcTradePL(trade, price) {
  const t = trade && typeof trade === 'object' ? trade : {};
  const entry = Number(t.entryPrice ?? t.entry);
  const sl = Number(t.initialSL);
  const riskAmount = Number(t.riskAmount);
  const p = Number(price);
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(p)) return { pl: 0, r: 0 };
  if (!Number.isFinite(riskAmount) || riskAmount <= 0) return { pl: 0, r: 0 };
  const riskDist = Math.abs(entry - sl);
  if (!Number.isFinite(riskDist) || riskDist <= 0) return { pl: 0, r: 0 };
  const diff = (p - entry) * dirSign(t.direction);
  const r = round2(diff / riskDist);
  return { pl: round2(r * riskAmount), r };
}

// ---- Execute ----

function buildNewTrade(clean, setup, exec, entry, sl, tp, lot, riskAmount, riskPercent, rr, contractFactor, factorKnown) {
  const now = new Date().toISOString();
  const lotScale = lot * contractFactor;
  const initialNote =
    typeof exec.notes === 'string' && exec.notes.trim() !== '' ? exec.notes.trim() : '';
  return makeTrade(
    {
      userId: clean,
      accountId: exec.accountId ?? setup.accountId ?? '',
      setupId: setup.id,
      pair: exec.pair ?? setup.pair ?? '',
      direction: normalizeDirection(exec.direction ?? setup.direction),
      strategyId: exec.strategyId ?? setup.strategyId ?? '',
      session: exec.session ?? setup.session ?? '',
      timeframe: exec.timeframe ?? setup.timeframe ?? '',
      setupType: exec.setupType ?? setup.setupType ?? '',
      lotSize: lot,
      entryPrice: entry,
      stopLoss: sl,
      takeProfit: tp,
      initialSL: sl,
      initialTP: tp,
      riskAmount: round2(riskAmount),
      riskPercent,
      potentialLoss: round2(Math.abs(entry - sl) * lotScale),
      potentialProfit: round2(Math.abs(tp - entry) * lotScale),
      rr,
      pnl: 0,
      pnlPercent: 0,
      rMultiple: 0,
      status: 'OPEN',
      openedAt: exec.openedAt || now,
      entryReason: exec.entryReason ?? setup.decision ?? '',
      notes: initialNote,
      checklistScore: toFinite(exec.checklistScore ?? setup.checklistScore, 0),
      checklistResults: deepCopy(exec.checklistResults ?? setup.checklistResults ?? []) ?? [],
      rulesSnapshot: deepCopy(
        Array.isArray(setup.checklistResults) ? setup.checklistResults : [],
      ) ?? [],
      screenshotIds: Array.isArray(exec.screenshotIds)
        ? [...exec.screenshotIds]
        : Array.isArray(setup.screenshotIds)
          ? [...setup.screenshotIds]
          : [],
      events: [
        makeEvent(
          'ENTRY',
          clean,
          {
            entryPrice: entry,
            lotSize: lot,
            stopLoss: sl,
            takeProfit: tp,
            contractFactor,
            contractFactorSource: factorKnown ? 'provided' : 'default-estimate',
            riskAmount: round2(riskAmount),
            riskPercent,
            rr,
          },
          `Executed @ ${entry} (${lot} lots)`,
        ),
      ],
      closedLot: 0,
      contractFactor,
      contractFactorSource: factorKnown ? 'provided' : 'default-estimate',
      pnlEstimated: !factorKnown,
      setupSnapshot: deepCopy(setup),
      strategySnapshot: deepCopy(exec.strategy ?? { strategyId: setup.strategyId ?? '' }) ?? {},
      notesLog: initialNote ? [{ at: now, text: initialNote }] : [],
      slTpHistory: [],
    },
    clean,
  );
}

function persistNewTrade(clean, trade, setupId) {
  const all = readRaw(clean);
  if (all.some((t) => t && t.id === trade.id)) {
    return { success: false, error: `Duplicate trade id: "${trade.id}"` };
  }
  all.push(trade);
  writeAll(clean, all);
  const setupRes = updateSetup(clean, setupId, { status: 'ENTERED', executedTradeId: trade.id });
  if (!setupRes || setupRes.success === false) {
    writeAll(
      clean,
      readCanonicalRaw(clean).filter((t) => !t || t.id !== trade.id),
    );
    return {
      success: false,
      error: `Trade created but setup could not move to ENTERED: ${setupRes?.error || 'unknown error'}`,
    };
  }
  auditTradeCreated(clean, trade);
  return { success: true, trade: normalizeTrade(trade, clean) };
}

function auditTradeCreated(clean, trade) {
  safeAudit(clean, {
    entityType: 'trade',
    entityId: String(trade?.id ?? ''),
    action: 'TRADE_CREATED',
    metadata: {
      pair: String(trade?.pair ?? ''),
      direction: String(trade?.direction ?? ''),
      accountId: String(trade?.accountId ?? ''),
    },
  });
}

function executeNew(setupId, executionData, user) {
  try {
    const exec = executionData && typeof executionData === 'object' ? executionData : {};
    const clean = normalizeUser(exec.user ?? exec.userId ?? user);
    if (!setupId) return { success: false, error: 'Setup id is required' };
    const setup = getSetup(clean, setupId);
    if (!setup) return { success: false, error: `Setup not found: "${setupId}"` };
    if (setup.status !== 'READY') {
      return {
        success: false,
        error: `Setup is not READY (current: ${setup.status || 'UNKNOWN'}). Only READY setups can be executed.`,
      };
    }

    const direction = normalizeDirection(exec.direction ?? setup.direction);
    const entry = Number(exec.entryPrice ?? setup.entryPrice);
    const sl = Number(exec.stopLoss ?? setup.stopLoss);
    const tp = Number(exec.takeProfit ?? setup.takeProfit);
    const lot = Number(exec.lotSize ?? exec.lot ?? setup.lotSize ?? NaN);

    if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp)) {
      return {
        success: false,
        error: `Invalid structure: entry/stop/take-profit must be finite numbers (entry=${String(exec.entryPrice ?? setup.entryPrice)}, sl=${String(exec.stopLoss ?? setup.stopLoss)}, tp=${String(exec.takeProfit ?? setup.takeProfit)}).`,
      };
    }
    if (!Number.isFinite(lot) || lot <= 0) {
      return {
        success: false,
        error: `Invalid structure: lotSize must be a number > 0 (got ${String(exec.lotSize ?? exec.lot ?? setup.lotSize)}).`,
      };
    }
    if (direction === 'LONG' && !(sl < entry && entry < tp)) {
      return {
        success: false,
        error: `Invalid levels for LONG: need SL < entry < TP (sl=${sl}, entry=${entry}, tp=${tp}).`,
      };
    }
    if (direction === 'SHORT' && !(sl > entry && entry > tp)) {
      return {
        success: false,
        error: `Invalid levels for SHORT: need SL > entry > TP (sl=${sl}, entry=${entry}, tp=${tp}).`,
      };
    }

    const accountId = exec.accountId ?? setup.accountId ?? '';
    const balance = getAccountBalance(clean, accountId);
    const riskPercent = toFinite(exec.riskPercent ?? setup.riskPercent, 0);
    const riskAmount = Number.isFinite(balance)
      ? calcRiskAmount(balance, riskPercent)
      : toFinite(exec.riskAmount ?? setup.riskAmount, 0);
    const rr = calcRR(entry, sl, tp, direction);

    const guards = checkRiskGuards({
      balance,
      riskAmount,
      riskPercent,
      dailyUsed: exec.dailyUsed,
      dailyLimit: exec.dailyLimit,
      maxRiskPerTrade: exec.maxRiskPerTrade,
      remainingDrawdown: exec.remainingDrawdown,
      entry,
      sl,
      tp,
      direction,
    });
    if (!guards.safe) {
      return {
        success: false,
        error: `Risk guard blocked execution (risk ${riskAmount} vs limits): ${guards.blockers.join(' ')}`,
      };
    }

    const factorRaw = exec.contractValuePerPoint ?? exec.contractFactor;
    const factorKnown = Number.isFinite(Number(factorRaw)) && Number(factorRaw) > 0;
    const contractFactor = factorKnown ? Number(factorRaw) : 1;
    const trade = buildNewTrade(clean, setup, exec, entry, sl, tp, lot, riskAmount, riskPercent, rr, contractFactor, factorKnown);
    return persistNewTrade(clean, trade, setup.id);
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to execute setup' };
  }
}

function executeLegacy(user, setup, executionData) {
  try {
    const clean = normalizeUser(user);
    if (!setup || typeof setup !== 'object') return { success: false, error: 'Setup is required' };
    const state = String(setup.state || setup.decision?.state || '').toUpperCase();
    const status = String(setup.status || '').toUpperCase();
    if (status === 'WAITING' || status === 'NO_TRADE' || state === 'WAITING' || state === 'NO_TRADE') {
      return { success: false, error: 'Only READY setups can be executed' };
    }
    const ex = executionData && typeof executionData === 'object' ? executionData : {};
    const entry = Number(ex.executionPrice ?? ex.entry ?? ex.entryPrice);
    const sl = Number(ex.stopLoss ?? ex.sl);
    const tp = Number(ex.takeProfit ?? ex.tp);
    const lots = Number(ex.lotSize ?? ex.lot);
    if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp)) {
      return { success: false, error: 'Execution price, SL and TP must be valid numbers' };
    }
    if (!Number.isFinite(lots) || lots <= 0) {
      return { success: false, error: 'Lot size must be a positive number' };
    }
    const direction = normalizeDirection(ex.direction ?? setup?.market?.direction ?? setup?.direction);
    if (direction === 'SHORT') {
      if (!(sl > entry)) return { success: false, error: `Invalid SL side for SHORT: SL ${sl} must be above entry ${entry}.` };
      if (!(tp < entry)) return { success: false, error: `Invalid TP side for SHORT: TP ${tp} must be below entry ${entry}.` };
    } else {
      if (!(sl < entry)) return { success: false, error: `Invalid SL side for LONG: SL ${sl} must be below entry ${entry}.` };
      if (!(tp > entry)) return { success: false, error: `Invalid TP side for LONG: TP ${tp} must be above entry ${entry}.` };
    }

    const market = setup.market && typeof setup.market === 'object' ? setup.market : {};
    const risk = setup.risk && typeof setup.risk === 'object' ? setup.risk : {};
    const riskAmount = toFinite(ex.riskAmount ?? risk.riskAmount ?? setup.riskAmount, 0);
    const riskPercent = toFinite(ex.riskPercent ?? risk.riskPercent ?? setup.riskPercent, 0);
    const rr = calcRR(entry, sl, tp, direction);
    const factorRaw = ex.contractValuePerPoint ?? ex.contractFactor;
    const factorKnown = Number.isFinite(Number(factorRaw)) && Number(factorRaw) > 0;
    const normalizedSetup = {
      id: setup.id || generateId(),
      accountId: market.accountId ?? setup.accountId ?? '',
      pair: market.pair ?? setup.pair ?? '',
      direction,
      strategyId: market.strategy ?? setup.strategy ?? setup.strategyId ?? '',
      session: market.session ?? setup.session ?? '',
      timeframe: market.timeframe ?? setup.timeframe ?? '',
      setupType: market.setupType ?? setup.setupType ?? '',
      checklistScore: toFinite(setup.score, 0),
      checklistResults: setup.checklist && typeof setup.checklist === 'object' ? [deepCopy(setup.checklist)] : [],
      decision: setup.state ?? (typeof setup.decision === 'string' ? setup.decision : ''),
      screenshotIds: Array.isArray(setup.screenshotIds) ? [...setup.screenshotIds] : [],
    };
    const trade = buildNewTrade(
      clean,
      normalizedSetup,
      {
        ...ex,
        accountId: normalizedSetup.accountId,
        pair: normalizedSetup.pair,
        direction,
        strategyId: normalizedSetup.strategyId,
        session: normalizedSetup.session,
        timeframe: normalizedSetup.timeframe,
        setupType: normalizedSetup.setupType,
        entryPrice: entry,
        stopLoss: sl,
        takeProfit: tp,
        lotSize: lots,
        notes: ex.notes,
        strategy: { strategyId: normalizedSetup.strategyId },
      },
      entry,
      sl,
      tp,
      lots,
      riskAmount,
      riskPercent,
      rr,
      factorKnown ? Number(factorRaw) : 1,
      factorKnown,
    );
    trade.setupSnapshot = deepCopy(setup);
    const res = persistNewTrade(clean, trade, setup.id);
    if (!res.success) return res;
    return { success: true, trade: toLegacyView(res.trade) };
  } catch (e) {
    return { success: false, error: e?.message || 'Execution failed' };
  }
}

export function executeSetup(a, b = {}, c) {
  const looksLikeSetupObject =
    b && typeof b === 'object' && !Array.isArray(b) && 'status' in b;
  if (typeof a === 'string' && looksLikeSetupObject) return executeLegacy(a, b, c);
  return executeNew(a, b, c);
}

// ---- Close ----

function closeCore(tradeId, opts = {}, user) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const clean = normalizeUser(o.user ?? o.userId ?? user);
    if (!tradeId) return { success: false, error: 'Trade id is required' };
    const all = readRaw(clean);
    const idx = all.findIndex((t) => t && t.id === tradeId);
    if (idx === -1) return { success: false, error: `Trade not found: "${tradeId}"` };

    const trade = normalizeTrade(all[idx], clean);
    if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_CLOSED') {
      return { success: false, error: `Trade is already CLOSED (status: ${trade.status}).` };
    }

    const exit = Number(o.exitPrice ?? o.price);
    if (!Number.isFinite(exit)) {
      return {
        success: false,
        error: `Invalid structure: exitPrice must be a finite number (got ${String(o.exitPrice ?? o.price)}). No live prices are fetched — pass an explicit exitPrice.`,
      };
    }

    const reason = mapCloseReason(o.reason);
    if (o.reason != null && o.reason !== '' && !reason) {
      return {
        success: false,
        error: `Invalid close reason "${o.reason}". Use one of: ${CLOSE_REASONS.join(', ')}.`,
      };
    }

    const rem = remainingLot(trade);
    const partialRaw = o.partialLot ?? o.closeLot ?? o.lot;
    const partialLot = partialRaw == null || partialRaw === '' ? null : Number(partialRaw);
    if (partialLot != null && (!Number.isFinite(partialLot) || partialLot <= 0)) {
      return {
        success: false,
        error: `Invalid structure: partialLot must be > 0 and < remaining lot ${rem} (got ${String(partialRaw)}).`,
      };
    }
    const isPartial = partialLot != null && partialLot < rem;

    const factor = Number(trade.contractFactor);
    const contractFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
    const now = new Date().toISOString();
    const priorRealized = toFinite(trade.pnl, 0);
    const noteText = typeof o.notes === 'string' && o.notes.trim() !== '' ? o.notes.trim() : '';
    const notesLog = [...trade.notesLog];
    if (noteText) notesLog.push({ at: now, text: noteText });

    if (isPartial) {
      const { pnl: realized } = computePnl({
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        exitPrice: exit,
        lot: partialLot,
        contractFactor,
      });
      const nextClosed = round2(toFinite(trade.closedLot, 0) + partialLot);
      const totalRealized = round2(priorRealized + realized);
      const closeReason = reason || 'PARTIAL_EXIT';
      const updated = normalizeTrade(
        {
          ...trade,
          exitPrice: exit,
          pnl: totalRealized,
          pnlPercent:
            trade.entryPrice && trade.lotSize
              ? round2((totalRealized / (Math.abs(trade.entryPrice) * trade.lotSize * contractFactor || 1)) * 100)
              : 0,
          rMultiple: trade.riskAmount > 0 ? round2(totalRealized / trade.riskAmount) : 0,
          status: 'PARTIALLY_CLOSED',
          closeReason,
          notes: noteText ? `${trade.notes ? `${trade.notes}\n` : ''}[${now}] ${noteText}` : trade.notes,
          notesLog,
          closedLot: nextClosed,
          events: [
            ...trade.events,
            makeEvent(
              'PARTIAL_CLOSE',
              clean,
              {
                exitPrice: exit,
                closedLot: partialLot,
                remainingLot: round2(rem - partialLot),
                realizedPnl: realized,
                totalRealizedPnl: totalRealized,
                reason: closeReason,
              },
              `Partial close ${partialLot} @ ${exit} (${closeReason})`,
            ),
          ],
          updatedAt: now,
        },
        clean,
      );
      all[idx] = updated;
      writeAll(clean, all);
      recalculateAccountBalance(clean, trade.accountId);
      return { success: true, trade: updated, partPL: realized, partR: trade.riskAmount > 0 ? round2(realized / trade.riskAmount) : 0 };
    }

    const { pnl: restPnl } = computePnl({
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      exitPrice: exit,
      lot: rem,
      contractFactor,
    });
    const totalPnl = round2(priorRealized + restPnl);
    const closeReason = reason || 'MANUAL_EXIT';
    const updated = normalizeTrade(
      {
        ...trade,
        exitPrice: exit,
        pnl: totalPnl,
        pnlPercent:
          trade.entryPrice && trade.lotSize
            ? round2((totalPnl / (Math.abs(trade.entryPrice) * trade.lotSize * contractFactor || 1)) * 100)
            : 0,
        rMultiple: trade.riskAmount > 0 ? round2(totalPnl / trade.riskAmount) : 0,
        status: 'CLOSED',
        closedAt: o.closedAt || o.exitTime || now,
        closeReason,
        notes: noteText ? `${trade.notes ? `${trade.notes}\n` : ''}[${now}] ${noteText}` : trade.notes,
        notesLog,
        closedLot: toFinite(trade.lotSize, 0),
        events: [
          ...trade.events,
          makeEvent(
            'CLOSE',
            clean,
            {
              exitPrice: exit,
              closedLot: rem,
              pnl: totalPnl,
              realizedOnClose: restPnl,
              priorRealizedPnl: priorRealized,
              reason: closeReason,
            },
            `Closed ${rem} @ ${exit} (${closeReason})`,
          ),
        ],
        updatedAt: now,
      },
      clean,
    );
    all[idx] = updated;
    writeAll(clean, all);
    recalculateAccountBalance(clean, trade.accountId);
    safeAudit(clean, {
      entityType: 'trade',
      entityId: String(tradeId),
      action: 'TRADE_CLOSED',
      metadata: {
        exitPrice: Number(exit),
        reason: String(closeReason),
        pnl: Number(totalPnl),
        rMultiple: Number(updated.rMultiple),
      },
    });
    return {
      success: true,
      trade: updated,
      partPL: restPnl,
      partR: trade.riskAmount > 0 ? round2(restPnl / trade.riskAmount) : 0,
    };
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to close trade' };
  }
}

export function closeTrade(a, b = {}, c) {
  if (typeof b === 'string') {
    const res = closeCore(b, c || {}, a);
    if (!res.success) return res;
    return { success: true, trade: toLegacyView(res.trade), partPL: res.partPL, partR: res.partR };
  }
  return closeCore(a, b || {}, c);
}

// ---- SL/TP / notes / price ticks ----

function updateSLTPCore(tradeId, levels = {}, user, requireBoth = false) {
  try {
    const lv = levels && typeof levels === 'object' ? levels : {};
    const clean = normalizeUser(lv.user ?? lv.userId ?? user);
    if (!tradeId) return { success: false, error: 'Trade id is required' };
    const all = readRaw(clean);
    const idx = all.findIndex((t) => t && t.id === tradeId);
    if (idx === -1) return { success: false, error: `Trade not found: "${tradeId}"` };

    const trade = normalizeTrade(all[idx], clean);
    if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_CLOSED') {
      return {
        success: false,
        error: `Trade is ${trade.status}: SL/TP can only change on OPEN or PARTIALLY_CLOSED trades. Entry price is immutable.`,
      };
    }
    const hasSL = lv.sl !== undefined || lv.stopLoss !== undefined;
    const hasTP = lv.tp !== undefined || lv.takeProfit !== undefined;
    if (requireBoth && (!hasSL || !hasTP)) {
      return { success: false, error: 'SL and TP must be valid numbers' };
    }
    if (!hasSL && !hasTP) return { success: false, error: 'Provide sl and/or tp to update' };

    const nextSL = hasSL ? Number(lv.sl ?? lv.stopLoss) : trade.stopLoss;
    const nextTP = hasTP ? Number(lv.tp ?? lv.takeProfit) : trade.takeProfit;
    if (hasSL && !Number.isFinite(nextSL)) {
      return { success: false, error: `Invalid structure: sl must be finite (got ${String(lv.sl ?? lv.stopLoss)}).` };
    }
    if (hasTP && !Number.isFinite(nextTP)) {
      return { success: false, error: `Invalid structure: tp must be finite (got ${String(lv.tp ?? lv.takeProfit)}).` };
    }
    const entry = Number(trade.entryPrice);
    if (Number.isFinite(entry) && hasSL && nextSL !== trade.stopLoss) {
      if (trade.direction === 'LONG' && !(nextSL < entry)) {
        return { success: false, error: `Invalid SL side for LONG: SL ${nextSL} must be below entry ${entry}.` };
      }
      if (trade.direction === 'SHORT' && !(nextSL > entry)) {
        return { success: false, error: `Invalid SL side for SHORT: SL ${nextSL} must be above entry ${entry}.` };
      }
    }
    if (Number.isFinite(entry) && hasTP && nextTP !== trade.takeProfit) {
      if (trade.direction === 'LONG' && !(nextTP > entry)) {
        return { success: false, error: `Invalid TP side for LONG: TP ${nextTP} must be above entry ${entry}.` };
      }
      if (trade.direction === 'SHORT' && !(nextTP < entry)) {
        return { success: false, error: `Invalid TP side for SHORT: TP ${nextTP} must be below entry ${entry}.` };
      }
    }

    const now = new Date().toISOString();
    const note = typeof lv.note === 'string' ? lv.note : '';
    const events = [...trade.events];
    const history = [...trade.slTpHistory];
    if (hasSL && nextSL !== trade.stopLoss) {
      events.push(makeEvent('SL_UPDATE', clean, { from: trade.stopLoss, to: nextSL, note }, `SL ${trade.stopLoss} → ${nextSL}`));
    }
    if (hasTP && nextTP !== trade.takeProfit) {
      events.push(makeEvent('TP_UPDATE', clean, { from: trade.takeProfit, to: nextTP, note }, `TP ${trade.takeProfit} → ${nextTP}`));
    }
    if ((hasSL && nextSL !== trade.stopLoss) || (hasTP && nextTP !== trade.takeProfit)) {
      history.push({ at: now, oldSL: trade.stopLoss, newSL: nextSL, oldTP: trade.takeProfit, newTP: nextTP, note });
    }
    const rr = calcRR(trade.entryPrice, nextSL, nextTP, trade.direction);
    const factor = Number(trade.contractFactor);
    const lotScale = toFinite(trade.lotSize, 0) * (Number.isFinite(factor) && factor > 0 ? factor : 1);
    const updated = normalizeTrade(
      {
        ...trade,
        stopLoss: nextSL,
        takeProfit: nextTP,
        initialSL: trade.initialSL || trade.stopLoss,
        initialTP: trade.initialTP || trade.takeProfit,
        rr,
        potentialLoss: round2(Math.abs(trade.entryPrice - nextSL) * lotScale),
        potentialProfit: round2(Math.abs(nextTP - trade.entryPrice) * lotScale),
        events,
        slTpHistory: history,
        updatedAt: now,
      },
      clean,
    );
    all[idx] = updated;
    writeAll(clean, all);
    if (hasSL && nextSL !== trade.stopLoss) {
      safeAudit(clean, {
        entityType: 'trade',
        entityId: String(tradeId),
        action: 'TRADE_SL_UPDATED',
        metadata: { oldValue: Number(trade.stopLoss), newValue: Number(nextSL) },
      });
    }
    if (hasTP && nextTP !== trade.takeProfit) {
      safeAudit(clean, {
        entityType: 'trade',
        entityId: String(tradeId),
        action: 'TRADE_TP_UPDATED',
        metadata: { oldValue: Number(trade.takeProfit), newValue: Number(nextTP) },
      });
    }
    return { success: true, trade: updated };
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to update SL/TP' };
  }
}

export function updateSLTP(a, b = {}, c) {
  if (typeof b === 'string') {
    const res = updateSLTPCore(b, c || {}, a, true);
    if (!res.success) return res;
    return { success: true, trade: toLegacyView(res.trade) };
  }
  return updateSLTPCore(a, b || {}, c, false);
}

function addTradeNoteCore(tradeId, note, user) {
  try {
    const extra = note && typeof note === 'object' ? note : null;
    const text = extra ? (extra.note ?? extra.text ?? '') : note;
    const clean = normalizeUser((extra && (extra.user ?? extra.userId)) ?? user);
    if (!tradeId) return { success: false, error: 'Trade id is required' };
    if (typeof text !== 'string' || text.trim() === '') {
      return { success: false, error: 'Note must be a non-empty string' };
    }
    const all = readRaw(clean);
    const idx = all.findIndex((t) => t && t.id === tradeId);
    if (idx === -1) return { success: false, error: `Trade not found: "${tradeId}"` };
    const trade = normalizeTrade(all[idx], clean);
    const now = new Date().toISOString();
    const updated = normalizeTrade(
      {
        ...trade,
        notes: `${trade.notes ? `${trade.notes}\n` : ''}[${now}] ${text.trim()}`,
        notesLog: [...trade.notesLog, { at: now, text: text.trim() }],
        events: [...trade.events, makeEvent('NOTE', clean, { text: text.trim() }, 'Note added')],
        updatedAt: now,
      },
      clean,
    );
    all[idx] = updated;
    writeAll(clean, all);
    safeAudit(clean, {
      entityType: 'trade',
      entityId: String(tradeId),
      action: 'TRADE_NOTE_UPDATED',
      metadata: {},
    });
    return { success: true, trade: updated };
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to add note' };
  }
}

export function addTradeNote(a, b, c) {
  const textOf = (x) =>
    x && typeof x === 'object' ? (x.note ?? x.text ?? '') : x;
  if (typeof a === 'string' && typeof b === 'string' && typeof c === 'string') {
    if (getTradeById(a, c)) return addTradeNoteCore(a, b, c);
    if (getTradeById(b, a)) {
      const res = addTradeNoteCore(b, c, a);
      if (!res.success) return res;
      return { success: true, trade: toLegacyView(res.trade) };
    }
    return addTradeNoteCore(a, b, c);
  }
  if (typeof b === 'string' && (c === undefined || typeof c !== 'object')) {
    const res = addTradeNoteCore(b, c, a);
    if (!res.success) return res;
    return { success: true, trade: toLegacyView(res.trade) };
  }
  const res = addTradeNoteCore(a, b, c);
  return res;
}

export function updateCurrentPrice(tradeId, price, user) {
  try {
    const src = price && typeof price === 'object' ? price : {};
    const clean = normalizeUser((src && (src.user ?? src.userId)) ?? user);
    if (!tradeId) return { success: false, error: 'Trade id is required' };
    const current = Number(price && typeof price === 'object' ? (price.price ?? price.currentPrice) : price);
    if (!Number.isFinite(current)) {
      return { success: false, error: `Invalid structure: price must be finite (got ${String(price)}).` };
    }
    const all = readRaw(clean);
    const idx = all.findIndex((t) => t && t.id === tradeId);
    if (idx === -1) return { success: false, error: `Trade not found: "${tradeId}"` };
    const trade = normalizeTrade(all[idx], clean);
    if (trade.status === 'CLOSED') {
      return { success: false, error: 'Trade is CLOSED: price ticks are only recorded on open trades.' };
    }
    const now = new Date().toISOString();
    const updated = normalizeTrade(
      {
        ...trade,
        events: [...trade.events, makeEvent('PRICE_UPDATE', clean, { price: current }, `Price tick ${current}`)],
        updatedAt: now,
      },
      clean,
    );
    all[idx] = updated;
    writeAll(clean, all);
    return { success: true, trade: updated };
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to record price' };
  }
}

// ---- Screenshot refs (ID-only; blobs live in IndexedDB) ----

// Attach/detach screenshot IDs on a trade. Entry/SL/TP/PnL/status are
// immutable here — only screenshotIds may change through this path.
// updateTrade(user, tradeId, updates). Tolerates updateTrade(tradeId, updates).
export function updateTrade(a, b, c) {
  try {
    let clean;
    let tradeId;
    let updates;
    if (c !== undefined) {
      clean = normalizeUser(a);
      tradeId = b;
      updates = c;
    } else {
      const d = b && typeof b === 'object' ? b : {};
      tradeId = a;
      updates = d;
      clean = normalizeUser(d.user ?? d.userId);
    }
    if (!tradeId) return { success: false, error: 'Trade id is required' };
    if (!clean) return { success: false, error: 'User is required' };
    const src = updates && typeof updates === 'object' && !Array.isArray(updates) ? updates : {};
    if (!Array.isArray(src.screenshotIds)) {
      return { success: false, error: 'updateTrade supports screenshotIds (array of screenshot ids)' };
    }
    const ids = [...new Set(src.screenshotIds.map(String).filter(Boolean))];
    const all = readRaw(clean);
    const idx = all.findIndex((t) => t && String(t.id) === String(tradeId));
    if (idx === -1) return { success: false, error: `Trade not found: "${tradeId}"` };
    const trade = normalizeTrade(all[idx], clean);
    const now = new Date().toISOString();
    const updated = normalizeTrade(
      {
        ...trade,
        screenshotIds: ids,
        events: [...trade.events, makeEvent('NOTE', clean, { screenshotIds: ids }, `Screenshots updated (${ids.length})`)],
        updatedAt: now,
      },
      clean,
    );
    all[idx] = updated;
    writeAll(clean, all);
    return { success: true, trade: updated };
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to update trade' };
  }
}

// ---- Balance ----

export function recalculateAccountBalance(user, accountId) {
  try {
    const clean = normalizeUser(user);
    if (!accountId) return { success: false, error: 'Account id is required' };
    const folders = readFolders(clean);
    const idx = folders.findIndex((f) => f && f.id === accountId);
    if (idx === -1) return { success: false, error: `Account not found: "${accountId}"` };

    const starting = toFinite(folders[idx].startingBalance, 0);
    let pnl = 0;
    for (const t of getExecutedTrades(clean, accountId)) {
      if (!t) continue;
      if (t.status === 'CLOSED') pnl += toFinite(t.pnl, 0);
      else if (t.status === 'PARTIALLY_CLOSED') pnl += toFinite(t.pnl, 0);
    }
    for (const t of legacyTradesFor(accountId)) {
      if (!t || typeof t !== 'object') continue;
      if (Number.isFinite(Number(t.pnl)) && (t.status === 'CLOSED' || t.type == null)) {
        pnl += Number(t.pnl);
        continue;
      }
      const amt = Number(t.amount);
      if (!Number.isFinite(amt)) continue;
      pnl += t.type === 'TP' ? Math.abs(amt) : -Math.abs(amt);
    }

    const balance = round2(starting + pnl);
    folders[idx] = { ...folders[idx], currentBalance: balance };
    writeFolders(clean, folders);
    return { success: true, balance };
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to recalculate balance' };
  }
}

export default {
  DEFAULT_TRADE,
  TRADE_STATUSES,
  CLOSE_REASONS,
  computePnl,
  calcTradePL,
  getExecutedTrades,
  getOpenTrades,
  getClosedTrades,
  getTradeById,
  getExecutedTrade,
  findSetupForTrade,
  executeSetup,
  closeTrade,
  updateSLTP,
  addTradeNote,
  updateTrade,
  updateCurrentPrice,
  updateTrade,
  recalculateAccountBalance,
};
