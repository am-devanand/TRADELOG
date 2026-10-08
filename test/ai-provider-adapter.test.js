import { test, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';

const adapter = await import('../src/js/utils/aiProviderAdapter.js');
const mock = await import('../src/js/utils/aiMockProvider.js');
const cons = await import('../src/js/utils/intelligenceConsolidation.js');
const degradation = await import('../src/js/utils/degradationEngine.js');
const attribution = await import('../src/js/utils/attributionIntelligence.js');
const improvement = await import('../src/js/utils/improvementEngine.js');
const contextBuilder = await import('../src/js/utils/aiContextBuilder.js');

const { AI_OUTCOMES, ADAPTER_PROHIBITIONS, buildPrompt, parseResponse, runAiProvider } = adapter;
const { SCENARIOS, createMockProvider, validScenario } = mock;


// Violations are { code, message } objects; these assertions read the human
// message while the code is asserted separately.
function messages(result) {
  return (result.violations || []).map((v) => (v && v.message !== undefined ? v.message : String(v))).join(' ');
}
const ADAPTER_CODE = new URL('../src/js/utils/aiProviderAdapter.js', import.meta.url);
const MOCK_CODE = new URL('../src/js/utils/aiMockProvider.js', import.meta.url);
const PAGE_CODE = new URL('../src/js/pages/intelligence.js', import.meta.url);

const ENABLED = { enabled: true };

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
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `a-h-${i}`, strategyId: 'S-WATCH', outcome: i < 32 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `a-r-${i}`, strategyId: 'S-WATCH', outcome: i < 31 ? 'WIN' : 'LOSS' }));

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
  return insights;
}

// Named distinctly from the exported run() suite entry point below.
const runWith = (provider, config = ENABLED, insights = fixture()) =>
  runAiProvider({ insights, provider, config });

// ---------- the required proofs ----------

test('proof: a valid response is accepted', async () => {
  const r = await runWith(createMockProvider({ scenario: 'valid' }));
  equal(r.outcome, 'ok');
  equal(r.success, true);
  ok(r.result !== null, 'a result is returned');
  ok(r.result.observations.length > 0, 'observations survived');
});

test('proof: a missing factId is rejected', async () => {
  const r = await runWith(createMockProvider({ scenario: 'missingFactId' }));
  equal(r.outcome, 'rejected');
  equal(r.result, null, 'no partial result is returned');
  ok(r.violations.length > 0, 'the violation is reported');
});

test('proof: an unknown factId is rejected', async () => {
  equal((await runWith(createMockProvider({ scenario: 'wrongFactId' }))).outcome, 'rejected');
});

test('proof: a figure attached to the wrong metric is rejected', async () => {
  const r = await runWith(createMockProvider({ scenario: 'wrongMetric' }));
  equal(r.outcome, 'rejected');
  ok(messages(r).includes('metric') || messages(r).includes('covered'),
    messages(r))
});

test('proof: a direction claim without a matching sign is rejected', async () => {
  const r = await runWith(createMockProvider({ scenario: 'wrongSign' }));
  equal(r.outcome, 'rejected');
  ok(messages(r).includes('decline'), messages(r))
});

test('proof: an invented number is rejected', async () => {
  equal((await runWith(createMockProvider({ scenario: 'inventedNumber' }))).outcome, 'rejected');
});

test('proof: a causal claim is rejected', async () => {
  const r = await runWith(createMockProvider({ scenario: 'causalClaim' }));
  equal(r.outcome, 'rejected');
  ok(messages(r).includes('causation'), messages(r))
});

test('proof: a trading instruction is rejected', async () => {
  const r = await runWith(createMockProvider({ scenario: 'tradingInstruction' }));
  equal(r.outcome, 'rejected');
  ok(messages(r).includes('instruction'), messages(r))
});

test('proof: an unsupported state claim is rejected', async () => {
  equal((await runWith(createMockProvider({ scenario: 'unsupportedState' }))).outcome, 'rejected');
});

test('proof: a self-assigned verdict is rejected', async () => {
  const r = await runWith(createMockProvider({ scenario: 'selfAssignedState' }));
  equal(r.outcome, 'rejected');
  ok(messages(r).includes('owns it'), messages(r))
});

test('proof: a record-level claim on pattern evidence is rejected', async () => {
  equal((await runWith(createMockProvider({ scenario: 'recordGroundingUpgrade' }))).outcome, 'rejected');
});

test('proof: an unknown section is rejected', async () => {
  equal((await runWith(createMockProvider({ scenario: 'unknownSection' }))).outcome, 'rejected');
});

test('proof: every catalogue scenario is rejected, none leaks', async () => {
  for (const name of Object.keys(SCENARIOS)) {
    const r = await runWith(createMockProvider({ scenario: name }));
    equal(r.outcome, 'rejected', `${name} must be rejected`);
    equal(r.result, null, `${name} must not return a result`);
  }
});

// ---------- outcome codes ----------

test('outcomes: the documented set is what the adapter actually returns', async () => {
  const seen = new Set();
  seen.add((await runWith(createMockProvider({ scenario: 'valid' }))).outcome);
  seen.add((await runWith(createMockProvider({ scenario: 'causalClaim' }))).outcome);
  seen.add((await runAiProvider({ insights: fixture(), config: {}, provider: createMockProvider({}) })).outcome);
  seen.add((await runWith(createMockProvider({ scenario: 'valid', available: false }))).outcome);
  seen.add((await runWith(createMockProvider({ scenario: 'valid', mode: 'throw' }))).outcome);
  for (const code of seen) ok(AI_OUTCOMES.includes(code), `${code} is documented`);
  equal(seen.size, 5, 'all five outcomes are reachable');
});

test('outcomes: disabled, unavailable, errored and rejected are distinguishable', async () => {
  equal((await runAiProvider({ insights: fixture(), config: {}, provider: createMockProvider({}) })).outcome, 'disabled');
  equal((await runWith(createMockProvider({ available: false }))).outcome, 'unavailable');
  equal((await runAiProvider({ insights: fixture(), config: ENABLED })).outcome, 'unavailable');
  equal((await runWith(createMockProvider({ mode: 'throw' }))).outcome, 'provider_error');
  equal((await runWith(createMockProvider({ scenario: 'causalClaim' }))).outcome, 'rejected');
});

test('outcomes: only a validated response carries a result', async () => {
  for (const outcomeName of ['disabled', 'unavailable', 'provider_error', 'rejected']) {
    const provider = outcomeName === 'unavailable'
      ? createMockProvider({ available: false })
      : outcomeName === 'provider_error'
        ? createMockProvider({ mode: 'throw' })
        : outcomeName === 'rejected'
          ? createMockProvider({ scenario: 'causalClaim' })
          : createMockProvider({ scenario: 'valid' });
    const config = outcomeName === 'disabled' ? {} : ENABLED;
    const r = await runWith(provider, config);
    equal(r.success, false, `${outcomeName} is not a success`);
    equal(r.result, null, `${outcomeName} carries no result`);
  }
});

// ---------- prompt ----------

test('prompt: states the factId requirement and the no-calculation rule', async () => {
  const insights = fixture();
  const context = contextBuilder.buildAiContext(insights);
  const prompt = buildPrompt(context);
  for (const needed of ['must cite one or more permitted factIds',
    'without a factId is invalid',
    'Do not calculate, round, interpolate, estimate or derive',
    'directly supports the claim',
    'another metric']) {
    ok(prompt.includes(needed), `prompt states "${needed}"`);
  }
});

test('prompt: states the ranking and traceability rules', async () => {
  const context = contextBuilder.buildAiContext(fixture());
  const prompt = buildPrompt(context);
  ok(prompt.includes('Do not infer a ranking from ranking.eligible'), 'eligible is not a rank');
  ok(prompt.includes('Only ranking.label represents an actual rank'), 'label is the rank');
  ok(prompt.includes('aggregate evidence supports aggregate statements only'), 'traceability rule stated');
});

test('prompt: carries the findings, states and permitted facts', async () => {
  const insights = fixture();
  const context = contextBuilder.buildAiContext(insights);
  const prompt = buildPrompt(context);
  ok(prompt.includes('Permitted numeric facts:'), 'facts section present');
  ok(prompt.includes('Findings:'), 'findings section present');
  for (const i of context.insights) {
    ok(prompt.includes(`id=${i.id}`), `${i.id} is in the prompt`);
    ok(prompt.includes(`state=${i.state ?? 'unavailable'}`), `${i.id} carries its state`);
  }
  equal(buildPrompt(context), buildPrompt(context), 'prompt building is deterministic');
  equal(buildPrompt(null), '', 'junk context yields an empty prompt, not a throw');
});

// ---------- parsing ----------

test('parsing: accepts an object or a JSON string and refuses everything else', () => {
  ok(parseResponse({ a: 1 }).success);
  ok(parseResponse('{"a":1}').success);
  for (const bad of [null, undefined, '', '   ', '{ not json', '[1,2]', 42, true]) {
    equal(parseResponse(bad).success, false, `${String(bad)} refused`);
  }
});

test('parsing: unparseable output is a rejection, never partially recovered', async () => {
  for (const mode of ['malformed', 'notObject', 'empty', 'null']) {
    const r = await runWith(createMockProvider({ scenario: 'valid', mode }));
    equal(r.outcome, 'rejected', `mode ${mode} rejected`);
    equal(r.result, null);
  }
  equal((await runWith(createMockProvider({ scenario: 'valid', mode: 'json' }))).outcome, 'ok',
    'well-formed JSON is accepted');
});

// ---------- the adapter boundary ----------

test('boundary: the adapter never calculates, queries storage or reaches the domain', () => {
  const code = readFileSync(ADAPTER_CODE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const imports = (code.match(/^import[\s\S]*?from\s+['"][^'"]+['"];?/gm) || []).join('\n');
  for (const forbidden of ['tradingAnalytics', 'degradationEngine', 'improvementEngine',
    'attributionIntelligence', 'executedTrades', 'tradeReviews', 'ruleHistory', 'propEngine',
    'firebase', 'storage.js', 'getCoreMetrics', 'profitFactor']) {
    ok(!imports.includes(forbidden), `adapter must not import ${forbidden}`);
  }
  ok(!/localStorage|sessionStorage|getItem\(|setItem\(/.test(code), 'no storage access');
  ok(!/\bfetch\(|XMLHttpRequest|axios/.test(code), 'no network in the adapter itself');
  ok(!/Math\.(round|floor|ceil)\(/.test(code), 'no rounding of values');
});

test('boundary: the prohibitions are documented', () => {
  const joined = ADAPTER_PROHIBITIONS.join(' ').toLowerCase();
  for (const needed of ['metric', 'storage', 'firebase', 'trade', 'rule', 'risk', 'prop', 'trading decision', 'repair']) {
    ok(joined.includes(needed), `prohibitions mention ${needed}`);
  }
});

test('boundary: the mock provider is deterministic and offline', () => {
  const code = readFileSync(MOCK_CODE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  ok(!/\bfetch\(|XMLHttpRequest/.test(code), 'no network');
  ok(!/setTimeout|setInterval/.test(code), 'no timers');
  ok(!/Math\.random/.test(code), 'no randomness');
  ok(!/Date\.now|new Date\(/.test(code), 'no clock');
});

test('boundary: buildAiContext stays provider-agnostic', () => {
  const code = readFileSync(new URL('../src/js/utils/aiContextBuilder.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  ok(!/provider|mock|generate\(|prompt/i.test(code), 'no provider concept in the context builder');
});

test('boundary: the intelligence page has no dependency on any AI module', () => {
  const code = readFileSync(PAGE_CODE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // intelligenceService is 10D's loader and is expected. Only the AI modules
  // must be absent, so the deterministic view never depends on them.
  ok(code.includes('intelligenceService'), 'the page still uses the 10D loader');
  for (const forbidden of ['aiAdapterContract', 'aiContextBuilder', 'aiProviderAdapter', 'aiMockProvider']) {
    ok(!code.includes(forbidden), `intelligence page must not import ${forbidden}`);
  }
});

test('boundary: intelligenceService stays free of the AI layer', () => {
  const code = readFileSync(new URL('../src/js/utils/intelligenceService.js', import.meta.url), 'utf8');
  for (const forbidden of ['aiAdapterContract', 'aiContextBuilder', 'aiProviderAdapter']) {
    ok(!code.includes(forbidden), `intelligenceService must not import ${forbidden}`);
  }
});

// ---------- resilience ----------

test('resilience: nothing here throws, whatever the provider does', async () => {
  const throwing = {
    id: 'bad', isAvailable: () => { throw new Error('down'); }, generate: () => ({}) };
  equal((await runWith(throwing)).outcome, 'unavailable');

  const badGenerate = {
    id: 'bad2', isAvailable: () => true, generate: () => { throw new Error('boom'); } };
  equal((await runWith(badGenerate)).outcome, 'provider_error');

  for (const bad of [null, undefined, 42, 'x', {}, { id: 'x' }]) {
    equal((await runWith(bad)).outcome, 'unavailable', `${String(bad)} handled`);
  }
});

test('resilience: empty and junk insight sets are handled', async () => {
  equal((await runWith(createMockProvider({ scenario: 'valid' }), ENABLED, [])).outcome, 'ok');
  equal((await runWith(createMockProvider({ scenario: 'valid' }), ENABLED, null)).outcome, 'ok');
});

test('resilience: a provider claiming availability with a non-boolean is not trusted', async () => {
  const odd = { id: 'o', isAvailable: () => 'yes', generate: () => ({}) };
  equal((await runWith(odd)).outcome, 'unavailable', 'only a strict true counts as available');
});

test('determinism: identical input yields an identical result', async () => {
  const insights = fixture();
  const a = await runWith(createMockProvider({ scenario: 'valid' }), ENABLED, insights);
  const b = await runWith(createMockProvider({ scenario: 'valid' }), ENABLED, fixture());
  equal(JSON.stringify(a), JSON.stringify(b));
  const failed = await runWith(createMockProvider({ scenario: 'causalClaim' }), ENABLED, insights);
  const failedAgain = await runWith(createMockProvider({ scenario: 'causalClaim' }), ENABLED, fixture());
  equal(JSON.stringify(failed.violations), JSON.stringify(failedAgain.violations));
});

test('validScenario: the compliant answer cites facts for every figure it states', () => {
  const insights = fixture();
  const context = contextBuilder.buildAiContext(insights);
  const answer = validScenario({ context });
  for (const o of answer.observations) {
    const hasFigure = /\d/.test(o.text);
    equal(hasFigure ? o.factIds.length > 0 : true, true,
      `figure in "${o.text}" must cite a fact`);
  }
  deepEqual(Object.keys(answer).sort(), ['observations', 'possibleHypotheses', 'questionsToInvestigate', 'summary']);
});

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}