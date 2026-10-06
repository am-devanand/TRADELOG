// Phase 9B gate suite: determinism + canonical strategy vocabulary coverage.
// Determinism is a phase gate that must not regress; the canonical vocabulary
// (models.js STRATEGY_CONDITION_TYPES) is the contract strategyStore templates
// and the Builder UI rely on, so a template strategy must actually trade.
// Vanilla ESM, offline, no dependencies. Fixed epoch-ms candles, no clock.
import { test, ok, equal } from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const engine = await import('../src/js/utils/replayEngine.js');
const {
  runReplay,
  evaluateSetup,
  buildChecks,
  resolveEntry,
  resolveStops,
  resolveExit,
  simulateTrade,
  REPLAY_EXIT_REASONS,
} = engine;

const T0 = 1700000000000;
const HOUR = 3600000;

function r4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

// 96 fixed candles: four 24-bar segments with base 100/102/104/106 and a +2
// step at each segment start, so BREAKS_STRUCTURE(10) triggers repeatedly.
function buildBreakoutCandles() {
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

// Steady drift series: mostly bullish closes for CANDLE_CLOSE coverage.
function buildDriftCandles() {
  const candles = [];
  let price = 100;
  for (let i = 0; i < 84; i += 1) {
    const o = price;
    const c = r4(o + (i % 5 === 4 ? -0.4 : 0.5));
    candles.push({ t: T0 + i * HOUR, o: r4(o), h: r4(Math.max(o, c) + 0.1), l: r4(Math.min(o, c) - 0.1), c, v: 500 });
    price = c;
  }
  return candles;
}

const ACCOUNT = { balance: 10000, currency: 'USD', startingBalance: 10000 };

function breakoutStrategy() {
  return {
    id: 'breakout-v1',
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

function legacyStrategy() {
  return {
    id: 'legacy-v1',
    version: 2,
    symbol: 'EUR/USD',
    timeframe: 'H1',
    direction: 'LONG',
    conditions: [
      { id: 'trend', type: 'close_above_sma', period: 5 },
      { id: 'mom', type: 'higher_close', streak: 2 },
    ],
    stopLoss: { type: 'distance', value: 1.5 },
    takeProfit: { type: 'distance', value: 3 },
    riskPercent: 1,
  };
}

test('replay determinism: three identical runs are byte-identical', () => {
  const candles = buildBreakoutCandles();
  const strategy = breakoutStrategy();
  const a = runReplay({ candles, strategy, rules: [], account: ACCOUNT, options: {} });
  const b = runReplay({ candles, strategy, rules: [], account: ACCOUNT, options: {} });
  const c = runReplay({ candles, strategy, rules: [], account: ACCOUNT, options: {} });
  equal(JSON.stringify(a), JSON.stringify(b), 'run1 === run2');
  equal(JSON.stringify(b), JSON.stringify(c), 'run2 === run3');
  equal(a.runId, b.runId, 'runId stable');
});

test('replay run identity: strategy id/version and rule versions surfaced', () => {
  const candles = buildBreakoutCandles();
  const rules = [
    { id: 'rr-min', name: 'Min RR', type: 'RR_LIMIT', category: 'RISK', weight: 5, required: true, enabled: true, validation: { operator: '>=', value: 1 } },
  ];
  const r = runReplay({ candles, strategy: breakoutStrategy(), rules, account: ACCOUNT, options: {} });
  equal(r.strategyId, 'breakout-v1', 'strategyId');
  equal(r.strategyVersion, 1, 'strategyVersion');
  equal(r.ruleVersions.length, 1, 'one rule version');
  ok(r.ruleVersions[0].startsWith('rr-min@'), `rule version tag (${r.ruleVersions[0]})`);
  equal(r.symbol, 'EUR/USD', 'symbol');
  equal(r.timeframe, 'H1', 'timeframe');
});

test('canonical BREAKS_STRUCTURE: template-style setup produces entries', () => {
  const candles = buildBreakoutCandles();
  const r = runReplay({ candles, strategy: breakoutStrategy(), rules: [], account: ACCOUNT, options: {} });
  equal(r.runId, 'replay_c15c7a12', 'golden runId');
  equal(r.entries.length, 3, 'three simulated entries');
  for (const t of r.entries) {
    equal(t.status, 'SIMULATED', `${t.id} simulated`);
    equal(t.decisionState, 'READY', `${t.id} READY verdict`);
    equal(t.id, `${r.runId}::t${t.entryIndex}`, `${t.id} deterministic id`);
  }
});

test('canonical CANDLE_CLOSE and PRICE_ABOVE produce entries when warranted', () => {
  const candles = buildDriftCandles();
  const cc = runReplay({
    candles,
    strategy: {
      id: 'cc-v1', version: 1, symbol: 'EUR/USD', timeframe: 'H1', direction: 'LONG',
      entryConditions: [{ id: 'e', type: 'CANDLE_CLOSE', params: { direction: 'BULLISH' } }],
      stopLoss: { type: 'distance', value: 1 }, takeProfit: { type: 'distance', value: 2 },
      maxHoldCandles: 5, riskPercent: 1,
    },
    rules: [], account: ACCOUNT, options: {},
  });
  ok(cc.entries.length > 0, `CANDLE_CLOSE entries (${cc.entries.length})`);
  const pa = runReplay({
    candles: buildBreakoutCandles(),
    strategy: {
      id: 'pa-v1', version: 1, symbol: 'EUR/USD', timeframe: 'H1', direction: 'LONG',
      entryConditions: [{ id: 'e', type: 'PRICE_ABOVE', params: { level: 101 } }],
      stopLoss: { type: 'distance', value: 2 }, takeProfit: { type: 'distance', value: 4 },
      maxHoldCandles: 6, riskPercent: 1,
    },
    rules: [], account: ACCOUNT, options: {},
  });
  ok(pa.entries.length > 0, `PRICE_ABOVE entries (${pa.entries.length})`);
});

test('canonical CROSS_UP / CROSS_DOWN / TOUCHES_LEVEL / INSIDE_RANGE evaluate', () => {
  const candles = buildBreakoutCandles();
  const cross = evaluateSetup({
    candles, cursor: 24,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'x', type: 'CROSS_UP', params: { level: 101 } }] },
  });
  equal(cross.pass, true, 'CROSS_UP fires on the step bar');
  ok(cross.checks[0].reason.includes('101'), `reason names the level (${cross.checks[0].reason})`);
  const touch = evaluateSetup({
    candles, cursor: 24,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'x', type: 'TOUCHES_LEVEL', params: { level: 102.5 } }] },
  });
  equal(touch.pass, true, 'TOUCHES_LEVEL fires when the range covers the level');
  const inside = evaluateSetup({
    candles, cursor: 24,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'x', type: 'INSIDE_RANGE', params: { low: 100, high: 103 } }] },
  });
  equal(inside.pass, true, 'INSIDE_RANGE fires inside the band');
  const below = evaluateSetup({
    candles, cursor: 10,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'x', type: 'PRICE_BELOW', params: { level: 101 } }] },
  });
  equal(below.pass, true, 'PRICE_BELOW fires below the level');
  const htf = evaluateSetup({
    candles, cursor: 30,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'x', type: 'HTF_BIAS', params: { period: 5, direction: 'up' } }] },
  });
  equal(htf.pass, true, 'HTF_BIAS up fires on rising SMA');
});

test('canonical CUSTOM: caller-supplied boolean used, otherwise never passes', () => {
  const candles = buildBreakoutCandles();
  const yes = evaluateSetup({
    candles, cursor: 30,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'x', type: 'CUSTOM', params: { result: true } }] },
  });
  equal(yes.pass, true, 'CUSTOM result:true passes');
  ok(yes.checks[0].reason.includes('supplied by caller'), 'reason labelled supplied by caller');
  const bare = evaluateSetup({
    candles, cursor: 30,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'x', type: 'CUSTOM', params: {} }] },
  });
  equal(bare.pass, false, 'bare CUSTOM never passes');
  ok(bare.checks[0].reason.includes('not auto-evaluated'), 'reason states no auto-evaluation');
  const run = runReplay({
    candles,
    strategy: { id: 'custom-v1', version: 1, direction: 'LONG', entryConditions: [{ id: 'x', type: 'CUSTOM', params: {} }] },
    rules: [], account: ACCOUNT, options: {},
  });
  equal(run.entries.length, 0, 'bare CUSTOM yields zero entries');
});

test('canonical type matching tolerates kebab-case and lowercase', () => {
  const candles = buildBreakoutCandles();
  const kebab = evaluateSetup({
    candles, cursor: 30,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'x', type: 'price-above', params: { level: 101 } }] },
  });
  equal(kebab.pass, true, 'kebab price-above matches');
  const lower = evaluateSetup({
    candles, cursor: 30,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'x', type: 'candle_close', params: { direction: 'bullish' } }] },
  });
  ok(typeof lower.pass === 'boolean', 'lowercase candle_close evaluates without throwing');
});

test('missing params fail with a clear reason and never crash the run', () => {
  const candles = buildBreakoutCandles();
  const bad = evaluateSetup({
    candles, cursor: 30,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'lvl', type: 'PRICE_ABOVE', params: {} }] },
  });
  equal(bad.pass, false, 'missing level fails');
  ok(bad.checks[0].reason.includes('level'), `reason names the problem (${bad.checks[0].reason})`);
  const run = runReplay({
    candles,
    strategy: { id: 'bad-v1', version: 1, direction: 'LONG', entryConditions: [{ id: 'lvl', type: 'PRICE_ABOVE', params: {} }] },
    rules: [], account: ACCOUNT, options: {},
  });
  equal(run.entries.length, 0, 'no entries from unevaluable condition');
  ok(typeof run.summary.noTradeReason === 'string' && run.summary.noTradeReason.length > 0, 'explicit no-trade reason');
  const inverted = evaluateSetup({
    candles, cursor: 30,
    strategy: { direction: 'LONG', entryConditions: [{ id: 'x', type: 'INSIDE_RANGE', params: { high: 90, low: 100 } }] },
  });
  equal(inverted.pass, false, 'inverted range fails');
});

test('exits: SL hit is negative rMultiple, TP hit positive, END_OF_DATA otherwise', () => {
  const t = T0;
  const mk = (o, h, l, c, i) => ({ t: t + i * HOUR, o, h, l, c, v: 10 });
  const entry = { entryIndex: 0, direction: 'LONG', entryPrice: 100, stopLoss: 99, takeProfit: 102 };
  const slExit = resolveExit({ candles: [mk(100, 100.5, 99.5, 100, 0), mk(100, 100.2, 98.5, 99, 1)], ...entry, strategy: {} });
  equal(slExit.reason, REPLAY_EXIT_REASONS.SL_HIT, 'SL exit reason');
  const slTrade = simulateTrade({
    runId: 'r1', entryIndex: 0, direction: 'LONG', entryPrice: 100, stopLoss: 99, takeProfit: 102,
    exit: slExit, strategy: { id: 's', version: 1 }, verdict: { state: 'READY', score: 100, passedRules: [] },
    account: ACCOUNT, riskPercent: 1, rules: [],
  });
  equal(slTrade.rMultiple, -1, 'SL gives rMultiple -1');
  const tpExit = resolveExit({ candles: [mk(100, 100.5, 99.5, 100, 0), mk(100, 102.5, 100, 102, 1)], ...entry, strategy: {} });
  equal(tpExit.reason, REPLAY_EXIT_REASONS.TP_HIT, 'TP exit reason');
  const tpTrade = simulateTrade({
    runId: 'r1', entryIndex: 0, direction: 'LONG', entryPrice: 100, stopLoss: 99, takeProfit: 102,
    exit: tpExit, strategy: { id: 's', version: 1 }, verdict: { state: 'READY', score: 100, passedRules: [] },
    account: ACCOUNT, riskPercent: 1, rules: [],
  });
  ok(tpTrade.rMultiple > 0, `TP gives positive rMultiple (${tpTrade.rMultiple})`);
  const eod = resolveExit({ candles: [mk(100, 100.5, 99.5, 100, 0), mk(100, 100.4, 99.6, 100.1, 1)], ...entry, strategy: {} });
  equal(eod.reason, REPLAY_EXIT_REASONS.END_OF_DATA, 'unhit levels give END_OF_DATA');
});

test('legacy snake_case strategies still produce identical results', () => {
  const candles = buildBreakoutCandles();
  const r = runReplay({ candles, strategy: legacyStrategy(), rules: [], account: ACCOUNT, options: {} });
  equal(r.runId, 'replay_5c38c048', 'legacy golden runId unchanged');
  equal(r.entries.length, 2, 'legacy entry count unchanged');
  const first = r.entries[0];
  equal(first.id, 'replay_5c38c048::t7', 'legacy first trade id');
  equal(first.entryPrice, 100.1, 'legacy entry price');
  equal(first.closeReason, 'TP_HIT', 'legacy exit reason');
  equal(first.rMultiple, 2, 'legacy rMultiple');
  equal(first.pnl, 200, 'legacy pnl');
  const setup = evaluateSetup({ candles, cursor: 6, strategy: legacyStrategy() });
  equal(setup.pass, true, 'legacy setup still triggers');
  const checks = buildChecks({
    strategy: legacyStrategy(), rules: [],
    context: { candles, cursor: 6, direction: 'LONG', riskReward: 2 },
  });
  ok(checks.trend.pass && checks.mom.pass, 'legacy buildChecks passes');
  const entry = resolveEntry({ candles, cursor: 6, strategy: legacyStrategy(), direction: 'LONG' });
  equal(entry.index, 7, 'legacy next-open entry');
  const stops = resolveStops({ candle: candles[6], entry: entry.price, direction: 'LONG', strategy: legacyStrategy() });
  ok(stops.stopLoss < entry.price && stops.takeProfit > entry.price, 'legacy stops on correct sides');
});

test('replay engine keeps its isolation boundary and determinism sources out', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, '..', 'src', 'js', 'utils', 'replayEngine.js'), 'utf8');
  const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  equal(specifiers.length, 2, 'exactly 2 import specifiers');
  ok(specifiers.includes('./decisionEngine.js'), 'imports decisionEngine');
  ok(specifiers.includes('./riskEngine.js'), 'imports riskEngine');
  for (const mod of ['executedTrades', 'propEngine', 'propRules', 'calendar', 'tradingAnalytics', 'riskAnalytics', 'performanceAttribution', 'storage', 'firebase']) {
    ok(!specifiers.some((s) => s.includes(mod)), `no import of ${mod}`);
  }
  ok(!src.includes('localStorage'), 'no localStorage reference');
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*'));
  });
  for (const banned of ['Date.now(', 'Math.random(', 'generateId(', 'new Date(']) {
    ok(!codeLines.some((l) => l.includes(banned)), `no ${banned} in code`);
  }
});

export async function run() {
  const helpers = await import('./helpers.js');
  return helpers.run();
}
