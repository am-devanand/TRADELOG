import '../../css/pagesAnalytics.css';
import { getCurrentUser, getFolder, getTrades } from '../utils/storage.js';
import { navigate, formatCurrency, formatDateShort, escapeHtml } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import { getClosedTrades, getExecutedTrade } from '../utils/executedTrades.js';
import { getReviews } from '../utils/tradeReviews.js';
import { gradeForTotal } from '../utils/processScore.js';
import Chart from 'chart.js/auto';

const liveCharts = [];

function destroyCharts() {
  while (liveCharts.length) {
    try { liveCharts.pop().destroy(); } catch { break; }
  }
}

function authoritativePnl(trade) {
  if (!trade || typeof trade !== 'object') return null;
  const candidates = [trade.pnl, trade.realizedPL, trade.realizedPnl, trade.netPnl, trade.profit];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function topCounts(items, limit) {
  const freq = new Map();
  for (const raw of items) {
    const label = String(raw ?? '').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    const prev = freq.get(key);
    if (prev) prev.count += 1;
    else freq.set(key, { label, count: 1 });
  }
  return [...freq.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, limit);
}

function processGradeBand(grade) {
  const g = String(grade || '').trim().toUpperCase();
  if (g === 'A' || g === 'B') return 'GOOD';
  if (g === 'C') return 'OK';
  if (g === 'D' || g === 'F') return 'POOR';
  return '';
}

function processStatsForFolder(user, folderId) {
  let joined = [];
  try {
    const reviews = getReviews(user).filter((r) => r && String(r.status || '').toUpperCase() === 'COMPLETED');
    const byId = new Map();
    try {
      for (const t of getClosedTrades(user)) {
        if (t && t.id) byId.set(String(t.id), t);
      }
    } catch { /* offline-safe */ }
    for (const r of reviews) {
      if (!r || !r.tradeId) continue;
      let trade = byId.get(String(r.tradeId));
      if (!trade) {
        try { trade = getExecutedTrade(user, r.tradeId) || null; } catch { trade = null; }
      }
      if (!trade) continue;
      const acct = trade.accountId ?? trade.folderId ?? '';
      if (folderId && acct && String(acct) !== String(folderId)) continue;
      joined.push({ review: r, trade });
    }
  } catch {
    joined = [];
  }
  const count = joined.length;
  const scores = joined.map((j) => Number(j.review?.processScore?.total)).filter(Number.isFinite);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const avgGrade = avg === null ? '' : gradeForTotal(avg);
  const clean = joined.filter((j) => {
    const v = j.review?.ruleViolations;
    return !Array.isArray(v) || v.length === 0;
  }).length;
  const adherence = count ? (clean / count) * 100 : null;
  const mistakes = topCounts(joined.flatMap((j) => (Array.isArray(j.review.mistakes) ? j.review.mistakes : [])), 5);
  const strengths = topCounts(joined.flatMap((j) => (Array.isArray(j.review.strengths) ? j.review.strengths : [])), 5);
  const matrix = { goodProfitable: 0, goodLosing: 0, poorProfitable: 0, poorLosing: 0, skipped: 0 };
  for (const j of joined) {
    const grade = String(j.review?.processScore?.grade || gradeForTotal(j.review?.processScore?.total) || '').toUpperCase();
    const band = processGradeBand(grade);
    const pnl = authoritativePnl(j.trade);
    if (pnl === null) { matrix.skipped += 1; continue; }
    const profitable = pnl > 0;
    if (band === 'GOOD') {
      if (profitable) matrix.goodProfitable += 1;
      else matrix.goodLosing += 1;
    } else if (band === 'POOR') {
      if (profitable) matrix.poorProfitable += 1;
      else matrix.poorLosing += 1;
    } else {
      matrix.skipped += 1;
    }
  }
  return { count, avg, avgGrade, avgBand: avgGrade ? processGradeBand(avgGrade) : '', adherence, mistakes, strengths, matrix };
}

function processSectionHtml(stats) {
  if (!stats || !stats.count) {
    return `
      <div class="chart-card" style="grid-column:1/-1;" aria-label="Process">
        <h3>📋 Process (completed reviews)</h3>
        <div class="empty-state"><h3>No completed reviews yet</h3><p>Process insights appear after the first completed review.</p></div>
      </div>
    `;
  }
  const avgTxt = stats.avg === null ? '—' : (Math.round(stats.avg * 100) / 100).toString();
  const gradeTxt = stats.avgGrade || '—';
  const bandTxt = stats.avgBand || '—';
  const adhTxt = stats.adherence === null ? '—' : `${(Math.round(stats.adherence * 10) / 10).toString()}%`;
  const m = stats.matrix;
  const listHtml = (rows, emptyHint) => (rows.length
    ? `<ul class="decision-list">${rows.map((r) => `<li>${escapeHtml(r.label)} <span style="color:var(--text-muted);">× ${r.count}</span></li>`).join('')}</ul>`
    : `<p style="color:var(--text-muted);font-size:var(--font-size-sm);">${escapeHtml(emptyHint)}</p>`);
  return `
    <div class="chart-card" style="grid-column:1/-1;" aria-label="Process">
      <h3>📋 Process (completed reviews)</h3>
      <div class="stats-grid" style="margin-bottom:0;">
        <div class="stat-card"><div class="stat-label">Reviews completed</div><div class="stat-value">${stats.count}</div></div>
        <div class="stat-card"><div class="stat-label">Avg process score</div><div class="stat-value">${escapeHtml(avgTxt)}</div></div>
        <div class="stat-card"><div class="stat-label">Avg grade band</div><div class="stat-value">${escapeHtml(gradeTxt)}${bandTxt && bandTxt !== gradeTxt ? ` · ${escapeHtml(bandTxt)}` : ''}</div></div>
        <div class="stat-card"><div class="stat-label">Rule adherence (% with no violations)</div><div class="stat-value">${escapeHtml(adhTxt)}</div></div>
      </div>
      <div class="stats-grid" style="margin-bottom:0;margin-top:12px;">
        <div class="stat-card"><div class="stat-label">Common mistakes (top 5)</div>${listHtml(stats.mistakes, 'No mistakes recorded.')}</div>
        <div class="stat-card"><div class="stat-label">Strengths (top 5)</div>${listHtml(stats.strengths, 'No strengths recorded.')}</div>
      </div>
      <div class="card" style="margin-top:12px;" aria-label="Process versus outcome">
        <div class="trade-section-title"><h2>Process vs outcome</h2><p>Counts only — descriptive, not a judgement of the trader.</p></div>
        <div class="risk-grid">
          <div class="risk-item"><div class="risk-label">Good process (A/B) · Profitable</div><div class="risk-value">${m.goodProfitable}</div></div>
          <div class="risk-item"><div class="risk-label">Good process (A/B) · Losing</div><div class="risk-value">${m.goodLosing}</div></div>
          <div class="risk-item"><div class="risk-label">Poor process (D/F) · Profitable</div><div class="risk-value">${m.poorProfitable}</div></div>
          <div class="risk-item"><div class="risk-label">Poor process (D/F) · Losing</div><div class="risk-value">${m.poorLosing}</div></div>
        </div>
        <p style="font-size:var(--font-size-xs);color:var(--text-muted);margin-top:8px;">Outcome from recorded trade P/L (profitable means P/L above zero; zero or below counts as losing). C-grade reviews are counted above but not in this matrix.</p>
      </div>
    </div>
  `;
}

export function renderAnalytics(params) {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const folder = getFolder(user, params.id);
  if (!folder) return navigate('/home');
  const trades = getTrades(folder.id).sort((a, b) => new Date(a.date) - new Date(b.date));
  const cur = folder.currency || 'USD';

  // Compute analytics data
  const tpCount = trades.filter(t => t.type === 'TP').length;
  const slCount = trades.filter(t => t.type === 'SL').length;

  // Equity curve
  const equityDates = trades.map(t => formatDateShort(t.date));
  const equityValues = trades.map(t => t.balanceAfter || 0);

  // Pair performance
  const pairMap = {};
  trades.forEach(t => {
    if (!pairMap[t.pair]) pairMap[t.pair] = 0;
    pairMap[t.pair] += t.type === 'TP' ? t.amount : -t.amount;
  });
  const pairLabels = Object.keys(pairMap);
  const pairValues = Object.values(pairMap);
  const pairColors = pairValues.map(v => v >= 0 ? 'rgba(0,230,118,0.7)' : 'rgba(255,71,87,0.7)');

  // Session performance
  const sessMap = {};
  trades.forEach(t => {
    const s = t.session || 'Untagged';
    if (!sessMap[s]) sessMap[s] = { pnl: 0, count: 0 };
    sessMap[s].pnl += t.type === 'TP' ? t.amount : -t.amount;
    sessMap[s].count++;
  });

  // Daily PnL for heatmap
  const dailyPnl = {};
  trades.forEach(t => {
    if (!dailyPnl[t.date]) dailyPnl[t.date] = 0;
    dailyPnl[t.date] += t.type === 'TP' ? t.amount : -t.amount;
  });

  // Streaks
  let winStreak = 0, lossStreak = 0, maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0;
  trades.forEach(t => {
    if (t.type === 'TP') { curWin++; curLoss = 0; maxWin = Math.max(maxWin, curWin); }
    else { curLoss++; curWin = 0; maxLoss = Math.max(maxLoss, curLoss); }
  });
  winStreak = curWin; lossStreak = curLoss;

  // Drawdown
  let peak = folder.startingBalance, maxDD = 0;
  trades.forEach(t => {
    const bal = t.balanceAfter || 0;
    if (bal > peak) peak = bal;
    const dd = ((peak - bal) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  });

  // Heatmap — last 35 days
  const heatmapDays = [];
  for (let i = 34; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    heatmapDays.push({ date: key, day: d.toLocaleDateString('en-US', { weekday: 'short' }), pnl: dailyPnl[key] || 0 });
  }
  const maxAbsPnl = Math.max(...heatmapDays.map(d => Math.abs(d.pnl)), 1);

  const processStats = processStatsForFolder(user, folder.id);

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <div class="page-header">
        <div>
          <button class="btn btn-ghost btn-sm" id="back-dash" style="margin-bottom:8px;">← Back to ${folder.name}</button>
          <h1 class="page-title">Analytics</h1>
        </div>
      </div>
      <nav class="analytics-tabs" aria-label="Analytics sections">
        <a class="analytics-tab" href="#/folder/${escapeHtml(folder.id)}/analytics" aria-current="page">Performance</a>
        <a class="analytics-tab" href="#/analytics/strategies">Strategies</a>
        <a class="analytics-tab" href="#/analytics/process">Process</a>
        <a class="analytics-tab" href="#/analytics/improvements">Improvements</a>
      </nav>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Current Win Streak</div><div class="stat-value positive">${winStreak > 0 ? '🔥 ' + winStreak : '—'}</div></div>
        <div class="stat-card"><div class="stat-label">Current Loss Streak</div><div class="stat-value negative">${lossStreak > 0 ? '💀 ' + lossStreak : '—'}</div></div>
        <div class="stat-card"><div class="stat-label">Max Win Streak</div><div class="stat-value">${maxWin}</div></div>
        <div class="stat-card"><div class="stat-label">Max Loss Streak</div><div class="stat-value">${maxLoss}</div></div>
        <div class="stat-card"><div class="stat-label">Max Drawdown</div><div class="stat-value negative">${maxDD.toFixed(1)}%</div></div>
        <div class="stat-card"><div class="stat-label">Peak Balance</div><div class="stat-value positive">${formatCurrency(peak, cur)}</div></div>
      </div>
      ${processSectionHtml(processStats)}
      <div class="chart-grid">
        <div class="chart-card" style="grid-column:1/-1;"><h3>📈 Equity Curve</h3><canvas id="equity-chart"></canvas></div>
        <div class="chart-card"><h3>🎯 Win / Loss Distribution</h3><canvas id="winloss-chart"></canvas></div>
        <div class="chart-card"><h3>💹 Performance by Pair</h3><canvas id="pair-chart"></canvas></div>
        <div class="chart-card" style="grid-column:1/-1;"><h3>🕐 Performance by Session</h3>
          <div class="stats-grid" style="margin-bottom:0;">
            ${Object.entries(sessMap).map(([s, d]) => `
              <div class="stat-card">
                <div class="stat-label">${s} (${d.count} trades)</div>
                <div class="stat-value ${d.pnl >= 0 ? 'positive' : 'negative'}">${d.pnl >= 0 ? '+' : '-'}${formatCurrency(Math.abs(d.pnl), cur)}</div>
              </div>`).join('')}
          </div>
        </div>
        <div class="chart-card" style="grid-column:1/-1;"><h3>🗓 Daily PnL Heatmap (Last 35 Days)</h3>
          <div class="heatmap-labels"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
          <div class="heatmap-grid">
            ${heatmapDays.map(d => {
              const intensity = Math.abs(d.pnl) / maxAbsPnl;
              let bg;
              if (d.pnl === 0) bg = 'var(--bg-elevated)';
              else if (d.pnl > 0) bg = `rgba(0,230,118,${0.15 + intensity * 0.7})`;
              else bg = `rgba(255,71,87,${0.15 + intensity * 0.7})`;
              const title = `${d.date}: ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)}`;
              return `<div class="heatmap-cell" style="background:${bg}" title="${title}"></div>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
  bindNavbar();
  document.getElementById('back-dash').addEventListener('click', () => navigate('/folder/' + folder.id));

  destroyCharts();
  const chartDefaults = { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: getComputedStyle(document.body).getPropertyValue('--text-secondary').trim() } } }, scales: {} };
  const gridColor = 'rgba(255,255,255,0.05)';
  const tickColor = getComputedStyle(document.body).getPropertyValue('--text-muted').trim();

  if (trades.length > 0) {
    const equityCanvas = document.getElementById('equity-chart');
    if (equityCanvas) liveCharts.push(new Chart(equityCanvas, {
      type: 'line',
      data: { labels: equityDates, datasets: [{ label: 'Balance', data: equityValues, borderColor: '#d4a017', backgroundColor: 'rgba(212,160,23,0.1)', fill: true, tension: 0.3, pointRadius: 2, pointHoverRadius: 5 }] },
      options: { ...chartDefaults, scales: { x: { ticks: { color: tickColor }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } }
    }));
  }

  const winlossCanvas = document.getElementById('winloss-chart');
  if (winlossCanvas) liveCharts.push(new Chart(winlossCanvas, {
    type: 'doughnut',
    data: { labels: ['Take Profit', 'Stop Loss'], datasets: [{ data: [tpCount, slCount], backgroundColor: ['rgba(0,230,118,0.8)', 'rgba(255,71,87,0.8)'], borderWidth: 0 }] },
    options: { ...chartDefaults, cutout: '60%' }
  }));

  if (pairLabels.length > 0) {
    const pairCanvas = document.getElementById('pair-chart');
    if (pairCanvas) liveCharts.push(new Chart(pairCanvas, {
      type: 'bar',
      data: { labels: pairLabels, datasets: [{ label: 'PnL', data: pairValues, backgroundColor: pairColors, borderRadius: 6 }] },
      options: { ...chartDefaults, scales: { x: { ticks: { color: tickColor }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } }
    }));
  }
}
