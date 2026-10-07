// ============================================
// Intelligence consolidation — PURE, read-only.
// Vanilla ESM, offline-first. No side effects on import.
//
// Phase 10D. Normalizes improvement patterns, degradation findings and
// qualified attribution findings into ONE canonical insight contract,
// then deduplicates and orders them deterministically.
//
// Existing engines are the only source of numerical truth. This module
// computes nothing: it never calls getCoreMetrics, never derives a win
// rate or profit factor, and never independently decides whether a
// sample is sufficient. Those verdicts arrive already made and are only
// relabelled here.
//
// The point is that no UI component needs to know which producer an
// insight came from. Degradation hid its reason under metric.reason while
// attribution used metric.suppressionReason; both are normalized into the
// same canonical ranking fields.
//
// This module deliberately imports none of the producer engines. It names
// them as strings for the informational `source` field and to attribute
// provenance, but the names are labels, not code paths it calls.
// ============================================
import { assessSample, findCausalClaims } from './intelligenceContracts.js';
import { ANALYTICS_THRESHOLDS } from './models.js';

/** Authoritative producer that produced an insight. Informational only. */
export const INSIGHT_SOURCES = ['degradationEngine', 'attributionIntelligence', 'improvementEngine'];

/** Controlled category vocabulary. Nothing outside this set is emitted. */
export const INSIGHT_CATEGORIES = [
  'strategy',
  'rule',
  'mistake',
  'degradation',
  'attribution',
  'improvement',
  'process',
];

/** Controlled state vocabulary, listed in presentation-priority order. */
export const INSIGHT_STATES = [
  'NEEDS_ATTENTION',
  'WATCH',
  'IMPROVING',
  'STABLE',
  'INSUFFICIENT_DATA',
];

/**
 * Producer categories mapped onto the canonical vocabulary. Anything not
 * listed here is rejected rather than guessed at, so a future producer
 * cannot silently invent a category.
 */
const CATEGORY_MAP = {
  DEGRADATION: 'degradation',
  ATTRIBUTION: 'attribution',
  MISTAKE: 'mistake',
  STRENGTH: 'improvement',
  PROCESS: 'process',
  ADHERENCE: 'rule',
  STRATEGY: 'strategy',
  RULE: 'rule',
  PATTERN: 'improvement',
};

/** Provenance attributed when a producer does not carry it on the object. */
const PRODUCER_PROVENANCE = {
  degradationEngine: 'tradingAnalytics.getCoreMetrics',
  attributionIntelligence: 'performanceAttribution.getAttribution',
  improvementEngine: 'improvementEngine.getImprovementPatterns',
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

function toSample(raw) {
  const declared = raw && typeof raw.sample === 'object' && raw.sample !== null ? raw.sample : null;
  const size = Number.isFinite(Number(declared?.sampleSize))
    ? Math.max(0, Math.floor(Number(declared.sampleSize)))
    : Number.isFinite(Number(raw?.sampleSize))
      ? Math.max(0, Math.floor(Number(raw.sampleSize)))
      : null;

  // Band and minimum always come from the one canonical threshold set.
  const assessment = assessSample(size ?? 0);
  const band = declared?.level && typeof declared.level === 'string' ? declared.level : assessment.level;
  const minimumSample = ANALYTICS_THRESHOLDS.minimumSample;

  const qualificationReason =
    size === null
      ? 'Sample size was not reported by the source.'
      : size < minimumSample
        ? `Sample of ${size} is below the minimum of ${minimumSample}; descriptive only.`
        : band === 'STRONG'
          ? `Sample of ${size} meets the strong-evidence threshold.`
          : `Sample of ${size} meets the minimum of ${minimumSample} but stays below the strong threshold.`;

  return {
    size,
    band,
    smallSample: size === null ? null : size < minimumSample,
    qualificationReason,
  };
}

/**
 * Observational templates per source and state. They explain the detection
 * or qualification condition, never why the trading outcome occurred.
 */
function whySurfacedFor(source, state, suppliedReason) {
  if (suppliedReason && findCausalClaims(suppliedReason).length === 0) {
    return state === 'INSUFFICIENT_DATA'
      ? `Retained but not ranked because ${suppliedReason}.`
      : `Surfaced because ${suppliedReason}.`;
  }
  const byState = {
    NEEDS_ATTENTION:
      source === 'degradationEngine'
        ? 'Surfaced because recent results sit materially outside the comparable earlier window.'
        : 'Surfaced because this pattern repeated often enough to warrant review.',
    WATCH: 'Surfaced because the shift is present but too small to call a firm change.',
    IMPROVING:
      source === 'improvementEngine'
        ? 'Surfaced because this positive pattern repeated often enough to warrant review.'
        : 'Surfaced because recent results sit above the comparable earlier window.',
    STABLE:
      source === 'attributionIntelligence'
        ? 'Surfaced as browsable because the comparable windows show no material movement.'
        : 'Surfaced because the comparable windows show no material movement.',
    INSUFFICIENT_DATA:
      'Surfaced as unranked because the recorded sample is too small to support a finding.',
  };
  return byState[state] ?? 'Surfaced because the source reported this finding against its qualification threshold.';
}

function investigationFor(state, source, raw) {
  const supplied = text(raw?.suggestedReviewQuestion);
  if (supplied) return supplied;
  const byState = {
    NEEDS_ATTENTION:
      source === 'degradationEngine'
        ? 'Has the recent shift persisted across the next comparable sample?'
        : 'Is this pattern concentrated in a particular session or setup?',
    WATCH: 'What do you notice about this area that is worth watching rather than acting on?',
    IMPROVING: 'What was consistent here that you could note for your next review session?',
    STABLE: 'Is there anything in your notes about this area that the numbers do not capture?',
    INSUFFICIENT_DATA: 'What would you want recorded consistently here before this can be judged?',
  };
  return byState[state] ?? 'What would you want to check next here?';
}

/**
 * Ranking status. Never decides eligibility itself — it reads the
 * producer's verdict, which came from qualifyForRanking.
 */
function rankingFor(raw, state, source) {
  const metric = raw?.metric && typeof raw.metric === 'object' ? raw.metric : {};
  const eligible = raw?.rankable === true;
  if (eligible) {
    const rank = Number.isFinite(Number(metric.rank)) ? Number(metric.rank) : null;
    return {
      eligible: true,
      label: rank === null ? 'Rankable' : `Rank #${rank}`,
      suppressionReason: null,
    };
  }
  const supplied = text(metric.suppressionReason) ?? text(metric.reason);
  const ranked = source === 'degradationEngine' || source === 'attributionIntelligence';
  return {
    eligible: false,
    label: null,
    suppressionReason:
      supplied ??
      (ranked || state === 'INSUFFICIENT_DATA'
        ? 'Sample is below the ranking threshold.'
        : 'Ranking does not apply to this finding type.'),
  };
}

/**
 * Evidence. Empty when the source supplied none — never a placeholder
 * carrying invented content. Numerical claims keep their provenance.
 */
function evidenceFor(raw, provenance) {
  const ref = raw?.evidenceRef && typeof raw.evidenceRef === 'object' ? raw.evidenceRef : {};
  const description = text(raw?.evidence);
  const refIds = Array.isArray(ref.refIds) ? ref.refIds.filter((r) => text(r) !== null) : [];
  if (!description && refIds.length === 0) return [];
  return [
    {
      kind: 'observation',
      description,
      refIds,
      sources: [...provenance],
      window: windowContext(raw),
    },
  ];
}

/** Window context, used both in evidence and in the dedupe identity. */
function windowContext(raw) {
  const metric = raw?.metric && typeof raw.metric === 'object' ? raw.metric : {};
  const hist = metric.historicalWindowSize;
  const recent = metric.recentWindowSize;
  if (Number.isFinite(Number(hist)) && Number.isFinite(Number(recent))) {
    return `${hist}-vs-${recent}`;
  }
  if (metric.tag != null) return `tag-${metric.tag}`;
  return null;
}

function entityOf(raw) {
  const metric = raw?.metric && typeof raw.metric === 'object' ? raw.metric : {};
  return text(metric.dimensionValue) ?? text(metric.tag) ?? text(metric.ruleId);
}

function provenanceFor(raw, source) {
  const declared = Array.isArray(raw?.provenance)
    ? raw.provenance.filter((p) => text(p) !== null)
    : [];
  if (declared.length > 0) return declared;
  const fallback = PRODUCER_PROVENANCE[source];
  return fallback ? [fallback] : [];
}

function stateFor(source, category, raw) {
  const metric = raw?.metric && typeof raw.metric === 'object' ? raw.metric : {};
  const declared = text(metric.state)?.toUpperCase() ?? null;

  if (source === 'degradationEngine') {
    const map = {
      DEGRADING: 'NEEDS_ATTENTION',
      WATCH: 'WATCH',
      IMPROVING: 'IMPROVING',
      STABLE: 'STABLE',
      INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
    };
    // An unrecognized source state is preserved rather than guessed at.
    return { state: map[declared] ?? null, sourceState: declared };
  }

  if (source === 'attributionIntelligence') {
    if (metric.rankable === true) return { state: 'STABLE', sourceState: declared };
    return { state: 'INSUFFICIENT_DATA', sourceState: declared ?? (metric.rankable === false ? null : null) };
  }

  if (source === 'improvementEngine') {
    const id = text(raw?.id) ?? '';
    if (category === 'mistake' || category === 'rule') return { state: 'NEEDS_ATTENTION', sourceState: declared };
    if (category === 'improvement') return { state: 'IMPROVING', sourceState: declared };
    if (category === 'process') {
      return { state: id.includes('low') ? 'NEEDS_ATTENTION' : 'IMPROVING', sourceState: declared };
    }
    return { state: null, sourceState: declared };
  }
  return { state: null, sourceState: declared };
}

function sourceFor(raw) {
  const category = text(raw?.category)?.toUpperCase() ?? '';
  if (category === 'DEGRADATION') return 'degradationEngine';
  if (category === 'ATTRIBUTION') return 'attributionIntelligence';
  return 'improvementEngine';
}

/**
 * Shared canonical construction. Rejects anything missing a title or
 * evidence: an insight with neither is not an insight, and substituting
 * filler would present invented content as a real finding.
 */
function buildCanonical(raw, expectedSource) {
  if (!raw || typeof raw !== 'object') return null;

  const title = text(raw.title);
  if (!title) return null;

  const rawCategory = text(raw.category)?.toUpperCase();
  const category = rawCategory ? CATEGORY_MAP[rawCategory] ?? null : null;
  if (!category) return null;

  const source = expectedSource ?? sourceFor(raw);
  if (!INSIGHT_SOURCES.includes(source)) return null;

  const evidence = evidenceFor(raw, provenanceFor(raw, source));
  if (evidence.length === 0) return null;

  const { state, sourceState } = stateFor(source, category, raw);
  const sample = toSample(raw);
  const metric = raw.metric && typeof raw.metric === 'object' ? raw.metric : {};

  return {
    id: text(raw.id) ?? null,
    category,
    source,
    title,
    state,
    sourceState,
    summary: text(raw.evidence),
    whySurfaced: whySurfacedFor(source, state, text(metric.suppressionReason) ?? text(metric.reason)),
    evidence,
    sample,
    ranking: rankingFor(raw, state, source),
    investigationQuestion: investigationFor(state, source, raw),
    provenance: provenanceFor(raw, source),
    entity: entityOf(raw),
    dimension: text(metric.dimension),
    window: windowContext(raw),
  };
}

export function normalizeImprovementPattern(raw) {
  return buildCanonical(raw, 'improvementEngine');
}

export function normalizeDegradationInsight(raw) {
  return buildCanonical(raw, 'degradationEngine');
}

export function normalizeAttributionInsight(raw) {
  return buildCanonical(raw, 'attributionIntelligence');
}

/** Dispatch to the adapter matching the insight's producer. */
export function normalizeInsight(raw) {
  return buildCanonical(raw, null);
}

function adapterFor(source) {
  if (source === 'degradationEngine') return normalizeDegradationInsight;
  if (source === 'attributionIntelligence') return normalizeAttributionInsight;
  return normalizeImprovementPattern;
}

/**
 * Stable semantic identity. Deliberately not the display id and not any
 * numeric value: two findings about the same entity in the same window
 * are the same observation, while the same entity across different
 * windows is not.
 */
export function identityKey(insight) {
  return [
    insight.source,
    insight.category,
    insight.dimension ?? '-',
    insight.entity ?? '-',
    insight.window ?? '-',
  ].join('|');
}

function candidateOrder(a, b) {
  const as = a.sample.size ?? -1;
  const bs = b.sample.size ?? -1;
  if (as !== bs) return bs - as;
  return compare(a.id, b.id);
}

/**
 * Merge, deduplicate and order.
 *
 * @param {object} input — { improvements, degradation, attribution }
 * @returns {Array<object>} canonical insights, deterministically ordered.
 */
export function consolidateInsights(input = {}) {
  const buckets = [
    ['degradation', input.degradation],
    ['attribution', input.attribution],
    ['improvements', input.improvements],
  ];

  const byIdentity = new Map();
  for (const [key, list] of buckets) {
    if (!Array.isArray(list)) continue;
    const adapter = adapterFor(key === 'degradation' ? 'degradationEngine'
      : key === 'attribution' ? 'attributionIntelligence'
        : 'improvementEngine');
    for (const raw of list) {
      const insight = adapter(raw);
      if (!insight) continue;
      const id = identityKey(insight);
      if (!byIdentity.has(id)) byIdentity.set(id, []);
      byIdentity.get(id).push(insight);
    }
  }

  // Duplicates resolve by richest evidence then lowest id, never by
  // arrival order, so the winner cannot depend on iteration order.
  const resolved = [];
  for (const candidates of byIdentity.values()) {
    const sorted = [...candidates].sort(candidateOrder);
    resolved.push(sorted[0]);
  }

  const rank = new Map(INSIGHT_STATES.map((s, i) => [s, i]));
  return resolved.sort((a, b) => {
    // An unmappable source state sorts last rather than being guessed into a bucket.
    const as = a.state === null ? INSIGHT_STATES.length : rank.get(a.state) ?? INSIGHT_STATES.length;
    const bs = b.state === null ? INSIGHT_STATES.length : rank.get(b.state) ?? INSIGHT_STATES.length;
    if (as !== bs) return as - bs;
    if (a.category !== b.category) return compare(a.category, b.category);
    if (a.source !== b.source) return compare(a.source, b.source);
    if (a.title !== b.title) return compare(a.title, b.title);
    return compare(a.id, b.id);
  });
}

/** Group canonical insights into the buckets the page renders. */
export function groupInsights(insights = []) {
  const groups = {};
  for (const state of INSIGHT_STATES) groups[state] = [];
  const unmapped = [];
  for (const insight of insights) {
    if (!insight || typeof insight !== 'object') continue;
    if (insight.state && groups[insight.state]) groups[insight.state].push(insight);
    else unmapped.push(insight);
  }
  return { groups, unmapped };
}

export default {
  INSIGHT_SOURCES,
  INSIGHT_CATEGORIES,
  INSIGHT_STATES,
  normalizeImprovementPattern,
  normalizeDegradationInsight,
  normalizeAttributionInsight,
  normalizeInsight,
  identityKey,
  consolidateInsights,
  groupInsights,
};