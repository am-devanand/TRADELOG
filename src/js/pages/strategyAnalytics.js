// ============================================
// Strategy Analytics — list + detail (Phase 7)
// Vanilla ESM. All math via utils/tradingAnalytics.js (engine).
// Daily aggregation via engine getDailyPnlSeries (no duplication).
// ============================================
import '../../css/analytics.css';
import '../../css/pagesAnalytics.css';
import { getCurrentUser } from '../utils/storage.js';
import { getClosedTrades } from '../utils/executedTrades.js';
import {
  getTradeDataset,
  getCoreMetrics,
  getAllStrategyStats,
  getSessionStats,
  getPairStats,
  getMistakeStats,
  getStrengthStats,
  getDailyPnlSeries,
} from '../utils/tradingAnalytics.js';
import { ANALYTICS_THRESHOLDS } from '../utils/models.js';
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
import { navigate, escapeHtml, formatCurrency } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import Chart from 'chart.js/auto';

// ---- Module-level state (reset when the signed-in account changes) ----
let filters = { ...clearFilters() };
let lastUser = '';
let sortKey = 'totalPnl';
let sortDir = 'desc';

const PREF_KEY = 'tradelog_analytics_filters_strategies';

function ensureUser() {
  const user = getCurrentUser() || '';
  if (user !== lastUser) {
    lastUser = user;
    filters = { ...clearFilters() };
    sortKey = 'totalPnl';
    sortDir = 'desc';
    try {
      const raw = localStorage.getItem(`${PREF_KEY}_${String(user).toLowerCase()}`);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') filters = { ...clearFilters(), ...saved };
      }
    } catch { /* prefs are best-effort */ }
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

function fmtPct(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  return `${Number(v).toFixed(1)}%`;
}

function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  return Number(v).toFixed(digits);
}

function fmtPF(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  return `${Number(v).toFixed(2)}`;
}

function cellValue(v, suffix = '') {
  if (v === null || v === undefined) return '<span class="analytics-na-cell">N/A</span>';
  return `${escapeHtml(String(v))}${suffix}`;
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

function sortRows(rows) {
  const dir = sortDir === 'asc' ? 1 : -1;
  const val = (r) => {
    switch (sortKey) {
      case 'key': return String(r.key || '').toLowerCase();
      case 'trades': return r.trades ?? 0;
      case 'winRate': return r.winRate ?? -Infinity;
      case 'avgR': return r.avgR ?? -Infinity;
      case 'totalPnl': return r.totalPnl ?? -Infinity;
      case 'profitFactor': return r.profitFactor ?? -Infinity;
      default: return 0;
    }
  };
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (typeof va === 'string') return va.localeCompare(String(vb)) * dir;
    if (va === vb) return String(a.key).localeCompare(String(b.key));
    return (va < vb ? -1 : 1) * dir;
  });
}

function tableHtml(rows) {
  if (!rows.length) {
    return '<div class="empty-state"><h3>No closed trades yet.</h3><p>Close a trade to see strategy breakdowns.</p></div>';
  }
  const arrow = (key) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const th = (key, label) => `<th><button type="button" class="analytics-sort-btn" data-sort="${escapeHtml(key)}" aria-label="Sort by ${escapeHtml(label)}">${escapeHtml(label)}${escapeHtml(arrow(key))}</button></th>`;
  const body = sortRows(rows)
    .map((r) => {
      const id = encodeURIComponent(String(r.key));
      return `
      <tr class="analytics-row-link" data-strategy="${escapeHtml(String(r.key))}" data-href="#/analytics/strategies/${id}" tabindex="0" aria-label="View ${escapeHtml(String(r.key))} details">
        <td>${escapeHtml(String(r.key))} ${renderSampleBadge(r.sampleSize ?? r.trades ?? 0, { minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}</td>
        <td class="analytics-num">${escapeHtml(String(r.trades ?? 0))}</td>
        <td class="analytics-num">${cellValue(fmtPct(r.winRate))}</td>
        <td class="analytics-num">${cellValue(fmtNum(r.avgR))}</td>
        <td class="analytics-num">${cellValue(r.totalPnl === null || r.totalPnl === undefined ? null : formatCurrency(r.totalPnl))}</td>
        <td class="analytics-num">${cellValue(fmtPF(r.profitFactor))}</td>
      </tr>`;
    })
    .join('');
  return `
    <div class="analytics-table-scroll">
      <table aria-label="Strategy performance table">
        <thead><tr>${th('key', 'Strategy')}${th('trades', 'N')}${th('winRate', 'Win%')}${th('avgR', 'Avg R')}${th('totalPnl', 'P/L')}${th('profitFactor', 'PF')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function mountChartsForList(dataset, stats) {
  const tickColor = (() => { try { return getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#888'; } catch { return '#888'; } })();
  const gridColor = 'rgba(255,255,255,0.06)';
  const base = { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: tickColor } } } };

  // Strategy comparison bar (avg R per strategy)
  const cmp = document.getElementById('chart-strategy-cmp');
  if (cmp && stats.length) {
    const c = new Chart(cmp, {
      type: 'bar',
      data: {
        labels: stats.map((s) => String(s.key)),
        datasets: [{ label: 'Avg R', data: stats.map((s) => (Number.isFinite(Number(s.avgR)) ? Number(s.avgR) : 0)), backgroundColor: 'rgba(212,160,23,0.7)', borderRadius: 6 }],
      },
      options: { ...base, scales: { x: { ticks: { color: tickColor }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } },
    });
    registerChart('chart-strategy-cmp', c);
  }

  // Daily P/L (engine series — shared semantic with calendar)
  const series = getDailyPnlSeries(dataset);
  const daily = document.getElementById('chart-daily-pnl');
  if (daily && series.length) {
    const colors = series.map((d) => (d.pnl >= 0 ? 'rgba(0,230,118,0.7)' : 'rgba(255,71,87,0.7)'));
    const c = new Chart(daily, {
      type: 'bar',
      data: { labels: series.map((d) => d.dateISO), datasets: [{ label: 'Daily P/L', data: series.map((d) => d.pnl), backgroundColor: colors, borderRadius: 4 }] },
      options: { ...base, scales: { x: { ticks: { color: tickColor, maxTicksLimit: 8 }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } },
    });
    registerChart('chart-daily-pnl', c);
  }

  // Equity curve (cumulative P/L from the same series)
  const eq = document.getElementById('chart-equity');
  if (eq && series.length) {
    let run = 0;
    const cum = series.map((d) => { run = Math.round((run + d.pnl) * 100) / 100; return run; });
    const c = new Chart(eq, {
      type: 'line',
      data: { labels: series.map((d) => d.dateISO), datasets: [{ label: 'Cumulative P/L', data: cum, borderColor: '#d4a017', backgroundColor: 'rgba(212,160,23,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
      options: { ...base, scales: { x: { ticks: { color: tickColor, maxTicksLimit: 8 }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } },
    });
    registerChart('chart-equity', c);
  }
}

export function renderStrategyAnalytics() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  ensureUser();
  destroyAllCharts();

  const dataset = getTradeDataset(user, { ...toEngineFilters(filters), user });
  const stats = getAllStrategyStats(dataset);
  const core = getCoreMetrics(dataset);
  const options = distinctOptions(user);
  const n = dataset.length;

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <div class="page-header analytics-page-head">
        <div>
          <h1 class="page-title">Strategy Analytics</h1>
          <p class="analytics-page-sub">Descriptive breakdowns per strategy. No rankings or recommendations. ${renderSampleBadge(n, { minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}</p>
        </div>
      </div>
      ${tabsHtml('strategies')}
      <div class="analytics-layout">
        <div class="analytics-region-filters">${renderAnalyticsFilters({ ...filters, account: filters.account }, options)}</div>
        <div class="analytics-content">
          <div class="analytics-region-summary analytics-summary-grid" aria-label="Overall summary">
            ${renderMetricCard({ label: 'Trades', value: String(core.totalTrades ?? 0), n, sub: 'Closed trades in filter' })}
            ${renderMetricCard({ label: 'Win rate', value: fmtPct(core.winRate), n, sub: core.wins != null ? `${core.wins}W / ${core.losses}L / ${core.breakeven}BE` : '' })}
            ${renderMetricCard({ label: 'Avg R', value: fmtNum(core.avgR), n })}
            ${renderMetricCard({ label: 'Total P/L', value: core.totalTrades === 0 ? null : formatCurrency(core.totalPnl ?? 0), n })}
            ${renderMetricCard({ label: 'Profit factor', value: fmtPF(core.profitFactor), n })}
          </div>
          <div class="analytics-region-charts analytics-charts-grid">
            ${renderChartCard({ title: 'Strategy comparison (Avg R)', canvasId: 'chart-strategy-cmp', empty: stats.length === 0, emptyMessage: 'No closed trades yet.', n })}
            ${renderChartCard({ title: 'Equity curve (Cumulative P/L)', canvasId: 'chart-equity', empty: getDailyPnlSeries(dataset).length === 0, emptyMessage: 'No closed trades yet.', n })}
            ${renderChartCard({ title: 'Daily P/L', canvasId: 'chart-daily-pnl', empty: getDailyPnlSeries(dataset).length === 0, emptyMessage: 'No closed trades yet.', n })}
          </div>
          <div class="analytics-region-table card analytics-table-card">
            <h3 class="analytics-section-title">Strategies</h3>
            ${tableHtml(stats)}
          </div>
        </div>
      </div>
    </div>
  `;
  bindNavbar();
  bindAnalyticsFilters({
    onChange: (next) => {
      filters = { ...clearFilters(), ...next };
      savePrefs();
      renderStrategyAnalytics();
    },
  });

  document.querySelectorAll('[data-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-sort') || 'totalPnl';
      if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortKey = key; sortDir = key === 'key' ? 'asc' : 'desc'; }
      renderStrategyAnalytics();
    });
  });
  document.querySelectorAll('[data-href]').forEach((row) => {
    const go = () => navigate(row.getAttribute('data-href') || '/analytics/strategies');
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });

  mountChartsForList(dataset, stats);
}

// ---- Detail ----

function breakdownTable(title, rows, emptyMsg) {
  if (!rows.length) return `<div class="card"><h3 class="analytics-section-title">${escapeHtml(title)}</h3><p class="analytics-muted">${escapeHtml(emptyMsg)}</p></div>`;
  const body = rows
    .map((r) => `<tr><td>${escapeHtml(String(r.key))} ${renderSampleBadge(r.sampleSize ?? r.trades ?? 0, { minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}</td><td class="analytics-num">${escapeHtml(String(r.trades))}</td><td class="analytics-num">${cellValue(fmtPct(r.winRate))}</td><td class="analytics-num">${cellValue(fmtNum(r.avgR))}</td><td class="analytics-num">${cellValue(r.totalPnl === null || r.totalPnl === undefined ? null : formatCurrency(r.totalPnl))}</td></tr>`)
    .join('');
  return `
    <div class="card analytics-table-card">
      <h3 class="analytics-section-title">${escapeHtml(title)}</h3>
      <div class="analytics-table-scroll"><table aria-label="${escapeHtml(title)}">
        <thead><tr><th>Group</th><th>N</th><th>Win%</th><th>Avg R</th><th>P/L</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
}

function tagTable(title, rows, emptyMsg) {
  if (!rows.length) return `<div class="card"><h3 class="analytics-section-title">${escapeHtml(title)}</h3><p class="analytics-muted">${escapeHtml(emptyMsg)}</p></div>`;
  const body = rows
    .map((r) => `<tr><td>${escapeHtml(String(r.tag))}</td><td class="analytics-num">${escapeHtml(String(r.count))}</td><td class="analytics-num">${cellValue(fmtPct(r.percentageOfReviewed), '')}</td><td class="analytics-num">${cellValue(fmtNum(r.avgR))}</td><td class="analytics-num">${cellValue(fmtNum(r.avgProcessScore, ''))}</td></tr>`)
    .join('');
  return `
    <div class="card analytics-table-card">
      <h3 class="analytics-section-title">${escapeHtml(title)}</h3>
      <div class="analytics-table-scroll"><table aria-label="${escapeHtml(title)}">
        <thead><tr><th>Tag</th><th>Count</th><th>% reviewed</th><th>Avg R</th><th>Avg process</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
}

function mountChartsForDetail(dataset) {
  const tickColor = (() => { try { return getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#888'; } catch { return '#888'; } })();
  const gridColor = 'rgba(255,255,255,0.06)';
  const base = { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: tickColor } } } };
  const core = getCoreMetrics(dataset);

  const out = document.getElementById('chart-outcome');
  if (out && dataset.length) {
    const c = new Chart(out, {
      type: 'doughnut',
      data: { labels: ['Wins', 'Losses', 'Breakeven'], datasets: [{ data: [core.wins ?? 0, core.losses ?? 0, core.breakeven ?? 0], backgroundColor: ['rgba(0,230,118,0.8)', 'rgba(255,71,87,0.8)', 'rgba(212,160,23,0.8)'], borderWidth: 0 }] },
      options: { ...base, cutout: '60%' },
    });
    registerChart('chart-outcome', c);
  }

  const series = getDailyPnlSeries(dataset);
  const eq = document.getElementById('chart-detail-equity');
  if (eq && series.length) {
    let run = 0;
    const cum = series.map((d) => { run = Math.round((run + d.pnl) * 100) / 100; return run; });
    const c = new Chart(eq, {
      type: 'line',
      data: { labels: series.map((d) => d.dateISO), datasets: [{ label: 'Cumulative P/L', data: cum, borderColor: '#d4a017', backgroundColor: 'rgba(212,160,23,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
      options: { ...base, scales: { x: { ticks: { color: tickColor, maxTicksLimit: 8 }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } },
    });
    registerChart('chart-detail-equity', c);
  }

  // R distribution (buckets of 0.5R)
  const rChart = document.getElementById('chart-r-dist');
  if (rChart && dataset.length) {
    const buckets = new Map();
    for (const row of dataset) {
      const r = Number(row.r);
      if (!Number.isFinite(r)) continue;
      const b = Math.floor(r / 0.5) * 0.5;
      const label = `${b.toFixed(1)}R`;
      buckets.set(label, (buckets.get(label) ?? 0) + 1);
    }
    const labels = [...buckets.keys()].sort((a, b) => parseFloat(a) - parseFloat(b));
    if (labels.length) {
      const c = new Chart(rChart, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Trades', data: labels.map((l) => buckets.get(l)), backgroundColor: 'rgba(212,160,23,0.7)', borderRadius: 4 }] },
        options: { ...base, scales: { x: { ticks: { color: tickColor }, grid: { color: gridColor } }, y: { ticks: { color: tickColor, precision: 0 }, grid: { color: gridColor } } } },
      });
      registerChart('chart-r-dist', c);
    }
  }
}

export function renderStrategyDetail(params = {}) {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  ensureUser();
  destroyAllCharts();

  const rawId = params.id ?? '';
  const strategyId = decodeURIComponent(String(rawId));
  if (!strategyId) return navigate('/analytics/strategies');

  const dataset = getTradeDataset(user, { ...toEngineFilters({ ...filters, strategies: [] }), user });
  const matchOf = (t) => String(t.strategyId ?? t.strategy ?? '').trim();
  const stratRows = dataset.filter((row) => matchOf(row.trade) === strategyId);
  const options = distinctOptions(user);
  const n = stratRows.length;

  const core = getCoreMetrics(stratRows);
  const sessions = getSessionStats(stratRows);
  const pairs = getPairStats(stratRows);
  const mistakes = getMistakeStats(stratRows).filter((m) => m.count > 0);
  const strengths = getStrengthStats(stratRows).filter((s) => s.count > 0);

  const recent = [...stratRows]
    .sort((a, b) => String(b.trade?.closedAt || '').localeCompare(String(a.trade?.closedAt || '')))
    .slice(0, 8);
  const recentHtml = recent.length
    ? `<div class="analytics-table-scroll"><table aria-label="Recent trades">
        <thead><tr><th>Pair</th><th>Session</th><th>P/L</th><th>R</th><th>Process</th><th></th></tr></thead>
        <tbody>${recent.map((row) => {
      const t = row.trade || {};
      const pnl = Number(t.pnl);
      const rV = Number(t.rMultiple ?? t.realizedR);
      const ps = Number.isFinite(Number(row.processScore)) ? Number(row.processScore).toFixed(0) : null;
      return `<tr><td>${escapeHtml(String(t.pair || '—'))}</td><td>${escapeHtml(String(t.session || '—'))}</td>
        <td class="analytics-num">${Number.isFinite(pnl) ? escapeHtml(formatCurrency(pnl)) : '<span class="analytics-na-cell">N/A</span>'}</td>
        <td class="analytics-num">${Number.isFinite(rV) ? escapeHtml(`${rV.toFixed(2)}R`) : '<span class="analytics-na-cell">N/A</span>'}</td>
        <td class="analytics-num">${ps === null ? '<span class="analytics-na-cell">N/A</span>' : escapeHtml(ps)}</td>
        <td><a href="#/trade/${escapeHtml(String(t.id || ''))}">View</a></td></tr>`;
    }).join('')}</tbody></table></div>`
    : '<div class="empty-state"><h3>No closed trades yet.</h3><p>No trades recorded for this strategy under the current filters.</p></div>';

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <div class="page-header analytics-page-head">
        <div>
          <button class="btn btn-ghost btn-sm" id="back-strategies" style="margin-bottom:8px;">← Back to strategies</button>
          <h1 class="page-title">${escapeHtml(strategyId)}</h1>
          <p class="analytics-page-sub">Descriptive summary for this strategy under current filters. ${renderSampleBadge(n, { minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}</p>
        </div>
      </div>
      ${tabsHtml('strategies')}
      <div class="analytics-layout">
        <div class="analytics-region-filters">${renderAnalyticsFilters({ ...filters, account: filters.account }, options)}</div>
        <div class="analytics-content">
          ${n === 0 ? '<div class="empty-state"><h3>Not enough data for this analysis.</h3><p>No closed trades match this strategy and the current filters.</p></div>' : ''}
          <div class="analytics-region-summary analytics-summary-grid" aria-label="Strategy KPIs">
            ${renderMetricCard({ label: 'Trades', value: String(core.totalTrades ?? 0), n })}
            ${renderMetricCard({ label: 'Win rate', value: fmtPct(core.winRate), n, sub: `${core.wins}W / ${core.losses}L / ${core.breakeven}BE` })}
            ${renderMetricCard({ label: 'Avg R', value: fmtNum(core.avgR), n })}
            ${renderMetricCard({ label: 'Total P/L', value: core.totalTrades === 0 ? null : formatCurrency(core.totalPnl ?? 0), n })}
            ${renderMetricCard({ label: 'Profit factor', value: fmtPF(core.profitFactor), n })}
            ${renderMetricCard({ label: 'Avg process', value: fmtNum(core.avgProcessScore, 1), n: core.avgProcessScore === null ? 0 : n, sub: 'Reviewed trades only' })}
            ${renderMetricCard({ label: 'Rule adherence', value: core.ruleAdherence === null ? null : `${Number(core.ruleAdherence).toFixed(1)}%`, n, sub: 'Historical snapshots' })}
          </div>
          <div class="analytics-region-charts analytics-charts-grid">
            ${renderChartCard({ title: 'Outcome distribution', canvasId: 'chart-outcome', empty: n === 0, emptyMessage: 'No closed trades yet.', n, minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}
            ${renderChartCard({ title: 'P/L curve (Cumulative)', canvasId: 'chart-detail-equity', empty: getDailyPnlSeries(stratRows).length === 0, emptyMessage: 'No closed trades yet.', n, minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}
            ${renderChartCard({ title: 'R distribution (0.5R buckets)', canvasId: 'chart-r-dist', empty: n === 0, emptyMessage: 'No closed trades yet.', n, minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}
          </div>
          ${breakdownTable('Session breakdown', sessions, 'Not enough data for this analysis.')}
          ${breakdownTable('Pair breakdown', pairs, 'Not enough data for this analysis.')}
          ${tagTable('Mistakes observed', mistakes, 'No reviewed trades yet. Complete a trade review to see process analytics.')}
          ${tagTable('Strengths observed', strengths, 'No reviewed trades yet. Complete a trade review to see process analytics.')}
          <div class="card analytics-table-card">
            <h3 class="analytics-section-title">Recent trades</h3>
            ${recentHtml}
          </div>
        </div>
      </div>
    </div>
  `;
  bindNavbar();
  document.getElementById('back-strategies')?.addEventListener('click', () => navigate('/analytics/strategies'));
  bindAnalyticsFilters({
    onChange: (next) => {
      filters = { ...clearFilters(), ...next };
      savePrefs();
      renderStrategyDetail({ id: rawId });
    },
  });
  mountChartsForDetail(stratRows);
}

export default { renderStrategyAnalytics, renderStrategyDetail };
