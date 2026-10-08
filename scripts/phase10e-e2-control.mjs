// Phase 10E-E2 — minimal-context provider control.
//
// Answers one question: did llama3.2:3b fail our contract because the
// context and prompt are too large and complicated, or because the model
// cannot follow the contract at all?
//
//   node scripts/phase10e-e2-control.mjs [casesPerArm]
//
// The experiment varies ONE thing: how many insights go into the context.
// Everything else is identical — the same buildAiContext, the same
// provider, the same runProviderValidation, the same contract.
//
// This script deliberately does not modify or bypass the validation layer.
// It observes transport metadata (token counts, truncation, prompt size)
// alongside the report, because "did the model finish?" is a question about
// the provider, not about the contract, and the validation layer has no
// reason to know about tokens.
//
// Neither arm persists provider response text. Determinism is measured by
// comparing response digests, so repeated runs can be compared without
// retaining what the model said.
import { createHash } from 'node:crypto';

const { buildAiContext } = await import('../src/js/utils/aiContextBuilder.js');
const { runProviderValidation } = await import('../src/js/utils/aiProviderValidation.js');
const { createOllamaProvider, buildChatBody } = await import('../src/js/utils/aiProviderOllama.js');
const { buildPrompt } = await import('../src/js/utils/aiProviderAdapter.js');
const { consolidateInsights } = await import('../src/js/utils/intelligenceConsolidation.js');
const degradation = await import('../src/js/utils/degradationEngine.js');
const attribution = await import('../src/js/utils/attributionIntelligence.js');
const improvement = await import('../src/js/utils/improvementEngine.js');

const CASES = Number(process.argv[2] || 5);
const MODEL = process.env.P10_MODEL || 'llama3.2:3b';

let clock = 0;
function tradeRow({ id, outcome, strategyId, pair = 'EUR/USD', session = 'London' }) {
  clock += 3600000;
  const r = outcome === 'WIN' ? 2 : -1;
  return {
    trade: {
      id, strategyId, pair, session, timeframe: 'H1', setupType: 'BREAKOUT',
      openedAt: new Date(clock).toISOString(),
      closedAt: new Date(clock + 60000).toISOString(),
      pnl: r * 100, rMultiple: r,
    },
    review: null, outcome, pnl: r * 100, r, processScore: 70,
  };
}

/** Arm A: the full context measured in 10E-E1. */
function fullArm() {
  clock = 0;
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `a-h-${i}`, strategyId: 'S-WATCH', outcome: i < 32 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `a-r-${i}`, strategyId: 'S-WATCH', outcome: i < 31 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 24; i++) rows.push(tradeRow({ id: `a-f-${i}`, strategyId: 'S-FALL', outcome: i < 6 ? 'WIN' : 'LOSS' }));
  return consolidateInsights({
    degradation: degradation.detectDegradation(rows, { dimension: 'strategy' }),
    attribution: attribution.qualifyAttributionRows([
      { dimensionValue: 'EUR/USD', trades: 104, pnl: 5200, totalR: 62, averageR: 0.6, winRate: 61, processScore: 70, sampleSize: 104 },
      { dimensionValue: 'GBP/USD', trades: 3, pnl: 60, totalR: 2, averageR: 0.67, winRate: 67, processScore: 70, sampleSize: 3 },
    ], { dimension: 'pair' }),
    improvements: improvement.getImprovementPatterns({
      reviews: Array.from({ length: 8 }, (_, i) => ({
        id: `rv-${i}`, mistakes: i < 5 ? ['LATE_ENTRY'] : [], strengths: [],
        processScore: { total: 70 }, ruleAdherence: 90,
      })),
    }),
  });
}

/**
 * Arm B: the same pipeline with the smallest context that still exercises
 * the contract — one insight, one producer, no attribution, no improvements.
 * Built by the same builder, not hand-written.
 */
function tinyArm() {
  clock = 0;
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `b-h-${i}`, strategyId: 'S-WATCH', outcome: i < 32 ? 'WIN' : 'LOSS' }));
  for (let i = 0; i < 40; i++) rows.push(tradeRow({ id: `b-r-${i}`, strategyId: 'S-WATCH', outcome: i < 31 ? 'WIN' : 'LOSS' }));
  return consolidateInsights({
    degradation: degradation.detectDegradation(rows, { dimension: 'strategy' }),
    attribution: [],
    improvements: [],
  });
}

/**
 * Transport-level diagnostics, kept outside the validation layer.
 *
 * This calls the provider endpoint directly rather than provider.generate(),
 * because generate() translates the reply into the boundary's shape and the
 * token metadata needed here would already be gone. The prompt is byte-for-
 * byte the one the adapter would send.
 */
async function transportProbe(insights) {
  const context = buildAiContext(insights);
  const request = {
    contractVersion: context.contractVersion,
    context,
    prompt: buildPrompt(context),
    allowedNumericFacts: context.allowedNumericFacts,
  };
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildChatBody(request, { model: MODEL, numPredict: 1400 })),
  });
  const raw = await response.json();
  const content = String(raw?.message?.content ?? '');
  return {
    promptChars: request.prompt.length,
    insights: context.insights.length,
    facts: context.allowedNumericFacts.length,
    evalCount: raw?.eval_count ?? null,
    promptTokens: raw?.prompt_eval_count ?? null,
    doneReason: raw?.done_reason ?? null,
    responseChars: content.length,
    truncated: raw?.done_reason === 'length',
    // A digest, not the content: lets us compare runs without retaining them.
    digest: createHash('sha256').update(content).digest('hex').slice(0, 16),
  };
}

function row(label, probe) {
  return {
    arm: label,
    insights: probe.insights,
    facts: probe.facts,
    promptChars: probe.promptChars,
    promptTokens: probe.promptTokens,
    evalTokens: probe.evalCount,
    doneReason: probe.doneReason,
    truncated: probe.truncated,
    responseChars: probe.responseChars,
    digest: probe.digest,
  };
}

async function runArm(label, insights) {
  const cases = Array.from({ length: CASES }, (_, i) => ({
    caseId: `${label}-${i + 1}`,
    provider: createOllamaProvider({ model: MODEL, timeoutMs: 240000, numPredict: 1400 }),
  }));
  const report = await runProviderValidation({ insights, config: { enabled: true }, cases });
  const codes = {};
  for (const entry of report.byViolation) codes[entry.code] = entry.count;
  return {
    label,
    totals: report.totals,
    codes,
    providerErrors: report.totals.providerErrors,
    accepted: report.totals.accepted,
  };
}

const fullInsights = fullArm();
const tinyInsights = tinyArm();

console.log(`model: ${MODEL}   cases per arm: ${CASES}\n`);

const fullProbe = await transportProbe(fullInsights);
const tinyProbe = await transportProbe(tinyInsights);
const fullProbe2 = await transportProbe(fullInsights);

console.log('Transport diagnostics');
console.log('-----------------------');
console.log(JSON.stringify([
  row('full', fullProbe),
  row('full(repeat)', fullProbe2),
  row('tiny', tinyProbe),
].map((r) => ({ ...r, digest: r.digest })), null, 1));
console.log('\nfull context deterministic across repeats:',
  fullProbe.digest === fullProbe2.digest);

const fullReport = await runArm('full', fullInsights);
const tinyReport = await runArm('tiny', tinyInsights);

console.log('\nContract validation');
console.log('--------------------');
console.log(JSON.stringify({ full: fullReport, tiny: tinyReport }, null, 1));

console.log('\nComparison');
console.log('----------');
const line = (k, a, b) => console.log(`${k.padEnd(24)} full=${String(a).padEnd(10)} tiny=${b}`);
line('requests', fullReport.totals.requests, tinyReport.totals.requests);
line('accepted', fullReport.totals.accepted, tinyReport.totals.accepted);
line('rejected', fullReport.totals.rejected, tinyReport.totals.rejected);
line('MALFORMED_RESPONSE', fullReport.codes.MALFORMED_RESPONSE ?? 0, tinyReport.codes.MALFORMED_RESPONSE ?? 0);
line('UNKNOWN_INSIGHT_ID', fullReport.codes.UNKNOWN_INSIGHT_ID ?? 0, tinyReport.codes.UNKNOWN_INSIGHT_ID ?? 0);
line('other violations',
  Object.entries(fullReport.codes).filter(([c]) => !['MALFORMED_RESPONSE', 'UNKNOWN_INSIGHT_ID'].includes(c)).length,
  Object.entries(tinyReport.codes).filter(([c]) => !['MALFORMED_RESPONSE', 'UNKNOWN_INSIGHT_ID'].includes(c)).length);
line('provider errors', fullReport.providerErrors, tinyReport.providerErrors);
line('prompt chars', fullProbe.promptChars, tinyProbe.promptChars);
line('truncated', fullProbe.truncated, tinyProbe.truncated);

const tinyOk = tinyReport.totals.accepted > 0;
console.log(`\nOutcome: ${tinyOk
  ? 'A — tiny context produced at least one valid response; the provider is capable and the problem is context/prompt complexity or output budget.'
  : 'B — tiny context still fails; this model is not a suitable provider for the contract.'}`);