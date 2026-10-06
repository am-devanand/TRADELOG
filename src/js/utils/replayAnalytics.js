// ============================================
// Replay Analytics — read-only metrics over SIMULATED replay trades
// Vanilla ESM, offline-first, deterministic. No side effects on import.
// No network. No Firebase import.
//
// ISOLATION BOUNDARY: replay results are SIMULATED and must never feed real
// trades, account balance, prop state, calendar, reviews, or real-trade
// analytics. This module reads simulation output only (replayStore.js) and
// never imports executedTrades.js, propEngine.js, calendar.js,
// tradingAnalytics.js, storage.js, or firebase.js. Conventions for
// null-vs-zero, sampleSize, and profitFactor mirror the existing analytics
// engine without importing it: empty or undefined aggregates are null
// (never Infinity or NaN), counts of zero stay numeric zero, and every
// aggregate carries sampleSize. Labels are descriptive only; no ranking,
// no winner labels, no causal claims.
// ============================================
import { getReplayRun, getSimulatedTrades } from './replayStore.js';

function round2(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function meanOrNull(vals) {
  if (!Array.isArray(vals) || vals.length === 0) return null;
  return round2(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function medianOrNull(vals) {
  if (!Array.isArray(vals) || vals.length === 0) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return round2(sorted[mid]);
  return round2((sorted[mid - 1] + sorted[mid]) / 2);
}

function profitFactorOrNull(pnls) {
  if (!Array.isArray(pnls) || pnls.length === 0) return null;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const pnl of pnls) {
    if (pnl > 0) grossProfit += pnl;
    else if (pnl < 0) grossLoss += Math.abs(pnl);
  }
  if (grossLoss === 0) return null;
  return round2(grossProfit / grossLoss);
}

function pnlOf(trade) {
  const t = trade && typeof trade === 'object' ? trade : {};
  return toFinite(t.pnl ?? t.realizedPnl, 0);
}

function rOf(trade) {
  const t = trade && typeof trade === 'object' ? trade : {};
  return toFinite(t.rMultiple ?? t.realizedR ?? t.r, 0);
}

function holdCandlesOf(trade) {
  const t = trade && typeof trade === 'object' ? trade : {};
  const candidates = [t.holdCandles, t.holdBars, t.candlesHeld, t.barsHeld, t.holdingCandles, t.candles];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function riskPercentOf(trade) {
  const t = trade && typeof trade === 'object' ? trade : {};
  const n = Number(t.riskPercent);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

function tradeTimestamp(trade) {
  const t = trade && typeof trade === 'object' ? trade : {};
  return t.closedAt || t.openedAt || t.createdAt || '';
}

function sortTradesDeterministic(trades) {
  return [...trades].sort((a, b) => {
    const ta = Date.parse(tradeTimestamp(a));
    const tb = Date.parse(tradeTimestamp(b));
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na !== nb) return na ? 1 : -1;
    if (!na && ta !== tb) return ta - tb;
    const ia = String((a && a.id) ?? '');
    const ib = String((b && b.id) ?? '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

function simulatedOnly(trades) {
  const list = Array.isArray(trades) ? trades : [];
  return list.filter((t) => t && typeof t === 'object' && t.status === 'SIMULATED');
}

function loadRunTrades(user, runId) {
  let trades = [];
  try {
    trades = getSimulatedTrades(user, runId) || [];
  } catch {
    trades = [];
  }
  return sortTradesDeterministic(simulatedOnly(trades));
}

function buildSummary(trades) {
  const entries = trades.length;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalPnl = 0;
  let totalR = 0;
  const rVals = [];
  const pnls = [];
  const holds = [];
  for (const t of trades) {
    const pnl = pnlOf(t);
    const r = rOf(t);
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;
    else breakeven += 1;
    totalPnl += pnl;
    totalR += r;
    rVals.push(r);
    pnls.push(pnl);
    const hold = holdCandlesOf(t);
    if (hold !== null) holds.push(hold);
  }
  totalPnl = round2(totalPnl);
  totalR = round2(totalR);
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    running = round2(running + pnl);
    if (running > peak) peak = running;
    const dd = round2(Math.max(0, peak - running));
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  maxDrawdown = round2(maxDrawdown);
  return {
    entries,
    wins,
    losses,
    breakeven,
    winRate: entries === 0 ? null : round2((wins / entries) * 100),
    totalR,
    averageR: entries === 0 ? null : round2(totalR / entries),
    medianR: medianOrNull(rVals),
    bestR: rVals.length === 0 ? null : round2(Math.max(...rVals)),
    worstR: rVals.length === 0 ? null : round2(Math.min(...rVals)),
    totalPnl,
    profitFactor: profitFactorOrNull(pnls),
    maxDrawdown,
    maxDrawdownPercent: peak > 0 ? round2((maxDrawdown / peak) * 100) : null,
    averageHoldCandles: meanOrNull(holds),
    sampleSize: entries,
  };
}

export function getReplaySummary(user, runId) {
  return buildSummary(loadRunTrades(user, runId));
}

const REPLAY_DIMENSIONS = ['strategy', 'strategyVersion', 'symbol', 'timeframe', 'exitReason'];

function dimensionValueOf(trade, dimension) {
  const t = trade && typeof trade === 'object' ? trade : {};
  let raw;
  if (dimension === 'strategy') raw = t.strategyId ?? t.strategy;
  else if (dimension === 'strategyVersion') raw = t.strategyVersion;
  else if (dimension === 'symbol') raw = t.symbol ?? t.pair;
  else if (dimension === 'timeframe') raw = t.timeframe;
  else raw = t.exitReason ?? t.closeReason ?? t.exitType;
  const s = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  return s === '' ? 'Unspecified' : s;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function getReplayStatsByDimension(user, runId, dimension) {
  if (!REPLAY_DIMENSIONS.includes(dimension)) {
    throw new Error(`Unknown replay dimension "${String(dimension)}". Use one of: ${REPLAY_DIMENSIONS.join(', ')}.`);
  }
  const trades = loadRunTrades(user, runId);
  const groups = new Map();
  for (const t of trades) {
    const key = dimensionValueOf(t, dimension);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.keys()].sort(compareStrings).map((dimensionValue) => {
    const rows = groups.get(dimensionValue);
    let wins = 0;
    let totalPnl = 0;
    let totalR = 0;
    for (const t of rows) {
      if (pnlOf(t) > 0) wins += 1;
      totalPnl += pnlOf(t);
      totalR += rOf(t);
    }
    totalPnl = round2(totalPnl);
    totalR = round2(totalR);
    return {
      dimensionValue,
      trades: rows.length,
      winRate: rows.length === 0 ? null : round2((wins / rows.length) * 100),
      totalR,
      averageR: rows.length === 0 ? null : round2(totalR / rows.length),
      pnl: totalPnl,
      sampleSize: rows.length,
    };
  });
}

const REPLAY_RISK_BINS = [
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

export function getRiskDistribution(user, runId) {
  const trades = loadRunTrades(user, runId);
  const counts = [0, 0, 0, 0, 0];
  for (const t of trades) {
    const rp = riskPercentOf(t);
    if (rp === null) continue;
    counts[binIndexFor(rp)] += 1;
  }
  const bins = [];
  for (let i = 0; i < REPLAY_RISK_BINS.length; i += 1) {
    if (counts[i] > 0) {
      bins.push({
        label: REPLAY_RISK_BINS[i].label,
        min: REPLAY_RISK_BINS[i].min,
        max: Number.isFinite(REPLAY_RISK_BINS[i].max) ? REPLAY_RISK_BINS[i].max : null,
        count: counts[i],
      });
    }
  }
  return { bins, sampleSize: trades.length };
}

function diffOrNull(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return round2(x - y);
}

export function compareReplays(user, runIds) {
  const ids = Array.isArray(runIds) ? runIds.map((id) => String(id)) : [];
  if (ids.length === 0) throw new Error('compareReplays requires a non-empty array of run ids.');
  const baselineRunId = ids[0];
  const baseline = buildSummary(loadRunTrades(user, baselineRunId));
  const rows = ids.map((runId) => {
    const summary = runId === baselineRunId ? baseline : buildSummary(loadRunTrades(user, runId));
    return {
      runId,
      ...summary,
      deltaVsBaseline: {
        entries: summary.entries - baseline.entries,
        totalR: diffOrNull(summary.totalR, baseline.totalR),
        totalPnl: diffOrNull(summary.totalPnl, baseline.totalPnl),
        winRate: diffOrNull(summary.winRate, baseline.winRate),
      },
    };
  });
  return { baselineRunId, rows };
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'number' || type === 'boolean') return JSON.stringify(value);
  if (type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (type === 'object') {
    const keys = Object.keys(value).sort(compareStrings);
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const VOLATILE_DIGEST_KEYS = new Set(['id', 'userId', 'runId', 'createdAt', 'updatedAt']);

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map((v) => stripVolatile(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (VOLATILE_DIGEST_KEYS.has(k)) continue;
      out[k] = stripVolatile(value[k]);
    }
    return out;
  }
  return value;
}

export function getDeterminismDigest(user, runId) {
  let run = null;
  try {
    run = getReplayRun(user, runId) || null;
  } catch {
    run = null;
  }
  const r = run && typeof run === 'object' ? run : {};
  const inputs = stripVolatile({
    strategyId: r.strategyId ?? '',
    strategyVersion: r.strategyVersion ?? '',
    ruleVersions: r.ruleVersions ?? [],
    symbol: r.symbol ?? '',
    timeframe: r.timeframe ?? '',
    candleRange: r.candleRange ?? { from: '', to: '' },
    barCount: Number.isFinite(Number(r.barCount)) ? Number(r.barCount) : 0,
    options: r.options && typeof r.options === 'object' ? r.options : {},
    status: r.status ?? '',
  });
  const trades = loadRunTrades(user, runId).map((t) => stripVolatile(t));
  const tradeStrings = trades.map((t) => stableStringify(t)).sort(compareStrings);
  const canonical = stableStringify({ inputs, trades: tradeStrings });
  return cyrb53(canonical).toString(16);
}

export default {
  getReplaySummary,
  getReplayStatsByDimension,
  getRiskDistribution,
  compareReplays,
  getDeterminismDigest,
};
