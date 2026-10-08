// ============================================
// AI provider adapter — PURE orchestration, read-only.
// Vanilla ESM, offline-first. No side effects on import.
//
// Phase 10E-C. The provider boundary, deliberately thin.
//
//   buildAiContext()  -> AIContext          (deterministic, provider-agnostic)
//   buildPrompt()     -> prompt text        (pure)
//   provider.generate()-> raw response      (the only step that can be remote)
//   parseResponse()   -> object             (defensive, never repairs)
//   validateAiResult()-> validated or rejected
//
// A provider adapter receives the closed context, sends it, parses what comes
// back and validates it. That is the whole job. It does not calculate
// metrics, query storage, reach Firebase, read trades, or touch rules, risk
// or prop state, and it never makes a trading decision.
//
// Nothing is repaired. A provider answer is either wholly valid or wholly
// rejected, because a partially repaired answer still reads as authoritative
// to whoever sees it. Missing factIds are therefore a contract violation
// rather than something to infer.
//
// The deterministic intelligence layer is never a dependency of this one: when
// AI is disabled, unavailable, erroring or rate limited, this module reports an
// outcome code and the deterministic view stands unchanged.
import { buildAiContext } from './aiContextBuilder.js';
import {
  AI_CONTRACT_VERSION,
  AI_RESULT_SECTIONS,
  isValidProviderAdapter,
  resolveAiConfig,
  validateAiResult,
} from './aiAdapterContract.js';

/**
 * Outcome codes. The caller distinguishes "AI said nothing" from "AI said
 * something invalid" from "AI was never asked", so it can degrade without
 * treating a provider problem as a data problem.
 */
export const AI_OUTCOMES = ['ok', 'rejected', 'disabled', 'unavailable', 'provider_error'];

/**
 * What a provider adapter must never do. Enforced by a structural test rather
 * than trusted to review.
 */
export const ADAPTER_PROHIBITIONS = [
  'calculate trading metrics',
  'query storage',
  'access Firebase',
  'read or write trades',
  'modify rules',
  'modify risk settings',
  'modify prop state',
  'modify balances',
  'make trading decisions',
  'repair or sanitize a provider response',
];

const PROMPT_PREAMBLE = [
  'You are summarising findings produced by a deterministic trading-intelligence engine.',
  'Those findings, their states, their sample sizes and every figure are authoritative and are not yours to change.',
  '',
  'Rules for every numeric statement:',
  '- Every numeric statement must cite one or more permitted factIds.',
  '- A numeric statement without a factId is invalid and will cause the whole response to be rejected.',
  '- Do not calculate, round, interpolate, estimate or derive numeric values.',
  '- Do not attach a factId unless that fact directly supports the claim.',
  '- Do not use a fact belonging to another metric to support the named metric.',
  '',
  'Ranking:',
  '- Do not infer a ranking from ranking.eligible. That flag only means the sample was large enough to rank.',
  '- Only ranking.label represents an actual rank.',
  '',
  'Evidence:',
  '- record evidence may discuss the cited records; aggregate evidence supports aggregate statements only; pattern evidence supports pattern statements only.',
  '- Never present a pattern or aggregate finding as if you had inspected individual trades.',
  '',
  'Conduct:',
  '- Do not claim causation. Describe only what was observed.',
  '- Do not give trading, risk, position-sizing or rule instructions.',
  '- Do not state or imply a state other than the one supplied.',
  '- Label every hypothesis as unverified.',
  '- Prefer questions for the trader over conclusions.',
].join('\n');

/**
 * Build the prompt from a closed context. Pure: same context, same prompt.
 *
 * The permitted facts are printed with their approved surface forms so the
 * provider can pick a representation without doing any arithmetic.
 */
export function buildPrompt(context) {
  if (!context || typeof context !== 'object') return '';
  const lines = [];
  lines.push(PROMPT_PREAMBLE);
  lines.push('');
  lines.push(`Output JSON with these keys only: ${AI_RESULT_SECTIONS.join(', ')}.`);
  lines.push('Each observation and hypothesis needs: text, insightIds, groundedOn, and factIds for any figure it states.');
  lines.push('');
  lines.push('Forbidden actions:');
  for (const action of Array.isArray(context.forbiddenActions) ? context.forbiddenActions : []) {
    lines.push(`- ${action}`);
  }
  lines.push('');
  lines.push('Permitted numeric facts:');
  for (const fact of Array.isArray(context.allowedNumericFacts) ? context.allowedNumericFacts : []) {
    lines.push(`- id=${fact.id} value=${fact.value} kind=${fact.kind} unit=${fact.unit ?? 'none'} (${fact.source})`);
  }
  lines.push('');
  lines.push('Findings:');
  for (const insight of Array.isArray(context.insights) ? context.insights : []) {
    lines.push(`- id=${insight.id}`);
    lines.push(`  state=${insight.state ?? 'unavailable'} sample=${insight.sample?.band ?? 'unknown'} size=${insight.sample?.size ?? 'unknown'}`);
    lines.push(`  traceability=${insight.traceability ?? 'unknown'} hasRecordEvidence=${insight.hasRecordEvidence === true}`);
    lines.push(`  ranking.eligible=${insight.ranking?.eligible === true} ranking.label=${insight.ranking?.label ?? 'none'}`);
    lines.push(`  summary=${insight.summary}`);
    lines.push(`  permittedFactIds=${(insight.permittedFactIds || []).join(',')}`);
  }
  return lines.join('\n');
}

/**
 * Parse a raw provider response.
 *
 * Accepts an object or a JSON string. Anything unparseable is reported as a
 * rejection with an empty candidate; it is never partially recovered.
 */
export function parseResponse(raw) {
  if (raw == null) return { success: false, reason: 'provider returned nothing' };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { success: true, candidate: raw };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return { success: false, reason: 'provider returned an empty string' };
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { success: false, reason: 'provider response was not a JSON object' };
      }
      return { success: true, candidate: parsed };
    } catch {
      return { success: false, reason: 'provider response was not valid JSON' };
    }
  }
  return { success: false, reason: 'provider response was not an object or JSON string' };
}

function outcome(code, extra = {}) {
  return { outcome: code, success: code === 'ok', result: null, violations: [], ...extra };
}

/**
 * Run the provider boundary end to end.
 *
 * @param {object} options — { insights, provider, config }
 * @returns {object} { outcome, success, result, violations, reason? }
 *   outcome is one of AI_OUTCOMES. Only 'ok' carries a result.
 */
export async function runAiProvider(options = {}) {
  const cfg = resolveAiConfig(options.config);

  if (!cfg.enabled) return outcome('disabled', { reason: 'AI layer is disabled' });

  const provider = options.provider;
  if (!isValidProviderAdapter(provider)) {
    return outcome('unavailable', { reason: 'no valid provider adapter supplied' });
  }

  let available = false;
  try {
    available = await provider.isAvailable();
  } catch {
    available = false;
  }
  if (available !== true) {
    return outcome('unavailable', { reason: 'provider reported itself unavailable' });
  }

  const context = buildAiContext(options.insights, options);
  const request = {
    contractVersion: AI_CONTRACT_VERSION,
    context,
    prompt: buildPrompt(context),
    allowedNumericFacts: context.allowedNumericFacts,
    maxOutputItems: cfg.maxOutputItems,
  };

  // The validator reads the whitelisted package directly rather than the
  // provider-facing envelope, so a provider is handed prose plus the
  // published facts and nothing that could be mistaken for a second
  // authority.
  const validationRequest = {
    contractVersion: AI_CONTRACT_VERSION,
    insights: context.insights,
    allowedNumericFacts: context.allowedNumericFacts,
  };

  let raw;
  try {
    raw = await provider.generate(request);
  } catch (err) {
    // A provider that throws, times out or is rate limited is not a data
    // problem. The deterministic view stands and the caller is told why.
    return outcome('provider_error', { reason: 'provider call failed' });
  }

  const parsed = parseResponse(raw);
  if (!parsed.success) {
    return outcome('rejected', { reason: parsed.reason });
  }

  const validated = validateAiResult(parsed.candidate, validationRequest, cfg);
  if (!validated.success) {
    return outcome('rejected', { violations: validated.violations, reason: 'contract validation failed' });
  }
  return outcome('ok', { result: validated.result });
}

export default {
  AI_OUTCOMES,
  ADAPTER_PROHIBITIONS,
  buildPrompt,
  parseResponse,
  runAiProvider,
};