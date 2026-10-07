import { test, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';

const cons = await import('../src/js/utils/intelligenceConsolidation.js');
const contracts = await import('../src/js/utils/intelligenceContracts.js');
const degradation = await import('../src/js/utils/degradationEngine.js');
const attribution = await import('../src/js/utils/attributionIntelligence.js');
const improvement = await import('../src/js/utils/improvementEngine.js');
const service = await import('../src/js/utils/intelligenceService.js');

const {
  INSIGHT_SOURCES,
  INSIGHT_CATEGORIES,
  INSIGHT_STATES,
  normalizeImprovementPattern,
  normalizeDegradationInsight,
  normalizeAttributionInsight,
  normalizeInsight,
  identityKey,
  consolidateInsights,
  groupInsights,
} = cons;

const CODE = new URL('../src/js/utils/intelligenceConsolidation.js', import.meta.url);

let clock = 0;
function tradeRow({ id, outcome, strategyId = 'S1', pair = 'EUR/USD', session = 'London' }) {
  clock += 3600000;
  const r = outcome === 'WIN' ? 2 : -1;
  return {
    trade: {
      id, strategyId, pair, session, timeframe: 'H1', setupType: 'BREAKOUT',
      openedAt: new Date(clock).toISOString(),
      closedAt: new Date(clock + 60000).toISOString(),
      pnl: r * 100, rMultiple: r,
    },
    review: null, outcome, pnl: r * 100, r, processScore: 70, reviewed: false,
  };
}

function series({ prefix, count, earlyWins, lateWins, strategyId = 'S1' }) {
  const half = count / 2;
  const out = [];
  for (let i = 0; i < count; i++) {
    const first = i < half;
    const local = first ? i : i - half;
    const wins = first ? earlyWins : lateWins;
    out.push(tradeRow({ id: `${prefix}-${i}`, strategyId, outcome: local < wins ? 'WIN' : 'LOSS' }));
  }
  return out;
}

function attributionRow({ value, sampleSize, averageR = 1 }) {
  return {
    dimensionValue: value, trades: sampleSize, pnl: averageR * sampleSize,
    totalR: averageR * sampleSize, averageR, winRate: 50, processScore: 70, sampleSize,
  };
}

function reviewsFixture() {
  return Array.from({ length: 8 }, (_, i) => ({
    id: `r-${i}`, mistakes: i < 5 ? ['LATE_ENTRY'] : [], strengths: i < 3 ? ['PATIENCE'] : [],
    processScore: { total: 70 }, ruleAdherence: 90,
  }));
}

function realOutputs() {
  return {
    degradation: degradation.detectDegradation(
      [
        ...series({ prefix: 'd1', count: 20, earlyWins: 9, lateWins: 1, strategyId: 'S-FALL' }),
        ...series({ prefix: 'd2', count: 4, earlyWins: 4, lateWins: 0, strategyId: 'S-SPARSE' }),
      ],
      { dimension: 'strategy' },
    ),
    attribution: attribution.qualifyAttributionRows(
      [
        attributionRow({ value: 'AAA', sampleSize: 30, averageR: 1.6 }),
        attributionRow({ value: 'THIN', sampleSize: 2, averageR: 0.1 }),
      ],
      { dimension: 'pair' },
    ),
    improvements: improvement.getImprovementPatterns({ reviews: reviewsFixture() }),
  };
}

function consolidated() {
  return consolidateInsights(realOutputs());
}

test('contract: vocabulary is the controlled set the spec requires', () => {
  deepEqual(INSIGHT_SOURCES, ['degradationEngine', 'attributionIntelligence', 'improvementEngine']);
  for (const c of ['strategy', 'rule', 'mistake', 'degradation', 'attribution', 'improvement', 'process']) {
    ok(INSIGHT_CATEGORIES.includes(c), `category ${c} present`);
  }
  for (const s of ['NEEDS_ATTENTION', 'WATCH', 'IMPROVING', 'STABLE', 'INSUFFICIENT_DATA']) {
    ok(INSIGHT_STATES.includes(s), `state ${s} present`);
  }
});

test('normalization: degradation -> canonical shape', () => {
  const i = normalizeDegradationInsight(realOutputs().degradation[0]);
  ok(i !== null);
  equal(i.source, 'degradationEngine');
  equal(i.category, 'degradation');
  equal(i.state, 'NEEDS_ATTENTION');
  ok(Array.isArray(i.evidence) && i.evidence.length > 0);
  deepEqual(Object.keys(i.sample).sort(), ['band', 'qualificationReason', 'size', 'smallSample']);
  deepEqual(Object.keys(i.ranking).sort(), ['eligible', 'label', 'suppressionReason']);
});

test('normalization: attribution -> canonical shape', () => {
  const rows = realOutputs().attribution;
  const strong = normalizeAttributionInsight(rows.find((r) => r.metric.dimensionValue === 'AAA'));
  equal(strong.source, 'attributionIntelligence');
  equal(strong.category, 'attribution');
  equal(strong.state, 'STABLE');
  equal(strong.ranking.eligible, true);
  ok(/^Rank #\d+$/.test(strong.ranking.label), `label is rank form, got ${strong.ranking.label}`);
  const thin = normalizeAttributionInsight(rows.find((r) => r.metric.dimensionValue === 'THIN'));
  equal(thin.state, 'INSUFFICIENT_DATA');
  equal(thin.ranking.eligible, false);
  equal(thin.ranking.label, null, 'label must be null when suppressed');
  ok(thin.ranking.suppressionReason.length > 0);
});

test('normalization: improvement -> canonical shape', () => {
  const patterns = realOutputs().improvements;
  ok(patterns.length > 0);
  for (const p of patterns) {
    const n = normalizeImprovementPattern(p);
    ok(n !== null, `pattern ${p.id} normalizes`);
    equal(n.source, 'improvementEngine');
    ok(INSIGHT_CATEGORIES.includes(n.category));
    deepEqual(n.provenance, ['improvementEngine.getImprovementPatterns']);
  }
});

test('normalization: all three producers land in one canonical shape', () => {
  const all = consolidated();
  ok(all.length > 0);
  for (const i of all) {
    for (const k of ['id', 'category', 'source', 'title', 'state', 'summary', 'whySurfaced',
      'evidence', 'sample', 'ranking', 'investigationQuestion', 'provenance']) {
      ok(k in i, `canonical field ${k}`);
    }
    ok(INSIGHT_SOURCES.includes(i.source));
    ok(INSIGHT_CATEGORIES.includes(i.category));
    ok(i.state === null || INSIGHT_STATES.includes(i.state));
  }
  equal(new Set(all.map((i) => i.source)).size, 3, 'all three producers represented');
});

test('normalization: missing optional fields become null, never invented', () => {
  const n = normalizeImprovementPattern({
    id: 'm', category: 'MISTAKE', title: 'Observed pattern',
    evidence: 'Observed alongside 6 of 8 reviewed trades.', sampleSize: 8,
  });
  ok(n !== null);
  equal(n.dimension, null);
  equal(n.window, null);
  ok(typeof n.sample.qualificationReason === 'string');
  ok(typeof n.ranking.suppressionReason === 'string');
});

test('normalization: evidence is empty and the insight rejected when none supplied', () => {
  const n = normalizeDegradationInsight({
    id: 'x', category: 'DEGRADATION', title: 'T', evidence: '   ', sampleSize: 20,
    evidenceRef: { refIds: [] },
  });
  equal(n, null, 'no description and no refIds means the insight is rejected outright');
});

test('normalization: no invented evidence or sample data', () => {
  for (const i of consolidated()) {
    for (const e of i.evidence) {
      ok(e.sources.length > 0, 'evidence keeps provenance');
      ok(e.description === null || typeof e.description === 'string');
    }
    ok(i.sample.size === null || Number.isFinite(i.sample.size));
    ok(['STRONG', 'ADEQUATE', 'THIN', 'INSUFFICIENT'].includes(i.sample.band));
  }
});

test('ranking: eligible ranking preserved, suppressed ranking preserved', () => {
  const all = consolidated();
  const eligible = all.filter((i) => i.ranking.eligible);
  const suppressed = all.filter((i) => !i.ranking.eligible);
  ok(eligible.length > 0, 'some rankable');
  ok(suppressed.length > 0, 'some suppressed');
  for (const i of eligible) {
    equal(i.ranking.suppressionReason, null);
    ok(i.ranking.label !== null);
  }
  for (const i of suppressed) {
    equal(i.ranking.label, null);
    ok(i.ranking.suppressionReason && i.ranking.suppressionReason.length > 0);
  }
});

test('ranking: thin and insufficient findings remain visible', () => {
  const all = consolidated();
  const insufficient = all.filter((i) => i.state === 'INSUFFICIENT_DATA');
  ok(insufficient.length >= 2, 'thin degradation and thin attribution both survive');
  const { groups } = groupInsights(all);
  equal(groups.INSUFFICIENT_DATA.length, insufficient.length, 'reachable in the view');
});

test('ranking: suppression reasons are distinct, not tautological', () => {
  const all = consolidated();
  const reasons = new Set(all.filter((i) => !i.ranking.eligible).map((i) => i.ranking.suppressionReason));
  ok(reasons.size >= 2, `expected several distinct reasons, got ${[...reasons].join(' / ')}`);
  for (const r of reasons) ok(!/not eligible for ranking/i.test(r), 'no tautological reason');
});

test('dedupe: identical semantic insight deduplicates', () => {
  const rows = series({ prefix: 'dup', count: 20, earlyWins: 9, lateWins: 1, strategyId: 'S' });
  const first = degradation.detectDegradation(rows, { dimension: 'strategy' });
  const second = degradation.detectDegradation(rows, { dimension: 'strategy' });
  equal(consolidateInsights({ degradation: [...first, ...second] }).length, first.length,
    'the same observation collapses to one');
});

test('dedupe: distinct insights remain separate', () => {
  const merged = consolidated();
  equal(new Set(merged.map(identityKey)).size, merged.length, 'no two survivors share an identity');
  ok(merged.length >= 5, 'multiple distinct findings coexist');
});

test('dedupe: resolution is deterministic and not arrival-order dependent', () => {
  const out = realOutputs();
  const a = consolidateInsights(out);
  const b = consolidateInsights({
    improvements: out.improvements, attribution: out.attribution, degradation: out.degradation,
  });
  equal(JSON.stringify(a), JSON.stringify(b), 'input key order does not matter');
});

test('dedupe: identity uses source, category, entity, dimension and window', () => {
  const key = identityKey(normalizeDegradationInsight(realOutputs().degradation[0]));
  ok(key.includes('degradationEngine'), 'source in identity');
  ok(key.includes('degradation'), 'category in identity');
  ok(key.includes('S-FALL'), 'entity in identity');
  ok(key.includes('strategy'), 'dimension in identity');
  ok(key.includes('vs'), 'window context in identity');
});

test('ordering: state priority is NEEDS_ATTENTION, WATCH, IMPROVING, STABLE, INSUFFICIENT_DATA', () => {
  const seen = [];
  for (const i of consolidated()) if (!seen.includes(i.state)) seen.push(i.state);
  const order = seen.map((s) => INSIGHT_STATES.indexOf(s)).filter((n) => n >= 0);
  for (let n = 1; n < order.length; n++) {
    ok(order[n] > order[n - 1], 'states ascend in the declared priority order');
  }
});

test('ordering: within a state, ordering is by category, source, title then id', () => {
  const byState = {};
  for (const i of consolidated()) {
    if (!byState[i.state]) byState[i.state] = [];
    byState[i.state].push(i);
  }
  for (const [state, rows] of Object.entries(byState)) {
    const keys = rows.map((i) => [i.category, i.source, i.title, i.id ?? ''].join(' '));
    equal(JSON.stringify(keys), JSON.stringify([...keys].sort()), `${state} sorted deterministically`);
  }
});

test('ordering: identical input yields byte-identical output and no mutation', () => {
  const out = realOutputs();
  const before = JSON.stringify(out);
  equal(
    JSON.stringify(consolidateInsights(out)),
    JSON.stringify(consolidateInsights(out)),
  );
  equal(JSON.stringify(out), before, 'input objects are not mutated');
});

test('safety: causal wording never reaches whySurfaced', () => {
  for (const i of consolidated()) {
    deepEqual(contracts.findCausalClaims(i.whySurfaced, i.summary, i.title), [], `${i.id} observational`);
  }
});

test('safety: a causal source reason is dropped for an observational template', () => {
  const n = normalizeDegradationInsight({
    id: 'x', category: 'DEGRADATION', title: 'T',
    evidence: 'Observed alongside 20 trades.', sampleSize: 20,
    metric: { state: 'DEGRADING', reason: 'London caused the losses' },
  });
  deepEqual(contracts.findCausalClaims(n.whySurfaced), []);
  ok(!n.whySurfaced.includes('caused'));
});

test('safety: malformed insight rejected', () => {
  equal(normalizeInsight(null), null);
  equal(normalizeInsight('x'), null);
  equal(normalizeInsight({}), null);
  equal(normalizeImprovementPattern(42), null);
});

test('safety: missing title rejected', () => {
  equal(normalizeImprovementPattern({ category: 'MISTAKE', evidence: 'e', sampleSize: 6 }), null);
  equal(normalizeImprovementPattern({ category: 'MISTAKE', title: '  ', evidence: 'e', sampleSize: 6 }), null);
});

test('safety: missing evidence rejected', () => {
  equal(normalizeImprovementPattern({ category: 'MISTAKE', title: 't', sampleSize: 6 }), null);
  equal(normalizeImprovementPattern({ category: 'MISTAKE', title: 't', evidence: '   ', sampleSize: 6 }), null);
});

test('safety: invalid category rejected rather than invented', () => {
  equal(normalizeInsight({ category: 'ASTROLOGY', title: 't', evidence: 'e', sampleSize: 6 }), null);
  equal(normalizeInsight({ title: 't', evidence: 'e', sampleSize: 6 }), null);
  for (const i of consolidated()) ok(INSIGHT_CATEGORIES.includes(i.category), `${i.category} controlled`);
});

test('safety: unmappable source state is preserved, not guessed', () => {
  const n = normalizeDegradationInsight({
    id: 'x', category: 'DEGRADATION', title: 'T', evidence: 'Observed alongside 20 trades.',
    sampleSize: 20, metric: { state: 'SOMETHING_NEW' },
  });
  equal(n.state, null, 'no bucket invented for an unknown state');
  equal(n.sourceState, 'SOMETHING_NEW', 'raw state preserved');
  equal(groupInsights([n]).unmapped.length, 1, 'unmapped insights are counted, not dropped');
});

test('service: assembles the three sources from injected data without storage', () => {
  const insights = service.buildConsolidatedInsights('', {
    user: 'contracttester',
    dataset: series({ prefix: 'svc', count: 20, earlyWins: 9, lateWins: 1 }),
    reviews: reviewsFixture(),
    attribution: attribution.qualifyAttributionRows(
      [attributionRow({ value: 'AAA', sampleSize: 30, averageR: 1.2 })], { dimension: 'pair' },
    ),
    filters: {},
  });
  equal(new Set(insights.map((i) => i.source)).size, 3);
  for (const i of insights) ok(i.state === null || INSIGHT_STATES.includes(i.state));
});

test('service: survives malformed input rather than throwing', () => {
  deepEqual(service.buildConsolidatedInsights('', { dataset: null, reviews: null, attribution: null }), []);
  deepEqual(service.buildConsolidatedInsights('acct', {}), []);
  deepEqual(service.buildConsolidatedInsightGroups('', { dataset: 'nope' }).insights, []);
});

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('structural: the consolidation module contains no metric mathematics', () => {
  const code = stripComments(readFileSync(CODE, 'utf8'))
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  for (const forbidden of ['getCoreMetrics', 'profitFactor', 'totalPnl', 'getTradeDataset', 'getCompletedReviews']) {
    ok(!code.includes(forbidden), `must not reference ${forbidden}`);
  }
});

test('structural: the consolidation module imports no producer engine', () => {
  const code = stripComments(readFileSync(CODE, 'utf8'));
  const imports = (code.match(/^import[\s\S]*?from\s+['"][^'"]+['"];?/gm) || []).join('\n');
  for (const forbidden of ['degradationEngine', 'attributionIntelligence', 'improvementEngine', 'tradingAnalytics', 'tradeReviews']) {
    ok(!imports.includes(forbidden), `must not import ${forbidden}`);
  }
});

test('structural: no second copy of the analytics thresholds', () => {
  const code = stripComments(readFileSync(CODE, 'utf8'));
  deepEqual(code.match(/minimumSample\s*:\s*\d+/g) || [], [], 'thresholds come from models.js');
});

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}