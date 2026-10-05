import { getCurrentUser, getFolder, getTrades } from '../utils/storage.js';
import { navigate, formatCurrency, formatDate } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import Papa from 'papaparse';

export function renderReports(params) {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const folder = getFolder(user, params.id);
  if (!folder) return navigate('/home');
  const cur = folder.currency || 'USD';
  let allTrades = getTrades(folder.id).sort((a, b) => new Date(b.date) - new Date(a.date));

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <div class="page-header">
        <div>
          <button class="btn btn-ghost btn-sm" id="back-dash" style="margin-bottom:8px;">← Back to ${folder.name}</button>
          <h1 class="page-title">Reports</h1>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" id="export-csv">📥 Export CSV</button>
          <button class="btn btn-secondary btn-sm" id="export-pdf">📄 Export PDF</button>
        </div>
      </div>
      <div class="filters-bar" id="filters-bar">
        <div class="form-group">
          <label class="form-label">From</label>
          <input type="date" id="filter-from">
        </div>
        <div class="form-group">
          <label class="form-label">To</label>
          <input type="date" id="filter-to">
        </div>
        <div class="form-group">
          <label class="form-label">Pair</label>
          <select id="filter-pair"><option value="">All Pairs</option></select>
        </div>
        <div class="form-group">
          <label class="form-label">Result</label>
          <select id="filter-result">
            <option value="">All</option><option value="TP">TP Only</option><option value="SL">SL Only</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Session</label>
          <select id="filter-session">
            <option value="">All</option><option value="London">London</option><option value="New York">New York</option>
            <option value="Asia">Asia</option><option value="Overlap">Overlap</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Strategy</label>
          <input type="text" id="filter-strategy" placeholder="Any">
        </div>
        <div class="form-group" style="display:flex;align-items:flex-end;">
          <button class="btn btn-secondary btn-sm" id="clear-filters" style="width:100%">Clear</button>
        </div>
      </div>
      <div id="report-stats"></div>
      <div id="report-table"></div>
    </div>
  `;

  // Populate pair dropdown
  const pairs = [...new Set(allTrades.map(t => t.pair))];
  const pairSelect = document.getElementById('filter-pair');
  pairs.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; pairSelect.appendChild(o); });

  bindNavbar();
  document.getElementById('back-dash').addEventListener('click', () => navigate('/folder/' + folder.id));

  function getFiltered() {
    let trades = [...allTrades];
    const from = document.getElementById('filter-from').value;
    const to = document.getElementById('filter-to').value;
    const pair = document.getElementById('filter-pair').value;
    const result = document.getElementById('filter-result').value;
    const session = document.getElementById('filter-session').value;
    const strategy = document.getElementById('filter-strategy').value.trim().toLowerCase();
    if (from) trades = trades.filter(t => t.date >= from);
    if (to) trades = trades.filter(t => t.date <= to);
    if (pair) trades = trades.filter(t => t.pair === pair);
    if (result) trades = trades.filter(t => t.type === result);
    if (session) trades = trades.filter(t => t.session === session);
    if (strategy) trades = trades.filter(t => (t.strategy || '').toLowerCase().includes(strategy));
    return trades;
  }

  function renderStats(trades) {
    const tp = trades.filter(t => t.type === 'TP');
    const sl = trades.filter(t => t.type === 'SL');
    const totalProfit = tp.reduce((s, t) => s + t.amount, 0);
    const totalLoss = sl.reduce((s, t) => s + t.amount, 0);
    const netPnl = totalProfit - totalLoss;
    const winRate = trades.length ? ((tp.length / trades.length) * 100).toFixed(1) : '0.0';
    const best = tp.length ? Math.max(...tp.map(t => t.amount)) : 0;
    const worst = sl.length ? Math.max(...sl.map(t => t.amount)) : 0;
    const avgTP = tp.length ? totalProfit / tp.length : 0;
    const avgSL = sl.length ? totalLoss / sl.length : 0;

    document.getElementById('report-stats').innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Total Trades</div><div class="stat-value">${trades.length}</div></div>
        <div class="stat-card"><div class="stat-label">TP / SL</div><div class="stat-value"><span class="positive">${tp.length}</span> / <span class="negative">${sl.length}</span></div></div>
        <div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-value">${winRate}%</div></div>
        <div class="stat-card"><div class="stat-label">Total Profit</div><div class="stat-value positive">+${formatCurrency(totalProfit, cur)}</div></div>
        <div class="stat-card"><div class="stat-label">Total Loss</div><div class="stat-value negative">-${formatCurrency(totalLoss, cur)}</div></div>
        <div class="stat-card"><div class="stat-label">Net PnL</div><div class="stat-value ${netPnl >= 0 ? 'positive' : 'negative'}">${netPnl >= 0 ? '+' : '-'}${formatCurrency(Math.abs(netPnl), cur)}</div></div>
        <div class="stat-card"><div class="stat-label">Best Trade</div><div class="stat-value positive">+${formatCurrency(best, cur)}</div></div>
        <div class="stat-card"><div class="stat-label">Worst Trade</div><div class="stat-value negative">-${formatCurrency(worst, cur)}</div></div>
        <div class="stat-card"><div class="stat-label">Avg TP</div><div class="stat-value">${formatCurrency(avgTP, cur)}</div></div>
        <div class="stat-card"><div class="stat-label">Avg SL</div><div class="stat-value">${formatCurrency(avgSL, cur)}</div></div>
      </div>`;
  }

  function renderTable(trades) {
    if (!trades.length) {
      document.getElementById('report-table').innerHTML = `<div class="empty-state"><h3>No trades match your filters</h3></div>`;
      return;
    }
    document.getElementById('report-table').innerHTML = `
      <div class="trade-table-container">
        <table>
          <thead><tr><th>Date</th><th>Pair</th><th>Result</th><th>Amount</th><th>Balance</th><th>Session</th><th>Strategy</th><th>Notes</th></tr></thead>
          <tbody>${trades.map(t => `
            <tr>
              <td>${formatDate(t.date)}</td>
              <td style="font-weight:600">${t.pair}</td>
              <td><span class="badge ${t.type === 'TP' ? 'badge-tp' : 'badge-sl'}">${t.type}</span></td>
              <td class="${t.type === 'TP' ? 'positive' : 'negative'}" style="font-weight:600">${t.type === 'TP' ? '+' : '-'}${formatCurrency(t.amount, cur)}</td>
              <td>${formatCurrency(t.balanceAfter || 0, cur)}</td>
              <td style="color:var(--text-secondary);font-size:var(--font-size-xs)">${t.session || '—'}</td>
              <td style="color:var(--text-secondary);font-size:var(--font-size-xs)">${t.strategy || '—'}</td>
              <td style="color:var(--text-secondary);font-size:var(--font-size-xs);max-width:150px;overflow:hidden;text-overflow:ellipsis">${t.notes || '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function refresh() { const f = getFiltered(); renderStats(f); renderTable(f); }
  refresh();

  // Filter listeners
  ['filter-from','filter-to','filter-pair','filter-result','filter-session','filter-strategy'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', refresh);
    document.getElementById(id)?.addEventListener('change', refresh);
  });
  document.getElementById('clear-filters').addEventListener('click', () => {
    ['filter-from','filter-to','filter-strategy'].forEach(id => { document.getElementById(id).value = ''; });
    ['filter-pair','filter-result','filter-session'].forEach(id => { document.getElementById(id).selectedIndex = 0; });
    refresh();
  });

  // Export CSV
  document.getElementById('export-csv').addEventListener('click', () => {
    const trades = getFiltered();
    const csv = Papa.unparse(trades.map(t => ({
      Date: t.date, Pair: t.pair, Result: t.type, Amount: t.amount,
      BalanceAfter: t.balanceAfter, Session: t.session, Strategy: t.strategy, Notes: t.notes
    })));
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${folder.name}_trades.csv`; a.click();
    URL.revokeObjectURL(url);
  });

  // Export PDF
  document.getElementById('export-pdf').addEventListener('click', () => {
    const trades = getFiltered();
    const doc = new jsPDF();
    doc.setFontSize(18); doc.text(`TradeLog — ${folder.name}`, 14, 20);
    doc.setFontSize(10); doc.setTextColor(100);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28);
    const tp = trades.filter(t => t.type === 'TP');
    const sl = trades.filter(t => t.type === 'SL');
    const totalProfit = tp.reduce((s, t) => s + t.amount, 0);
    const totalLoss = sl.reduce((s, t) => s + t.amount, 0);
    doc.setFontSize(11); doc.setTextColor(0);
    doc.text(`Trades: ${trades.length} | TP: ${tp.length} | SL: ${sl.length} | Win Rate: ${trades.length ? ((tp.length/trades.length)*100).toFixed(1) : 0}%`, 14, 38);
    doc.text(`Profit: $${totalProfit.toFixed(2)} | Loss: $${totalLoss.toFixed(2)} | Net: $${(totalProfit - totalLoss).toFixed(2)}`, 14, 45);
    const tableBody = trades.map(t => [t.date, t.pair, t.type, `$${Number(t.amount || 0).toFixed(2)}`, `$${Number(t.balanceAfter || 0).toFixed(2)}`, t.session || '', t.strategy || '']);
    if (typeof doc.autoTable === 'function') {
      doc.autoTable({
        startY: 52,
        head: [['Date', 'Pair', 'Result', 'Amount', 'Balance', 'Session', 'Strategy']],
        body: tableBody,
        styles: { fontSize: 8 }, headStyles: { fillColor: [212, 160, 23] }
      });
    } else {
      autoTable(doc, {
        startY: 52,
        head: [['Date', 'Pair', 'Result', 'Amount', 'Balance', 'Session', 'Strategy']],
        body: tableBody,
        styles: { fontSize: 8 }, headStyles: { fillColor: [212, 160, 23] }
      });
    }
    doc.save(`${folder.name}_report.pdf`);
  });
}
