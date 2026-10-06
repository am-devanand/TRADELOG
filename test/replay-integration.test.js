// Engine -> store -> analytics integration: replay results must stay
// attributable to their run. The engine emits `runId` on every SIMULATED
// trade; replayStore scopes by `trade.runId`; replayAnalytics reads the store.
// Vanilla ESM, offline, fixed epoch-ms candles, no clock.
import { test, ok, equal, assertThrows } from './helpers.js';

const engine = await import('../src/js/utils/replayEngine.js');
const store = await import('../src/js/utils/replayStore.js');
const analytics = await import('../src/js/utils/replayAnalytics.js');

const { runReplay } = engine;
const { saveReplayRun, getReplayRun, saveSimulatedTrades, getSimulatedTrades } = store;
const { getReplaySummary, getReplayStatsByDimension, getDeterminismDigest } = analytics;

const USER = 'replay-integration';
const T0 = 1700000000000;
const HOUR = 3600000;

function r4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

// 96 fixed candles with real bodies: four 24-bar segments stepping +2, so a
// BREAKS_STRUCTURE(10) setup triggers repeatedly.
function buildCandles() {
  const candles = [];
  let price = 100;
  for (let i = 0; i < 96; i += 1) {
    const seg = Math.floor(i / 24);
    const baseSeg = 100 + seg * 2;
    const step = i % 24 === 0 && i > 0;
    const o = price;
    const c = step ? baseSeg + 0.5 : baseSeg + ((i % 4) - 1.5) * 0.2;
    const h = Math.max(o, c) + 0.15;
    const l = Math.min(o, c) - 0.15;
    candles.push({ t: T0 + i * HOUR, o: r4(o), h: r4(h), l: r4(l), c: r4(c), v: 1000 });
    price = c;
  }
  return candles;
}

const ACCOUNT = { balance: 10000, currency: 'USD', startingBalance: 10000 };

function breakoutStrategy() {
  return {
    id: 'breakout-int',
    version: 1,
    symbol: 'EUR/USD',
    timeframe: 'H1',
    direction: 'LONG',
    entryConditions: [{ id: 'entry-break', type: 'BREAKS_STRUCTURE', params: { lookback: 10 } }],
    stopLoss: { type: 'distance', value: 2 },
    takeProfit: { type: 'distance', value: 4 },
    maxHoldCandles: 6,
    riskPercent: 1,
  };
}

function persistRun(candles, run) {
  const savedRun = saveReplayRun(USER, {
    id: run.runId,
    strategyId: run.strategyId,
    strategyVersion: run.strategyVersion,
    ruleVersions: run.ruleVersions,
    symbol: run.symbol,
    timeframe: run.timeframe,
    candleRange: { from: candles[0].t, to: candles[candles.length - 1].t },
    barCount: run.barsProcessed,
    options: {},
    summary: run.summary,
    entryCount: run.entries.length,
    status: 'COMPLETED',
  });
  ok(savedRun.success, 'run persisted');
  const savedTrades = saveSimulatedTrades(USER, run.entries);
  equal(savedTrades.count, run.entries.length, 'all entries persisted');
  return run.runId;
}

test('integration: engine trades carry the run id used for store scoping', () => {
  const candles = buildCandles();
  ok(candles.length >= 90, 'series length >= 90');
  ok(candles.every((c) => c.o !== c.c), 'real bodies (open !== close)');
  const run = runReplay({ candles, strategy: breakoutStrategy(), rules: [], account: ACCOUNT, options: {} });
  ok(run.entries.length > 0, `strategy trades (${run.entries.length})`);
  for (const t of run.entries) {
    equal(t.runId, run.runId, `${t.id} carries runId`);
    equal(t.id, `${run.runId}::t${t.entryIndex}`, `${t.id} keeps deterministic id format`);
    equal(t.status, 'SIMULATED', `${t.id} simulated`);
  }
});

test('integration: stored trades round-trip by runId and summary matches', () => {
  const candles = buildCandles();
  const run = runReplay({ candles, strategy: breakoutStrategy(), rules: [], account: ACCOUNT, options: {} });
  ok(run.entries.length > 0, 'strategy trades');
  const runId = persistRun(candles, run);
  const stored = getSimulatedTrades(USER, runId);
  equal(stored.length, run.entries.length, 'getSimulatedTrades returns every entry');
  const summary = getReplaySummary(USER, runId);
  equal(summary.entries, run.entries.length, 'analytics entry count matches engine');
  ok(summary.winRate !== null, `winRate reported (${summary.winRate})`);
});

test('integration: exitReason dimension returns non-empty rows', () => {
  const candles = buildCandles();
  const run = runReplay({ candles, strategy: breakoutStrategy(), rules: [], account: ACCOUNT, options: {} });
  const runId = persistRun(candles, run);
  const rows = getReplayStatsByDimension(USER, runId, 'exitReason');
  ok(rows.length > 0, `exitReason rows non-empty (${rows.length})`);
  const counted = rows.reduce((a, r) => a + r.trades, 0);
  equal(counted, run.entries.length, 'dimension rows cover every entry');
});

test('integration: determinism digest is stable across calls', () => {
  const candles = buildCandles();
  const run = runReplay({ candles, strategy: breakoutStrategy(), rules: [], account: ACCOUNT, options: {} });
  const runId = persistRun(candles, run);
  const d1 = getDeterminismDigest(USER, runId);
  const d2 = getDeterminismDigest(USER, runId);
  ok(typeof d1 === 'string' && d1.length > 0, 'digest is a non-empty string');
  equal(d1, d2, 'digest stable across calls');
});

test('integration: store rejects non-SIMULATED trades', () => {
  const candles = buildCandles();
  const run = runReplay({ candles, strategy: breakoutStrategy(), rules: [], account: ACCOUNT, options: {} });
  ok(run.entries.length > 0, 'strategy trades');
  assertThrows(
    () => saveSimulatedTrades(USER, [{ ...run.entries[0], status: 'CLOSED' }]),
    'non-SIMULATED status refused',
  );
  assertThrows(
    () => saveSimulatedTrades(USER, [{ ...run.entries[0], status: 'OPEN' }]),
    'OPEN status refused',
  );
});

test('integration: SL_HIT is negative rMultiple, TP_HIT positive', () => {
  const mk = (o, h, l, c, i) => ({ t: T0 + i * HOUR, o, h, l, c, v: 10 });
  const slRun = runReplay({
    candles: [mk(100, 100.6, 99.9, 100.5, 0), mk(100.5, 100.7, 99.0, 99.2, 1), mk(99.2, 99.5, 98.8, 99.0, 2)],
    strategy: {
      id: 'sl-warrant', version: 1, symbol: 'EUR/USD', timeframe: 'H1', direction: 'LONG',
      entryConditions: [{ id: 'e', type: 'CANDLE_CLOSE', params: { direction: 'BULLISH' } }],
      stopLoss: { type: 'distance', value: 0.3 }, takeProfit: { type: 'distance', value: 5 }, riskPercent: 1,
    },
    rules: [], account: ACCOUNT, options: { maxTrades: 1 },
  });
  equal(slRun.entries.length, 1, 'SL-warranting run trades once');
  equal(slRun.entries[0].closeReason, 'SL_HIT', 'SL exit reason');
  equal(slRun.entries[0].rMultiple, -1, 'SL gives rMultiple -1');
  const tpRun = runReplay({
    candles: [mk(100, 100.6, 99.9, 100.5, 0), mk(100.5, 102.0, 100.4, 101.8, 1), mk(101.8, 102.1, 101.5, 102.0, 2)],
    strategy: {
      id: 'tp-warrant', version: 1, symbol: 'EUR/USD', timeframe: 'H1', direction: 'LONG',
      entryConditions: [{ id: 'e', type: 'CANDLE_CLOSE', params: { direction: 'BULLISH' } }],
      stopLoss: { type: 'distance', value: 0.3 }, takeProfit: { type: 'distance', value: 0.5 }, riskPercent: 1,
    },
    rules: [], account: ACCOUNT, options: { maxTrades: 1 },
  });
  equal(tpRun.entries.length, 1, 'TP-warranting run trades once');
  equal(tpRun.entries[0].closeReason, 'TP_HIT', 'TP exit reason');
  ok(tpRun.entries[0].rMultiple > 0, `TP gives positive rMultiple (${tpRun.entries[0].rMultiple})`);
});

export async function run() {
  const helpers = await import('./helpers.js');
  return helpers.run();
}
