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
  TRACEABILITY_LEVELS,
  normalizeImprovementPattern,
  normalizeDegradationInsight,
  normalizeAttributionInsight,
  normalizeInsight,
  identityKey,
  consolidateInsights,
  groupInsights,
} = cons;

const CODE = new URL("../src/js/utils/intelligenceConsolidation.js", import.meta.url);

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
  for (const forbidden of ['getCoreMetrics', 'totalPnl', 'getTradeDataset', 'getCompletedReviews']) {
    ok(!code.includes(forbidden), `must not reference ${forbidden}`);
  }
  // Metric names appear only as display-unit labels; what must not exist is
  // arithmetic over them.
  ok(!/winRate\s*[-+*/]/.test(code), 'no arithmetic on a metric name');
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


// ---------- traceability ----------

test('traceability: levels are the controlled set the spec requires', () => {
  deepEqual(TRACEABILITY_LEVELS, ['record', 'aggregate', 'pattern']);
});

test('traceability: degradation cites real records, so it is record-level', () => {
  const rows = series({ prefix: 'tr', count: 20, earlyWins: 9, lateWins: 1, strategyId: 'S' });
  const n = normalizeDegradationInsight(degradation.detectDegradation(rows, { dimension: 'strategy' })[0]);
  equal(n.traceability, 'record');
  equal(n.hasRecordEvidence, true);
  const refs = n.evidence[0].sourceRefs;
  ok(refs.length >= 20, `expected the full window cited, got ${refs.length}`);
  equal(n.evidence[0].scope, 'records');
  for (const r of refs) ok(typeof r === 'string' && r.length > 0);
});

test('traceability: attribution is aggregate-level and cites no record ids', () => {
  const n = normalizeAttributionInsight(attribution.qualifyAttributionRows(
    [attributionRow({ value: 'AAA', sampleSize: 30, averageR: 1.2 })], { dimension: 'pair' },
  )[0]);
  equal(n.traceability, 'aggregate');
  equal(n.hasRecordEvidence, false);
  deepEqual(n.evidence[0].sourceRefs, []);
  equal(n.evidence[0].scope, 'aggregate');
});

test('traceability: improvement patterns are pattern-level and cite no record ids', () => {
  const n = normalizeImprovementPattern(improvement.getImprovementPatterns({ reviews: reviewsFixture() })[0]);
  equal(n.traceability, 'pattern');
  equal(n.hasRecordEvidence, false);
  deepEqual(n.evidence[0].sourceRefs, []);
  equal(n.evidence[0].scope, 'pattern');
});

test('traceability: no insight claims record-level evidence without real refs', () => {
  for (const i of consolidated()) {
    for (const e of i.evidence) {
      const hasRefs = Array.isArray(e.sourceRefs) && e.sourceRefs.length > 0;
      if (e.traceability === 'record') ok(hasRefs, `${i.id} record-level without refs is impossible`);
      if (!hasRefs) ok(e.traceability !== 'record', `${i.id} must not claim record traceability`);
      ok(TRACEABILITY_LEVELS.includes(e.traceability));
    }
    equal(i.hasRecordEvidence, i.evidence.some((e) => Array.isArray(e.sourceRefs) && e.sourceRefs.length > 0),
      `${i.id} flag agrees with its evidence`);
  }
});

test('traceability: all three producers are represented across levels', () => {
  const levels = new Set(consolidated().map((i) => i.traceability));
  ok(levels.has('record'), 'degradation contributes record-level');
  ok(levels.has('aggregate'), 'attribution contributes aggregate-level');
  ok(levels.has('pattern'), 'improvements contribute pattern-level');
});

// ---------- WATCH reachability ----------

test('watch: a deterministic fixture reaches WATCH under default thresholds', () => {
  // 40-trade strategy: historical 32W/8L, recent 31W/9L, uniform +/-2R.
  // Win rate moves -3.1% (STABLE) and profit factor -13.9%, which sits
  // inside the default 5%-15% watch band, so the worst verdict is WATCH.
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `wh-${i}`, strategyId: 'S-WATCH', outcome: i < 32 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `wr-${i}`, strategyId: 'S-WATCH', outcome: i < 31 ? 'WIN' : 'LOSS' }));

  const out = degradation.detectDegradation(rows, { dimension: 'strategy' });
  equal(out.length, 1);
  equal(out[0].metric.state, 'WATCH');
  ok(out[0].rankable === false || out[0].rankable === true, 'ranking verdict still present');

  const n = normalizeDegradationInsight(out[0]);
  equal(n.state, 'WATCH');
  equal(n.traceability, 'record');
  deepEqual(contracts.findCausalClaims(n.whySurfaced, n.summary, n.title), [], 'stays observational');
  ok(n.investigationQuestion.length > 0, 'a WATCH insight still carries an investigation question');
});

test('watch: WATCH survives consolidation and is grouped into its own bucket', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `wh-${i}`, strategyId: 'S-WATCH', outcome: i < 32 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `wr-${i}`, strategyId: 'S-WATCH', outcome: i < 31 ? 'WIN' : 'LOSS' }));
  const out = degradation.detectDegradation(rows, { dimension: 'strategy' });
  const merged = consolidateInsights({ degradation: out, attribution: [], improvements: [] });
  equal(merged.filter((i) => i.state === 'WATCH').length, 1);
  equal(groupInsights(merged).groups.WATCH.length, 1, 'reachable in the view');
});

test('watch: the fixture is deterministic across repeated runs', () => {
  const build = () => {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `wh-${i}`, strategyId: 'S-WATCH', outcome: i < 32 ? 'WIN' : 'LOSS' }));
    for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `wr-${i}`, strategyId: 'S-WATCH', outcome: i < 31 ? 'WIN' : 'LOSS' }));
    return consolidationOf(rows);
  };
  equal(JSON.stringify(build()), JSON.stringify(build()));
});

function consolidationOf(rows) {
  return consolidateInsights({
    degradation: degradation.detectDegradation(rows, { dimension: 'strategy' }),
    attribution: [],
    improvements: [],
  });
}

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}
// ---------- permittedFacts: authoritative values preserved across the boundary ----------

test('permittedFacts: degradation metric changes survive canonical normalization', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `pf-w-${i}`, strategyId: 'S', outcome: i < 32 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `pf-r-${i}`, strategyId: 'S', outcome: i < 31 ? 'WIN' : 'LOSS' }));

  const raw = degradation.detectDegradation(rows, { dimension: 'strategy' })[0];
  const n = normalizeDegradationInsight(raw);

  const change = n.permittedFacts.numeric.find((f) => f.metric === 'winRate.change');
  ok(change !== undefined, 'the change is carried through');
  const upstream = raw.metric.metrics.find((m) => m.metric === 'winRate');
  equal(change.value, upstream.change, 'value is copied verbatim from the engine, not recomputed');
  equal(change.kind, 'derived');
  equal(change.unit, 'percent');
  equal(change.source, 'degradationEngine.metricVerdict');
});

test('permittedFacts: the endpoints the change came from are carried as exact facts', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `pf2-w-${i}`, strategyId: 'S', outcome: i < 32 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `pf2-r-${i}`, strategyId: 'S', outcome: i < 31 ? 'WIN' : 'LOSS' }));
  const n = normalizeDegradationInsight(degradation.detectDegradation(rows, { dimension: 'strategy' })[0]);
  const hist = n.permittedFacts.numeric.find((f) => f.metric === 'winRate.historical');
  const recent = n.permittedFacts.numeric.find((f) => f.metric === 'winRate.recent');
  equal(hist.kind, 'exact');
  equal(recent.kind, 'exact');
  equal(hist.value, 80);
  equal(recent.value, 77.5);
});

test('permittedFacts: every carried fact has full provenance', () => {
  for (const i of consolidated()) {
    ok(Array.isArray(i.permittedFacts.numeric), 'array present on every insight');
    for (const f of i.permittedFacts.numeric) {
      ok(typeof f.metric === 'string' && f.metric.length > 0, 'metric named');
      ok(Number.isFinite(Number(f.value)), 'value is finite');
      ok(f.kind === 'exact' || f.kind === 'derived', 'kind is controlled');
      ok(typeof f.source === 'string' && f.source.length > 0, 'source attributed');
    }
  }
});

test('permittedFacts: non-degradation insights carry none', () => {
  const merged = consolidated();
  for (const i of merged) {
    if (i.source !== 'degradationEngine') {
      deepEqual(i.permittedFacts.numeric, [], `${i.source} exposes no degradation facts`);
    }
  }
  ok(merged.some((i) => i.source === 'degradationEngine' && i.permittedFacts.numeric.length > 0),
    'degradation does expose facts');
});

test('permittedFacts: output stays deterministic and existing fields are untouched', () => {
  const out = realOutputs();
  const before = normalizeDegradationInsight(out.degradation[0]);
  const after = normalizeDegradationInsight(out.degradation[0]);
  deepEqual(after, before, 'normalization is deterministic');

  // The amendment adds one field and removes or renames none.
  const required = ['id', 'category', 'source', 'title', 'state', 'sourceState', 'summary',
    'whySurfaced', 'evidence', 'traceability', 'hasRecordEvidence', 'sample', 'ranking',
    'investigationQuestion', 'provenance', 'entity', 'dimension', 'window', 'permittedFacts'];
  for (const key of required) ok(key in after, `${key} still present`);
  equal(Object.keys(after).length, required.length, 'no field was added or dropped beyond the amendment');
});

test('permittedFacts: no metric calculation was introduced here', () => {
  const code = readFileSync(CODE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // An arithmetic operator applied to window endpoints would be a new metric.
  ok(!/historical\s*[-*/]\s*recent/.test(code), 'no difference computed from the endpoints');
  ok(!/Math\.(round|floor|abs)\([^)]*(change|historical|recent)/.test(code),
    'no rounding applied to a carried fact value');
  ok(!/minimumSample\s*:\s*\d+/.test(code), 'no threshold redefinition');
});

test('permittedFacts: a degradation insight without metrics yields no facts rather than throwing', () => {
  const n = normalizeDegradationInsight({
    id: 'x', category: 'DEGRADATION', title: 'T', evidence: 'Observed alongside 20 trades.',
    sampleSize: 20, metric: { state: 'DEGRADING' },
  });
  ok(n !== null);
  deepEqual(n.permittedFacts.numeric, []);
});
