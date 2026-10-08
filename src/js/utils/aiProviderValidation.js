// ============================================
// Provider validation and observability — PURE, read-only.
// Vanilla ESM, offline-first. No side effects on import.
//
// Phase 10E-D. Answers one question: when a provider is given a valid
// closed AI context, does it reliably return a contract-valid answer?
//
// This is provider-quality telemetry, NOT trading analytics. Nothing here
// computes, aggregates or reports anything about trading performance. The
// numbers describe how a provider behaved against a contract; a high
// rejection rate says the provider is non-compliant, never that the trader
// performed badly. The two must never be mixed.
//
// Two rules the design exists to enforce:
//
// - A rejection rate is never a reason to weaken the contract. If a provider
//   omits factIds, the finding is "this provider does not satisfy our
//   contract", not "make factIds optional".
// - Raw provider responses are never retained by default. They can carry
//   echoed context and provider-specific material. Only structured outcomes
//   and coarse response sizes are kept.
//
// No automatic retry: a retry would hide exactly the rejection rate this
// layer exists to measure.
import { runAiProvider, AI_OUTCOMES } from './aiProviderAdapter.js';
import { VIOLATION_CODES } from './aiAdapterContract.js';

export { VIOLATION_CODES, AI_OUTCOMES };

function codesOf(result) {
  const violations = Array.isArray(result?.violations) ? result.violations : [];
  return violations
    .map((v) => (v && typeof v.code === 'string' ? v.code : null))
    .filter((c) => c !== null);
}

/**
 * Coarse size of a response, for spotting truncation or runaway output
 * without retaining the content itself.
 */
export function responseSize(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'string') return raw.length;
  try {
    return JSON.stringify(raw)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Run one validation case and reduce it to a structured outcome.
 *
 * Deliberately retains no provider text: only the outcome, the violation
 * codes, and coarse sizes.
 */
export async function runValidationCase(options = {}) {
  const result = await runAiProvider(options);
  const codes = codesOf(result);
  return {
    caseId: text(options.caseId),
    outcome: result.outcome,
    accepted: result.outcome === 'ok',
    violationCodes: [...new Set(codes)].sort(),
    violationCount: codes.length,
    // Kept for diagnostics only; never the response body.
    resultSize: responseSize(options.rawResponse),
    reason: text(result.reason),
  };
}

function text(value) {
  const s = value == null ? '' : String(value).trim();
  return s === '' ? null : s;
}

/**
 * Aggregate structured outcomes into a deterministic validation report.
 *
 * Identical outcomes always produce an identical report: counts are sorted by
 * code, cases keep their given order, and nothing is derived from timing.
 */
export function buildValidationReport(outcomes = []) {
  const rows = (Array.isArray(outcomes) ? outcomes : [])
    .filter((o) => o && typeof o === 'object')
    .map((o) => ({
      caseId: text(o.caseId) ?? 'unknown',
      outcome: AI_OUTCOMES.includes(o.outcome) ? o.outcome : 'provider_error',
      accepted: o.accepted === true,
      violationCodes: Array.isArray(o.violationCodes)
        ? [...new Set(o.violationCodes.filter((c) => typeof c === 'string'))].sort()
        : [],
      violationCount: Number.isFinite(Number(o.violationCount)) ? Number(o.violationCount) : 0,
    }));

  const total = rows.length;
  const accepted = rows.filter((r) => r.accepted).length;
  const byOutcome = {};
  for (const code of AI_OUTCOMES) byOutcome[code] = 0;
  for (const row of rows) byOutcome[row.outcome] += 1;

  // A rejection may carry several codes, so the code tally can exceed the
  // rejected count. That is intentional and is why both are reported.
  const byViolation = {};
  for (const row of rows) {
    for (const code of row.violationCodes) byViolation[code] = (byViolation[code] ?? 0) + 1;
  }
  const sortedViolations = Object.keys(byViolation).sort().map((code) => ({ code, count: byViolation[code] }));

  return {
    schemaVersion: '1.0.0',
    kind: 'providerValidation',
    // Named explicitly so this report can never be mistaken for trading data.
    measuresContractCompliance: true,
    containsTradingMetrics: false,
    retainsProviderResponses: false,
    totals: {
      requests: total,
      accepted,
      rejected: rows.filter((r) => r.outcome === 'rejected').length,
      notAttempted: rows.filter((r) => r.outcome === 'disabled' || r.outcome === 'unavailable').length,
      providerErrors: rows.filter((r) => r.outcome === 'provider_error').length,
    },
    byOutcome,
    byViolation: sortedViolations,
    cases: rows,
  };
}

/**
 * Run a set of validation cases and produce the report.
 *
 * Each case supplies its own provider. There is no retry and no batching
 * beyond the cases given, so the rejection rate reported is the rejection
 * rate actually observed.
 */
export async function runProviderValidation(options = {}) {
  const cases = Array.isArray(options.cases) ? options.cases : [];
  const outcomes = [];
  for (const testCase of cases) {
    // Sequential and unrepeated on purpose: a retry would conceal the rate.
    outcomes.push(await runValidationCase({
      insights: options.insights,
      config: options.config,
      caseId: testCase?.caseId,
      provider: typeof testCase?.provider === 'function' ? testCase.provider() : testCase?.provider,
      rawResponse: testCase?.rawResponse,
    }));
  }
  return buildValidationReport(outcomes);
}

export default {
  VIOLATION_CODES,
  AI_OUTCOMES,
  responseSize,
  runValidationCase,
  buildValidationReport,
  runProviderValidation,
};