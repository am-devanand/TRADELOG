// ============================================
// Improvement pattern engine — PURE, read-only.
// Vanilla ESM, offline-first. No side effects on import.
// No localStorage, no network, no writes anywhere.
//
// Surfaces REPEATED OBSERVABLE patterns from review
// data only. Every entry carries sampleSize and is
// reported only when sampleSize >= minimumSample —
// small samples return [] (no claims from thin data).
//
// Wording rules (hard):
// - "Observed alongside" — NEVER caused/guarantees/will improve.
// - REVIEW PROMPTS only — never trading instructions
//   (no buy/sell/avoid/take language).
// ============================================
import { ANALYTICS_THRESHOLDS } from './models.js';

const THRESHOLDS = { ...ANALYTICS_THRESHOLDS };

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function slug(tag) {
  return String(tag ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function label(tag) {
  return String(tag ?? '')
    .trim()
    .replace(/_/g, ' ')
    .toLowerCase() || 'unknown';
}

/** Accept { reviews: [...] } or a bare [...] ; anything else -> []. Pure. */
function toReviewList(dataset) {
  const isReview = (r) => r && typeof r === 'object';
  if (Array.isArray(dataset)) {
    // getTradeDataset rows wrap the review as row.review; bare reviews pass through.
    return dataset
      .map((r) => (isReview(r) && isReview(r.review) ? r.review : r))
      .filter((r) => isReview(r) && (Array.isArray(r.mistakes) || Array.isArray(r.strengths) || r.processScore));
  }
  if (isReview(dataset)) {
    if (Array.isArray(dataset.reviews)) {
      return dataset.reviews.filter(isReview);
    }
    if (Array.isArray(dataset.rows)) {
      return toReviewList(dataset.rows);
    }
  }
  return [];
}

function processTotal(review) {
  const nested = review.processScore && typeof review.processScore === 'object' ? review.processScore : {};
  for (const c of [nested.total, review.total]) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function adherence(review) {
  const n = Number(review.ruleAdherence);
  return Number.isFinite(n) ? n : null;
}

function countTags(reviews, field) {
  const counts = new Map();
  for (const r of reviews) {
    const tags = Array.isArray(r[field]) ? r[field] : [];
    const seen = new Set();
    for (const t of tags) {
      const key = String(t ?? '').trim().toUpperCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Detect repeated observable patterns in review data. Pure, read-only.
 * @param {object|Array} dataset — { reviews: [...] } or a bare review array.
 * @returns {Array<{id,category,title,evidence,sampleSize,metric,suggestedReviewQuestion}>}
 *   [] when input is unusable or no cohort reaches minimumSample.
 */
export function getImprovementPatterns(dataset) {
  try {
    const reviews = toReviewList(dataset);
    const minimumSample = toFinite(THRESHOLDS.minimumSample, 5);
    const repeatAt = toFinite(
      THRESHOLDS.repeatedPatternCount,
      3,
    );
    const lowScoreAt = toFinite(THRESHOLDS.lowProcessScore, 60);
    const highScoreAt = toFinite(
      THRESHOLDS.highProcessScore,
      80,
    );
    const lowAdherenceAt = toFinite(
      THRESHOLDS.lowRuleAdherence,
      75,
    );

    if (reviews.length < minimumSample) return [];

    const out = [];

    // 1. Repeated mistake tags (>= repeatedPatternCount)
    const mistakes = countTags(reviews, 'mistakes');
    for (const [tag, count] of [...mistakes.entries()].sort((a, b) => b[1] - a[1])) {
      if (count < repeatAt) continue;
      out.push({
        id: `mistake-${slug(tag)}`,
        category: 'MISTAKE',
        title: `Repeated observation: ${label(tag)}`,
        evidence: `"${tag}" observed alongside ${count} of ${reviews.length} reviewed trades.`,
        sampleSize: reviews.length,
        metric: { tag, count, reviewCount: reviews.length },
        suggestedReviewQuestion:
          `What do you notice across the ${count} reviews tagged "${label(tag)}" ` +
          `that you could reflect on in your next review session?`,
      });
    }

    // 2. Repeated strength tags (positive patterns, same gate)
    const strengths = countTags(reviews, 'strengths');
    for (const [tag, count] of [...strengths.entries()].sort((a, b) => b[1] - a[1])) {
      if (count < repeatAt) continue;
      out.push({
        id: `strength-${slug(tag)}`,
        category: 'STRENGTH',
        title: `Repeated strength: ${label(tag)}`,
        evidence: `"${tag}" observed alongside ${count} of ${reviews.length} reviewed trades.`,
        sampleSize: reviews.length,
        metric: { tag, count, reviewCount: reviews.length },
        suggestedReviewQuestion:
          `What was present in the ${count} reviews tagged "${label(tag)}" ` +
          `that you could note for your next review session?`,
      });
    }

    // 3. Low-process-score cohort
    const low = reviews.filter((r) => {
      const t = processTotal(r);
      return t != null && t < lowScoreAt;
    });
    if (low.length >= minimumSample) {
      const avg = low.reduce((s, r) => s + processTotal(r), 0) / low.length;
      out.push({
        id: 'cohort-low-process-score',
        category: 'PROCESS',
        title: 'Cohort observed with lower process scores',
        evidence:
          `Lower process scores (below ${lowScoreAt}) observed alongside ` +
          `${low.length} of ${reviews.length} reviewed trades.`,
        sampleSize: low.length,
        metric: {
          count: low.length,
          reviewCount: reviews.length,
          avgProcessScore: Math.round(avg * 10) / 10,
          threshold: lowScoreAt,
        },
        suggestedReviewQuestion:
          `What stands out when you review the ${low.length} lower-scored sessions ` +
          `side by side with your higher-scored ones?`,
      });
    }

    // 4. High-process-score cohort
    const high = reviews.filter((r) => {
      const t = processTotal(r);
      return t != null && t >= highScoreAt;
    });
    if (high.length >= minimumSample) {
      const avg = high.reduce((s, r) => s + processTotal(r), 0) / high.length;
      out.push({
        id: 'cohort-high-process-score',
        category: 'PROCESS',
        title: 'Cohort observed with higher process scores',
        evidence:
          `Higher process scores (${highScoreAt}+) observed alongside ` +
          `${high.length} of ${reviews.length} reviewed trades.`,
        sampleSize: high.length,
        metric: {
          count: high.length,
          reviewCount: reviews.length,
          avgProcessScore: Math.round(avg * 10) / 10,
          threshold: highScoreAt,
        },
        suggestedReviewQuestion:
          `What was consistent across the ${high.length} higher-scored sessions ` +
          `that you could describe in your own review notes?`,
      });
    }

    // 5. Low rule-adherence cohort
    const lowAdh = reviews.filter((r) => {
      const a = adherence(r);
      return a != null && a < lowAdherenceAt;
    });
    if (lowAdh.length >= minimumSample) {
      const avg = lowAdh.reduce((s, r) => s + adherence(r), 0) / lowAdh.length;
      out.push({
        id: 'cohort-low-rule-adherence',
        category: 'ADHERENCE',
        title: 'Cohort observed with lower rule adherence',
        evidence:
          `Lower rule adherence (below ${lowAdherenceAt}) observed alongside ` +
          `${lowAdh.length} of ${reviews.length} reviewed trades.`,
        sampleSize: lowAdh.length,
        metric: {
          count: lowAdh.length,
          reviewCount: reviews.length,
          avgRuleAdherence: Math.round(avg * 10) / 10,
          threshold: lowAdherenceAt,
        },
        suggestedReviewQuestion:
          `Which rules appear most often in the ${lowAdh.length} lower-adherence reviews, ` +
          `and what could you clarify about them in your next review?`,
      });
    }

    return out;
  } catch {
    return [];
  }
}

export default { getImprovementPatterns };
