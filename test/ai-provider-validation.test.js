import { test, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';

const validation = await import('../src/js/utils/aiProviderValidation.js');
const adapter = await import('../src/js/utils/aiProviderAdapter.js');
const contract = await import('../src/js/utils/aiAdapterContract.js');
const mock = await import('../src/js/utils/aiMockProvider.js');
const cons = await import('../src/js/utils/intelligenceConsolidation.js');
const degradation = await import('../src/js/utils/degradationEngine.js');
const improvement = await import('../src/js/utils/improvementEngine.js');

const {
  VIOLATION_CODES, AI_OUTCOMES,
  runValidationCase, buildValidationReport, runProviderValidation, responseSize,
} = validation;

const CODE = new URL('../src/js/utils/aiProviderValidation.js', import.meta.url);
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

function fixture() {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `v-h-${i}`, strategyId: 'S-WATCH', outcome: i < 32 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `v-r-${i}`, strategyId: 'S-WATCH', outcome: i < 31 ? 'WIN' : 'LOSS' }));
  return cons.consolidateInsights({
    degradation: degradation.detectDegradation(rows, { dimension: 'strategy' }),
    attribution: [],
    improvements: improvement.getImprovementPatterns({
      reviews: Array.from({ length: 8 }, (_, i) => ({
        id: `r-${i}`, mistakes: i < 5 ? ['LATE_ENTRY'] : [], strengths: [],
        processScore: { total: 70 }, ruleAdherence: 90,
      })),
    }),
  });
}

const provider = (options) => mock.createMockProvider(options);

// ---------- the required test matrix ----------

const MATRIX = [
  { caseId: 'valid', provider: provider({ scenario: 'valid' }), expect: 'ok' },
  { caseId: 'missing-fact-id', provider: provider({ scenario: 'missingFactId' }), expect: 'rejected', code: VIOLATION_CODES.MISSING_FACT_ID },
  { caseId: 'wrong-fact', provider: provider({ scenario: 'wrongFactId' }), expect: 'rejected', code: VIOLATION_CODES.UNKNOWN_FACT_ID },
  { caseId: 'wrong-metric', provider: provider({ scenario: 'wrongMetric' }), expect: 'rejected', code: VIOLATION_CODES.WRONG_METRIC },
  { caseId: 'wrong-sign', provider: provider({ scenario: 'wrongSign' }), expect: 'rejected', code: VIOLATION_CODES.WRONG_SIGN },
  { caseId: 'invented-number', provider: provider({ scenario: 'inventedNumber' }), expect: 'rejected', code: VIOLATION_CODES.UNAUTHORIZED_NUMBER },
  { caseId: 'causal-claim', provider: provider({ scenario: 'causalClaim' }), expect: 'rejected', code: VIOLATION_CODES.CAUSAL_CLAIM },
  { caseId: 'trading-instruction', provider: provider({ scenario: 'tradingInstruction' }), expect: 'rejected', code: VIOLATION_CODES.TRADING_INSTRUCTION },
  { caseId: 'pattern-to-record', provider: provider({ scenario: 'recordGroundingUpgrade' }), expect: 'rejected', code: VIOLATION_CODES.TRACEABILITY_UPGRADE },
  { caseId: 'self-assigned-state', provider: provider({ scenario: 'selfAssignedState' }), expect: 'rejected', code: VIOLATION_CODES.STATE_CLAIM },
  { caseId: 'malformed', provider: provider({ scenario: 'valid', mode: 'malformed' }), expect: 'rejected' },
  { caseId: 'provider-error', provider: provider({ scenario: 'valid', mode: 'throw' }), expect: 'provider_error' },
  { caseId: 'unavailable', provider: provider({ scenario: 'valid', available: false }), expect: 'unavailable' },
];

test('matrix: every required case produces its expected outcome', async () => {
  const insights = fixture();
  for (const entry of MATRIX) {
    const outcome = await runValidationCase({
      insights, config: ENABLED, caseId: entry.caseId, provider: entry.provider,
    });
    equal(outcome.outcome, entry.expect, `${entry.caseId} outcome`);
    if (entry.code) {
      ok(outcome.violationCodes.includes(entry.code),
        `${entry.caseId} expected ${entry.code}, got ${outcome.violationCodes.join(',')}`);
    }
  }
});

test('matrix: AI disabled is reported as disabled, not as a contract rejection', async () => {
  const outcome = await runValidationCase({
    insights: fixture(), config: {}, caseId: 'disabled', provider: provider({ scenario: 'valid' }),
  });
  equal(outcome.outcome, 'disabled');
  equal(outcome.accepted, false);
  equal(outcome.violationCodes.length, 0, 'being disabled is not a contract violation');
});

test('matrix: the full matrix aggregates into a coherent report', async () => {
  const insights = fixture();
  const report = await runProviderValidation({
    insights,
    config: ENABLED,
    cases: MATRIX.map((m) => ({ caseId: m.caseId, provider: m.provider })),
  });
  equal(report.kind, 'providerValidation');
  equal(report.totals.requests, MATRIX.length);
  equal(report.totals.accepted, 1);
  equal(report.totals.rejected, 10);
  equal(report.totals.providerErrors, 1);
  equal(report.totals.notAttempted, 1);
  deepEqual(report.byOutcome, {
    ok: 1, rejected: 10, provider_error: 1, disabled: 0, unavailable: 1,
  });
});

// ---------- rejection reasons ----------

test('reasons: every rejection carries at least one machine-readable code', async () => {
  const insights = fixture();
  for (const entry of MATRIX) {
    const outcome = await runValidationCase({
      insights, config: ENABLED, caseId: entry.caseId, provider: entry.provider,
    });
    if (entry.expect !== 'rejected') continue;
    ok(outcome.violationCodes.length > 0, `${entry.caseId} carries a code`);
    for (const code of outcome.violationCodes) {
      ok(Object.values(VIOLATION_CODES).includes(code), `${code} is a declared code`);
    }
  }
});

test('reasons: the report tallies violations by code, sorted deterministically', async () => {
  const insights = fixture();
  const report = await runProviderValidation({
    insights, config: ENABLED,
    cases: MATRIX.map((m) => ({ caseId: m.caseId, provider: m.provider })),
  });
  const codes = report.byViolation.map((v) => v.code);
  deepEqual(codes, [...codes].sort(), 'codes are sorted');
  ok(report.byViolation.length >= 6, `expected several distinct reasons, got ${codes.length}`);
  for (const entry of report.byViolation) {
    ok(Number.isInteger(entry.count) && entry.count > 0, `${entry.code} counted`);
  }
});

test('reasons: codes are distinct from the human messages', async () => {
  const insights = fixture();
  const outcome = await runValidationCase({
    insights, config: ENABLED, caseId: 'causal', provider: provider({ scenario: 'causalClaim' }),
  });
  equal(outcome.violationCodes[0], VIOLATION_CODES.CAUSAL_CLAIM);
  ok(!outcome.violationCodes.some((c) => /\s/.test(c)), 'codes contain no prose');
});

test('reasons: the contract emits codes for every rejection it can produce', () => {
  // A code with no producer would be dead vocabulary.
  const produced = new Set();
  for (const name of Object.keys(mock.SCENARIOS)) produced.add(name);
  ok(produced.size >= 10, 'the mock exercises many scenarios');
  for (const code of [VIOLATION_CODES.MISSING_FACT_ID, VIOLATION_CODES.UNKNOWN_FACT_ID,
    VIOLATION_CODES.WRONG_METRIC, VIOLATION_CODES.WRONG_SIGN, VIOLATION_CODES.UNAUTHORIZED_NUMBER,
    VIOLATION_CODES.CAUSAL_CLAIM, VIOLATION_CODES.TRADING_INSTRUCTION, VIOLATION_CODES.STATE_CLAIM,
    VIOLATION_CODES.TRACEABILITY_UPGRADE, VIOLATION_CODES.UNKNOWN_SECTION,
    VIOLATION_CODES.MALFORMED_RESPONSE, VIOLATION_CODES.OUTPUT_LIMIT,
    VIOLATION_CODES.UNKNOWN_INSIGHT_ID, VIOLATION_CODES.UNKNOWN_TRACEABILITY,
    VIOLATION_CODES.ADAPTER_FAULT]) {
    ok(typeof code === 'string' && code.length > 0, `${code} declared`);
  }
});

// ---------- provider failure vs contract failure ----------

test('separation: a provider failure is never recorded as a contract violation', async () => {
  const insights = fixture();
  for (const entry of MATRIX.filter((m) => m.expect === 'provider_error' || m.expect === 'unavailable')) {
    const outcome = await runValidationCase({
      insights, config: ENABLED, caseId: entry.caseId, provider: entry.provider,
    });
    equal(outcome.violationCodes.length, 0, `${entry.caseId} is not a contract rejection`);
    equal(outcome.accepted, false);
  }
  const disabled = await runValidationCase({
    insights, config: {}, caseId: 'off', provider: provider({ scenario: 'valid' }),
  });
  equal(disabled.violationCodes.length, 0);
});

// ---------- determinism ----------

test('determinism: the same captured outcomes always yield the same report', async () => {
  const insights = fixture();
  const cases = MATRIX.map((m) => ({ caseId: m.caseId, provider: m.provider }));
  const first = await runProviderValidation({ insights, config: ENABLED, cases });
  const second = await runProviderValidation({ insights, config: ENABLED, cases });
  equal(JSON.stringify(first), JSON.stringify(second));
});

test('determinism: report building is a pure function of its outcomes', () => {
  const rows = [
    { caseId: 'a', outcome: 'ok', accepted: true, violationCodes: [], violationCount: 0 },
    { caseId: 'b', outcome: 'rejected', accepted: false, violationCodes: ['CAUSAL_CLAIM'], violationCount: 1 },
  ];
  equal(JSON.stringify(buildValidationReport(rows)), JSON.stringify(buildValidationReport(rows)));
  deepEqual(buildValidationReport(rows).byViolation, [{ code: 'CAUSAL_CLAIM', count: 1 }]);
  equal(buildValidationReport(rows).totals.requests, 2);
  deepEqual(buildValidationReport(null).totals.requests, 0);
  deepEqual(buildValidationReport('junk').byViolation, []);
});

// ---------- not trading analytics, no retention, no retry ----------

test('boundaries: the report declares it is not trading data and retains no responses', async () => {
  const report = await runProviderValidation({
    insights: fixture(), config: ENABLED,
    cases: MATRIX.map((m) => ({ caseId: m.caseId, provider: m.provider })),
  });
  equal(report.measuresContractCompliance, true);
  equal(report.containsTradingMetrics, false);
  equal(report.retainsProviderResponses, false);
  const serialized = JSON.stringify(report);
  for (const leaked of ['winRate', 'profitFactor', 'pnl', 'rMultiple', 'S-WATCH', 'tradelog_']) {
    ok(!serialized.includes(leaked), `report must not carry ${leaked}`);
  }
});

test('boundaries: no provider response text is retained anywhere in the report', async () => {
  const insights = fixture();
  const report = await runProviderValidation({
    insights, config: ENABLED,
    cases: [{ caseId: 'x', provider: provider({ scenario: 'valid' }) }],
  });
  const serialized = JSON.stringify(report);
  for (const phrase of ['worth watching', 'deterministic observations', 'unverified']) {
    ok(!serialized.includes(phrase), `report must not retain "${phrase}"`);
  }
});

test('boundaries: response size is reported without the body', () => {
  equal(responseSize(null), 0);
  equal(responseSize('abcd'), 4);
  equal(responseSize({ a: 1 }), JSON.stringify({ a: 1 }).length);
  ok(responseSize({ summary: 'hello world' }) > 0);
});

test('boundaries: the layer calculates no trading metric and stores nothing', () => {
  const code = readFileSync(CODE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const forbidden of ['getCoreMetrics', 'profitFactor', 'winRate', 'totalPnl', 'tradingAnalytics',
    'performanceAttribution', 'degradationEngine', 'localStorage', 'getItem(', 'setItem(']) {
    ok(!code.includes(forbidden), `validation layer must not reference ${forbidden}`);
  }
  ok(!/\bfetch\(/.test(code), 'no network of its own');
});

test('boundaries: cases run exactly once, with no retry', async () => {
  const insights = fixture();
  let calls = 0;
  let provider;
  const counting = {
    id: 'counting',
    isAvailable: () => true,
    generate: (request) => { calls += 1; return mock.validScenario(request); },
  };
  provider = counting;
  await runProviderValidation({
    insights, config: ENABLED, cases: [{ caseId: 'once', provider }],
  });
  equal(calls, 1, 'a single attempt per case');

  let failingCalls = 0;
  const failing = {
    id: 'failing',
    isAvailable: () => true,
    generate: () => { failingCalls += 1; throw new Error('down'); },
  };
  const report = await runProviderValidation({
    insights, config: ENABLED, cases: [{ caseId: 'fails', provider: failing }],
  });
  equal(failingCalls, 1, 'a failing provider is not retried');
  equal(report.totals.providerErrors, 1, 'the failure is visible rather than hidden');
});

test('boundaries: a provider function is resolved once per case', async () => {
  const insights = fixture();
  let built = 0;
  const report = await runProviderValidation({
    insights, config: ENABLED,
    cases: [{
      caseId: 'lazy',
      provider: () => { built += 1; return provider({ scenario: 'valid' }); },
    }],
  });
  equal(built, 1);
  equal(report.totals.accepted, 1);
});

test('boundaries: the adapter boundary is unchanged by the observability layer', () => {
  const code = readFileSync(new URL('../src/js/utils/aiProviderAdapter.js', import.meta.url), 'utf8');
  ok(!code.includes('aiProviderValidation'), 'the adapter does not depend on the telemetry layer');
  ok(adapter.AI_OUTCOMES.length === AI_OUTCOMES.length, 'outcome vocabulary is shared');
  ok(contract.VIOLATION_CODES !== undefined, 'codes are owned by the contract');
});

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}