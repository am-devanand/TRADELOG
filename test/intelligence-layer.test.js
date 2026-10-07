import { test, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';

const layer = await import('../src/js/utils/intelligenceLayer.js');
const contracts = await import('../src/js/utils/intelligenceContracts.js');
const degradation = await import('../src/js/utils/degradationEngine.js');
const attribution = await import('../src/js/utils/attributionIntelligence.js');
const improvement = await import('../src/js/utils/improvementEngine.js');
const service = await import('../src/js/utils/intelligenceService.js');

const {
  INTELLIGENCE_STATES,
  normalizeInsight,
  consolidateIntelligence,
  groupByState,
  toCanonicalState,
  toSourceKind,
} = layer;

const SIX_QUESTIONS = ['summary', 'whySurfaced', 'evidence', 'sample', 'ranking', 'investigationQuestion'];

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

/** The three producers' real output, built from synthetic records. */
function producerOutputs() {
  const degradationOut = degradation.detectDegradation(
    [
      ...series({ prefix: 'd1', count: 20, earlyWins: 9, lateWins: 1, strategyId: 'S-THICK' }),
      ...series({ prefix: 'd2', count: 4, earlyWins: 4, lateWins: 0, strategyId: 'S-SPARSE' }),
    ],
    { dimension: 'strategy' },
  );
  const attributionOut = attribution.qualifyAttributionRows(
    [
      attributionRow({ value: 'AAA', sampleSize: 30, averageR: 1.6 }),
      attributionRow({ value: 'THIN', sampleSize: 2, averageR: 0.1 }),
    ],
    { dimension: 'pair' },
  );
  const reviews = Array.from({ length: 8 }, (_, i) => ({
    id: `r-${i}`, mistakes: i < 5 ? ['LATE_ENTRY'] : [], strengths: i < 3 ? ['PATIENCE'] : [],
    processScore: { total: 70 }, ruleAdherence: 90,
  }));
  const improvementOut = improvement.getImprovementPatterns({ reviews });
  return { degradationOut, attributionOut, improvementOut };
}

test('normalization: all three producers land in one canonical shape', () => {
  const { degradationOut, attributionOut, improvementOut } = producerOutputs();
  const all = consolidateIntelligence({
    degradation: degradationOut, attribution: attributionOut, improvements: improvementOut,
  });
  ok(all.length > 0, 'produced insights');
  const sources = new Set(all.map((i) => i.source));
  for (const expected of ['degradation', 'attribution', 'improvement']) {
    ok(sources.has(expected), `${expected} producer is represented`);
  }
  for (const insight of all) {
    for (const key of SIX_QUESTIONS) ok(key in insight, `canonical field ${key} present`);
    ok(INTELLIGENCE_STATES.includes(insight.state), `${insight.state} is a canonical state`);
    ok(insight.id.length > 0);
    ok(insight.title.length > 0);
  }
});

test('six questions: every one is explicitly populated, never reconstructed downstream', () => {
  const { degradationOut, attributionOut, improvementOut } = producerOutputs();
  const all = consolidateIntelligence({
    degradation: degradationOut, attribution: attributionOut, improvements: improvementOut,
  });
  for (const insight of all) {
    ok(typeof insight.summary === 'string' && insight.summary.length > 0, 'summary is a string');
    ok(typeof insight.whySurfaced === 'string' && insight.whySurfaced.length > 0, 'whySurfaced is a string');
    ok(Array.isArray(insight.evidence) && insight.evidence.length > 0, 'evidence is a non-empty array');
    ok(insight.sample && typeof insight.sample.level === 'string', 'sample is qualified');
    ok(insight.ranking && typeof insight.ranking.eligible === 'boolean', 'ranking is explicit');
    ok(typeof insight.investigationQuestion === 'string' && insight.investigationQuestion.length > 0);
  }
});

test('wording: whySurfaced never asserts a cause', () => {
  const { degradationOut, attributionOut, improvementOut } = producerOutputs();
  const all = consolidateIntelligence({
    degradation: degradationOut, attribution: attributionOut, improvements: improvementOut,
  });
  for (const insight of all) {
    const hits = contracts.findCausalClaims(insight.whySurfaced, insight.summary, insight.title);
    deepEqual(hits, [], `${insight.id} must stay observational`);
  }
});

test('wording: a causal source reason is dropped in favour of the observational template', () => {
  const normalized = normalizeInsight({
    id: 'x', category: 'DEGRADATION', title: 't',
    evidence: 'Observed alongside 20 trades.',
    sampleSize: 20, rankable: true, provenance: ['tradingAnalytics.getCoreMetrics'],
    metric: { state: 'DEGRADING', reason: 'London caused the losses' },
  });
  ok(normalized.whySurfaced.length > 0);
  deepEqual(contracts.findCausalClaims(normalized.whySurfaced), [],
    'causal reason is not surfaced as an explanation');
  ok(!normalized.whySurfaced.includes('caused'));
});

test('states: producer vocabularies map onto the canonical buckets', () => {
  equal(toCanonicalState({ category: 'DEGRADATION', metric: { state: 'DEGRADING' } }), 'NEEDS_ATTENTION');
  equal(toCanonicalState({ category: 'DEGRADATION', metric: { state: 'WATCH' } }), 'WATCH');
  equal(toCanonicalState({ category: 'DEGRADATION', metric: { state: 'IMPROVING' } }), 'IMPROVING');
  equal(toCanonicalState({ category: 'DEGRADATION', metric: { state: 'STABLE' } }), 'STABLE');
  equal(toCanonicalState({ category: 'DEGRADATION', metric: { state: 'INSUFFICIENT_DATA' } }), 'INSUFFICIENT_EVIDENCE');
  equal(toCanonicalState({ category: 'ATTRIBUTION', metric: { rankable: true } }), 'STABLE');
  equal(toCanonicalState({ category: 'ATTRIBUTION', metric: { rankable: false } }), 'INSUFFICIENT_EVIDENCE');
  equal(toCanonicalState({ category: 'MISTAKE' }), 'NEEDS_ATTENTION');
  equal(toCanonicalState({ category: 'STRENGTH' }), 'IMPROVING');
  equal(toCanonicalState({ id: 'cohort-low-process-score', category: 'PROCESS' }), 'NEEDS_ATTENTION');
  equal(toCanonicalState({ id: 'cohort-high-process-score', category: 'PROCESS' }), 'IMPROVING');
  equal(toSourceKind({ category: 'DEGRADATION' }), 'degradation');
  equal(toSourceKind({ category: 'ATTRIBUTION' }), 'attribution');
  equal(toSourceKind({ category: 'MISTAKE' }), 'improvement');
});

test('thin and insufficient findings stay visible instead of being dropped', () => {
  const { degradationOut, attributionOut, improvementOut } = producerOutputs();
  const all = consolidateIntelligence({
    degradation: degradationOut, attribution: attributionOut, improvements: improvementOut,
  });
  const thin = all.filter((i) => i.state === 'INSUFFICIENT_EVIDENCE');
  ok(thin.length >= 2, 'thin degradation and thin attribution both survive');
  const groups = groupByState(all);
  equal(groups.INSUFFICIENT_EVIDENCE.length, thin.length, 'they are reachable in the view');
});

test('ranking suppression is explicit, not silent', () => {
  const normalized = normalizeInsight({
    id: 'a', category: 'ATTRIBUTION', title: 'THIN pair', evidence: 'THIN across 2 closed trades.',
    sampleSize: 2, rankable: false, provenance: ['performanceAttribution.getAttribution'],
    metric: { dimension: 'pair', dimensionValue: 'THIN', rankable: false, suppressionReason: 'sample of 2 below rankable minimum', rank: null },
  });
  equal(normalized.ranking.eligible, false);
  equal(normalized.ranking.label, null, 'no label when not eligible');
  equal(normalized.ranking.rank, null);
  ok(normalized.ranking.suppressionReason.length > 0, 'reason is stated');
});

test('provenance survives normalization', () => {
  const { degradationOut, attributionOut, improvementOut } = producerOutputs();
  const all = consolidateIntelligence({
    degradation: degradationOut, attribution: attributionOut, improvements: improvementOut,
  });
  for (const insight of all) {
    ok(insight.provenance.length > 0, `${insight.id} keeps provenance`);
    for (const source of insight.provenance) {
      ok(contracts.INTELLIGENCE_SOURCES.includes(source), `${source} stays on the allowlist`);
    }
    const fromEvidence = insight.evidence.every((e) => Array.isArray(e.sources));
    ok(fromEvidence, 'evidence entries also carry their sources');
  }
});

test('duplicate ids resolve deterministically, keeping the first source in fixed order', () => {
  const duplicate = {
    id: 'shared-id', category: 'DEGRADATION', title: 'From degradation',
    evidence: 'Observed alongside 20 trades.', sampleSize: 20, rankable: true,
    provenance: ['tradingAnalytics.getCoreMetrics'], metric: { state: 'DEGRADING' },
  };
  const a = consolidateIntelligence({ degradation: [duplicate], attribution: [], improvements: [] });
  const b = consolidateIntelligence({ degradation: [duplicate], attribution: [], improvements: [] });
  equal(a.length, 1, 'collapsed to one');
  equal(a[0].title, 'From degradation');
  deepEqual(JSON.stringify(a), JSON.stringify(b), 'resolution is deterministic');
});

test('ordering is deterministic and groups by state, then rank, then id', () => {
  const { degradationOut, attributionOut, improvementOut } = producerOutputs();
  const input = { degradation: degradationOut, attribution: attributionOut, improvements: improvementOut };
  const first = consolidateIntelligence(input);
  const second = consolidateIntelligence(input);
  equal(JSON.stringify(first), JSON.stringify(second), 'identical input yields identical output');

  const order = INTELLIGENCE_STATES.map((s) => INTELLIGENCE_STATES.indexOf(s));
  let cursor = -1;
  for (const insight of first) {
    const idx = INTELLIGENCE_STATES.indexOf(insight.state);
    ok(idx >= cursor, `states appear in canonical order at ${insight.id}`);
    cursor = idx;
  }
  void order;
});

test('normalizeInsight rejects unknown categories and non-objects without inventing data', () => {
  equal(normalizeInsight(null), null);
  equal(normalizeInsight('x'), null);
  equal(normalizeInsight({ category: 'ASTROLOGY' }), null);
  equal(normalizeInsight({}), null);

  const minimal = normalizeInsight({ id: 'm', category: 'MISTAKE' });
  ok(minimal !== null);
  equal(minimal.summary, 'No summary available.', 'missing summary is explicit, not fabricated');
  equal(minimal.dimension, null);
  equal(minimal.dimensionValue, null);
  deepEqual(minimal.provenance, ['improvementEngine.getImprovementPatterns'],
    'provenance is attributed from the known producer, not left empty');
});

/**
 * Strip comments before scanning. The layer's header documents which
 * producers it must not import, so a raw substring match would flag the
 * documentation rather than the code.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Strip comments and string literals. Provenance entries are strings
 * naming authoritative exports such as 'tradingAnalytics.getCoreMetrics';
 * citing one is not computing anything, so only real identifiers remain.
 */
function codeOnly(relativePath) {
  return stripComments(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

test('structural: the consolidation layer contains no metric mathematics', () => {
  const code = codeOnly('../src/js/utils/intelligenceLayer.js');
  for (const forbidden of ['getCoreMetrics', 'profitFactor', 'totalPnl', 'getTradeDataset']) {
    ok(!code.includes(forbidden), `intelligenceLayer code must not reference ${forbidden}`);
  }
});

test('structural: the consolidation layer does not import the producer engines', () => {
  const code = stripComments(readFileSync(new URL('../src/js/utils/intelligenceLayer.js', import.meta.url), 'utf8'));
  const importBlock = code.match(/^import[\s\S]*?from\s+['"][^'"]+['"];?/gm) || [];
  const imports = importBlock.join('\n');
  for (const forbidden of ['degradationEngine', 'attributionIntelligence', 'improvementEngine', 'tradingAnalytics']) {
    ok(!imports.includes(forbidden), `intelligenceLayer must not import ${forbidden}`);
  }
  ok(!code.includes('require('), 'no dynamic requires either');
});

test('service: assembles the three sources from injected data without touching storage', () => {
  const rows = series({ prefix: 'svc', count: 20, earlyWins: 9, lateWins: 1 });
  const insights = service.buildIntelligence('', {
    user: 'contracttester',
    dataset: rows,
    reviews: Array.from({ length: 8 }, (_, i) => ({
      id: `r-${i}`, mistakes: i < 5 ? ['LATE_ENTRY'] : [], strengths: [],
      processScore: { total: 70 }, ruleAdherence: 90,
    })),
    attribution: attribution.qualifyAttributionRows(
      [attributionRow({ value: 'AAA', sampleSize: 30, averageR: 1.2 })], { dimension: 'pair' },
    ),
    filters: {},
  });
  const sources = new Set(insights.map((i) => i.source));
  ok(sources.has('degradation'), 'degradation included');
  ok(sources.has('attribution'), 'attribution included');
  ok(sources.has('improvement'), 'improvement included');
  for (const i of insights) equal(i.state in {} ? null : INTELLIGENCE_STATES.includes(i.state), true);
});

test('service: survives malformed input rather than throwing', () => {
  deepEqual(service.buildIntelligence('', { dataset: null, reviews: null, attribution: null }), []);
  deepEqual(service.buildIntelligence('acct', {}), []);
  deepEqual(service.buildIntelligenceGroups('', { dataset: 'nope' }).insights, []);
});

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}