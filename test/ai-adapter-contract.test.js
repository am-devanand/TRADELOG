import { test, ok, equal, deepEqual } from './helpers.js';

const ai = await import('../src/js/utils/aiAdapterContract.js');
const cons = await import('../src/js/utils/intelligenceConsolidation.js');
const degradation = await import('../src/js/utils/degradationEngine.js');
const attribution = await import('../src/js/utils/attributionIntelligence.js');
const improvement = await import('../src/js/utils/improvementEngine.js');

const {
  AI_CONTRACT_VERSION,
  AI_RESULT_SECTIONS,
  DEFAULT_AI_CONFIG,
  resolveAiConfig,
  weakestTraceability,
  collectContextNumbers,
  findFabricatedNumbers,
  findUnsupportedStateClaims,
  buildAiRequest,
  isValidProviderAdapter,
  validateAiResult,
} = ai;

let clock = 0;
function tradeRow({ id, outcome, strategyId = 'S1' }) {
  clock += 3600000;
  const r = outcome === 'WIN' ? 2 : -1;
  return {
    trade: {
      id, strategyId, pair: 'EUR/USD', session: 'London', timeframe: 'H1',
      openedAt: new Date(clock).toISOString(),
      closedAt: new Date(clock + 60000).toISOString(),
      pnl: r * 100, rMultiple: r,
    },
    review: null, outcome, pnl: r * 100, r, processScore: 70,
  };
}

function attributionRow({ value, sampleSize, averageR = 1 }) {
  return {
    dimensionValue: value, trades: sampleSize, pnl: averageR * sampleSize,
    totalR: averageR * sampleSize, averageR, winRate: 50, processScore: 70, sampleSize,
  };
}

/** Three insights: record-level WATCH, aggregate-level STABLE, pattern-level. */
function fixture() {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `wh-${i}`, strategyId: 'S-WATCH', outcome: i < 32 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `wr-${i}`, strategyId: 'S-WATCH', outcome: i < 31 ? 'WIN' : 'LOSS' }));

  const insights = cons.consolidateInsights({
    degradation: degradation.detectDegradation(rows, { dimension: 'strategy' }),
    attribution: attribution.qualifyAttributionRows(
      [attributionRow({ value: 'AAA', sampleSize: 30, averageR: 1.2 })], { dimension: 'pair' },
    ),
    improvements: improvement.getImprovementPatterns({
      reviews: Array.from({ length: 8 }, (_, i) => ({
        id: `r-${i}`, mistakes: i < 5 ? ['LATE_ENTRY'] : [], strengths: [],
        processScore: { total: 70 }, ruleAdherence: 90,
      })),
    }),
  });

  const bySource = (s) => insights.find((i) => i.source === s);
  return {
    insights,
    request: buildAiRequest(insights),
    watch: bySource('degradationEngine'),
    attr: bySource('attributionIntelligence'),
    pattern: bySource('improvementEngine'),
  };
}

const ENABLED = { enabled: true };
const okResult = (result, request, config = ENABLED) => validateAiResult(result, request, config);

// ---------- shape ----------

test('contract: fixture covers all three traceability levels and states', () => {
  const f = fixture();
  equal(f.watch.traceability, 'record');
  equal(f.watch.hasRecordEvidence, true);
  equal(f.attr.traceability, 'aggregate');
  equal(f.attr.hasRecordEvidence, false);
  equal(f.pattern.traceability, 'pattern');
  equal(f.pattern.hasRecordEvidence, false);
  equal(f.watch.state, 'WATCH');
});

test('contract: provider adapter shape is checked structurally', () => {
  equal(isValidProviderAdapter(null), false);
  equal(isValidProviderAdapter({}), false);
  equal(isValidProviderAdapter({ id: 'p' }), false);
  equal(isValidProviderAdapter({ id: 'p', isAvailable: () => true }), false);
  equal(isValidProviderAdapter({ id: 'p', generate: async () => ({}) }), false);
  ok(isValidProviderAdapter({ id: 'p', isAvailable: () => true, generate: async () => ({}) }));
});

test('config: the AI layer is disabled unless explicitly enabled', () => {
  equal(DEFAULT_AI_CONFIG.enabled, false);
  equal(resolveAiConfig().enabled, false);
  equal(resolveAiConfig({}).enabled, false);
  equal(resolveAiConfig({ enabled: 'yes' }).enabled, false, 'truthy strings do not enable it');
  equal(resolveAiConfig({ enabled: 1 }).enabled, false);
  equal(resolveAiConfig({ enabled: true }).enabled, true);
});

test('config: disabled means every result is rejected and none is returned', () => {
  const f = fixture();
  const v = okResult({ summary: 'Anything at all.' }, f.request, {});
  equal(v.success, false);
  equal(v.result, null);
  deepEqual(v.violations, ['AI layer is disabled']);
});

test('request: is deterministic, bounded and marked as generated from the deterministic layer', () => {
  const f = fixture();
  deepEqual(JSON.stringify(buildAiRequest(f.insights)), JSON.stringify(buildAiRequest(f.insights)));
  equal(buildAiRequest(f.insights).generatedFrom, 'deterministic-intelligence');
  equal(buildAiRequest(f.insights, { maxInsights: 1 }).insights.length, 1);
  equal(buildAiRequest(f.insights).policy.mayUpgradeEvidence, false);
  equal(buildAiRequest(f.insights).policy.mayRestateState, false);
  equal(buildAiRequest(f.insights).policy.rankRequires, 'ranking.label');
  equal(buildAiRequest(f.insights).policy.recordLevelReasoningRequires, 'hasRecordEvidence === true');
});

test('request: tolerates junk without throwing', () => {
  deepEqual(buildAiRequest(null).insights, []);
  deepEqual(buildAiRequest('nope').insights, []);
  deepEqual(buildAiRequest([null, 7, 'x']).insights, []);
});

// ---------- ranking distinction ----------

test('ranking: eligible never implies a rank, only a label does', () => {
  const f = fixture();
  // Degradation has no peer-ranking dimension: eligible but no rank number.
  equal(f.watch.ranking.eligible, true);
  equal(f.watch.ranking.label, 'Rankable');
  ok(!/#\d+/.test(f.watch.ranking.label), 'no peer rank exists for this insight');
  // Attribution does carry a real peer rank.
  ok(/^Rank #\d+$/.test(f.attr.ranking.label), `expected a rank label, got ${f.attr.ranking.label}`);
  equal(f.attr.ranking.eligible, true);
});

// ---------- grounding: evidence can never be upgraded ----------

test('grounding: weakest cited traceability caps the claim', () => {
  const f = fixture();
  equal(weakestTraceability([f.watch, f.attr]), 'aggregate');
  equal(weakestTraceability([f.watch]), 'record');
  equal(weakestTraceability([f.attr, f.pattern]), 'pattern');
  equal(weakestTraceability([f.watch, f.attr, f.pattern]), 'pattern');
  equal(weakestTraceability([]), null);
});

test('grounding: a single record citation cannot carry a mixed aggregate claim', () => {
  const f = fixture();
  // Regression guard: citing one record-level insight alongside an aggregate
  // one must not upgrade the claim to record, because the weakest citation
  // caps what may be asserted.
  const v = okResult({
    observations: [{
      text: 'The windows and the grouped figures both moved.',
      insightIds: [f.watch.id, f.attr.id],
      groundedOn: 'record',
    }],
  }, f.request);
  equal(v.success, false, 'the aggregate citation caps the claim at aggregate');
  ok(v.violations[0].includes('aggregate-level evidence'), v.violations[0]);
});

test('grounding: a mixed record and pattern claim caps at pattern', () => {
  const f = fixture();
  const v = okResult({
    observations: [{
      text: 'The repeated observation and the windows line up.',
      insightIds: [f.watch.id, f.pattern.id],
      groundedOn: 'record',
    }],
  }, f.request);
  equal(v.success, false, 'the pattern citation caps the claim at pattern');
});

test('grounding: record-level claim on aggregate evidence is rejected', () => {
  const f = fixture();
  const v = okResult({
    observations: [{ text: 'Individual trades show the shift.', insightIds: [f.attr.id], groundedOn: 'record' }],
  }, f.request);
  equal(v.success, false);
  ok(v.violations[0].includes('record grounding'), v.violations[0]);
});

test('grounding: record-level claim on pattern evidence is rejected', () => {
  const f = fixture();
  const v = okResult({
    observations: [{ text: 'These trades demonstrate the pattern.', insightIds: [f.pattern.id], groundedOn: 'record' }],
  }, f.request);
  equal(v.success, false);
  ok(v.violations[0].includes('record grounding'), v.violations[0]);
});

test('grounding: record-level claim is allowed on record evidence', () => {
  const f = fixture();
  const v = okResult({
    observations: [{ text: 'The compared windows show a smaller profit factor.', insightIds: [f.watch.id], groundedOn: 'record' }],
  }, f.request);
  ok(v.success, v.violations.join(' | '));
  equal(v.result.observations[0].groundedOn, 'record');
  equal(v.result.observations[0].status, 'observed');
});

test('grounding: a claim may be weaker than its evidence, never stronger', () => {
  const f = fixture();
  const v = okResult({
    observations: [{ text: 'The grouped figures moved.', insightIds: [f.watch.id], groundedOn: 'aggregate' }],
  }, f.request);
  ok(v.success, v.violations.join(' | '));
  equal(v.result.observations[0].groundedOn, 'aggregate');
});

test('grounding: an observation citing nothing known is rejected', () => {
  const f = fixture();
  equal(okResult({ observations: [{ text: 'Something.', insightIds: ['missing-id'] }] }, f.request).success, false);
  equal(okResult({ observations: [{ text: 'Something.' }] }, f.request).success, false);
});

// ---------- state may not be restated or upgraded ----------

test('state: WATCH cannot be narrated as degrading', () => {
  const f = fixture();
  for (const phrase of ['degrading', 'degraded', 'getting worse', 'deteriorating']) {
    const v = okResult({
      observations: [{ text: `This strategy is ${phrase}.`, insightIds: [f.watch.id], groundedOn: 'record' }],
    }, f.request);
    equal(v.success, false, `"${phrase}" must be rejected`);
    ok(v.violations[0].includes('restates a state'), v.violations[0]);
  }
});

test('state: a claim matching a real cited state is allowed', () => {
  const f = fixture();
  const v = okResult({
    observations: [{ text: 'This area is worth watching rather than acting on.', insightIds: [f.watch.id], groundedOn: 'record' }],
  }, f.request);
  ok(v.success, v.violations.join(' | '));
});

test('state: the result may not carry its own state or verdict', () => {
  const f = fixture();
  for (const key of ['state', 'states', 'verdict', 'verdicts', 'score']) {
    const v = okResult({ [key]: 'DEGRADED' }, f.request);
    equal(v.success, false, `${key} must be rejected`);
    ok(v.violations.some((x) => x.includes(key)));
  }
});

test('state: unknown sections are rejected', () => {
  const f = fixture();
  const v = okResult({ summary: 'ok', recommendations: ['do something'] }, f.request);
  equal(v.success, false);
  ok(v.violations.some((x) => x.includes('unknown section')));
});

// ---------- anti-fabrication ----------

test('fabrication: numbers absent from the package are rejected', () => {
  const f = fixture();
  const allowed = collectContextNumbers(f.request.insights);
  deepEqual(findFabricatedNumbers('profit factor moved from 8 to 6.89', allowed), []);
  deepEqual(findFabricatedNumbers('win rate reached 87 percent', allowed), ['87']);
  const v = okResult({
    observations: [{ text: 'Win rate reached 87 percent.', insightIds: [f.watch.id], groundedOn: 'record' }],
  }, f.request);
  equal(v.success, false);
  ok(v.violations[0].includes('invents figures'), v.violations[0]);
});

test('fabrication: the summary is held to the same numeric rule', () => {
  const f = fixture();
  equal(okResult({ summary: 'Aggregate win rate is 50 across the slice.' }, f.request).success, true);
  equal(okResult({ summary: 'Aggregate win rate is 92 across the slice.' }, f.request).success, false);
});

test('fabrication: numbers present anywhere in the package are permitted', () => {
  const allowed = collectContextNumbers([
    { id: 'x', sample: { size: 40 }, evidence: [{ description: '80 vs 77.5' }], ranking: { rank: 3 } },
  ]);
  for (const n of ['40', '80', '77.5', '3']) ok(allowed.has(n), `${n} collected`);
  deepEqual(findFabricatedNumbers('80 compared with 77.5 across 40 records', allowed), []);
});

// ---------- prohibitions ----------

test('prohibition: causal claims are rejected in every section', () => {
  const f = fixture();
  equal(okResult({ summary: 'The window change caused lower returns.' }, f.request).success, false);
  equal(okResult({ observations: [{ text: 'Late entries caused the decline.', insightIds: [f.watch.id], groundedOn: 'record' }] }, f.request).success, false);
  equal(okResult({ possibleHypotheses: [{ text: 'This was caused by regime change.', insightIds: [f.watch.id], groundedOn: 'record' }] }, f.request).success, false);
});

test('prohibition: trading instructions are rejected', () => {
  const f = fixture();
  for (const phrase of ['stop trading this', 'increase your stop loss', 'you should avoid this setup', 'recommend reducing risk']) {
    const v = okResult({
      observations: [{ text: `You should ${phrase}.`, insightIds: [f.watch.id], groundedOn: 'record' }],
    }, f.request);
    equal(v.success, false, `"${phrase}" must be rejected`);
    ok(v.violations[0].includes('instruction'), v.violations[0]);
  }
});

test('prohibition: questions must be phrased as questions and carry no instruction', () => {
  const f = fixture();
  const good = okResult({ questionsToInvestigate: ['Is this concentrated in one session?'] }, f.request);
  ok(good.success, good.violations.join(' | '));
  equal(okResult({ questionsToInvestigate: ['Increase your position size'] }, f.request).success, false);
  equal(okResult({ questionsToInvestigate: ['Stop trading this strategy'] }, f.request).success, false);
});

test('prohibition: hypotheses are always marked unverified', () => {
  const f = fixture();
  const v = okResult({
    possibleHypotheses: [{ text: 'Market regime may differ between the windows.', insightIds: [f.watch.id], groundedOn: 'aggregate' }],
  }, f.request);
  ok(v.success, v.violations.join(' | '));
  equal(v.result.possibleHypotheses[0].status, 'unverified');
});

// ---------- robustness ----------

test('robustness: malformed results are rejected without throwing', () => {
  const f = fixture();
  for (const bad of [null, undefined, 'text', 42, []]) {
    equal(okResult(bad, f.request).success, false, `${String(bad)} rejected`);
  }
  equal(okResult({}, null).success, false);
  equal(okResult({}, {}).success, false);
});

test('robustness: output item counts are bounded', () => {
  const f = fixture();
  const many = Array.from({ length: 30 }, () => ({ text: 'A grouped figure moved.', insightIds: [f.attr.id], groundedOn: 'aggregate' }));
  const v = okResult({ observations: many }, f.request);
  equal(v.success, false);
  ok(v.violations.some((x) => x.includes('maxOutputItems')));
});

test('robustness: a validated result carries only the allowed sections', () => {
  const f = fixture();
  const v = okResult({
    summary: 'The grouped figures moved.',
    observations: [{ text: 'The grouped figures moved.', insightIds: [f.attr.id], groundedOn: 'aggregate' }],
    questionsToInvestigate: ['Is this concentrated in one session?'],
    possibleHypotheses: [{ text: 'Sample composition may differ.', insightIds: [f.attr.id], groundedOn: 'aggregate' }],
  }, f.request);
  ok(v.success, v.violations.join(' | '));
  deepEqual(Object.keys(v.result).sort(), [...AI_RESULT_SECTIONS, 'contractVersion'].sort());
  equal(v.result.contractVersion, AI_CONTRACT_VERSION);
});

test('robustness: one violation invalidates the whole answer rather than sanitizing it', () => {
  const f = fixture();
  const v = okResult({
    summary: 'A perfectly reasonable summary.',
    observations: [
      { text: 'A legitimate observation.', insightIds: [f.watch.id], groundedOn: 'record' },
      { text: 'You should stop trading this.', insightIds: [f.watch.id], groundedOn: 'record' },
    ],
  }, f.request);
  equal(v.success, false, 'a partially bad answer is rejected entirely');
  equal(v.result, null, 'no partial result is returned');
});

test('robustness: deterministic inputs produce deterministic validation', () => {
  const f = fixture();
  const result = {
    summary: 'The grouped figures moved.',
    observations: [{ text: 'The grouped figures moved.', insightIds: [f.attr.id], groundedOn: 'aggregate' }],
  };
  equal(JSON.stringify(okResult(result, f.request)), JSON.stringify(okResult(result, f.request)));
});

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}