// ============================================
// AI adapter contract — PURE, read-only.
// Vanilla ESM, offline-first. No side effects on import.
// No provider SDK, no network, no storage.
//
// Phase 10E-A. Defines what any AI provider adapter must implement, what
// package it is allowed to receive, and what shape its answer may take.
//
// The layer is default-disabled and provider-agnostic. Nothing here talks
// to a provider; a provider is supplied later (10E-C) and must satisfy this
// contract to be used at all.
//
// The deterministic intelligence stack owns every fact. This contract
// exists to make that structurally true rather than merely documented:
//
// - AI may interpret and question a finding. It may not restate, upgrade or
//   contradict the state the deterministic layer assigned.
// - Evidence quality can never be upgraded. An observation grounded on a
//   PATTERN insight cannot speak about individual trades, because the
//   weakest cited traceability caps the claim.
// - Statistics cannot be invented. Every number in a provider answer must
//   already appear in the whitelisted package it was given.
// - No trading instruction may be emitted. The layer is observational.
// - ranking.eligible means "enough evidence to rank". Only ranking.label
//   means a rank exists. A rank is never inferred from eligible.
// ============================================
import { findCausalClaims } from './intelligenceContracts.js';
import { TRACEABILITY_LEVELS } from './intelligenceConsolidation.js';

export const AI_CONTRACT_VERSION = '1.0.0';

/** Sections a provider answer may contain. Nothing else is accepted. */
export const AI_RESULT_SECTIONS = [
  'summary',
  'observations',
  'questionsToInvestigate',
  'possibleHypotheses',
];

/**
 * Words that turn an observation into a trading instruction. The layer is
 * observational, so an answer telling the trader what to do is rejected
 * outright rather than softened.
 */
export const FORBIDDEN_INSTRUCTION_PHRASES = [
  'stop trading',
  'avoid trading',
  'do not trade',
  'increase your position',
  'increase your risk',
  'reduce your risk',
  'increase your stop',
  'widen your stop',
  'tighten your stop',
  'change your stop',
  'you should trade',
  'you should avoid',
  'we recommend trading',
  'recommend increasing',
  'recommend reducing',
  'take a position',
  'open a position',
  'close your position',
];

/**
 * State words the deterministic layer owns. A provider answer may discuss
 * a state that the cited insights actually carry, but may not assert a
 * state transition that none of them support.
 */
const STATE_CLAIM_PHRASES = {
  DEGRADING: ['degrading', 'degraded', 'is getting worse', 'going downhill', 'deteriorating'],
  IMPROVING: ['improving', 'improved', 'getting better', 'trending up'],
  WATCH: ['is watch', 'worth watching', 'borderline'],
  INSUFFICIENT_DATA: ['insufficient data', 'not enough data', 'too little data'],
};

/** AI is off unless explicitly enabled. Absence of a provider means no AI. */
export const DEFAULT_AI_CONFIG = {
  enabled: false,
  maxInsights: 25,
  maxOutputItems: 12,
};

function text(value) {
  const s = value == null ? '' : String(value).trim();
  return s === '' ? null : s;
}

function compare(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

export function resolveAiConfig(overrides = {}) {
  const input = overrides && typeof overrides === 'object' ? overrides : {};
  const maxInsights = Number(input.maxInsights);
  const maxOutputItems = Number(input.maxOutputItems);
  return {
    // Default-disabled: only an explicit `enabled: true` turns the layer on.
    enabled: input.enabled === true,
    maxInsights: Number.isFinite(maxInsights) && maxInsights > 0 ? Math.floor(maxInsights) : DEFAULT_AI_CONFIG.maxInsights,
    maxOutputItems:
      Number.isFinite(maxOutputItems) && maxOutputItems > 0
        ? Math.floor(maxOutputItems)
        : DEFAULT_AI_CONFIG.maxOutputItems,
  };
}

/**
 * Strength of a traceability level. TRACEABILITY_LEVELS is ordered
 * strongest-first, so a LOWER index means STRONGER evidence.
 */
function levelStrength(level) {
  const index = TRACEABILITY_LEVELS.indexOf(level);
  return index < 0 ? -1 : index;
}

/**
 * The weakest evidence among the given insights, which caps what any claim
 * citing them may assert.
 *
 * This must select the HIGHEST index (least detail). Selecting the lowest
 * would return the strongest citation and silently let an observation cite
 * one record-level insight alongside an aggregate one and still claim
 * record grounding, which is exactly the upgrade this contract forbids.
 */
export function weakestTraceability(insights) {
  let weakest = null;
  for (const insight of insights) {
    const level = insight?.traceability;
    if (!TRACEABILITY_LEVELS.includes(level)) continue;
    if (weakest === null || levelStrength(level) > levelStrength(weakest)) weakest = level;
  }
  return weakest;
}

/**
 * Every numeric token present in the whitelisted package. A provider answer
 * may only use numbers that already appear here; anything else is a
 * fabricated statistic.
 */
export function collectContextNumbers(insights) {
  const found = new Set();
  const visit = (value) => {
    if (value == null) return;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) found.add(String(value));
      return;
    }
    if (typeof value === 'string') {
      for (const match of value.match(/-?\d+(?:\.\d+)?/g) || []) found.add(match);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      for (const key of Object.keys(value).sort()) visit(value[key]);
    }
  };
  for (const insight of insights) visit(insight);
  return found;
}

/**
 * Numbers appearing in a provider answer that were never supplied.
 * Ordinal words are ignored; only digits are checked.
 */
export function findFabricatedNumbers(textValue, allowed) {
  const tokens = String(textValue ?? '').match(/-?\d+(?:\.\d+)?/g) || [];
  const fabricated = [];
  for (const token of tokens) {
    if (!allowed.has(token)) fabricated.push(token);
  }
  return [...new Set(fabricated)];
}

function findInstructionPhrases(textValue) {
  const s = String(textValue ?? '').toLowerCase();
  return FORBIDDEN_INSTRUCTION_PHRASES.filter((p) => s.includes(p));
}

/**
 * State claims the answer makes that no cited insight supports.
 *
 * This is what stops WATCH from being upgraded to "degrading", and what
 * stops a STABLE insight from being narrated as a decline.
 */
export function findUnsupportedStateClaims(textValue, citedInsights) {
  const s = String(textValue ?? '').toLowerCase();
  const unsupported = [];
  for (const [state, phrases] of Object.entries(STATE_CLAIM_PHRASES)) {
    if (!phrases.some((p) => s.includes(p))) continue;
    const supported = citedInsights.some((i) => i?.state === state);
    if (!supported) unsupported.push(state);
  }
  return unsupported;
}

/**
 * The whitelisted package handed to a provider.
 *
 * Read-only by construction: canonical insights are passed through as-is so
 * the provider cannot edit a state, and the policy block states the limits
 * the validator will enforce.
 */
export function buildAiRequest(insights, config = {}) {
  const cfg = resolveAiConfig(config);
  const list = Array.isArray(insights) ? insights.filter((i) => i && typeof i === 'object') : [];
  const selected = [...list].sort((a, b) => compare(a.id, b.id)).slice(0, cfg.maxInsights);
  return {
    contractVersion: AI_CONTRACT_VERSION,
    generatedFrom: 'deterministic-intelligence',
    insights: selected,
    policy: {
      maxOutputItems: cfg.maxOutputItems,
      allowedSections: [...AI_RESULT_SECTIONS],
      recordLevelReasoningRequires: 'hasRecordEvidence === true',
      rankRequires: 'ranking.label',
      mayUpgradeEvidence: false,
      mayRestateState: false,
      mayInstruct: false,
    },
  };
}

/**
 * A provider adapter must satisfy this shape. Checked structurally so a
 * provider that drifts fails loudly at the boundary instead of quietly
 * producing unusable output.
 */
export function isValidProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') return false;
  if (!text(adapter.id)) return false;
  if (typeof adapter.isAvailable !== 'function') return false;
  if (typeof adapter.generate !== 'function') return false;
  return true;
}

function validateGroundedItems(items, label, insightsById, allowedNumbers, cfg, violations) {
  const out = [];
  if (items == null) return out;
  if (!Array.isArray(items)) {
    violations.push(`${label} must be an array`);
    return out;
  }
  if (items.length > cfg.maxOutputItems) {
    violations.push(`${label} exceeds maxOutputItems (${items.length} > ${cfg.maxOutputItems})`);
  }
  for (const raw of items) {
    const item = typeof raw === 'string' ? { text: raw } : raw;
    if (!item || typeof item !== 'object') {
      violations.push(`${label} contains a non-object entry`);
      continue;
    }
    const body = text(item.text);
    if (!body) {
      violations.push(`${label} entry is missing text`);
      continue;
    }

    const citedIds = Array.isArray(item.insightIds) ? item.insightIds.filter((v) => text(v) !== null) : [];
    const cited = citedIds
      .map((id) => insightsById.get(String(id)))
      .filter((i) => i !== undefined);

    // Grounding must not exceed the weakest evidence cited. An observation
    // that cites a PATTERN insight may not claim record-level grounding.
    const claimed = text(item.groundedOn);
    if (claimed !== null && !TRACEABILITY_LEVELS.includes(claimed)) {
      violations.push(`${label} entry has unknown groundedOn "${claimed}"`);
      continue;
    }
    const weakest = weakestTraceability(cited);
    if (claimed !== null && weakest !== null && levelStrength(claimed) < levelStrength(weakest)) {
      violations.push(
        `${label} entry claims ${claimed} grounding but cites ${weakest}-level evidence`,
      );
      continue;
    }
    // Record-level reasoning requires real record evidence on every citation.
    if (claimed === 'record' && cited.some((i) => i.hasRecordEvidence !== true)) {
      violations.push(`${label} entry claims record grounding without record-level evidence`);
      continue;
    }
    if (cited.length === 0) {
      violations.push(`${label} entry cites no known insight`);
      continue;
    }

    const causal = findCausalClaims(body);
    if (causal.length > 0) {
      violations.push(`${label} entry asserts causation (${causal.join(', ')})`);
      continue;
    }
    const instructions = findInstructionPhrases(body);
    if (instructions.length > 0) {
      violations.push(`${label} entry contains a trading instruction (${instructions.join(', ')})`);
      continue;
    }
    const unsupportedStates = findUnsupportedStateClaims(body, cited);
    if (unsupportedStates.length > 0) {
      violations.push(`${label} entry restates a state no cited insight supports (${unsupportedStates.join(', ')})`);
      continue;
    }
    const fabricated = findFabricatedNumbers(body, allowedNumbers);
    if (fabricated.length > 0) {
      violations.push(`${label} entry invents figures not present in the package (${fabricated.join(', ')})`);
      continue;
    }

    out.push({
      text: body,
      insightIds: citedIds.map(String).sort(),
      groundedOn: claimed ?? weakest,
      status: label === 'possibleHypotheses' ? 'unverified' : 'observed',
    });
  }
  return out;
}

/**
 * Validate a provider answer against the package it was given.
 *
 * Everything is rejected rather than repaired: a partially sanitized answer
 * would still look authoritative to a reader, so a violation invalidates the
 * whole response and the deterministic view stays authoritative.
 */
export function validateAiResult(result, request, config = {}) {
  const violations = [];
  const cfg = resolveAiConfig(config);

  if (cfg.enabled !== true) {
    return { success: false, violations: ['AI layer is disabled'], result: null };
  }
  if (!request || typeof request !== 'object' || !Array.isArray(request.insights)) {
    return { success: false, violations: ['invalid request package'], result: null };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { success: false, violations: ['result must be an object'], result: null };
  }

  // The deterministic layer owns state. An answer may not carry one.
  for (const forbidden of ['state', 'states', 'verdict', 'verdicts', 'status', 'score']) {
    if (forbidden in result) {
      violations.push(`result must not carry "${forbidden}"; the deterministic layer owns it`);
    }
  }

  for (const key of Object.keys(result).sort()) {
    if (!AI_RESULT_SECTIONS.includes(key)) {
      violations.push(`result contains unknown section "${key}"`);
    }
  }

  const insightsById = new Map();
  for (const insight of request.insights) {
    const id = text(insight?.id);
    if (id !== null) insightsById.set(id, insight);
  }
  const allowedNumbers = collectContextNumbers(request.insights);

  const summaryText = text(result.summary);
  if (summaryText !== null) {
    const causal = findCausalClaims(summaryText);
    if (causal.length > 0) violations.push(`summary asserts causation (${causal.join(', ')})`);
    const instructions = findInstructionPhrases(summaryText);
    if (instructions.length > 0) violations.push(`summary contains a trading instruction (${instructions.join(', ')})`);
    const unsupported = findUnsupportedStateClaims(summaryText, request.insights);
    if (unsupported.length > 0) {
      violations.push(`summary restates a state no insight supports (${unsupported.join(', ')})`);
    }
    const fabricated = findFabricatedNumbers(summaryText, allowedNumbers);
    if (fabricated.length > 0) {
      violations.push(`summary invents figures not present in the package (${fabricated.join(', ')})`);
    }
  }

  const observations = validateGroundedItems(
    result.observations, 'observations', insightsById, allowedNumbers, cfg, violations,
  );
  const hypotheses = validateGroundedItems(
    result.possibleHypotheses, 'possibleHypotheses', insightsById, allowedNumbers, cfg, violations,
  );

  const questions = [];
  if (result.questionsToInvestigate != null) {
    if (!Array.isArray(result.questionsToInvestigate)) {
      violations.push('questionsToInvestigate must be an array');
    } else {
      for (const raw of result.questionsToInvestigate) {
        const body = text(raw);
        if (!body) {
          violations.push('questionsToInvestigate contains an empty entry');
          continue;
        }
        const instructions = findInstructionPhrases(body);
        if (instructions.length > 0) {
          violations.push(`questionsToInvestigate contains an instruction (${instructions.join(', ')})`);
          continue;
        }
        if (body.endsWith('?') === false) {
          violations.push('questionsToInvestigate entry is not phrased as a question');
          continue;
        }
        questions.push(body);
      }
      if (questions.length > cfg.maxOutputItems) {
        violations.push(`questionsToInvestigate exceeds maxOutputItems`);
      }
    }
  }

  if (violations.length > 0) {
    return { success: false, violations, result: null };
  }

  return {
    success: true,
    violations: [],
    result: {
      contractVersion: AI_CONTRACT_VERSION,
      summary: summaryText,
      observations,
      questionsToInvestigate: questions,
      possibleHypotheses: hypotheses,
    },
  };
}

export default {
  AI_CONTRACT_VERSION,
  AI_RESULT_SECTIONS,
  DEFAULT_AI_CONFIG,
  FORBIDDEN_INSTRUCTION_PHRASES,
  resolveAiConfig,
  weakestTraceability,
  collectContextNumbers,
  findFabricatedNumbers,
  findUnsupportedStateClaims,
  buildAiRequest,
  isValidProviderAdapter,
  validateAiResult,
};