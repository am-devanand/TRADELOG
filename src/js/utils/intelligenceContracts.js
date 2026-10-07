// ============================================
// Intelligence contracts — PURE, read-only.
// Vanilla ESM, offline-first. No side effects on import.
// No localStorage, no network, no writes anywhere.
//
// Phase 10A foundation. This module defines the SHAPE every
// intelligence insight must satisfy, plus the evidence model that
// points each insight back at real records.
//
// Architectural rule (project owner): Phase 10 must NOT create a
// second analytics engine. So this file computes NO trading metrics.
// It only constrains, labels and qualifies insights that already
// came from the authoritative modules, and every insight must name
// the module that produced its numbers (see INTELLIGENCE_SOURCES).
//
// Backward compatibility: the first four categories are the ones
// improvementEngine.getImprovementPatterns already emits, and
// fromImprovementPattern() round-trips that output. The four
// existing analytics pages keep rendering unchanged.
// ============================================
import { ANALYTICS_THRESHOLDS } from './models.js';

/**
 * Categories emitted by improvementEngine.getImprovementPatterns.
 * Do not rename or reorder these: existing pages switch on them.
 */
export const EXISTING_INSIGHT_CATEGORIES = ['MISTAKE', 'STRENGTH', 'PROCESS', 'ADHERENCE'];

/** Categories added by Phase 10 for strategy/rule/attribution/degradation reads. */
export const INTELLIGENCE_INSIGHT_CATEGORIES = ['STRATEGY', 'RULE', 'ATTRIBUTION', 'DEGRADATION', 'PATTERN'];

export const INSIGHT_CATEGORIES = [...EXISTING_INSIGHT_CATEGORIES, ...INTELLIGENCE_INSIGHT_CATEGORIES];

/** What kind of records an insight's evidence points at. */
export const EVIDENCE_KINDS = ['TRADES', 'REVIEWS', 'RULES', 'RUNS', 'STRATEGIES'];

/**
 * Every authoritative producer Phase 10 may cite as provenance.
 * Names are verbatim `module.function` exports; an insight that
 * cannot name one of these is not allowed to carry numbers, which
 * is what stops this layer from quietly recomputing analytics.
 */
export const INTELLIGENCE_SOURCES = [
  'tradingAnalytics.getCoreMetrics',
  'tradingAnalytics.getStrategyStats',
  'tradingAnalytics.getAllStrategyStats',
  'tradingAnalytics.getSetupStats',
  'tradingAnalytics.getSessionStats',
  'tradingAnalytics.getPairStats',
  'tradingAnalytics.getTimeframeStats',
  'tradingAnalytics.getProcessStats',
  'tradingAnalytics.getMistakeStats',
  'tradingAnalytics.getStrengthStats',
  'tradingAnalytics.getRuleAdherenceStats',
  'tradingAnalytics.getOutcomeProcessMatrix',
  'tradingAnalytics.getDailyPnlSeries',
  'performanceAttribution.getAttribution',
  'performanceAttribution.getLongVsShort',
  'performanceAttribution.getDayOfWeekStats',
  'improvementEngine.getImprovementPatterns',
  'riskAnalytics.getRiskViolations',
  'riskAnalytics.getDrawdownSeries',
  'riskAnalytics.getMaxObservedDrawdown',
  'riskAnalytics.getConsecutiveLosses',
  'ruleHistory.getRuleVersion',
];

/** Ordered weakest to strongest; a sample is only rankable at ADEQUATE or above. */
export const SAMPLE_LEVELS = ['INSUFFICIENT', 'THIN', 'ADEQUATE', 'STRONG'];

/**
 * Causal assertions this project forbids (hard wording rule, mirroring
 * improvementEngine). Evidence must observe, never attribute cause.
 */
export const FORBIDDEN_CAUSAL_CLAIMS = [
  'caused',
  'causes',
  'causing',
  'guarantees',
  'guaranteed',
  'will improve',
  'will increase',
  'will reduce',
  'because of',
  'due to my',
  'proves that',
];

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function nonEmptyString(value) {
  const s = value == null ? '' : String(value).trim();
  return s === '' ? '' : s;
}

function slug(value) {
  return (
    nonEmptyString(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

function uniqStrings(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = nonEmptyString(item);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Unambiguous causal phrasing found in the given text, if any. */
export function findCausalClaims(...texts) {
  const hits = new Set();
  for (const text of texts) {
    const s = nonEmptyString(text).toLowerCase();
    if (!s) continue;
    for (const claim of FORBIDDEN_CAUSAL_CLAIMS) {
      if (s.includes(claim)) hits.add(claim);
    }
  }
  return [...hits];
}

/**
 * Grade a sample against the canonical thresholds. Levels are derived
 * from minimumSample rather than hardcoded, so the single source of
 * truth in models.js governs every band.
 */
export function assessSample(sampleSize, thresholds = ANALYTICS_THRESHOLDS) {
  const n = toFinite(sampleSize, 0);
  const floor = Math.max(1, toFinite(thresholds?.minimumSample, 5));
  let level = 'INSUFFICIENT';
  if (n >= floor * 4) level = 'STRONG';
  else if (n >= floor * 2) level = 'ADEQUATE';
  else if (n >= floor) level = 'THIN';
  return {
    sampleSize: n,
    minimumSample: floor,
    level,
    sufficient: level !== 'INSUFFICIENT',
    rankable: level === 'ADEQUATE' || level === 'STRONG',
  };
}

/**
 * Build the evidence record attached to an insight. Provenance is
 * mandatory: at least one authoritative source must be named, which
 * is how the no-recompute rule is enforced structurally.
 */
export function makeEvidence(input = {}) {
  const kind = nonEmptyString(input.kind).toUpperCase();
  if (!EVIDENCE_KINDS.includes(kind)) {
    return { success: false, error: `evidence.kind must be one of ${EVIDENCE_KINDS.join(', ')}` };
  }
  const sources = uniqStrings(input.sources).filter((s) => INTELLIGENCE_SOURCES.includes(s));
  if (sources.length === 0) {
    return {
      success: false,
      error: `evidence.sources must cite at least one authoritative source from INTELLIGENCE_SOURCES`,
    };
  }
  const refIds = uniqStrings(input.refIds);
  const sampleSize = Math.max(0, Math.floor(toFinite(input.sampleSize, refIds.length)));
  const range = input.range && typeof input.range === 'object' ? input.range : {};
  return {
    success: true,
    evidence: {
      kind,
      refIds,
      sampleSize,
      range: {
        from: nonEmptyString(range.from),
        to: nonEmptyString(range.to),
      },
      sources,
      sample: assessSample(sampleSize),
    },
  };
}

/**
 * Construct an insight. Fails loudly rather than emitting a malformed
 * one: an insight with no evidence, an unknown category or causal
 * wording is worse than no insight at all.
 */
export function makeInsight(input = {}) {
  const title = nonEmptyString(input.title);
  if (!title) return { success: false, error: 'insight.title is required' };

  const evidenceText = nonEmptyString(input.evidence);
  if (!evidenceText) return { success: false, error: 'insight.evidence is required' };

  const category = nonEmptyString(input.category).toUpperCase();
  if (!INSIGHT_CATEGORIES.includes(category)) {
    return { success: false, error: `insight.category must be one of ${INSIGHT_CATEGORIES.join(', ')}` };
  }

  const causal = findCausalClaims(title, evidenceText);
  if (causal.length > 0) {
    return {
      success: false,
      error: `insight wording must observe, not attribute cause (${causal.join(', ')})`,
    };
  }

  const evidenceInput = input.evidenceRef && typeof input.evidenceRef === 'object' ? input.evidenceRef : {};
  const built = makeEvidence({
    ...evidenceInput,
    sampleSize: input.sampleSize ?? evidenceInput.sampleSize,
  });
  if (!built.success) return { success: false, error: built.error };

  const sample = assessSample(input.sampleSize ?? built.evidence.sampleSize);
  const metric = input.metric && typeof input.metric === 'object' ? { ...input.metric } : {};

  return {
    success: true,
    insight: {
      id: nonEmptyString(input.id) || `${slug(category)}-${slug(metric.dimensionValue || title)}`,
      category,
      title,
      evidence: evidenceText,
      sampleSize: sample.sampleSize,
      sample,
      metric,
      suggestedReviewQuestion: nonEmptyString(input.suggestedReviewQuestion),
      evidenceRef: built.evidence,
      rankable: sample.rankable,
      provenance: built.evidence.sources,
    },
  };
}

/**
 * Sample-aware ranking. Insufficient/thin insights are returned but
 * never labelled leader or laggard, so the UI cannot present a
 * four-trade "worst pair" as a finding.
 */
export function qualifyForRanking(insights = [], thresholds = ANALYTICS_THRESHOLDS) {
  if (!Array.isArray(insights)) return [];
  const rows = insights
    .filter((i) => i && typeof i === 'object')
    .map((insight) => {
      const sample = insight.sample ?? assessSample(insight.sampleSize, thresholds);
      const rankable = sample.rankable;
      return {
        ...insight,
        sample,
        rankable,
        // Label stays null unless the sample supports the claim.
        rankingLabel: rankable ? 'RANKABLE' : null,
        rankingSuppressedReason: rankable ? null : `sample of ${sample.sampleSize} below rankable minimum`,
      };
    });
  return rows.sort((a, b) => {
    const av = toFinite(a.metric?.rankValue, null);
    const bv = toFinite(b.metric?.rankValue, null);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });
}

/**
 * Wrap a real improvementEngine.getImprovementPatterns entry.
 * Proves the Phase 10 contract is a superset of the shape the four
 * existing analytics pages already render.
 */
export function fromImprovementPattern(pattern, options = {}) {
  if (!pattern || typeof pattern !== 'object') {
    return { success: false, error: 'improvement pattern must be an object' };
  }
  const reviews = toFinite(pattern.sampleSize, 0);
  const refIds = uniqStrings(options.reviewIds);
  return makeInsight({
    id: pattern.id,
    category: pattern.category,
    title: pattern.title,
    evidence: pattern.evidence,
    sampleSize: reviews,
    metric: pattern.metric,
    suggestedReviewQuestion: pattern.suggestedReviewQuestion,
    evidenceRef: {
      kind: 'REVIEWS',
      refIds,
      sampleSize: reviews,
      range: options.range,
      sources: ['improvementEngine.getImprovementPatterns'],
    },
  });
}

export default {
  EXISTING_INSIGHT_CATEGORIES,
  INTELLIGENCE_INSIGHT_CATEGORIES,
  INSIGHT_CATEGORIES,
  EVIDENCE_KINDS,
  INTELLIGENCE_SOURCES,
  SAMPLE_LEVELS,
  FORBIDDEN_CAUSAL_CLAIMS,
  assessSample,
  findCausalClaims,
  makeEvidence,
  makeInsight,
  qualifyForRanking,
  fromImprovementPattern,
};