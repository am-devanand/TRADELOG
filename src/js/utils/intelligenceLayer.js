// ============================================
// Intelligence consolidation — PURE, read-only.
// Vanilla ESM, offline-first. No side effects on import.
//
// Phase 10D. Normalizes three different insight producers into ONE
// presentation contract, then merges and orders them.
//
//   improvementEngine.getImprovementPatterns  ─┐
//   degradationEngine.detectDegradation       ─┼→ normalizeInsight()
//   attributionIntelligence.qualifyAttribution┘        ↓
//                                        dedupe + deterministic order
//
// This layer computes NOTHING. It never calls getCoreMetrics, never
// derives a win rate or a profit factor, and never re-decides whether a
// sample is sufficient. Those verdicts arrive already made from the
// authoritative engines and are only relabelled here.
//
// The point of normalizing is that no UI component ever needs to know
// which producer an insight came from. Degradation used to hide its
// reason under metric.reason while attribution used
// metric.suppressionReason; both land in the same canonical fields now.
//
// Wording is guarded: whySurfaced must describe why a finding was
// surfaced, never assert why it happened. Causal phrasing is rejected
// rather than passed through to the UI.
// ============================================
import {
  assessSample,
  findCausalClaims,
  INSIGHT_CATEGORIES,
} from './intelligenceContracts.js';

/** Buckets the intelligence page renders. */
export const INTELLIGENCE_STATES = [
  'NEEDS_ATTENTION',
  'IMPROVING',
  'WATCH',
  'STABLE',
  'INSUFFICIENT_EVIDENCE',
];

export const INTELLIGENCE_SOURCES_KIND = ['improvement', 'degradation', 'attribution'];

function text(value) {
  const s = value == null ? '' : String(value).trim();
  return s === '' ? null : s;
}

function byName(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Observational templates only. Each explains why a finding was surfaced
 * based on the evidence, and none of them claim a cause.
 */
const WHY_BY_STATE = {
  NEEDS_ATTENTION:
    'Surfaced because recent results sit materially outside the comparable earlier window.',
  WATCH:
    'Surfaced because the shift is present but too small to call a firm change.',
  IMPROVING:
    'Surfaced because recent results sit above the comparable earlier window.',
  STABLE:
    'Surfaced because the comparable windows show no material movement.',
  INSUFFICIENT_EVIDENCE:
    'Surfaced as unranked because the recorded sample is too small to support a finding.',
};

const QUESTION_BY_STATE = {
  NEEDS_ATTENTION:
    'What changed between these two windows that you could describe in your own notes?',
  WATCH:
    'What do you notice about this area that is worth watching rather than acting on?',
  IMPROVING:
    'What was consistent here that you could note for your next review session?',
  STABLE:
    'Is there anything in your notes about this area that the numbers do not capture?',
  INSUFFICIENT_EVIDENCE:
    'What would you want recorded consistently here before this can be judged?',
};

/**
 * Map every producer's own vocabulary onto the canonical state.
 * Producers keep their own semantics; this is relabelling only.
 */
export function toCanonicalState(raw) {
  const category = text(raw?.category)?.toUpperCase() ?? '';
  const metric = raw?.metric && typeof raw.metric === 'object' ? raw.metric : {};

  // Degradation carries an explicit verdict already.
  const degradationState = text(metric.state)?.toUpperCase();
  if (category === 'DEGRADATION' && degradationState) {
    if (degradationState === 'DEGRADING') return 'NEEDS_ATTENTION';
    if (degradationState === 'WATCH') return 'WATCH';
    if (degradationState === 'IMPROVING') return 'IMPROVING';
    if (degradationState === 'STABLE') return 'STABLE';
    if (degradationState === 'INSUFFICIENT_DATA') return 'INSUFFICIENT_EVIDENCE';
  }

  // Attribution is rankable or not; a rankable row is browsable, not a warning.
  if (category === 'ATTRIBUTION') {
    if (metric.rankable === true) return 'STABLE';
    if (metric.rankable === false || metric.suppressionReason) return 'INSUFFICIENT_EVIDENCE';
    return 'STABLE';
  }

  // Improvement patterns are classified by category, and the two process
  // cohorts are distinguished by whether they are the low or high cohort.
  const id = text(raw?.id) ?? '';
  if (category === 'MISTAKE') return 'NEEDS_ATTENTION';
  if (category === 'STRENGTH') return 'IMPROVING';
  if (category === 'ADHERENCE') return 'NEEDS_ATTENTION';
  if (category === 'PROCESS') {
    return id.includes('low') ? 'NEEDS_ATTENTION' : 'IMPROVING';
  }
  if (category === 'DEGRADING') return 'NEEDS_ATTENTION';
  return 'STABLE';
}

/** Which producer an insight came from, without the UI needing to guess. */
export function toSourceKind(raw) {
  const category = text(raw?.category)?.toUpperCase() ?? '';
  if (category === 'DEGRADATION') return 'degradation';
  if (category === 'ATTRIBUTION') return 'attribution';
  if (INSIGHT_CATEGORIES.includes(category)) return 'improvement';
  return null;
}

/**
 * Why this was surfaced. Falls back to the state template when a producer
 * supplies nothing usable, and never carries causal phrasing: if a source
 * reason reads causally it is dropped in favour of the template rather
 * than shown as an explanation.
 */
export function toWhySurfaced(raw, canonicalState) {
  const metric = raw?.metric && typeof raw.metric === 'object' ? raw.metric : {};
  const supplied = text(metric.suppressionReason) ?? text(metric.reason);
  if (supplied) {
    const causal = findCausalClaims(supplied);
    if (causal.length === 0) {
      return canonicalState === 'INSUFFICIENT_EVIDENCE'
        ? `Surfaced as unranked: ${supplied}.`
        : `Surfaced: ${supplied}.`;
    }
  }
  return WHY_BY_STATE[canonicalState] ?? WHY_BY_STATE.STABLE;
}

/**
 * Canonical evidence entries. Every insight exposes what it rests on and
 * which authoritative module produced the numbers, so provenance survives
 * normalization instead of being flattened away.
 */
export function toEvidenceArray(raw, provenance = []) {
  const ref = raw?.evidenceRef && typeof raw.evidenceRef === 'object' ? raw.evidenceRef : {};
  const described = text(raw?.evidence);
  const entries = [];
  if (described) {
    entries.push({
      kind: 'observation',
      description: described,
      sampleSize: Number.isFinite(Number(raw?.sampleSize)) ? Number(raw.sampleSize) : null,
      refIds: Array.isArray(ref.refIds) ? [...ref.refIds] : [],
      sources: [...provenance],
    });
  }
  if (!entries.length) {
    entries.push({
      kind: 'unavailable',
      description: null,
      sampleSize: Number.isFinite(Number(raw?.sampleSize)) ? Number(raw.sampleSize) : null,
      refIds: Array.isArray(ref.refIds) ? [...ref.refIds] : [],
      sources: [...provenance],
    });
  }
  return entries;
}

/**
 * Ranking eligibility. "Not rankable because the sample is too small" and
 * "not rankable because this finding has no ranking dimension" are different
 * statements, and collapsing them into one reason produces the tautology
 * "not rankable — not eligible for ranking".
 */
export function toRanking(raw, canonicalState, source = null) {
  const metric = raw?.metric && typeof raw.metric === 'object' ? raw.metric : {};
  const eligible = raw?.rankable === true;
  if (eligible) {
    const rank = Number.isFinite(Number(metric.rank)) ? Number(metric.rank) : null;
    return {
      eligible: true,
      label: metric.rank != null ? `Rank ${metric.rank}` : 'Rankable',
      rank,
      suppressionReason: null,
    };
  }
  const supplied = text(metric.suppressionReason) ?? text(metric.reason);
  const hasRankingDimension = source === 'degradation' || source === 'attribution';
  return {
    eligible: false,
    label: null,
    rank: null,
    suppressionReason:
      supplied ??
      (hasRankingDimension || canonicalState === 'INSUFFICIENT_EVIDENCE'
        ? 'sample below the rankable minimum'
        : 'ranking does not apply to this finding type'),
  };
}

/**
 * Raw producer output does not always carry a provenance array — the
 * improvement patterns, for instance, are the output of one named engine
 * but do not say so on the object. The consolidator already knows which
 * producer an insight came from, so provenance is attributed here rather
 * than lost. Naming the producer is not importing it: these are the
 * authoritative exports an insight was computed from, not code paths
 * this layer calls.
 */
const DEFAULT_PROVENANCE = {
  degradation: 'tradingAnalytics.getCoreMetrics',
  attribution: 'performanceAttribution.getAttribution',
  improvement: 'improvementEngine.getImprovementPatterns',
};

/**
 * Normalize any producer's insight into the one presentation contract.
 * Missing information becomes null or an explicit unavailable state; it is
 * never invented.
 */
export function normalizeInsight(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const category = text(raw.category)?.toUpperCase();
  if (!category || !INSIGHT_CATEGORIES.includes(category)) return null;

  const state = toCanonicalState(raw);
  const source = toSourceKind(raw);
  const metric = raw.metric && typeof raw.metric === 'object' ? raw.metric : {};
  const sampleSize = Number.isFinite(Number(raw.sampleSize))
    ? Math.max(0, Math.floor(Number(raw.sampleSize)))
    : 0;
  const sample = raw.sample && typeof raw.sample === 'object' ? raw.sample : assessSample(sampleSize);

  const declared = Array.isArray(raw.provenance)
    ? raw.provenance.filter((p) => typeof p === 'string' && p.trim() !== '')
    : [];
  const fallback = DEFAULT_PROVENANCE[source];
  const provenance = declared.length > 0 ? declared : fallback ? [fallback] : [];

  return {
    id: text(raw.id) ?? 'unknown',
    source,
    category,
    title: text(raw.title) ?? 'Untitled finding',
    state,
    summary: text(raw.evidence) ?? 'No summary available.',
    whySurfaced: toWhySurfaced(raw, state),
    evidence: toEvidenceArray(raw, provenance),
    sample,
    ranking: toRanking(raw, state, source),
    investigationQuestion:
      text(raw.suggestedReviewQuestion) ?? QUESTION_BY_STATE[state] ?? QUESTION_BY_STATE.STABLE,
    provenance: [...provenance],
    dimension: text(metric.dimension),
    dimensionValue: text(metric.dimensionValue),
  };
}

/**
 * Merge, dedupe and order. Pure: takes already-computed producer output.
 *
 * Dedupe keeps the first occurrence in a fixed source order
 * (degradation, attribution, improvement) so a collision resolves the same
 * way every run rather than by whichever arrived first.
 */
export function consolidateIntelligence(input = {}) {
  const groups = [
    ...(Array.isArray(input.degradation) ? input.degradation : []),
    ...(Array.isArray(input.attribution) ? input.attribution : []),
    ...(Array.isArray(input.improvements) ? input.improvements : []),
  ];

  const seen = new Map();
  const normalized = [];
  for (const raw of groups) {
    const insight = normalizeInsight(raw);
    if (!insight) continue;
    if (seen.has(insight.id)) continue;
    seen.set(insight.id, insight);
    normalized.push(insight);
  }

  const bucketOrder = new Map(INTELLIGENCE_STATES.map((s, i) => [s, i]));
  return normalized.sort((a, b) => {
    const ab = bucketOrder.get(a.state) ?? INTELLIGENCE_STATES.length;
    const bb = bucketOrder.get(b.state) ?? INTELLIGENCE_STATES.length;
    if (ab !== bb) return ab - bb;
    const ar = a.ranking.rank;
    const br = b.ranking.rank;
    if (ar !== null && br !== null && ar !== br) return ar - br;
    if (ar !== null && br === null) return -1;
    if (ar === null && br !== null) return 1;
    return byName(a.id, b.id);
  });
}

/** Group normalized insights into the buckets the page renders. */
export function groupByState(insights = []) {
  const groups = {};
  for (const state of INTELLIGENCE_STATES) groups[state] = [];
  for (const insight of insights) {
    if (!insight || !groups[insight.state]) continue;
    groups[insight.state].push(insight);
  }
  return groups;
}

export default {
  INTELLIGENCE_STATES,
  INTELLIGENCE_SOURCES_KIND,
  toCanonicalState,
  toSourceKind,
  toWhySurfaced,
  toEvidenceArray,
  toRanking,
  normalizeInsight,
  consolidateIntelligence,
  groupByState,
};