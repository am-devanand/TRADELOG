import { getCurrentUser, getFolder, getTrades } from '../utils/storage.js';
import { navigate, formatCurrency, formatDateShort } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import Chart from 'chart.js/auto';

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
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Current Win Streak</div><div class="stat-value positive">${winStreak > 0 ? '🔥 ' + winStreak : '—'}</div></div>
        <div class="stat-card"><div class="stat-label">Current Loss Streak</div><div class="stat-value negative">${lossStreak > 0 ? '💀 ' + lossStreak : '—'}</div></div>
        <div class="stat-card"><div class="stat-label">Max Win Streak</div><div class="stat-value">${maxWin}</div></div>
        <div class="stat-card"><div class="stat-label">Max Loss Streak</div><div class="stat-value">${maxLoss}</div></div>
        <div class="stat-card"><div class="stat-label">Max Drawdown</div><div class="stat-value negative">${maxDD.toFixed(1)}%</div></div>
        <div class="stat-card"><div class="stat-label">Peak Balance</div><div class="stat-value positive">${formatCurrency(peak, cur)}</div></div>
      </div>
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

  // Charts
  const chartDefaults = { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: getComputedStyle(document.body).getPropertyValue('--text-secondary').trim() } } }, scales: {} };
  const gridColor = 'rgba(255,255,255,0.05)';
  const tickColor = getComputedStyle(document.body).getPropertyValue('--text-muted').trim();

  // Equity
  if (trades.length > 0) {
    new Chart(document.getElementById('equity-chart'), {
      type: 'line',
      data: { labels: equityDates, datasets: [{ label: 'Balance', data: equityValues, borderColor: '#d4a017', backgroundColor: 'rgba(212,160,23,0.1)', fill: true, tension: 0.3, pointRadius: 2, pointHoverRadius: 5 }] },
      options: { ...chartDefaults, scales: { x: { ticks: { color: tickColor }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } }
    });
  }

  // Win/Loss Pie
  new Chart(document.getElementById('winloss-chart'), {
    type: 'doughnut',
    data: { labels: ['Take Profit', 'Stop Loss'], datasets: [{ data: [tpCount, slCount], backgroundColor: ['rgba(0,230,118,0.8)', 'rgba(255,71,87,0.8)'], borderWidth: 0 }] },
    options: { ...chartDefaults, cutout: '60%' }
  });

  // Pair Bar
  if (pairLabels.length > 0) {
    new Chart(document.getElementById('pair-chart'), {
      type: 'bar',
      data: { labels: pairLabels, datasets: [{ label: 'PnL', data: pairValues, backgroundColor: pairColors, borderRadius: 6 }] },
      options: { ...chartDefaults, scales: { x: { ticks: { color: tickColor }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } }
    });
  }
}
