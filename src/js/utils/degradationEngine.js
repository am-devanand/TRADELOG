// ============================================
// Degradation intelligence — PURE, deterministic, read-only.
// Vanilla ESM, offline-first. No side effects on import.
// No localStorage, no network, no writes anywhere.
//
// Detects CHANGE between two equivalent time windows for a dimension.
// It computes no performance metrics of its own: every number it
// compares comes from tradingAnalytics.getCoreMetrics, and every
// finding is emitted through intelligenceContracts.makeInsight so it
// carries evidence, sample qualification and provenance.
//
// Pure means: same rows in, same findings out. No Date.now(), no
// randomness, no ambient reads. Windows are equal-sized and cut from a
// deterministic ordering, so the split cannot drift between runs.
//
// States: IMPROVING | DEGRADING | WATCH | STABLE | INSUFFICIENT_DATA
//
// WATCH is the deliberately weaker tier: a move large enough to be
// worth noticing but not large enough to call degradation. A thin
// window is never reported as degradation — it is INSUFFICIENT_DATA.
// ============================================
import { ANALYTICS_THRESHOLDS } from './models.js';
import { getCoreMetrics } from './tradingAnalytics.js';
import { getDimensionValue, DIMENSIONS } from './performanceAttribution.js';
import { makeInsight } from './intelligenceContracts.js';

export const DEGRADATION_STATES = [
  'IMPROVING',
  'DEGRADING',
  'WATCH',
  'STABLE',
  'INSUFFICIENT_DATA',
];

/**
 * Relative margins. Values are fractions of the historical baseline:
 * winRate 64 -> 42 is -0.34, which crosses degradeMargin and is
 * reported DEGRADING. Profit factor is the noisiest of the three, so
 * it gets a wider band; a move inside watchMargin is reported WATCH.
 */
export const DEFAULT_DEGRADATION_CONFIG = {
  metrics: ['winRate', 'avgR', 'profitFactor'],
  minimumWindowSample: ANALYTICS_THRESHOLDS.minimumSample,
  degradeMargin: 0.15,
  watchMargin: 0.05,
  improveMargin: 0.15,
};

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function slug(value) {
  const s = value == null ? '' : String(value).trim();
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unspecified';
}

function byName(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

function isRow(value) {
  return !!value && typeof value === 'object';
}

/** Accept a bare dataset array, {rows}, or {reviews}; anything else -> []. */
function toRows(dataset) {
  if (Array.isArray(dataset)) return dataset.filter(isRow);
  if (isRow(dataset)) {
    if (Array.isArray(dataset.rows)) return dataset.rows.filter(isRow);
  }
  return [];
}

function tradeOf(row) {
  return isRow(row?.trade) ? row.trade : null;
}

function tradeIdOf(row) {
  const trade = tradeOf(row);
  return trade ? String(trade.id ?? '') : '';
}

function timeOf(row) {
  const trade = tradeOf(row);
  if (!trade) return Number.NaN;
  return Date.parse(trade.closedAt || trade.openedAt || trade.createdAt || '');
}

/**
 * Deterministic ascending order: valid timestamps first, then by time,
 * then by trade id. Matches getTradeDataset's own ordering so a
 * degradation split lines up with the rest of the analytics layer.
 */
export function orderRows(rows) {
  return [...rows].sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na !== nb) return na ? 1 : -1;
    if (!na && ta !== tb) return ta - tb;
    const ia = tradeIdOf(a);
    const ib = tradeIdOf(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

function resolveConfig(input = {}) {
  const base = { ...DEFAULT_DEGRADATION_CONFIG, ...(input || {}) };
  const metrics = Array.isArray(base.metrics) && base.metrics.length
    ? base.metrics.filter((m) => typeof m === 'string' && m.trim() !== '')
    : [...DEFAULT_DEGRADATION_CONFIG.metrics];
  return {
    ...base,
    metrics,
    minimumWindowSample: Math.max(1, Math.floor(toFinite(base.minimumWindowSample, 5))),
    degradeMargin: toFinite(base.degradeMargin, DEFAULT_DEGRADATION_CONFIG.degradeMargin),
    watchMargin: toFinite(base.watchMargin, DEFAULT_DEGRADATION_CONFIG.watchMargin),
    improveMargin: toFinite(base.improveMargin, DEFAULT_DEGRADATION_CONFIG.improveMargin),
  };
}

/**
 * Split a group's rows into two equal windows: the most recent half is
 * "recent", the half before it is "historical". Equal size keeps the
 * comparison like-for-like instead of comparing a month against a year.
 */
export function splitWindows(rows, minimumWindowSample = 5) {
  const ordered = orderRows(rows);
  const total = ordered.length;
  if (total < minimumWindowSample * 2) {
    return { historical: [], recent: [], ordered, sufficient: false, reason: `only ${total} rows, need ${minimumWindowSample * 2} for two windows` };
  }
  const size = Math.floor(total / 2);
  const recent = ordered.slice(total - size);
  const historical = ordered.slice(total - size * 2, total - size);
  return { historical, recent, ordered, sufficient: true, reason: null };
}

/**
 * Verdict for one metric across the two windows.
 *
 * A non-positive historical baseline yields INSUFFICIENT_DATA rather
 * than a verdict: relative change against zero or a negative baseline
 * is either undefined or explosive, and reporting it as degradation
 * would be a fabricated finding.
 */
export function metricVerdict(metric, historical, recent, config = DEFAULT_DEGRADATION_CONFIG) {
  const h = Number(historical);
  const r = Number(recent);
  if (!Number.isFinite(h) || !Number.isFinite(r)) {
    return { metric, state: 'INSUFFICIENT_DATA', reason: 'metric unavailable in one window' };
  }
  if (h <= 0) {
    return {
      metric,
      state: 'INSUFFICIENT_DATA',
      reason: `historical ${metric} is ${h}; relative change undefined against a non-positive baseline`,
      historical: h,
      recent: r,
    };
  }
  const change = (r - h) / h;
  let state = 'STABLE';
  if (change <= -config.degradeMargin) state = 'DEGRADING';
  else if (change <= -config.watchMargin) state = 'WATCH';
  else if (change >= config.improveMargin) state = 'IMPROVING';
  return { metric, state, historical: h, recent: r, change: Math.round(change * 10000) / 10000 };
}

/** Worst-evidence-wins aggregation across a group's metric verdicts. */
export function aggregateState(verdicts) {
  const order = ['DEGRADING', 'WATCH', 'IMPROVING', 'STABLE'];
  for (const state of order) {
    if (verdicts.some((v) => v.state === state)) return state;
  }
  return 'INSUFFICIENT_DATA';
}

function formatMetricValue(metric, value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (metric === 'winRate' || metric === 'profitFactor') {
    return `${Math.round(value * 100) / 100}`;
  }
  return `${Math.round(value * 100) / 100}`;
}

/**
 * Detect degradation for every value of one dimension.
 *
 * @param {Array|object} dataset — tradingAnalytics dataset rows (or {rows}).
 * @param {object} options — { dimension, config }
 * @returns {Array<object>} intelligence insight objects (contract shape).
 */
export function detectDegradation(dataset, options = {}) {
  try {
    const rows = toRows(dataset);
    const dimension = DIMENSIONS.includes(options.dimension) ? options.dimension : 'strategy';
    const config = resolveConfig(options.config);
    if (rows.length === 0) return [];

    const groups = new Map();
    for (const row of rows) {
      const trade = tradeOf(row);
      if (!trade) continue;
      const key = getDimensionValue(trade, dimension);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const insights = [];
    for (const key of [...groups.keys()].sort(byName)) {
      const groupRows = groups.get(key);
      const split = splitWindows(groupRows, config.minimumWindowSample);

      if (!split.sufficient) {
        const built = makeInsight({
          id: `degradation-${dimension}-${slug(key)}`,
          category: 'DEGRADATION',
          title: `${key}: not enough history to compare windows`,
          evidence:
            `${groupRows.length} closed trades recorded under ${dimension}; ` +
            `${config.minimumWindowSample * 2} needed for two comparable windows.`,
          sampleSize: groupRows.length,
          metric: {
            dimension,
            dimensionValue: key,
            state: 'INSUFFICIENT_DATA',
            reason: split.reason,
          },
          evidenceRef: {
            kind: 'TRADES',
            refIds: groupRows.map(tradeIdOf).filter(Boolean),
            sampleSize: groupRows.length,
            sources: ['tradingAnalytics.getCoreMetrics'],
          },
        });
        if (built.success) insights.push(built.insight);
        continue;
      }

      const historicalMetrics = getCoreMetrics(split.historical);
      const recentMetrics = getCoreMetrics(split.recent);
      const verdicts = config.metrics.map((metric) =>
        metricVerdict(
          metric,
          historicalMetrics[metric],
          recentMetrics[metric],
          config,
        ),
      );
      const state = aggregateState(verdicts);
      const windowSample = Math.min(split.historical.length, split.recent.length);
      const refIds = [...split.historical, ...split.recent].map(tradeIdOf).filter(Boolean);

      const worst = verdicts.find((v) => v.state === state) ?? verdicts[0];
      const comparable = verdicts.filter((v) => Number.isFinite(v.change));
      const evidence =
        state === 'INSUFFICIENT_DATA'
          ? `Comparing ${windowSample} recent trades against ${split.historical.length} earlier trades under ${dimension} "${key}" produced no comparable metric.`
          : comparable.map(
              (v) =>
                `${v.metric} ${formatMetricValue(v.metric, v.historical)} historical vs ` +
                `${formatMetricValue(v.metric, v.recent)} recent across ${windowSample}-trade windows`,
            ).join('; ') + '.';

      const built = makeInsight({
        id: `degradation-${dimension}-${slug(key)}`,
        category: 'DEGRADATION',
        title: `${key}: recent window ${state.replace('_', ' ').toLowerCase()}`,
        evidence,
        sampleSize: windowSample,
        metric: {
          dimension,
          dimensionValue: key,
          state,
          worstMetric: worst ? worst.metric : null,
          historicalWindowSize: split.historical.length,
          recentWindowSize: split.recent.length,
          metrics: verdicts,
        },
        suggestedReviewQuestion:
          `What changed between the two windows for ${key} that you could describe in your own notes?`,
        evidenceRef: {
          kind: 'TRADES',
          refIds,
          sampleSize: windowSample,
          sources: ['tradingAnalytics.getCoreMetrics'],
        },
      });
      if (built.success) insights.push(built.insight);
    }
    return insights;
  } catch {
    return [];
  }
}

export default {
  DEGRADATION_STATES,
  DEFAULT_DEGRADATION_CONFIG,
  orderRows,
  splitWindows,
  metricVerdict,
  aggregateState,
  detectDegradation,
};