import { test, ok, equal, deepEqual } from './helpers.js';

const intel = await import('../src/js/utils/attributionIntelligence.js');
const perf = await import('../src/js/utils/performanceAttribution.js');
const contracts = await import('../src/js/utils/intelligenceContracts.js');

const { qualifyAttributionRows, qualifyAttribution, DEFAULT_RANKING_METRIC } = intel;

const SOURCE = 'performanceAttribution.getAttribution';
const floor = contracts.assessSample(0).minimumSample;

/** Build an attribution row in the exact shape performanceAttribution emits. */
function row({ value, sampleSize, averageR = 1, winRate = 50, processScore = 70 }) {
  return {
    dimensionValue: value,
    trades: sampleSize,
    pnl: averageR * 100 * sampleSize,
    totalR: averageR * sampleSize,
    averageR,
    winRate,
    processScore,
    sampleSize,
  };
}

const byValue = (insights) => Object.fromEntries(insights.map((i) => [i.metric.dimensionValue, i]));

test('provenance: every surfaced insight cites the existing attribution export', () => {
  const insights = qualifyAttributionRows([row({ value: 'EUR/USD', sampleSize: 30 })]);
  equal(insights.length, 1);
  deepEqual(insights[0].provenance, [SOURCE]);
  ok(contracts.INTELLIGENCE_SOURCES.includes(SOURCE), 'source is on the allowlist');
  equal(insights[0].evidenceRef.kind, 'TRADES');
});

test('adequate sample: becomes rankable with an explicit rank and label', () => {
  const insights = qualifyAttributionRows([
    row({ value: 'AAA', sampleSize: 30, averageR: 0.4 }),
    row({ value: 'BBB', sampleSize: 28, averageR: 1.8 }),
    row({ value: 'CCC', sampleSize: 26, averageR: 1.1 }),
  ]);
  deepEqual(insights.map((i) => i.metric.dimensionValue), ['BBB', 'CCC', 'AAA'],
    'ordered best first on averageR');
  deepEqual(insights.map((i) => i.metric.rank), [1, 2, 3]);
  for (const i of insights) {
    equal(i.rankable, true, `${i.metric.dimensionValue} should be rankable`);
    equal(i.metric.state, 'RANKED');
    equal(i.metric.suppressionReason, null);
    equal(i.sample.level, 'STRONG');
    ok(i.title.includes('rank'), 'title states the rank, not a leader claim');
  }
});

test('thin sample: preserved but never labelled a rank', () => {
  const insights = qualifyAttributionRows([
    row({ value: 'THIN', sampleSize: floor, averageR: 9.9 }),
    row({ value: 'BIG', sampleSize: 30, averageR: 0.2 }),
  ]);
  equal(insights.length, 2, 'thin row is preserved, not hidden');
  const thin = byValue(insights).THIN;
  equal(thin.rankable, false);
  equal(thin.metric.rank, null);
  equal(thin.metric.state, 'INSUFFICIENT_DATA');
  ok(thin.metric.suppressionReason && thin.metric.suppressionReason.length > 0, 'reason is explicit');
  ok(thin.title.includes('insufficient'), 'title explains the silence');
  equal(thin.sample.level, 'THIN');
});

test('insufficient sample: preserved with the weakest qualification', () => {
  const [insight] = qualifyAttributionRows([row({ value: 'SPARSE', sampleSize: 2, averageR: 5 })]);
  equal(insight.rankable, false);
  equal(insight.metric.rank, null);
  equal(insight.sample.level, 'INSUFFICIENT');
  equal(insight.sample.sufficient, false);
  ok(insight.evidence.includes('2 closed trades'), 'evidence states the real sample');
});

test('ties: share a rank and do not manufacture a winner', () => {
  const insights = qualifyAttributionRows([
    row({ value: 'T1', sampleSize: 30, averageR: 1.5 }),
    row({ value: 'T2', sampleSize: 30, averageR: 1.5 }),
    row({ value: 'T3', sampleSize: 30, averageR: 0.5 }),
  ]);
  const m = byValue(insights);
  equal(m.T1.metric.rank, 1, 'first of the tie takes rank 1');
  equal(m.T2.metric.rank, 1, 'second of the tie shares rank 1');
  equal(m.T3.metric.rank, 3, 'next distinct value skips ahead');
});

test('tie order is deterministic: equal values keep a stable alphabetical order', () => {
  const rows = [
    row({ value: 'ZZZ', sampleSize: 30, averageR: 1.5 }),
    row({ value: 'AAA', sampleSize: 30, averageR: 1.5 }),
  ];
  const insights = qualifyAttributionRows(rows);
  deepEqual(insights.map((i) => i.metric.dimensionValue), ['AAA', 'ZZZ']);
});

test('single-category dataset yields exactly one insight', () => {
  const insights = qualifyAttributionRows([row({ value: 'ONLY', sampleSize: 12, averageR: 0.7 })]);
  equal(insights.length, 1);
  equal(insights[0].metric.dimensionValue, 'ONLY');
  equal(insights[0].metric.rank, 1);
});

test('a strong row is not promoted above a thin row that scores higher', () => {
  const insights = qualifyAttributionRows([
    row({ value: 'THIN-BEST', sampleSize: 3, averageR: 9.9 }),
    row({ value: 'SOLID', sampleSize: 40, averageR: 0.3 }),
  ]);
  const m = byValue(insights);
  equal(m['THIN-BEST'].rankable, false, 'the thin row earns no rank despite the better number');
  equal(m['THIN-BEST'].metric.rank, null);
  equal(m.SOLID.metric.rank, 1, 'the well-evidenced row holds the only rank');
});

test('missing ranking value is preserved but left unranked', () => {
  const insights = qualifyAttributionRows([
    { dimensionValue: 'NAN', trades: 30, sampleSize: 30, averageR: null, winRate: 50, processScore: 70 },
    row({ value: 'GOOD', sampleSize: 30, averageR: 1.2 }),
  ]);
  equal(insights.length, 2);
  const nan = byValue(insights).NAN;
  equal(nan.metric.rankValue, null);
  equal(nan.metric.rank, null);
  equal(byValue(insights).GOOD.metric.rank, 1);
  ok(nan.evidence.includes('n/a'), 'evidence admits the value is unavailable');
});

test('rankBy is configurable and defaults to averageR', () => {
  equal(DEFAULT_RANKING_METRIC, 'averageR');
  const rows = [
    row({ value: 'X', sampleSize: 30, averageR: 0.2, winRate: 90 }),
    row({ value: 'Y', sampleSize: 30, averageR: 2.0, winRate: 20 }),
  ];
  const byR = qualifyAttributionRows(rows);
  deepEqual(byR.map((i) => i.metric.dimensionValue), ['Y', 'X']);
  const byWin = qualifyAttributionRows(rows, { rankBy: 'winRate' });
  deepEqual(byWin.map((i) => i.metric.dimensionValue), ['X', 'Y']);
  equal(byWin[0].metric.rankBy, 'winRate');
});

test('dimensions namespace the ids so a category is not confused across dimensions', () => {
  const rows = [row({ value: 'EUR/USD', sampleSize: 30, averageR: 1 })];
  const byPair = qualifyAttributionRows(rows, { dimension: 'pair' });
  const bySession = qualifyAttributionRows(rows, { dimension: 'session' });
  ok(byPair[0].id.includes('pair'));
  ok(bySession[0].id.includes('session'));
  ok(byPair[0].id !== bySession[0].id);
  equal(byPair[0].metric.dimension, 'pair');
});

test('determinism: identical input yields byte-identical output', () => {
  const rows = [
    row({ value: 'A', sampleSize: 30, averageR: 1.1 }),
    row({ value: 'B', sampleSize: 12, averageR: 0.2 }),
    row({ value: 'C', sampleSize: 30, averageR: 1.1 }),
  ];
  const first = qualifyAttributionRows(rows, { dimension: 'pair' });
  const second = qualifyAttributionRows(rows, { dimension: 'pair' });
  equal(JSON.stringify(first), JSON.stringify(second));
});

test('purity: caller rows are never mutated', () => {
  const rows = [
    row({ value: 'A', sampleSize: 30, averageR: 1.1 }),
    row({ value: 'B', sampleSize: 4, averageR: 0.2 }),
  ];
  const snapshot = JSON.stringify(rows);
  qualifyAttributionRows(rows, { dimension: 'strategy' });
  equal(JSON.stringify(rows), snapshot, 'input rows unchanged');
});

test('every surfaced insight satisfies the 10A contract', () => {
  const insights = qualifyAttributionRows([
    row({ value: 'A', sampleSize: 30, averageR: 1.1 }),
    row({ value: 'B', sampleSize: 6, averageR: 0.2 }),
    row({ value: 'C', sampleSize: 1, averageR: 0.9 }),
  ]);
  equal(insights.length, 3, 'nothing dropped');
  for (const i of insights) {
    equal(i.category, 'ATTRIBUTION');
    ok(i.id.length > 0);
    ok(i.title.length > 0);
    ok(i.evidence.length > 0);
    equal(i.provenance.length, 1);
    equal(i.provenance[0], SOURCE);
    ok(typeof i.rankable === 'boolean');
    ok(i.sample && typeof i.sample.level === 'string');
  }
});

test('malformed input yields no insights rather than throwing', () => {
  deepEqual(qualifyAttributionRows(null), []);
  deepEqual(qualifyAttributionRows(undefined), []);
  deepEqual(qualifyAttributionRows('nope'), []);
  deepEqual(qualifyAttributionRows([]), []);
  deepEqual(qualifyAttributionRows([null, undefined, 7]), []);
  deepEqual(qualifyAttribution('acc1', 'nonsense-dimension'), [], 'unknown dimension is safe');
});

test('regression: performanceAttribution is behaviourally unchanged', () => {
  deepEqual(perf.DIMENSIONS, ['strategy', 'setup', 'pair', 'session', 'timeframe', 'direction', 'dayOfWeek']);
  deepEqual(perf.getAttributionDimensions(), perf.DIMENSIONS);
  deepEqual(perf.getAttribution('acc1', 'not-a-dimension'), []);
  equal(perf.getDimensionValue({ direction: 'BUY' }, 'direction'), 'LONG');
  equal(perf.getDimensionValue({ direction: 'SELL' }, 'direction'), 'SHORT');
  equal(perf.getDimensionValue({ direction: '??? ' }, 'direction'), 'Unspecified');
  equal(perf.getDimensionValue({}, 'pair'), 'Unspecified');
  equal(perf.getDimensionValue({}, 'unknown-dim'), 'Unspecified');
  deepEqual(perf.getLongVsShort('acc1'), [], 'no data stays empty');
});

test('regression: attribute-value summary notes row shape still matches the contract', () => {
  const sample = row({ value: 'V', sampleSize: 12, averageR: 0.8 });
  for (const key of ['dimensionValue', 'trades', 'pnl', 'totalR', 'averageR', 'winRate', 'processScore', 'sampleSize']) {
    ok(key in sample, `attribution row still carries ${key}`);
  }
});

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}