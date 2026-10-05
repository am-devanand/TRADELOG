// ============================================
// Process Analytics (Phase 7)
// Vanilla ESM. All math via utils/tradingAnalytics.js (engine).
// Subscore averages come from getProcessStats (never recomputed).
// Trend uses engine getDailyPnlSeries (shared with calendar semantic).
// ============================================
import '../../css/analytics.css';
import '../../css/pagesAnalytics.css';
import { getCurrentUser } from '../utils/storage.js';
import { getClosedTrades } from '../utils/executedTrades.js';
import {
  getTradeDataset,
  getProcessStats,
  getMistakeStats,
  getStrengthStats,
  getRuleAdherenceStats,
  getOutcomeProcessMatrix,
  getDailyPnlSeries,
} from '../utils/tradingAnalytics.js';
import { ANALYTICS_THRESHOLDS, PROCESS_QUALITY_THRESHOLD } from '../utils/models.js';
import {
  DEFAULT_FILTERS,
  renderAnalyticsFilters,
  bindAnalyticsFilters,
  clearFilters,
} from '../components/analyticsFilters.js';
import { renderMetricCard } from '../components/analytics/metricCard.js';
import {
  renderChartCard,
  registerChart,
  destroyAllCharts,
} from '../components/analytics/chartCard.js';
import { renderSampleBadge } from '../components/analytics/sampleBadge.js';
import { navigate, escapeHtml } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import Chart from 'chart.js/auto';

let filters = { ...clearFilters() };
let lastUser = '';
const PREF_KEY = 'tradelog_analytics_filters_process';

function ensureUser() {
  const user = getCurrentUser() || '';
  if (user !== lastUser) {
    lastUser = user;
    filters = { ...clearFilters() };
    try {
      const raw = localStorage.getItem(`${PREF_KEY}_${String(user).toLowerCase()}`);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') filters = { ...clearFilters(), ...saved };
      }
    } catch { /* prefs best-effort */ }
  }
  return user;
}

function savePrefs() {
  try {
    if (lastUser) localStorage.setItem(`${PREF_KEY}_${String(lastUser).toLowerCase()}`, JSON.stringify(filters));
  } catch { /* offline-safe */ }
}

function toEngineFilters(f) {
  return {
    accountId: f.account && f.account !== 'ALL' ? f.account : '',
    strategies: [...(f.strategies || [])],
    pairs: [...(f.pairs || [])],
    sessions: [...(f.sessions || [])],
    timeframes: [...(f.timeframes || [])],
    setupTypes: [...(f.setups || [])],
    outcomes: f.outcome && f.outcome !== 'ALL' ? [f.outcome] : null,
    reviewStatus: f.reviewStatus || 'ALL',
    dateFrom: f.dateFrom || '',
    dateTo: f.dateTo || '',
  };
}

function distinctOptions(user) {
  let trades = [];
  try {
    trades = getClosedTrades(user, filters.account && filters.account !== 'ALL' ? filters.account : undefined) || [];
  } catch { trades = []; }
  const uniq = (fn) => {
    const seen = new Set();
    const out = [];
    for (const t of trades) {
      const v = String(fn(t) ?? '').trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out.sort();
  };
  return {
    strategies: uniq((t) => t.strategyId ?? t.strategy),
    pairs: uniq((t) => t.pair),
    sessions: uniq((t) => t.session),
    timeframes: uniq((t) => t.timeframe),
    setupTypes: uniq((t) => t.setupType),
  };
}

function fmt1(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  return Number(v).toFixed(1);
}

function cellVal(v) {
  if (v === null || v === undefined) return '<span class="analytics-na-cell">N/A</span>';
  return escapeHtml(String(v));
}

function tabsHtml(active) {
  const tab = (href, label, key) => `<a class="analytics-tab" href="${escapeHtml(href)}"${active === key ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  return `
    <nav class="analytics-tabs" aria-label="Analytics sections">
      ${tab('#/analytics/strategies', 'Strategies', 'strategies')}
      ${tab('#/analytics/process', 'Process', 'process')}
      ${tab('#/analytics/improvements', 'Improvements', 'improvements')}
    </nav>`;
}

function tagTableHtml(title, rows, emptyMsg) {
  if (!rows.length) {
    return `<div class="card analytics-table-card"><h3 class="analytics-section-title">${escapeHtml(title)}</h3><p class="analytics-muted">${escapeHtml(emptyMsg)}</p></div>`;
  }
  const body = rows
    .map((r) => {
      const observed = `"${r.tag}" observed alongside ${r.count} reviewed trade${r.count === 1 ? '' : 's'}.`;
      return `<tr>
        <td>${escapeHtml(String(r.tag))}</td>
        <td class="analytics-num">${escapeHtml(String(r.count))}</td>
        <td class="analytics-num">${cellVal(r.percentageOfReviewed === null ? null : `${Number(r.percentageOfReviewed).toFixed(1)}%`)}</td>
        <td class="analytics-num">${cellVal(r.avgR === null ? null : Number(r.avgR).toFixed(2))}</td>
        <td class="analytics-num">${cellVal(r.avgProcessScore === null ? null : Number(r.avgProcessScore).toFixed(1))}</td>
        <td>${escapeHtml(observed)}</td>
      </tr>`;
    })
    .join('');
  return `
    <div class="card analytics-table-card">
      <h3 class="analytics-section-title">${escapeHtml(title)}</h3>
      <div class="analytics-table-scroll"><table aria-label="${escapeHtml(title)}">
        <thead><tr><th>Tag</th><th>Count</th><th>% of reviewed</th><th>Avg R</th><th>Avg process</th><th>Observed alongside</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
}

function ruleTableHtml(rows) {
  if (!rows.length) {
    return '<div class="card analytics-table-card"><h3 class="analytics-section-title">Rule adherence (historical snapshots)</h3><p class="analytics-muted">N/A — insufficient data. No rule snapshots observed under the current filters.</p></div>';
  }
  const body = rows
    .map((r) => `<tr>
      <td>${escapeHtml(String(r.ruleName))}</td>
      <td class="analytics-num">${escapeHtml(String(r.evaluated))}</td>
      <td class="analytics-num">${escapeHtml(String(r.passed))}</td>
      <td class="analytics-num">${escapeHtml(String(r.failed))}</td>
      <td class="analytics-num">${r.adherencePct === null ? '<span class="analytics-na-cell">N/A — insufficient data</span>' : escapeHtml(`${Number(r.adherencePct).toFixed(1)}%`)}</td>
    </tr>`)
    .join('');
  return `
    <div class="card analytics-table-card">
      <h3 class="analytics-section-title">Rule adherence (historical snapshots)</h3>
      <div class="analytics-table-scroll"><table aria-label="Rule adherence">
        <thead><tr><th>Rule</th><th>Evaluated</th><th>Passed</th><th>Failed</th><th>Adherence</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
}

function matrixHtml(matrix) {
  const v = (x) => (x === null || x === undefined ? '<span class="analytics-na-cell">N/A</span>' : escapeHtml(String(x)));
  const hp = matrix.highProcessProfitable;
  const hl = matrix.highProcessLosing;
  const lp = matrix.lowProcessProfitable;
  const ll = matrix.lowProcessLosing;
  return `
    <div class="card analytics-table-card">
      <h3 class="analytics-section-title">Process quality × outcome (descriptive counts)</h3>
      <p class="analytics-muted">High process means score ≥ ${escapeHtml(String(PROCESS_QUALITY_THRESHOLD))}; low means score ≤ ${escapeHtml(String(ANALYTICS_THRESHOLDS.lowProcessScore))}. Counts only — no causal reading.</p>
      <div class="analytics-matrix">
        <div class="stat-card"><div class="stat-label">High process · Profitable</div><div class="stat-value">${v(hp)}</div></div>
        <div class="stat-card"><div class="stat-label">High process · Losing</div><div class="stat-value">${v(hl)}</div></div>
        <div class="stat-card"><div class="stat-label">Low process · Profitable</div><div class="stat-value">${v(lp)}</div></div>
        <div class="stat-card"><div class="stat-label">Low process · Losing</div><div class="stat-value">${v(ll)}</div></div>
      </div>
    </div>`;
}

function mountCharts(dataset, proc) {
  const tickColor = (() => { try { return getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#888'; } catch { return '#888'; } })();
  const gridColor = 'rgba(255,255,255,0.06)';
  const base = { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: tickColor } } } };

  const grades = proc?.gradeDistribution || { A: 0, B: 0, C: 0, D: 0, F: 0 };
  const gradeEl = document.getElementById('chart-grades');
  if (gradeEl && (proc?.sampleSize ?? 0) > 0) {
    const c = new Chart(gradeEl, {
      type: 'bar',
      data: {
        labels: ['A', 'B', 'C', 'D', 'F'],
        datasets: [{ label: 'Reviews', data: ['A', 'B', 'C', 'D', 'F'].map((g) => grades[g] ?? 0), backgroundColor: 'rgba(212,160,23,0.7)', borderRadius: 6 }],
      },
      options: { ...base, scales: { x: { ticks: { color: tickColor }, grid: { color: gridColor } }, y: { ticks: { color: tickColor, precision: 0 }, grid: { color: gridColor } } } },
    });
    registerChart('chart-grades', c);
  }

  const series = getDailyPnlSeries(dataset);
  const trend = series.filter((d) => d.avgScore !== null && d.avgScore !== undefined);
  const trendEl = document.getElementById('chart-process-trend');
  if (trendEl && trend.length) {
    const c = new Chart(trendEl, {
      type: 'line',
      data: { labels: trend.map((d) => d.dateISO), datasets: [{ label: 'Avg process score', data: trend.map((d) => d.avgScore), borderColor: '#d4a017', backgroundColor: 'rgba(212,160,23,0.1)', fill: true, tension: 0.3, pointRadius: 2 }] },
      options: { ...base, scales: { x: { ticks: { color: tickColor, maxTicksLimit: 8 }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } },
    });
    registerChart('chart-process-trend', c);
  }

  const mistakes = getMistakeStats(dataset).filter((m) => m.count > 0).slice(0, 8);
  const mistEl = document.getElementById('chart-mistakes');
  if (mistEl && mistakes.length) {
    const c = new Chart(mistEl, {
      type: 'bar',
      data: {
        labels: mistakes.map((m) => String(m.tag)),
        datasets: [{ label: 'Count', data: mistakes.map((m) => m.count), backgroundColor: 'rgba(255,71,87,0.7)', borderRadius: 6 }],
      },
      options: { ...base, indexAxis: 'y', scales: { x: { ticks: { color: tickColor, precision: 0 }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } },
    });
    registerChart('chart-mistakes', c);
  }
}

export function renderProcessAnalytics() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  ensureUser();
  destroyAllCharts();

  const dataset = getTradeDataset(user, { ...toEngineFilters(filters), user });
  const proc = getProcessStats(dataset);
  const mistakes = getMistakeStats(dataset).filter((m) => m.count > 0);
  const strengths = getStrengthStats(dataset).filter((s) => s.count > 0);
  const rules = getRuleAdherenceStats(dataset);
  const matrix = getOutcomeProcessMatrix(dataset, {
    highProcessScore: PROCESS_QUALITY_THRESHOLD,
    lowProcessScore: ANALYTICS_THRESHOLDS.lowProcessScore,
  });
  const series = getDailyPnlSeries(dataset);
  const trendN = series.filter((d) => d.avgScore !== null && d.avgScore !== undefined).length;
  const options = distinctOptions(user);
  const scoredN = proc?.sampleSize ?? 0;
  const hasReviewed = scoredN > 0;

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <div class="page-header analytics-page-head">
        <div>
          <h1 class="page-title">Process Analytics</h1>
          <p class="analytics-page-sub">Execution quality from completed reviews. Descriptive only. ${renderSampleBadge(scoredN, { minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}</p>
        </div>
      </div>
      ${tabsHtml('process')}
      <div class="analytics-layout">
        <div class="analytics-region-filters">${renderAnalyticsFilters({ ...filters, account: filters.account }, options)}</div>
        <div class="analytics-content">
          ${hasReviewed ? '' : '<div class="empty-state"><h3>No reviewed trades yet.</h3><p>Complete a trade review to see process analytics.</p></div>'}
          <div class="analytics-region-summary analytics-summary-grid" aria-label="Process summary">
            ${renderMetricCard({ label: 'Avg process score', value: fmt1(proc?.avgProcessScore), n: scoredN, sub: 'Reviewed trades only' })}
            ${renderMetricCard({ label: 'Rule adherence', value: proc?.ruleAdherence === null || proc?.ruleAdherence === undefined ? null : `${Number(proc.ruleAdherence).toFixed(1)}%`, n: scoredN, sub: 'Historical snapshots' })}
            ${renderMetricCard({ label: 'Pre-trade avg', value: fmt1(proc?.preTrade), n: scoredN })}
            ${renderMetricCard({ label: 'Execution avg', value: fmt1(proc?.execution), n: scoredN })}
            ${renderMetricCard({ label: 'Management avg', value: fmt1(proc?.management), n: scoredN })}
            ${renderMetricCard({ label: 'Discipline avg', value: fmt1(proc?.discipline), n: scoredN })}
          </div>
          <div class="analytics-region-charts analytics-charts-grid">
            ${renderChartCard({ title: 'Grade distribution (A–F)', canvasId: 'chart-grades', empty: !hasReviewed, emptyMessage: 'No reviewed trades yet. Complete a trade review to see process analytics.', n: scoredN, minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}
            ${renderChartCard({ title: 'Process score trend (daily avg)', canvasId: 'chart-process-trend', empty: trendN === 0, emptyMessage: 'Not enough data for this analysis.', n: scoredN, minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}
            ${renderChartCard({ title: 'Mistake frequency (top 8)', canvasId: 'chart-mistakes', empty: mistakes.length === 0, emptyMessage: 'No reviewed trades yet. Complete a trade review to see process analytics.', n: scoredN, minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}
          </div>
          ${matrixHtml(matrix)}
          ${tagTableHtml('Mistakes', mistakes, 'No reviewed trades yet. Complete a trade review to see process analytics.')}
          ${tagTableHtml('Strengths', strengths, 'No reviewed trades yet. Complete a trade review to see process analytics.')}
          ${ruleTableHtml(rules)}
        </div>
      </div>
    </div>
  `;
  bindNavbar();
  bindAnalyticsFilters({
    onChange: (next) => {
      filters = { ...clearFilters(), ...next };
      savePrefs();
      renderProcessAnalytics();
    },
  });
  mountCharts(dataset, proc);
}

export default { renderProcessAnalytics };
