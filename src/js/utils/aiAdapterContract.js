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
 * Numeric facts come in two kinds.
 *
 * `exact`   — a value read straight from a source record.
 * `derived` — a value the deterministic layer already computed and published
 *             (for example a window-over-window change). AI may restate it
 *             because the arithmetic happened upstream, never in the model.
 */
export const NUMERIC_FACT_KINDS = ['exact', 'derived'];

/**
 * Surface forms a provider may use for one authoritative value.
 *
 * Formatting may change; the factual value may not. A value may be
 * re-expressed in another unit (0.8 and 80 are the same quantity) and small
 * integers may be spelled out ("forty"), because neither step introduces a
 * new fact. Rounding to a different precision is NOT included: 3.1 is a
 * different value from 3.12, and producing it would be arithmetic the
 * deterministic layer never did.
 */
export function numericSurfaceForms(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return [];
  const forms = new Set();
  const add = (v) => {
    if (!Number.isFinite(v)) return;
    // Scaling a fraction produces float noise (0.0312 * 100 is
    // 3.1200000000000006), which would make the percent form of a published
    // change unmatchable. Trim to significant digits before comparing.
    forms.add(String(Number(v.toPrecision(12))));
  };
  add(num);
  add(Math.abs(num));
  for (const scale of [10, 100, 1000, 0.1, 0.01, 0.001]) {
    add(num * scale);
    add(Math.abs(num) * scale);
  }
  if (Number.isInteger(num) && Math.abs(num) <= 9999) {
    forms.add(String(Math.abs(num)));
  }
  return [...forms];
}

const NUMBER_WORDS = {
  0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
  7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve',
  13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen', 17: 'seventeen',
  18: 'eighteen', 19: 'nineteen', 20: 'twenty', 30: 'thirty', 40: 'forty',
  50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety',
  100: 'one hundred',
};

function addWordForms(forms, value) {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) return;
  const abs = Math.abs(num);
  if (abs === 0) {
    forms.add(NUMBER_WORDS[0]);
    return;
  }
  if (abs <= 20) {
    forms.add(NUMBER_WORDS[abs]);
    return;
  }
  const tens = Math.floor(abs / 10) * 10;
  const ones = abs % 10;
  if (tens === 100 && ones === 0) {
    forms.add(NUMBER_WORDS[100]);
    return;
  }
  if (NUMBER_WORDS[tens] && ones === 0) {
    forms.add(NUMBER_WORDS[tens]);
    return;
  }
  if (NUMBER_WORDS[tens] && NUMBER_WORDS[ones]) {
    forms.add(`${NUMBER_WORDS[tens]}-${NUMBER_WORDS[ones]}`);
  }
}

/**
 * Build the numeric fact registry from the authoritative package.
 *
 * Every entry names the value, where it came from, and which surface forms
 * the provider may use. Values are read from fields the deterministic layer
 * already published; nothing here is calculated from the insights.
 */
export function buildNumericFactRegistry(insights) {
  const facts = [];
  const seen = new Set();
  const list = Array.isArray(insights) ? insights : [];
  const push = (id, label, value, kind, source, unit = null) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return;
    const forms = new Set(numericSurfaceForms(num));
    addWordForms(forms, num);
    if (forms.size === 0) return;
    if (seen.has(id)) return;
    seen.add(id);
    facts.push({
      id,
      label,
      value: num,
      unit,
      kind: NUMERIC_FACT_KINDS.includes(kind) ? kind : 'exact',
      source,
      permittedForms: [...forms].sort(),
    });
  };

  for (const insight of list) {
    if (!insight || typeof insight !== 'object') continue;
    const base = text(insight.id) ?? 'insight';

    if (insight.sample && Number.isFinite(Number(insight.sample.size))) {
      push(`${base}.sample.size`, 'sample size', insight.sample.size, 'exact', 'intelligenceContracts.assessSample');
    }
    if (insight.ranking && Number.isFinite(Number(insight.ranking.rank))) {
      push(`${base}.ranking.rank`, 'rank', insight.ranking.rank, 'exact', 'intelligenceConsolidation.rankingFor');
    }
    if (insight.metric && Number.isFinite(Number(insight.metric.rankValue))) {
      push(`${base}.metric.rankValue`, 'rank value', insight.metric.rankValue, 'exact', 'performanceAttribution.getAttribution');
    }

    // Authoritative facts preserved across the consolidation boundary. These
    // were already computed upstream; nothing here is recalculated. The raw
    // `metric` path is kept as a fallback for un-normalized producers.
    const carried = Array.isArray(insight.permittedFacts?.numeric) ? insight.permittedFacts.numeric : [];
    for (const f of carried) {
      if (!f || typeof f !== 'object') continue;
      const label = text(f.metric);
      if (label === null) continue;
      push(`${base}.${label}`, label, f.value, f.kind, f.source, f.unit ?? null);
    }
    if (carried.length === 0) {
      const metrics = Array.isArray(insight.metric?.metrics) ? insight.metric.metrics : [];
      for (const m of metrics) {
        if (!m || typeof m !== 'object') continue;
        if (Number.isFinite(Number(m.change))) {
          push(`${base}.change.${text(m.metric) ?? 'metric'}`, `${text(m.metric) ?? 'metric'} change`,
            m.change, 'derived', 'degradationEngine.metricVerdict');
        }
        for (const key of ['historical', 'recent']) {
          if (Number.isFinite(Number(m[key]))) {
            push(`${base}.${key}.${text(m.metric) ?? 'metric'}`, `${text(m.metric) ?? 'metric'} ${key}`,
              m[key], 'exact', 'tradingAnalytics.getCoreMetrics');
          }
        }
      }
    }

    // Figures already present in the evidence text and window label.
    const haystack = [];
    for (const entry of Array.isArray(insight.evidence) ? insight.evidence : []) {
      if (entry && typeof entry.description === 'string') haystack.push(entry.description);
      if (entry && typeof entry.window === 'string') haystack.push(entry.window);
    }
    const seenNumbers = new Set();
    for (const raw of haystack) {
      // A leading hyphen only counts as a sign when it is not the tail of a
      // word such as the "-vs-" in a window label, which would otherwise turn
      // "40-vs-40" into a fabricated negative forty.
      for (const token of raw.match(/(?<![A-Za-z])-?\d+(?:\.\d+)?/g) || []) {
        if (seenNumbers.has(token)) continue;
        seenNumbers.add(token);
        push(`${base}.evidence.${token}`, 'evidence figure', Number(token), 'exact', 'insight evidence');
      }
    }
  }

  return {
    facts,
    allowedTokens: new Set(facts.flatMap((f) => f.permittedForms)),
  };
}

/**
 * Numbers in a provider answer that are not a permitted form of an
 * authoritative fact. This is the anti-fabrication check: re-expressing a
 * value is fine, introducing one is not.
 */
export function findUngroundedNumbers(textValue, registry) {
  const allowed = registry instanceof Set ? registry : registry?.allowedTokens ?? new Set();
  const tokens = String(textValue ?? '').match(/(?<![A-Za-z])-?\d+(?:\.\d+)?/g) || [];
  const ungrounded = [];
  for (const token of tokens) {
    if (allowed.has(token)) continue;
    ungrounded.push(token);
  }
  return [...new Set(ungrounded)];
}

/**
 * Direction vocabulary. A figure only supports a direction when a cited
 * derived fact carries that sign: "8" is a legitimate historical profit
 * factor, but it is not "a decline of 8%".
 */
const DECLINE_WORDS = ['fell', 'fall', 'falling', 'decline', 'declined', 'decreasing',
  'decrease', 'decreased', 'dropped', 'drop', 'lower', 'worse', 'down'];
const RISE_WORDS = ['rose', 'rise', 'rising', 'increase', 'increased', 'increasing',
  'grew', 'gain', 'gained', 'higher', 'up'];

export function directionOfClaim(textValue) {
  const s = String(textValue ?? '').toLowerCase();
  const down = DECLINE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(s));
  const up = RISE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(s));
  if (down === up) return null;
  return down ? 'decline' : 'rise';
}

/**
 * Metric names a provider may refer to in prose, mapped onto the fact ids
 * they must correspond to. Without this, a real figure attached to the wrong
 * metric ("Win rate decreased by 13.88%" citing the profit factor change)
 * passes every other check.
 */
const METRIC_PHRASES = [
  { phrases: ['win rate', 'winrate', 'win-rate'], prefix: 'winRate' },
  { phrases: ['average r', 'avg r', 'avgr', 'avg-r'], prefix: 'avgR' },
  { phrases: ['profit factor', 'profitfactor', 'profit-factor'], prefix: 'profitFactor' },
  { phrases: ['sample size', 'sample-size'], prefix: 'sample.size' },
];

/** Metric prefixes the text refers to, if any. */
export function referencedMetrics(textValue) {
  const s = String(textValue ?? '').toLowerCase();
  const found = [];
  for (const entry of METRIC_PHRASES) {
    if (entry.phrases.some((p) => s.includes(p))) found.push(entry.prefix);
  }
  return found;
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
  const registry = buildNumericFactRegistry(selected);
  return {
    contractVersion: AI_CONTRACT_VERSION,
    generatedFrom: 'deterministic-intelligence',
    insights: selected,
    // The provider may only use these values, in these forms. It is handed
    // the registry rather than the raw insights so there is no path by which
    // it could read a number that was never authorised.
    allowedNumericFacts: registry.facts,
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

function validateGroundedItems(items, label, insightsById, registry, cfg, violations) {
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
    // Numbers must be traceable to the facts this entry cites, not merely to
    // any authorised value. Otherwise a legitimate figure can be re-used in a
    // role no fact supports: "8" is a historical profit factor, not a fall.
    const citedFactIds = Array.isArray(item.factIds)
      ? item.factIds.map((v) => text(v)).filter((v) => v !== null)
      : [];
    const citedFacts = citedFactIds
      .map((fid) => (registry.factsById instanceof Map ? registry.factsById.get(fid) : undefined))
      .filter((f) => f !== undefined);

    const tokens = String(body).match(/(?<![A-Za-z])-?\d+(?:\.\d+)?/g) || [];
    if (tokens.length > 0) {
      if (citedFacts.length === 0) {
        violations.push(`${label} entry states a figure without citing an authorised fact`);
        continue;
      }
      const covered = new Set(citedFacts.flatMap((f) => f.permittedForms || []));
      const unattributed = tokens.filter((t) => !covered.has(t));
      if (unattributed.length > 0) {
        violations.push(`${label} entry states a figure not covered by the facts it cites (${unattributed.join(', ')})`);
        continue;
      }
      // A named metric must match the cited facts, so a real figure cannot be
      // attached to a metric it does not describe.
      const referenced = referencedMetrics(body);
      if (referenced.length > 0) {
        const mismatched = citedFacts.filter((f) => !referenced.some((p) => String(f.id).includes(p)));
        if (mismatched.length > 0) {
          violations.push(`${label} entry names a metric its cited facts do not cover (${mismatched.map((f) => f.id).join(', ')})`);
          continue;
        }
      }
      // A direction claim needs a derived fact carrying that sign.
      const direction = directionOfClaim(body);
      if (direction !== null) {
        const signed = citedFacts.some((f) => {
          if (f.kind !== 'derived') return false;
          const v = Number(f.value);
          return direction === 'decline' ? v < 0 : v > 0;
        });
        if (!signed) {
          violations.push(`${label} entry asserts a ${direction} without a cited derived fact showing that sign`);
          continue;
        }
      }
    }

    const fabricated = findUngroundedNumbers(body, registry);
    if (fabricated.length > 0) {
      violations.push(`${label} entry states a figure that is not an authorised fact (${fabricated.join(', ')})`);
      continue;
    }

    out.push({
      text: body,
      insightIds: citedIds.map(String).sort(),
      groundedOn: claimed ?? weakest,
      factIds: citedFacts.map((f) => f.id).sort(),
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
  const registry = Array.isArray(request.allowedNumericFacts)
    ? {
      facts: request.allowedNumericFacts,
      factsById: new Map(request.allowedNumericFacts.filter((f) => text(f?.id) !== null).map((f) => [String(f.id), f])),
      allowedTokens: new Set(
        request.allowedNumericFacts.flatMap((f) => (Array.isArray(f?.permittedForms) ? f.permittedForms : [])),
      ),
    }
    : (() => {
      const built = buildNumericFactRegistry(request.insights);
      return {
        ...built,
        factsById: new Map(built.facts.map((f) => [f.id, f])),
      };
    })();

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
    const fabricated = findUngroundedNumbers(summaryText, registry);
    if (fabricated.length > 0) {
      violations.push(`summary states a figure that is not an authorised fact (${fabricated.join(', ')})`);
    }
  }

  const observations = validateGroundedItems(
    result.observations, 'observations', insightsById, registry, cfg, violations,
  );
  const hypotheses = validateGroundedItems(
    result.possibleHypotheses, 'possibleHypotheses', insightsById, registry, cfg, violations,
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
  NUMERIC_FACT_KINDS,
  resolveAiConfig,
  weakestTraceability,
  numericSurfaceForms,
  buildNumericFactRegistry,
  findUngroundedNumbers,
  findUnsupportedStateClaims,
  directionOfClaim,
  referencedMetrics,
  buildAiRequest,
  isValidProviderAdapter,
  validateAiResult,
};