import { test, ok, equal, deepEqual, assertNoMutation } from './helpers.js';

const degradation = await import('../src/js/utils/degradationEngine.js');
const perf = await import('../src/js/utils/performanceAttribution.js');

const {
  DEGRADATION_STATES,
  detectDegradation,
  orderRows,
  splitWindows,
  metricVerdict,
  aggregateState,
} = degradation;

const floor = 5;

let clock = 0;
function row({ id, outcome, strategyId = 'S1', r = outcome === 'WIN' ? 1 : -1, pair = 'EUR/USD' }) {
  clock += 3600000;
  const pnl = r * 100;
  return {
    trade: {
      id, strategyId, pair,
      openedAt: new Date(clock).toISOString(),
      closedAt: new Date(clock + 60000).toISOString(),
      pnl, rMultiple: r,
    },
    review: null,
    outcome,
    pnl,
    r,
    processScore: null,
    reviewed: false,
  };
}

/** n trades where `earlyWins` of the first half are winners and the rest losers. */
function series({ prefix, count, earlyWins, lateWins }) {
  const half = count / 2;
  const out = [];
  for (let i = 0; i < count; i++) {
    const firstHalf = i < half;
    const local = firstHalf ? i : i - half;
    const wins = firstHalf ? earlyWins : lateWins;
    out.push(row({ id: `${prefix}-${i}`, outcome: local < wins ? 'WIN' : 'LOSS' }));
  }
  return out;
}

test('states: the declared vocabulary includes every state the engine can emit', () => {
  for (const state of ['IMPROVING', 'DEGRADING', 'WATCH', 'STABLE', 'INSUFFICIENT_DATA']) {
    ok(DEGRADATION_STATES.includes(state), `${state} declared`);
  }
});

test('ordering: is deterministic, NaN timestamps last, ties broken by trade id', () => {
  const a = row({ id: 'b', outcome: 'WIN' });
  const b = row({ id: 'a', outcome: 'WIN' });
  const undated = { trade: { id: 'zz', pnl: 0, rMultiple: 0 }, outcome: 'WIN', pnl: 0, r: 0 };
  a.trade.closedAt = b.trade.closedAt = '';
  b.trade.openedAt = a.trade.openedAt = '2024-01-01T00:00:00.000Z';

  const ordered = orderRows([a, undated, b]);
  equal(ordered[0].trade.id, 'a', 'tie on timestamp resolved by id');
  equal(ordered[1].trade.id, 'b');
  equal(ordered[2].trade.id, 'zz', 'undated rows sort last');
  deepEqual(orderRows([a, undated, b]).map((r) => r.trade.id), ordered.map((r) => r.trade.id));
});

test('windows: two equal-sized windows, and refusal when the group is too small', () => {
  const rows = series({ prefix: 'w', count: 20, earlyWins: 10, lateWins: 10 });
  const split = splitWindows(rows, floor);
  ok(split.sufficient);
  equal(split.historical.length, split.recent.length, 'windows are equal size');
  equal(split.recent[0].trade.id, 'w-10', 'recent is the later half');

  const thin = splitWindows(rows.slice(0, 6), floor);
  equal(thin.sufficient, false);
  ok(thin.reason.includes('need 10'), 'reason states the requirement');
});

test('verdict: bands map a relative move onto the right state', () => {
  const cfg = { degradeMargin: 0.15, watchMargin: 0.05, improveMargin: 0.15 };
  equal(metricVerdict('winRate', 64, 42, cfg).state, 'DEGRADING');
  equal(metricVerdict('winRate', 100, 92, cfg).state, 'WATCH');
  equal(metricVerdict('winRate', 64, 66, cfg).state, 'STABLE');
  equal(metricVerdict('winRate', 42, 64, cfg).state, 'IMPROVING');
});

test('verdict: the profit-factor example is the weaker WATCH tier, not degradation', () => {
  const cfg = { degradeMargin: 0.15, watchMargin: 0.05, improveMargin: 0.15 };
  equal(metricVerdict('profitFactor', 2.1, 1.1, cfg).state, 'DEGRADING');
  const wide = { degradeMargin: 0.6, watchMargin: 0.1, improveMargin: 0.6 };
  equal(metricVerdict('profitFactor', 2.1, 1.1, wide).state, 'WATCH',
    'configurable margins let a volatile metric sit at the weaker tier');
});

test('verdict: a non-positive baseline yields INSUFFICIENT_DATA, never degradation', () => {
  const cfg = { degradeMargin: 0.15, watchMargin: 0.05, improveMargin: 0.15 };
  for (const baseline of [0, -0.12, -3]) {
    const v = metricVerdict('avgR', baseline, -5, cfg);
    equal(v.state, 'INSUFFICIENT_DATA', `baseline ${baseline} must not be judged`);
    ok(v.reason.includes('non-positive'), 'reason explains the refusal');
  }
  equal(metricVerdict('winRate', null, 50, cfg).state, 'INSUFFICIENT_DATA');
  equal(metricVerdict('winRate', NaN, 50, cfg).state, 'INSUFFICIENT_DATA');
});

test('aggregate: worst evidence wins, and no evidence means insufficient', () => {
  equal(aggregateState([{ state: 'STABLE' }, { state: 'DEGRADING' }]), 'DEGRADING');
  equal(aggregateState([{ state: 'IMPROVING' }, { state: 'WATCH' }]), 'WATCH');
  equal(aggregateState([{ state: 'STABLE' }, { state: 'IMPROVING' }]), 'IMPROVING');
  equal(aggregateState([{ state: 'INSUFFICIENT_DATA' }]), 'INSUFFICIENT_DATA');
});

test('detect: a falling strategy is reported DEGRADING with provenance and evidence', () => {
  const rows = series({ prefix: 'deg', count: 20, earlyWins: 9, lateWins: 2 });
  const insights = detectDegradation(rows, { dimension: 'strategy' });
  equal(insights.length, 1);
  const insight = insights[0];
  equal(insight.category, 'DEGRADATION');
  equal(insight.metric.state, 'DEGRADING');
  equal(insight.metric.dimensionValue, 'S1');
  deepEqual(insight.provenance, ['tradingAnalytics.getCoreMetrics']);
  equal(insight.evidenceRef.kind, 'TRADES');
  equal(insight.evidenceRef.refIds.length, 20, 'evidence points at both windows');
  ok(insight.evidence.includes('winRate'), 'evidence names the compared metric');
  ok(insight.sampleSize > 0 && insight.sample.level !== 'INSUFFICIENT');
});

test('detect: a stable strategy is reported STABLE, not a finding to act on', () => {
  const rows = series({ prefix: 'stable', count: 20, earlyWins: 7, lateWins: 7 });
  const [insight] = detectDegradation(rows, { dimension: 'strategy' });
  equal(insight.metric.state, 'STABLE');
});

test('detect: an improving strategy is reported IMPROVING', () => {
  const rows = series({ prefix: 'imp', count: 20, earlyWins: 3, lateWins: 9 });
  const [insight] = detectDegradation(rows, { dimension: 'strategy' });
  equal(insight.metric.state, 'IMPROVING');
});

test('detect: a thin group is INSUFFICIENT_DATA and is never called degradation', () => {
  const rows = series({ prefix: 'thin', count: 6, earlyWins: 4, lateWins: 0 });
  const [insight] = detectDegradation(rows, { dimension: 'strategy' });
  equal(insight.metric.state, 'INSUFFICIENT_DATA');
  ok(insight.title.toLowerCase().includes('not enough'), 'title explains the silence');
  equal(insight.rankable, false, 'a thin window is not rankable');
});

test('detect: groups per dimension value, using the shared attribution mapping', () => {
  const rows = [
    ...series({ prefix: 'a', count: 20, earlyWins: 9, lateWins: 1 }),
    ...series({ prefix: 'b', count: 20, earlyWins: 9, lateWins: 1 }).map((r) => ({
      ...r, trade: { ...r.trade, strategyId: 'S2' },
    })),
  ];
  const insights = detectDegradation(rows, { dimension: 'strategy' });
  equal(insights.length, 2);
  deepEqual(insights.map((i) => i.metric.dimensionValue), ['S1', 'S2']);
  deepEqual(insights.map((i) => i.metric.state), ['DEGRADING', 'DEGRADING']);
});

test('detect: session dimension resolves through performanceAttribution, not a second mapping', () => {
  const rows = series({ prefix: 'sess', count: 20, earlyWins: 9, lateWins: 1 }).map((r) => ({
    ...r, trade: { ...r.trade, session: 'London' },
  }));
  const [insight] = detectDegradation(rows, { dimension: 'session' });
  equal(insight.metric.dimensionValue, 'London');
  equal(perf.getDimensionValue(rows[0].trade, 'session'), 'London');
});

test('detect: is pure — the caller dataset is never mutated', () => {
  const rows = series({ prefix: 'pure', count: 20, earlyWins: 9, lateWins: 1 });
  const snapshot = JSON.stringify(rows);
  detectDegradation(rows, { dimension: 'strategy' });
  equal(JSON.stringify(rows), snapshot, 'input rows unchanged');
});

test('detect: is deterministic — identical input yields byte-identical findings', () => {
  const rows = series({ prefix: 'det', count: 24, earlyWins: 12, lateWins: 3 });
  const a = detectDegradation(rows, { dimension: 'strategy' });
  const b = detectDegradation(rows, { dimension: 'strategy' });
  equal(JSON.stringify(a), JSON.stringify(b));
});

test('detect: input order does not change the verdict', () => {
  const rows = series({ prefix: 'ord', count: 20, earlyWins: 9, lateWins: 1 });
  const shuffled = [...rows].reverse();
  const a = detectDegradation(rows, { dimension: 'strategy' });
  const b = detectDegradation(shuffled, { dimension: 'strategy' });
  equal(a[0].metric.state, b[0].metric.state);
  equal(JSON.stringify(a), JSON.stringify(b), 'ordering is normalised internally');
});

test('detect: malformed or empty input yields no findings rather than throwing', () => {
  deepEqual(detectDegradation([], { dimension: 'strategy' }), []);
  deepEqual(detectDegradation(null, { dimension: 'strategy' }), []);
  deepEqual(detectDegradation({ nope: 1 }, { dimension: 'strategy' }), []);
  deepEqual(detectDegradation('garbage', { dimension: 'strategy' }), []);
});

test('detect: a minimum sample threshold is configurable', () => {
  const rows = series({ prefix: 'cfg', count: 12, earlyWins: 9, lateWins: 0 });
  equal(detectDegradation(rows, { dimension: 'strategy' })[0].metric.state, 'DEGRADING');
  const strict = detectDegradation(rows, {
    dimension: 'strategy',
    config: { minimumWindowSample: 10 },
  });
  equal(strict[0].metric.state, 'INSUFFICIENT_DATA', 'raising the floor silences the claim');
});

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}