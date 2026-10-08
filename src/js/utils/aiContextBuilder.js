// ============================================
// AI context builder — PURE, read-only.
// Vanilla ESM, offline-first. No side effects on import.
//
// Phase 10E-B. Turns already-qualified canonical insights into the closed
// evidence package a provider is allowed to see.
//
// Pure means: deterministic output, no network, no provider imports, no
// metric calculation, no storage mutation, no AI call, no random ids and
// no generated timestamps. The same insights always produce the same
// package, so a provider cannot see something the next run would not.
//
// Closed means: the package is an explicit whitelist. It carries only the
// fields needed to explain the selected insights, and it never carries the
// trading dataset itself. Exposing raw trades would raise privacy exposure,
// token cost and hallucination surface for no benefit — the intelligence
// layer has already reduced them to findings.
//
// Every number comes from the registry published by the contract, which is
// built from values the deterministic layer already computed. This module
// calculates nothing.
import {
  AI_CONTRACT_VERSION,
  AI_RESULT_SECTIONS,
  buildNumericFactRegistry,
  resolveAiConfig,
} from './aiAdapterContract.js';
import { INSIGHT_CATEGORIES, INSIGHT_SOURCES, INSIGHT_STATES, TRACEABILITY_LEVELS } from './intelligenceConsolidation.js';

export const AI_CONTEXT_SCHEMA_VERSION = '1.0.0';

export const AI_CONTEXT_PURPOSE =
  'Summarise and question existing evidence-based findings for a trading journal owner. ' +
  'The findings, their states, their sample sizes and every figure shown were computed ' +
  'deterministically before this package was built and are not yours to change.';

export const AI_CONTEXT_FORBIDDEN_ACTIONS = [
  'Do not state, restate or imply a different state than the one supplied.',
  'Do not upgrade evidence quality: a pattern-level finding cannot be discussed as if it had individual trades.',
  'Do not introduce any figure that is not an allowed numeric fact.',
  'Do not calculate differences, ratios or percentages from supplied figures.',
  'Do not claim causation; describe only what was observed.',
  'Do not give trading, risk, position-sizing or rule instructions.',
  'Do not rank, score or compare beyond the supplied ranking labels.',
  'Do not treat an absent or thin finding as evidence of good performance.',
];

export const AI_CONTEXT_INSTRUCTIONS = [
  'You are summarising findings that a deterministic engine already produced and qualified.',
  'Every insight you are given carries a state, a sample band and an evidence level. Those are authoritative.',
  'ranking.eligible means only that the sample was large enough to rank; a rank exists only when ranking.label states one.',
  'Cite the insights each observation rests on, and never ground a claim more strongly than the weakest insight you cite.',
  'If the evidence is aggregate or pattern level, say so rather than implying you inspected individual trades.',
  'Prefer questions for the trader over conclusions.',
  'Hypotheses must be labelled unverified; they are starting points for review, not findings.',
];

/** Bounded so a large window never becomes an unbounded token cost. */
export const MAX_SOURCE_REFS_IN_CONTEXT = 10;
export const MAX_TEXT_LENGTH = 400;

function clip(value, max = MAX_TEXT_LENGTH) {
  const s = value == null ? '' : String(value);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function compare(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Select which insights enter the package.
 *
 * Attention-worthy states come first so a bounded budget still covers what
 * matters, and ties break deterministically on id. Insights whose state is
 * unavailable are kept only if nothing else fits, since they cannot be
 * prioritised.
 */
function selectInsights(insights, maxInsights) {
  const rank = new Map(INSIGHT_STATES.map((s, i) => [s, i]));
  const ordered = [...insights].sort((a, b) => {
    const ar = a?.state === null || a?.state === undefined ? INSIGHT_STATES.length : rank.get(a.state) ?? INSIGHT_STATES.length;
    const br = b?.state === null || b?.state === undefined ? INSIGHT_STATES.length : rank.get(b.state) ?? INSIGHT_STATES.length;
    if (ar !== br) return ar - br;
    return compare(a?.id, b?.id);
  });
  return ordered.slice(0, maxInsights);
}

/** Categorical statements the package authorises, as an explicit closed set. */
function buildCategoricalFacts(insights) {
  const states = [];
  const categories = [];
  const sources = [];
  const bands = [];
  for (const insight of insights) {
    if (insight.state != null && !states.includes(insight.state)) states.push(insight.state);
    if (insight.category && !categories.includes(insight.category)) categories.push(insight.category);
    if (insight.source && !sources.includes(insight.source)) sources.push(insight.source);
    const band = insight.sample?.band;
    if (band && !bands.includes(band)) bands.push(band);
  }
  return {
    states: states.sort(),
    categories: categories.sort(),
    sources: sources.sort(),
    sampleBands: bands.sort(),
    knownStateVocabulary: [...INSIGHT_STATES],
    knownCategoryVocabulary: [...INSIGHT_CATEGORIES],
    knownSourceVocabulary: [...INSIGHT_SOURCES],
    knownTraceabilityVocabulary: [...TRACEABILITY_LEVELS],
  };
}

/**
 * The evidence for one insight, reduced to what is needed to explain it.
 *
 * Record ids are included only as a bounded sample with the true total
 * alongside, because a full id list adds cost and privacy exposure without
 * making the finding any more explainable.
 */
function buildEvidence(insight) {
  const out = [];
  for (const entry of Array.isArray(insight?.evidence) ? insight.evidence : []) {
    const refs = Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [];
    out.push({
      description: clip(entry.description),
      traceability: entry.traceability ?? null,
      scope: entry.scope ?? null,
      window: entry.window ?? null,
      provenance: Array.isArray(entry.sources) ? [...entry.sources] : [],
      sourceRecordCount: refs.length,
      sourceRecordSample: refs.slice(0, MAX_SOURCE_REFS_IN_CONTEXT),
      sourceRecordsTruncated: refs.length > MAX_SOURCE_REFS_IN_CONTEXT,
    });
  }
  return out;
}

/**
 * Build the closed AI context package.
 *
 * @param {Array} insights — canonical insights from intelligenceConsolidation.
 * @param {object} options — { maxInsights }
 * @returns {object} AIContext
 */
export function buildAiContext(insights, options = {}) {
  const cfg = resolveAiConfig(options);
  const list = Array.isArray(insights) ? insights.filter((i) => i && typeof i === 'object') : [];
  const selected = selectInsights(list, cfg.maxInsights);

  const registry = buildNumericFactRegistry(selected);
  const selectedIds = new Set(selected.map((i) => text_(i.id)));

  const packaged = selected.map((insight) => ({
    id: text_(insight.id),
    category: insight.category ?? null,
    source: insight.source ?? null,
    title: clip(insight.title),
    state: insight.state ?? null,
    sourceState: insight.sourceState ?? null,
    summary: clip(insight.summary),
    whySurfaced: clip(insight.whySurfaced),
    investigationQuestion: clip(insight.investigationQuestion),
    traceability: insight.traceability ?? null,
    hasRecordEvidence: insight.hasRecordEvidence === true,
    sample: {
      size: insight.sample?.size ?? null,
      band: insight.sample?.band ?? null,
      smallSample: insight.sample?.smallSample ?? null,
      qualificationReason: clip(insight.sample?.qualificationReason, MAX_TEXT_LENGTH),
    },
    ranking: {
      eligible: insight.ranking?.eligible === true,
      label: insight.ranking?.label ?? null,
      suppressionReason: clip(insight.ranking?.suppressionReason, 200),
    },
    evidence: buildEvidence(insight),
    // Authoritative facts preserved by the consolidation layer. Carried
    // through verbatim: this module neither calculates nor extends them.
    permittedNumericFacts: (Array.isArray(insight.permittedFacts?.numeric)
      ? insight.permittedFacts.numeric
      : []).map((f) => ({
      metric: f?.metric ?? null,
      value: Number.isFinite(Number(f?.value)) ? Number(f.value) : null,
      unit: f?.unit ?? null,
      kind: f?.kind ?? null,
      source: f?.source ?? null,
    })),
    provenance: Array.isArray(insight.provenance) ? [...insight.provenance] : [],
    permittedFactIds: registry.facts
      .filter((f) => f.id.startsWith(`${text_(insight.id)}.`))
      .map((f) => f.id)
      .sort(),
  }));

  return {
    schemaVersion: AI_CONTEXT_SCHEMA_VERSION,
    contractVersion: AI_CONTRACT_VERSION,
    purpose: AI_CONTEXT_PURPOSE,
    instructions: [...AI_CONTEXT_INSTRUCTIONS],
    forbiddenActions: [...AI_CONTEXT_FORBIDDEN_ACTIONS],
    allowedSections: [...AI_RESULT_SECTIONS],
    selection: {
      requested: list.length,
      included: packaged.length,
      maxInsights: cfg.maxInsights,
      order: INSIGHT_STATES.map((s) => s).join(', then '),
    },
    allowedNumericFacts: registry.facts.map((f) => ({
      id: f.id,
      label: f.label,
      value: f.value,
      kind: f.kind,
      source: f.source,
      permittedForms: [...f.permittedForms],
    })),
    allowedCategoricalFacts: buildCategoricalFacts(packaged),
    insights: packaged,
  };
}

function text_(value) {
  const s = value == null ? '' : String(value).trim();
  return s === '' ? 'unknown' : s;
}

export default {
  AI_CONTEXT_SCHEMA_VERSION,
  AI_CONTEXT_PURPOSE,
  AI_CONTEXT_INSTRUCTIONS,
  AI_CONTEXT_FORBIDDEN_ACTIONS,
  MAX_SOURCE_REFS_IN_CONTEXT,
  buildAiContext,
};