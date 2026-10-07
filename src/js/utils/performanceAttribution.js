// ============================================
// Performance Attribution — per-dimension breakdowns
// Vanilla ESM, offline-first. No side effects on import.
// No network. No Firebase.
//
// All reads go through tradingAnalytics.js getTradeDataset
// (single source for filtering + dataset rows), and per-group
// metrics reuse getCoreMetrics — no duplicated filter/math here.
// Output carries no ranking or winner labels by design: the UI
// layer decides how to present leaders/laggards.
// ============================================
import { getTradeDataset, getCoreMetrics } from './tradingAnalytics.js';

export const DIMENSIONS = [
  'strategy',
  'setup',
  'pair',
  'session',
  'timeframe',
  'direction',
  'dayOfWeek',
];

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function byName(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

function blankToUnspecified(v) {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? 'Unspecified' : s;
}

function normalizeDirection(raw) {
  const d = String(raw ?? '').trim().toUpperCase();
  if (d === 'SHORT' || d === 'SELL' || d === 'S') return 'SHORT';
  if (d === 'LONG' || d === 'BUY' || d === 'B') return 'LONG';
  return 'Unspecified';
}

function weekdayName(trade) {
  const t = trade && typeof trade === 'object' ? trade : {};
  const raw = t.closedAt || t.openedAt || t.createdAt || '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return 'Unspecified';
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
}

function dimensionValueFor(trade, dimension) {
  const t = trade && typeof trade === 'object' ? trade : {};
  switch (dimension) {
    case 'strategy':
      return blankToUnspecified(t.strategyId ?? t.strategy);
    case 'setup':
      return blankToUnspecified(t.setupType ?? t.setupId ?? t.setup);
    case 'pair':
      return blankToUnspecified(t.pair);
    case 'session':
      return blankToUnspecified(t.session);
    case 'timeframe':
      return blankToUnspecified(t.timeframe);
    case 'direction':
      return normalizeDirection(t.direction);
    case 'dayOfWeek':
      return weekdayName(trade);
    default:
      return 'Unspecified';
  }
}

// Shape one attribution row from a group's dataset rows via the shared
// core metrics (winRate/totalPnl/totalR/avgR/avgProcessScore/sampleSize).
function toAttributionRow(dimensionValue, rows) {
  const m = getCoreMetrics(rows);
  return {
    dimensionValue,
    trades: m.totalTrades,
    pnl: m.totalPnl,
    totalR: m.totalR,
    averageR: m.avgR,
    winRate: m.winRate,
    processScore: m.avgProcessScore,
    sampleSize: m.sampleSize,
  };
}

function groupDataset(accountId, dimension, filters = {}) {
  const dataset = getTradeDataset(accountId, filters);
  const groups = new Map();
  for (const row of dataset) {
    const trade = row && typeof row === 'object' && 'trade' in row ? row.trade : row;
    const key = dimensionValueFor(trade, dimension);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

/** Dimensions supported by getAttribution (fresh copy each call). */
export function getAttributionDimensions() {
  return [...DIMENSIONS];
}

/**
 * Resolve one trade's bucket for a dimension. Exported so other layers
 * (degradation intelligence) group by the same mapping instead of
 * reimplementing it. Unknown dimensions yield 'Unspecified'.
 */
export function getDimensionValue(trade, dimension) {
  return dimensionValueFor(trade, dimension);
}

/**
 * Attribution breakdown for one dimension. Only values actually present
 * in the filtered dataset appear; rows sort alphabetically by value.
 */
export function getAttribution(accountId, dimension, filters = {}) {
  if (!DIMENSIONS.includes(dimension)) return [];
  const groups = groupDataset(accountId, dimension, filters);
  return [...groups.keys()]
    .sort(byName)
    .map((key) => toAttributionRow(key, groups.get(key)));
}

/** LONG vs SHORT breakdown (same row shape; sides present in data only). */
export function getLongVsShort(accountId, filters = {}) {
  const groups = groupDataset(accountId, 'direction', filters);
  const out = [];
  for (const side of ['LONG', 'SHORT']) {
    if (groups.has(side)) out.push(toAttributionRow(side, groups.get(side)));
  }
  return out;
}

/**
 * Monday..Friday stats for days present in data, in weekday order.
 * Weekend trades (if any) are out of scope for this view, not re-bucketed.
 */
export function getDayOfWeekStats(accountId, filters = {}) {
  const groups = groupDataset(accountId, 'dayOfWeek', filters);
  const out = [];
  for (const day of DAY_ORDER) {
    if (!groups.has(day)) continue;
    const row = toAttributionRow(day, groups.get(day));
    out.push({
      day,
      trades: row.trades,
      pnl: row.pnl,
      totalR: row.totalR,
      processScore: row.processScore,
      sampleSize: row.sampleSize,
    });
  }
  return out;
}

/** Attribution for every dimension, keyed by dimension name. */
export function getAllAttributions(accountId, filters = {}) {
  const out = {};
  for (const dimension of DIMENSIONS) {
    out[dimension] = getAttribution(accountId, dimension, filters);
  }
  return out;
}

export default {
  DIMENSIONS,
  getAttribution,
  getAttributionDimensions,
  getLongVsShort,
  getDayOfWeekStats,
  getAllAttributions,
};
