// ============================================
// Sample-aware attribution intelligence — PURE, read-only.
// Vanilla ESM, offline-first. No side effects on import.
//
// Phase 10C. The qualification layer that sits between the existing
// attribution maths and anything that might present a ranking.
//
//   performanceAttribution.getAttribution  (authoritative numbers)
//        ↓
//   getDimensionValue                      (existing grouping mapping)
//        ↓
//   assessSample / qualifyForRanking       (10A contract)
//        ↓
//   makeInsight                            (insight with evidence)
//
// This layer adds NO metric maths. Every figure arrives pre-computed on
// an attribution row; this only decides whether that row's sample
// supports a ranking claim, and states the reason when it does not.
//
// Thin and insufficient rows are PRESERVED, never dropped. A category
// with two trades still appears, labelled as insufficient, because
// silently omitting it would read as "nothing to see here" rather than
// "not enough evidence yet".
//
// No leaderboard or dashboard lives here. Presentation is a later phase.
// ============================================
import { getAttribution, getAllAttributions, DIMENSIONS } from './performanceAttribution.js';
import { assessSample, qualifyForRanking, makeInsight, INTELLIGENCE_SOURCES } from './intelligenceContracts.js';

const PROVENANCE = 'performanceAttribution.getAttribution';

export const DEFAULT_RANKING_METRIC = 'averageR';

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function slug(value) {
  const s = value == null ? '' : String(value).trim();
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unspecified';
}

function formatMetricValue(metric, value) {
  return Number.isFinite(value) ? `${Math.round(value * 100) / 100}` : 'n/a';
}

/**
 * A ranking metric is usable only if the row actually carries a number.
 * Number(null) is 0 and Number('') is 0, so presence is checked first:
 * a missing averageR must read as unavailable, not as a score of zero.
 */
function readRankValue(row, rankBy) {
  const raw = row?.[rankBy];
  if (raw == null || raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/**
 * Final ordering and competition ranking: 1,1,3. Assigning 1,2 to a tie
 * would manufacture a winner the data does not support.
 *
 * Ties break alphabetically by dimensionValue so the same set of rows
 * always produces the same order regardless of arrival order. Only
 * rankable rows consume a position, so a suppressed row never leaves a
 * visible gap above it.
 */
function applyCompetitionRank(rows) {
  const ordered = [...rows].sort((a, b) => {
    const av = a.rankValue;
    const bv = b.rankValue;
    if (av === null && bv === null) return String(a.dimensionValue ?? '').localeCompare(String(b.dimensionValue ?? ''));
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return bv - av;
    return String(a.dimensionValue ?? '').localeCompare(String(b.dimensionValue ?? ''));
  });

  const out = [];
  let lastValue = null;
  let lastRank = 0;
  let placed = 0;
  for (const row of ordered) {
    const rankable = row.rankable === true && row.rankValue !== null;
    if (!rankable) {
      out.push({ ...row, rank: null });
      continue;
    }
    placed += 1;
    if (lastValue === null || row.rankValue !== lastValue) {
      lastRank = placed;
      lastValue = row.rankValue;
    }
    out.push({ ...row, rank: lastRank });
  }
  return out;
}

/**
 * Qualify already-computed attribution rows. Pure: no storage, no
 * network, no mutation of the rows passed in.
 *
 * @param {Array} rows — attribution rows: { dimensionValue, trades, pnl,
 *   totalR, averageR, winRate, processScore, sampleSize }
 * @param {object} options — { rankBy, dimension }
 * @returns {Array<object>} insight objects in the 10A contract shape.
 */
export function qualifyAttributionRows(rows, options = {}) {
  if (!Array.isArray(rows)) return [];
  const rankBy = typeof options.rankBy === 'string' && options.rankBy.trim() !== ''
    ? options.rankBy.trim()
    : DEFAULT_RANKING_METRIC;
  const dimension = typeof options.dimension === 'string' ? options.dimension : 'strategy';

  const candidates = rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const sampleSize = Math.max(0, Math.floor(toFinite(row.sampleSize, row.trades)));
      const rankValue = readRankValue(row, rankBy);
      return {
        id: `attribution-${dimension}-${slug(row.dimensionValue)}`,
        dimensionValue: row.dimensionValue,
        dimension,
        rankValue,
        // qualifyForRanking reads metric.rankValue; without this the sort
        // sees every row as null and silently falls back to input order.
        metric: { rankValue },
        sampleSize,
        sample: assessSample(sampleSize),
        row: { ...row },
      };
    });

  const qualified = qualifyForRanking(candidates);

  const ranked = applyCompetitionRank(qualified);

  const insights = [];
  for (const item of ranked) {
    const sampleSize = item.sampleSize;
    const sample = item.sample ?? assessSample(sampleSize);
    const rankable = sample.rankable;
    const value = item.rankValue;
    const row = item.row;

    const evidence =
      `${row.dimensionValue} across ${sampleSize} closed trades under ${dimension}: ` +
      `${rankBy} ${formatMetricValue(rankBy, value)}, ` +
      `win rate ${formatMetricValue('winRate', row.winRate)}%, ` +
      `process ${formatMetricValue('processScore', row.processScore)}.`;

    const built = makeInsight({
      id: item.id,
      category: 'ATTRIBUTION',
      title: rankable
        ? `${row.dimensionValue}: rank ${item.rank} on ${rankBy}`
        : `${row.dimensionValue}: insufficient sample for a ${rankBy} ranking`,
      evidence,
      sampleSize,
      metric: {
        dimension,
        dimensionValue: row.dimensionValue,
        state: rankable ? 'RANKED' : 'INSUFFICIENT_DATA',
        rankBy,
        rankValue: value,
        rank: item.rank ?? null,
        rankable,
        suppressionReason: rankable ? null : item.rankingSuppressedReason,
        underlying: {
          trades: row.trades,
          pnl: row.pnl,
          totalR: row.totalR,
          averageR: row.averageR,
          winRate: row.winRate,
          processScore: row.processScore,
          sampleSize: row.sampleSize,
        },
      },
      evidenceRef: {
        kind: 'TRADES',
        refIds: [],
        sampleSize,
        sources: [PROVENANCE],
      },
    });
    if (built.success) insights.push(built.insight);
  }
  return insights;
}

/**
 * Storage-facing entry point. Reads the same attribution rows the
 * existing analytics pages read, then qualifies them. Passing
 * dimension 'all' walks every supported dimension in DIMENSIONS order.
 */
export function qualifyAttribution(accountId, dimension = 'all', filters = {}, options = {}) {
  try {
    if (dimension === 'all') {
      const all = getAllAttributions(accountId, filters);
      const out = [];
      for (const dim of DIMENSIONS) {
        const rows = Array.isArray(all?.[dim]) ? all[dim] : [];
        for (const insight of qualifyAttributionRows(rows, { ...options, dimension: dim })) {
          out.push(insight);
        }
      }
      return out;
    }
    const rows = getAttribution(accountId, dimension, filters);
    return qualifyAttributionRows(rows, { ...options, dimension });
  } catch {
    return [];
  }
}

export { PROVENANCE as ATTRIBUTION_INTELLIGENCE_SOURCE, INTELLIGENCE_SOURCES };

export default {
  DEFAULT_RANKING_METRIC,
  ATTRIBUTION_INTELLIGENCE_SOURCE: PROVENANCE,
  qualifyAttribution,
  qualifyAttributionRows,
};