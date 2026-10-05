// ============================================
// Risk Analytics — historical risk analysis (READ-ONLY)
// Vanilla ESM, offline-first, deterministic. No Firebase import.
// Never modifies riskEngine.js, rules, or trading data: all reads go
// through canonical readers (tradingAnalytics dataset builders,
// executedTrades open-trade reader, ruleManager/propRules config).
// Money and R rounded to 2dp. No causal or psychological language.
// When the user configured no maximum risk, configured values are
// null with an explanatory note — never an invented limit.
// ============================================
import { getTradeDataset } from './tradingAnalytics.js';
import { getOpenTrades } from './executedTrades.js';
import { getRules } from './ruleManager.js';
import { getPropConfig } from './propRules.js';
import { toLocalISO } from './dayKey.js';

function round2(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function currentSessionUser() {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem('tradelog_session') || '';
  } catch {
    return '';
  }
}

function resolveUser(filters) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const explicit = normalizeUser(f.user ?? f.userId ?? '');
  if (explicit) return explicit;
  return normalizeUser(currentSessionUser());
}

function tradeOf(row) {
  if (row && typeof row === 'object' && !Array.isArray(row) && row.trade && typeof row.trade === 'object') {
    return row.trade;
  }
  return row && typeof row === 'object' ? row : {};
}

function closedRows(accountId, filters) {
  try {
    const rows = getTradeDataset(accountId, filters);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function tradeTimestamp(trade) {
  const t = trade && typeof trade === 'object' ? trade : {};
  return t.closedAt || t.openedAt || t.createdAt || '';
}

function localDayOf(timestamp) {
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return toLocalISO(d) || '';
  } catch {
    return '';
  }
}

// Configured maximum risk percent, when the user defined one:
// - strictest enabled PERCENTAGE_LIMIT rule (operator <= or <), or
// - prop max_risk_per_trade limit expressed against starting balance.
// Returns { value: number|null, note: string|null }.
function configuredMax(accountId, filters) {
  const user = resolveUser(filters);
  const candidates = [];
  try {
    const rules = getRules(user) || [];
    for (const r of rules) {
      if (!r || typeof r !== 'object') continue;
      if (String(r.type || '').trim().toUpperCase() !== 'PERCENTAGE_LIMIT') continue;
      if (r.enabled === false) continue;
      const v = r.validation && typeof r.validation === 'object' ? r.validation : {};
      const op = String(v.operator ?? r.operator ?? '<=').trim();
      if (op !== '<=' && op !== '<') continue;
      const val = Number(v.value ?? r.value);
      if (Number.isFinite(val) && val > 0) candidates.push(val);
    }
  } catch {
    // No rules available — fall through to prop config.
  }
  try {
    const config = getPropConfig(accountId, user);
    const start = Number(config && config.startingBalance);
    const rules = (config && Array.isArray(config.rules)) ? config.rules : [];
    const rule = rules.find((r) => r && r.id === 'max_risk_per_trade');
    if (rule && rule.enabled !== false) {
      const limit = Number(rule.limit);
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(start) && start > 0) {
        candidates.push((limit / start) * 100);
      }
    }
  } catch {
    // No prop config available — ignore.
  }
  if (candidates.length === 0) {
    return { value: null, note: 'No configured maximum risk found in rules or prop config.' };
  }
  return { value: round2(Math.min(...candidates)), note: null };
}

function startingBalanceFor(accountId, user) {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(`tradelog_folders_${normalizeUser(user)}`);
      const folders = raw == null ? [] : JSON.parse(raw);
      if (Array.isArray(folders)) {
        const folder = folders.find((f) => f && f.id === accountId);
        const start = folder ? Number(folder.startingBalance) : NaN;
        if (Number.isFinite(start)) return start;
      }
    }
  } catch {
    // Fall through to prop config.
  }
  try {
    const config = getPropConfig(accountId, user);
    const start = Number(config && config.startingBalance);
    if (Number.isFinite(start)) return start;
  } catch {
    // Unknown baseline.
  }
  return 0;
}

function riskPercentOf(trade) {
  const v = Number(trade && trade.riskPercent);
  return Number.isFinite(v) ? Math.abs(v) : null;
}

function riskAmountOf(trade) {
  const v = Number(trade && trade.riskAmount);
  return Number.isFinite(v) ? Math.abs(v) : null;
}

function pnlOf(trade) {
  return toFinite(trade && trade.pnl, 0);
}

const RISK_BINS = [
  { label: '0–0.25%', min: 0, max: 0.25 },
  { label: '0.25–0.50%', min: 0.25, max: 0.5 },
  { label: '0.50–1.00%', min: 0.5, max: 1.0 },
  { label: '1.00–2.00%', min: 1.0, max: 2.0 },
  { label: '>2.00%', min: 2.0, max: Infinity },
];

function binIndexFor(riskPercent) {
  if (riskPercent < 0.25) return 0;
  if (riskPercent < 0.5) return 1;
  if (riskPercent < 1.0) return 2;
  if (riskPercent < 2.0) return 3;
  return 4;
}

function buildDrawdownSeries(rows, startingBalance) {
  let running = toFinite(startingBalance, 0);
  let peak = running;
  return rows.map((row) => {
    const trade = tradeOf(row);
    running = round2(running + pnlOf(trade));
    if (running > peak) peak = running;
    const drawdown = round2(Math.max(0, peak - running));
    return {
      timestamp: tradeTimestamp(trade),
      balance: running,
      peak: round2(peak),
      drawdown,
      drawdownPercent: peak > 0 ? round2((drawdown / peak) * 100) : null,
    };
  });
}

function streaks(rows) {
  let longestWin = 0;
  let currentWin = 0;
  let longestLoss = 0;
  let currentLoss = 0;
  for (const row of rows) {
    const pnl = pnlOf(tradeOf(row));
    if (pnl > 0) {
      currentWin += 1;
      currentLoss = 0;
      if (currentWin > longestWin) longestWin = currentWin;
    } else if (pnl < 0) {
      currentLoss += 1;
      currentWin = 0;
      if (currentLoss > longestLoss) longestLoss = currentLoss;
    } else {
      currentWin = 0;
      currentLoss = 0;
    }
  }
  return { longestWin, currentWin, longestLoss, currentLoss };
}

export function getRiskDistribution(accountId, filters = {}) {
  const rows = closedRows(accountId, filters);
  const counts = [0, 0, 0, 0, 0];
  for (const row of rows) {
    const rp = riskPercentOf(tradeOf(row));
    if (rp === null) continue;
    counts[binIndexFor(rp)] += 1;
  }
  const bins = [];
  for (let i = 0; i < RISK_BINS.length; i += 1) {
    if (counts[i] > 0) {
      bins.push({
        label: RISK_BINS[i].label,
        min: RISK_BINS[i].min,
        max: Number.isFinite(RISK_BINS[i].max) ? RISK_BINS[i].max : null,
        count: counts[i],
      });
    }
  }
  const cfg = configuredMax(accountId, filters);
  return {
    bins,
    sampleSize: rows.length,
    configuredMaxRiskPercent: cfg.value,
  };
}

export function getAverageRisk(accountId, filters = {}) {
  const rows = closedRows(accountId, filters);
  const vals = [];
  for (const row of rows) {
    const rp = riskPercentOf(tradeOf(row));
    if (rp !== null) vals.push(rp);
  }
  if (vals.length === 0) {
    return { averageRiskPercent: null, sampleSize: rows.length };
  }
  return {
    averageRiskPercent: round2(vals.reduce((a, b) => a + b, 0) / vals.length),
    sampleSize: rows.length,
  };
}

export function getMaxRisk(accountId, filters = {}) {
  const rows = closedRows(accountId, filters);
  let best = null;
  let bestId = null;
  for (const row of rows) {
    const trade = tradeOf(row);
    const rp = riskPercentOf(trade);
    if (rp === null) continue;
    if (best === null || rp > best) {
      best = rp;
      bestId = trade && trade.id != null ? String(trade.id) : null;
    }
  }
  if (best === null) {
    return { maxRiskPercent: null, tradeId: null, sampleSize: rows.length };
  }
  return { maxRiskPercent: round2(best), tradeId: bestId, sampleSize: rows.length };
}

export function getRiskViolations(accountId, filters = {}) {
  const rows = closedRows(accountId, filters);
  const cfg = configuredMax(accountId, filters);
  if (cfg.value === null) {
    return {
      violations: [],
      count: 0,
      sampleSize: rows.length,
      configuredMax: null,
      note: cfg.note,
    };
  }
  const violations = [];
  for (const row of rows) {
    const trade = tradeOf(row);
    const rp = riskPercentOf(trade);
    if (rp === null) continue;
    if (rp > cfg.value) {
      violations.push({
        tradeId: trade && trade.id != null ? String(trade.id) : '',
        riskPercent: round2(rp),
        configuredMax: cfg.value,
        excess: round2(rp - cfg.value),
      });
    }
  }
  return {
    violations,
    count: violations.length,
    sampleSize: rows.length,
    configuredMax: cfg.value,
  };
}

export function getDrawdownSeries(accountId, filters = {}) {
  const rows = closedRows(accountId, filters);
  const startingBalance = startingBalanceFor(accountId, resolveUser(filters));
  if (rows.length === 0) {
    return { series: [], sampleSize: 0, startingBalance: round2(startingBalance) };
  }
  return {
    series: buildDrawdownSeries(rows, startingBalance),
    sampleSize: rows.length,
    startingBalance: round2(startingBalance),
  };
}

export function getMaxObservedDrawdown(accountId, filters = {}) {
  const rows = closedRows(accountId, filters);
  const startingBalance = startingBalanceFor(accountId, resolveUser(filters));
  if (rows.length === 0) {
    return {
      maxDrawdown: 0,
      maxDrawdownPercent: null,
      peak: round2(startingBalance),
      sampleSize: 0,
    };
  }
  const series = buildDrawdownSeries(rows, startingBalance);
  let maxDrawdown = 0;
  let maxDrawdownPercent = null;
  let peak = round2(startingBalance);
  for (const point of series) {
    if (point.peak > peak) peak = point.peak;
    if (point.drawdown > maxDrawdown) {
      maxDrawdown = point.drawdown;
      maxDrawdownPercent = point.drawdownPercent;
    }
  }
  return {
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPercent,
    peak: round2(peak),
    sampleSize: rows.length,
  };
}

export function getConsecutiveLosses(accountId, filters = {}) {
  const rows = closedRows(accountId, filters);
  const s = streaks(rows);
  return {
    longestLossStreak: s.longestLoss,
    currentLossStreak: s.currentLoss,
    sampleSize: rows.length,
  };
}

export function getConsecutiveWins(accountId, filters = {}) {
  const rows = closedRows(accountId, filters);
  const s = streaks(rows);
  return {
    longestWinStreak: s.longestWin,
    currentWinStreak: s.currentWin,
    sampleSize: rows.length,
  };
}

export function getDailyRiskStats(accountId, filters = {}) {
  const rows = closedRows(accountId, filters);
  if (rows.length === 0) {
    return { days: [], sampleSize: 0 };
  }
  const user = resolveUser(filters);
  let openByDay = null;
  try {
    const open = getOpenTrades(user, accountId) || [];
    openByDay = new Map();
    for (const t of open) {
      const day = localDayOf(t && (t.openedAt || t.createdAt));
      if (!day) continue;
      const amt = riskAmountOf(t);
      if (amt === null) continue;
      openByDay.set(day, round2((openByDay.get(day) || 0) + amt));
    }
  } catch {
    openByDay = null;
  }
  const byDay = new Map();
  for (const row of rows) {
    const trade = tradeOf(row);
    const day = localDayOf(tradeTimestamp(trade));
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(trade);
  }
  const days = [...byDay.keys()].sort().map((dateISO) => {
    const trades = byDay.get(dateISO);
    let planned = 0;
    let realized = 0;
    let loss = 0;
    let largest = null;
    for (const t of trades) {
      const amt = riskAmountOf(t);
      if (amt !== null) {
        planned = round2(planned + amt);
        if (largest === null || amt > largest) largest = amt;
      }
      const pnl = pnlOf(t);
      realized = round2(realized + pnl);
      if (pnl < 0) loss = round2(loss + Math.abs(pnl));
    }
    return {
      dateISO,
      trades: trades.length,
      plannedRisk: round2(planned),
      realizedPnl: round2(realized),
      realizedLoss: round2(loss),
      largestSingleRisk: largest === null ? null : round2(largest),
      openRiskIfAvailable: openByDay !== null && openByDay.has(dateISO) ? openByDay.get(dateISO) : null,
    };
  });
  return { days, sampleSize: rows.length };
}

export default {
  getRiskDistribution,
  getAverageRisk,
  getMaxRisk,
  getRiskViolations,
  getDrawdownSeries,
  getMaxObservedDrawdown,
  getConsecutiveLosses,
  getConsecutiveWins,
  getDailyRiskStats,
};
