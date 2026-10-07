// ============================================
// Intelligence assembly — reads and delegates only.
// Vanilla ESM, offline-first. No side effects on import.
//
// Phase 10D loader. intelligenceLayer.js stays pure by living here
// instead: this module is the only place that touches storage, and its
// whole job is to hand the three producers their inputs and pass their
// output to the consolidator.
//
// It computes no metrics. Every number reaches the UI because
// tradingAnalytics or performanceAttribution produced it, and every
// sufficiency verdict was already made by intelligenceContracts.
import { getTradeDataset } from './tradingAnalytics.js';
import { getImprovementPatterns } from './improvementEngine.js';
import { getCompletedReviews } from './tradeReviews.js';
import { detectDegradation } from './degradationEngine.js';
import { qualifyAttribution } from './attributionIntelligence.js';
import { consolidateIntelligence, groupByState } from './intelligenceLayer.js';

/**
 * Assemble the consolidated intelligence view.
 *
 * @param {string} accountId
 * @param {object} options — { user, filters, dimension, attributionDimension,
 *   dataset, reviews, attribution, degradationConfig }
 *   Pre-supplied dataset/reviews/attribution exist so callers and tests can
 *   inject data instead of seeding storage.
 * @returns {Array<object>} normalized insights, deterministically ordered.
 */
export function buildIntelligence(accountId, options = {}) {
  const filters = options.filters && typeof options.filters === 'object' ? options.filters : {};
  const dimension = options.dimension || 'strategy';
  const attributionDimension = options.attributionDimension || 'all';

  let degradation = [];
  let attribution = [];
  let improvements = [];

  try {
    const dataset = Array.isArray(options.dataset)
      ? options.dataset
      : getTradeDataset(accountId, filters);
    degradation = detectDegradation(dataset, { dimension, config: options.degradationConfig });
  } catch {
    degradation = [];
  }

  try {
    attribution = Array.isArray(options.attribution)
      ? options.attribution
      : qualifyAttribution(accountId, attributionDimension, filters);
  } catch {
    attribution = [];
  }

  try {
    const reviews = Array.isArray(options.reviews)
      ? options.reviews
      : options.user
        ? getCompletedReviews(options.user)
        : [];
    improvements = getImprovementPatterns({ reviews });
  } catch {
    improvements = [];
  }

  return consolidateIntelligence({ degradation, attribution, improvements });
}

/** Convenience: the same view already bucketed for rendering. */
export function buildIntelligenceGroups(accountId, options = {}) {
  const insights = buildIntelligence(accountId, options);
  return { insights, groups: groupByState(insights) };
}

export default { buildIntelligence, buildIntelligenceGroups };