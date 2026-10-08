import { test, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';

const ctx = await import('../src/js/utils/aiContextBuilder.js');
const ai = await import('../src/js/utils/aiAdapterContract.js');
const cons = await import('../src/js/utils/intelligenceConsolidation.js');
const degradation = await import('../src/js/utils/degradationEngine.js');
const attribution = await import('../src/js/utils/attributionIntelligence.js');
const improvement = await import('../src/js/utils/improvementEngine.js');

const {
  AI_CONTEXT_SCHEMA_VERSION,
  AI_CONTEXT_PURPOSE,
  AI_CONTEXT_INSTRUCTIONS,
  AI_CONTEXT_FORBIDDEN_ACTIONS,
  MAX_SOURCE_REFS_IN_CONTEXT,
  buildAiContext,
} = ctx;

const CODE = new URL('../src/js/utils/aiContextBuilder.js', import.meta.url);

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

function fixture() {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `wh-${i}`, strategyId: 'S-WATCH', outcome: i < 32 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `wr-${i}`, strategyId: 'S-WATCH', outcome: i < 31 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 4; i++) rows.push(tradeRow({ id: `sp-${i}`, strategyId: 'S-SPARSE', outcome: 'WIN' }));

  const insights = cons.consolidateInsights({
    degradation: degradation.detectDegradation(rows, { dimension: 'strategy' }),
    attribution: attribution.qualifyAttributionRows(
      [attributionRow({ value: 'AAA', sampleSize: 30, averageR: 1.2 }),
        attributionRow({ value: 'THIN', sampleSize: 2, averageR: 0.1 })],
      { dimension: 'pair' },
    ),
    improvements: improvement.getImprovementPatterns({
      reviews: Array.from({ length: 8 }, (_, i) => ({
        id: `r-${i}`, mistakes: i < 5 ? ['LATE_ENTRY'] : [], strengths: i < 3 ? ['PATIENCE'] : [],
        processScore: { total: 70 }, ruleAdherence: 90,
      })),
    }),
  });
  return insights;
}

// ---------- shape ----------

test('context: has every section the specification names', () => {
  const c = buildAiContext(fixture());
  equal(c.schemaVersion, AI_CONTEXT_SCHEMA_VERSION);
  equal(typeof c.purpose, 'string');
  ok(c.purpose.length > 0);
  ok(Array.isArray(c.instructions) && c.instructions.length > 0);
  ok(Array.isArray(c.forbiddenActions) && c.forbiddenActions.length > 0);
  ok(Array.isArray(c.insights));
  ok(Array.isArray(c.allowedNumericFacts));
  ok(c.allowedCategoricalFacts && typeof c.allowedCategoricalFacts === 'object');
});

test('context: forbidden actions state every prohibition explicitly', () => {
  const joined = AI_CONTEXT_FORBIDDEN_ACTIONS.join(' ').toLowerCase();
  for (const needed of ['state', 'upgrade evidence', 'not an allowed numeric fact', 'calculate', 'causation', 'instruction', 'rank', 'absent']) {
    ok(joined.includes(needed), `forbidden actions mention "${needed}"`);
  }
});

test('context: instructions carry the ranking distinction', () => {
  const joined = AI_CONTEXT_INSTRUCTIONS.join(' ');
  ok(joined.includes('ranking.eligible'), 'eligible is explained');
  ok(joined.includes('ranking.label'), 'label is explained');
  ok(joined.includes('weakest'), 'grounding ceiling is explained');
});

test('context: each insight carries the canonical fields plus traceability and permitted facts', () => {
  const c = buildAiContext(fixture());
  ok(c.insights.length > 0);
  for (const i of c.insights) {
    for (const k of ['id', 'category', 'source', 'title', 'state', 'summary', 'whySurfaced',
      'evidence', 'traceability', 'hasRecordEvidence', 'sample', 'ranking', 'investigationQuestion', 'provenance', 'permittedFactIds']) {
      ok(k in i, `field ${k} present`);
    }
    deepEqual(Object.keys(i.sample).sort(), ['band', 'qualificationReason', 'size', 'smallSample']);
    deepEqual(Object.keys(i.ranking).sort(), ['eligible', 'label', 'suppressionReason']);
  }
});

test('context: traceability is carried through unchanged', () => {
  const c = buildAiContext(fixture());
  const levels = new Set(c.insights.map((i) => i.traceability));
  ok(levels.has('record'), 'record level present');
  ok(levels.has('aggregate'), 'aggregate level present');
  ok(levels.has('pattern'), 'pattern level present');
  const source = fixture().reduce((acc, i) => { acc[i.source] = i.traceability; return acc; }, {});
  for (const i of c.insights) equal(i.traceability, source[i.source], 'unchanged per producer');
});

test('context: hasRecordEvidence agrees with traceability', () => {
  for (const i of buildAiContext(fixture()).insights) {
    equal(i.hasRecordEvidence, i.traceability === 'record', `${i.id} flag is consistent`);
  }
});

// ---------- minimality ----------

test('minimality: the trading dataset is never included', () => {
  const serialized = JSON.stringify(buildAiContext(fixture()));
  for (const leaked of ['rMultiple', 'openedAt', 'closedAt', 'closeReason', 'tradelog_', 'tradeSnapshot']) {
    ok(!serialized.includes(leaked), `context must not carry ${leaked}`);
  }
});

test('minimality: record ids are a bounded sample with the true total kept', () => {
  const c = buildAiContext(fixture());
  const withRecords = c.insights.filter((i) => i.traceability === 'record');
  ok(withRecords.length > 0, 'a record-level insight is present');
  for (const i of withRecords) {
    for (const e of i.evidence) {
      ok(e.sourceRecordSample.length <= MAX_SOURCE_REFS_IN_CONTEXT, 'sample is bounded');
      ok(e.sourceRecordSample.length <= e.sourceRecordCount, 'sample never exceeds the total');
      if (e.sourceRecordCount > MAX_SOURCE_REFS_IN_CONTEXT) {
        equal(e.sourceRecordsTruncated, true, 'truncation is declared, not hidden');
      }
    }
  }
});

test('minimality: long text is clipped rather than passed through whole', () => {
  const long = 'x'.repeat(5000);
  const c = buildAiContext([{ id: 'a', category: 'mistake', source: 'improvementEngine', title: long, state: 'NEEDS_ATTENTION', summary: long, whySurfaced: long, evidence: [], provenance: [] }]);
  ok(c.insights[0].title.length < long.length, 'title clipped');
  ok(c.insights[0].title.endsWith('…'), 'clipping is visible');
});

// ---------- numeric facts ----------

test('facts: every published fact is grounded in a supplied insight', () => {
  const insights = fixture();
  const c = buildAiContext(insights);
  const ids = new Set(c.insights.map((i) => i.id));
  for (const f of c.allowedNumericFacts) {
    const owner = f.id.split('.')[0];
    ok(ids.has(owner), `${f.id} belongs to an included insight`);
    ok(['exact', 'derived'].includes(f.kind));
    ok(f.permittedForms.length > 0);
    ok(f.permittedForms.includes(String(f.value)));
  }
});

test('facts: insight-level permittedFactIds match the registry', () => {
  const c = buildAiContext(fixture());
  const published = new Set(c.allowedNumericFacts.map((f) => f.id));
  for (const i of c.insights) {
    for (const id of i.permittedFactIds) {
      ok(published.has(id), `${id} is published`);
      ok(id.startsWith(`${i.id}.`), `${id} belongs to ${i.id}`);
    }
  }
});

test('facts: the context drives the contract validator end to end', () => {
  const c = buildAiContext(fixture());
  const request = ai.buildAiRequest(c.insights, { enabled: true });
  request.allowedNumericFacts = c.allowedNumericFacts;
  const record = c.insights.find((i) => i.traceability === 'record');

  const good = ai.validateAiResult({
    observations: [{ text: 'Win rate was 80.', insightIds: [record.id], groundedOn: 'record' }],
  }, request, { enabled: true });
  ok(good.success, good.violations.join(' | '));

  const bad = ai.validateAiResult({
    observations: [{ text: 'Win rate was 82.', insightIds: [record.id], groundedOn: 'record' }],
  }, request, { enabled: true });
  equal(bad.success, false, 'a figure outside the context is still rejected');
});

// ---------- selection ----------

test('selection: bounded and prioritised by state, deterministically', () => {
  const insights = fixture();
  const small = buildAiContext(insights, { maxInsights: 1 });
  equal(small.insights.length, 1);
  equal(small.selection.requested, insights.length);
  equal(small.selection.included, 1);
  deepEqual(small.insights, buildAiContext(insights, { maxInsights: 1 }).insights,
    'selection is deterministic');
});

test('selection: attention-worthy states are kept when the budget is tight', () => {
  const insights = fixture();
  const c = buildAiContext(insights, { maxInsights: 2 });
  const states = c.insights.map((i) => i.state);
  ok(states.includes('NEEDS_ATTENTION'), 'the attention state survives a tight budget');
});

// ---------- purity ----------

test('purity: deterministic output across repeated calls', () => {
  const insights = fixture();
  equal(JSON.stringify(buildAiContext(insights)), JSON.stringify(buildAiContext(insights)));
});

test('purity: the input insights are never mutated', () => {
  const insights = fixture();
  const before = JSON.stringify(insights);
  buildAiContext(insights);
  buildAiContext(insights, { maxInsights: 1 });
  equal(JSON.stringify(insights), before, 'input unchanged');
});

test('purity: the package carries no timestamp, random id or wall-clock value', () => {
  const c = buildAiContext(fixture());
  const keys = Object.keys(c);
  for (const k of keys) ok(!/time|date|generatedAt|createdAt|nonce|uuid/i.test(k), `${k} is not a clock field`);
  const serialized = JSON.stringify(c);
  ok(!/"generatedAt"/.test(serialized), 'no generation timestamp');
});

test('purity: handles junk input without throwing', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const c = buildAiContext(bad);
    equal(c.insights.length, 0);
    equal(c.allowedNumericFacts.length, 0);
  }
  const mixed = buildAiContext([null, 7, { id: 'a', category: 'mistake', title: 't', summary: 's', whySurfaced: 'w', evidence: [], provenance: [] }]);
  equal(mixed.insights.length, 1, 'usable entries survive');
});

// ---------- structural: no provider, no network, no storage ----------

test('structural: the builder imports no provider, network or storage module', () => {
  const code = readFileSync(CODE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const imports = (code.match(/^import[\s\S]*?from\s+['"][^'"]+['"];?/gm) || []).join('\n');
  for (const forbidden of ['firebase', 'executedTrades', 'tradeReviews', 'fetch', 'openai', 'anthropic', 'tradingAnalytics', 'improvementEngine', 'degradationEngine']) {
    ok(!imports.includes(forbidden), `must not import ${forbidden}`);
  }
  ok(!/\bfetch\s*\(/.test(code), 'no network call');
  ok(!/localStorage/.test(code), 'no storage access');
  ok(!/Date\.now|new Date|Math\.random/.test(code), 'no clock or randomness');
});

test('structural: the builder calculates no metrics of its own', () => {
  const code = readFileSync(CODE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const forbidden of ['getCoreMetrics', 'profitFactor', 'winRate', 'totalPnl', '/ *', 'reduce(']) {
    ok(!code.includes(forbidden), `must not contain ${forbidden}`);
  }
});

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}