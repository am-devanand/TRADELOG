import { test, ok, equal, deepEqual } from './helpers.js';

const contracts = await import('../src/js/utils/intelligenceContracts.js');
const improvementEngine = await import('../src/js/utils/improvementEngine.js');
const models = await import('../src/js/utils/models.js');

const {
  INSIGHT_CATEGORIES,
  EXISTING_INSIGHT_CATEGORIES,
  INTELLIGENCE_INSIGHT_CATEGORIES,
  EVIDENCE_KINDS,
  INTELLIGENCE_SOURCES,
  assessSample,
  findCausalClaims,
  makeEvidence,
  makeInsight,
  qualifyForRanking,
  fromImprovementPattern,
} = contracts;

const floor = models.ANALYTICS_THRESHOLDS.minimumSample;

test('contract: existing improvementEngine categories are a subset of the Phase 10 vocabulary', () => {
  for (const category of EXISTING_INSIGHT_CATEGORIES) {
    ok(INSIGHT_CATEGORIES.includes(category), `${category} must stay supported`);
  }
  ok(
    INSIGHT_CATEGORIES.length ===
      EXISTING_INSIGHT_CATEGORIES.length + INTELLIGENCE_INSIGHT_CATEGORIES.length,
    'vocabulary is the union of existing and Phase 10 categories',
  );
});

test('contract: every provenance source names a real exported function', async () => {
  const [trading, attribution, risk, rules] = await Promise.all([
    import('../src/js/utils/tradingAnalytics.js'),
    import('../src/js/utils/performanceAttribution.js'),
    import('../src/js/utils/riskAnalytics.js'),
    import('../src/js/utils/ruleHistory.js'),
  ]);
  const modules = {
    'tradingAnalytics': trading,
    'performanceAttribution': attribution,
    'riskAnalytics': risk,
    'ruleHistory': rules,
    'improvementEngine': improvementEngine,
  };
  for (const source of INTELLIGENCE_SOURCES) {
    const [moduleName, fnName] = source.split('.');
    const mod = modules[moduleName];
    ok(mod, `${source} names a known module`);
    ok(
      typeof mod[fnName] === 'function',
      `${source} must resolve to an exported function, got ${typeof mod[fnName]}`,
    );
  }
});

test('sample: bands derive from the canonical minimumSample, not hardcoded numbers', () => {
  equal(assessSample(0).level, 'INSUFFICIENT');
  equal(assessSample(floor - 1).level, 'INSUFFICIENT');
  equal(assessSample(floor).level, 'THIN');
  equal(assessSample(floor * 2).level, 'ADEQUATE');
  equal(assessSample(floor * 4).level, 'STRONG');
  equal(assessSample(999).level, 'STRONG');
});

test('sample: only ADEQUATE and STRONG are rankable', () => {
  equal(assessSample(floor - 1).rankable, false);
  equal(assessSample(floor).rankable, false);
  equal(assessSample(floor * 2).rankable, true);
  equal(assessSample(floor * 4).rankable, true);
});

test('wording: causal claims are detected in title or evidence', () => {
  deepEqual(findCausalClaims('Setup X caused better outcomes'), ['caused']);
  deepEqual(findCausalClaims('Observed alongside 6 of 8 trades'), []);
  deepEqual(findCausalClaims('', null, undefined), []);
});

test('evidence: rejects unknown kind and missing provenance', () => {
  equal(makeEvidence({ kind: 'PLANETS', sources: ['tradingAnalytics.getCoreMetrics'] }).success, false);
  equal(makeEvidence({ kind: 'TRADES', sources: [] }).success, false);
  equal(
    makeEvidence({ kind: 'TRADES', sources: ['someModule.makeUpNumbers'] }).success,
    false,
    'unknown provenance must be refused so the layer cannot fake a source',
  );
});

test('evidence: accepts a real source and dedupes refIds', () => {
  const built = makeEvidence({
    kind: 'TRADES',
    refIds: ['t-1', 't-1', 't-2', '  ', ''],
    sampleSize: 2,
    sources: ['tradingAnalytics.getCoreMetrics', 'tradingAnalytics.getCoreMetrics'],
  });
  ok(built.success);
  deepEqual(built.evidence.refIds, ['t-1', 't-2']);
  deepEqual(built.evidence.sources, ['tradingAnalytics.getCoreMetrics']);
});

test('insight: rejects missing title, missing evidence and unknown category', () => {
  const base = {
    title: 'Valid title',
    evidence: 'Observed alongside 6 of 8 reviewed trades.',
    category: 'MISTAKE',
    sampleSize: 6,
    evidenceRef: { kind: 'REVIEWS', sources: ['improvementEngine.getImprovementPatterns'] },
  };
  equal(makeInsight({ ...base, title: '  ' }).success, false);
  equal(makeInsight({ ...base, evidence: '' }).success, false);
  equal(makeInsight({ ...base, category: 'ASTROLOGY' }).success, false);
  ok(makeInsight(base).success, 'a well-formed insight is accepted');
});

test('insight: refuses causal wording', () => {
  const built = makeInsight({
    title: 'London session caused the losses',
    evidence: 'Observed alongside 6 of 8 reviewed trades.',
    category: 'MISTAKE',
    sampleSize: 6,
    evidenceRef: { kind: 'REVIEWS', sources: ['improvementEngine.getImprovementPatterns'] },
  });
  equal(built.success, false);
  ok(String(built.error).includes('observe'), 'error explains the wording rule');
});

test('insight: carries evidence, provenance and sample assessment', () => {
  const built = makeInsight({
    id: 'rule-low-adherence',
    category: 'RULE',
    title: 'Rule adherence observed below threshold',
    evidence: 'Rule R-3 violations observed alongside 9 of 12 reviewed trades.',
    sampleSize: floor * 2,
    metric: { ruleId: 'R-3', count: 9 },
    evidenceRef: {
      kind: 'RULES',
      refIds: ['R-3'],
      sources: ['tradingAnalytics.getRuleAdherenceStats', 'ruleHistory.getRuleVersion'],
    },
  });
  ok(built.success);
  const i = built.insight;
  equal(i.id, 'rule-low-adherence');
  equal(i.category, 'RULE');
  equal(i.sampleSize, floor * 2);
  equal(i.sample.level, 'ADEQUATE');
  equal(i.rankable, true);
  deepEqual(i.provenance, ['tradingAnalytics.getRuleAdherenceStats', 'ruleHistory.getRuleVersion']);
  deepEqual(i.evidenceRef.refIds, ['R-3']);
  ok(i.evidence.length > 0, 'every insight states its evidence');
});

test('ranking: thin samples are returned but never labelled rankable', () => {
  const strong = makeInsight({
    id: 'strong', category: 'STRATEGY', title: 'Strategy A observed strong',
    evidence: 'Observed alongside 30 of 30 closed trades.', sampleSize: 30,
    metric: { rankValue: 2.1 },
    evidenceRef: { kind: 'TRADES', refIds: ['t1'], sources: ['tradingAnalytics.getStrategyStats'] },
  }).insight;
  const thin = makeInsight({
    id: 'thin', category: 'STRATEGY', title: 'Strategy B observed once',
    evidence: 'Observed alongside 1 of 1 closed trade.', sampleSize: 1,
    metric: { rankValue: 9.9 },
    evidenceRef: { kind: 'TRADES', refIds: ['t2'], sources: ['tradingAnalytics.getStrategyStats'] },
  }).insight;

  const ranked = qualifyForRanking([thin, strong]);
  equal(ranked.length, 2, 'thin insights are still surfaced, not hidden');
  const strongRow = ranked.find((r) => r.id === 'strong');
  const thinRow = ranked.find((r) => r.id === 'thin');
  equal(strongRow.rankable, true);
  equal(strongRow.rankingLabel, 'RANKABLE');
  equal(thinRow.rankable, false);
  equal(thinRow.rankingLabel, null, 'a one-trade sample must not be labelled a leader');
  ok(thinRow.rankingSuppressedReason.length > 0, 'suppression is explained, not silent');
});

test('ranking: a thin high-scoring insight cannot outrank a strong one for a leader claim', () => {
  const mk = (id, n, v) => makeInsight({
    id, category: 'ATTRIBUTION', title: `${id} observed`, evidence: `Observed alongside ${n} trades.`,
    sampleSize: n, metric: { rankValue: v },
    evidenceRef: { kind: 'TRADES', refIds: [id], sources: ['performanceAttribution.getAttribution'] },
  }).insight;
  const ranked = qualifyForRanking([mk('thin-huge', 2, 99), mk('strong-modest', 30, 1.2)]);
  equal(ranked[0].id, 'thin-huge', 'raw order is preserved');
  equal(ranked[0].rankable, false);
  equal(ranked[1].rankable, true, 'only the strong row may be presented as a finding');
});

test('adapter: wraps a real improvementEngine pattern without losing its fields', () => {
  const reviews = Array.from({ length: 6 }, (_, i) => ({
    id: `r-${i}`,
    mistakes: ['LATE_ENTRY'],
    strengths: [],
    processScore: { total: 70 },
    ruleAdherence: 90,
  }));
  const patterns = improvementEngine.getImprovementPatterns({ reviews });
  ok(patterns.length > 0, 'engine produced a pattern from the fixture');

  for (const pattern of patterns) {
    const wrapped = fromImprovementPattern(pattern, { reviewIds: ['r-0', 'r-1'] });
    ok(wrapped.success, `pattern ${pattern.id} must be wrappable`);
    equal(wrapped.insight.id, pattern.id);
    equal(wrapped.insight.category, pattern.category);
    equal(wrapped.insight.title, pattern.title);
    equal(wrapped.insight.evidence, pattern.evidence);
    deepEqual(wrapped.insight.metric, pattern.metric);
    deepEqual(wrapped.insight.provenance, ['improvementEngine.getImprovementPatterns']);
    deepEqual(wrapped.insight.evidenceRef.refIds, ['r-0', 'r-1']);
  }
});

test('adapter: improvementEngine still reads thresholds from models.js after consolidation', () => {
  equal(models.ANALYTICS_THRESHOLDS.lowRuleAdherence, 75);
  const reviews = Array.from({ length: 6 }, (_, i) => ({
    id: `a-${i}`, mistakes: [], strengths: [], ruleAdherence: 10, processScore: { total: 50 },
  }));
  const patterns = improvementEngine.getImprovementPatterns({ reviews });
  const adherence = patterns.find((p) => p.id === 'cohort-low-rule-adherence');
  ok(adherence, 'low-adherence cohort still detected through the shared threshold');
  equal(adherence.sampleSize, 6);
});

test('adapter: refuses malformed patterns instead of emitting a broken insight', () => {
  equal(fromImprovementPattern(null).success, false);
  equal(fromImprovementPattern({ category: 'MISTAKE' }).success, false);
});

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}