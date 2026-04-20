import { getCurrentUser, getFolder, getTrades, saveTrade, updateTrade, deleteTrade, recalculateBalances } from '../utils/storage.js';
import { navigate, showModal, hideModal, showToast, showConfirm, generateId, formatCurrency, formatDate, getWeekStart } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import Papa from 'papaparse';

const PAIRS = ['EUR/USD','GBP/USD','USD/JPY','XAU/USD','NAS100','US30','BTCUSD','ETH/USD','AUD/USD','USD/CAD'];
const SESSIONS = ['London','New York','Asia','Overlap'];
const STRATEGIES = ['Breakout','Reversal','Scalp','Trend Following','Range','News','Supply & Demand','Smart Money'];

function getStreak(trades) {
  if (!trades.length) return { type: null, count: 0 };
  const sorted = [...trades].sort((a,b) => new Date(b.date) - new Date(b.date) || new Date(b.createdAt) - new Date(a.createdAt));
  const lastType = sorted[0].type;
  let count = 0;
  for (const t of sorted) { if (t.type === lastType) count++; else break; }
  return { type: lastType, count };
}

export function renderDashboard(params) {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const folder = getFolder(user, params.id);
  if (!folder) return navigate('/home');

  const allTrades = getTrades(folder.id);
  const weekStart = getWeekStart();
  const recentTrades = allTrades.filter(t => new Date(t.date) >= weekStart)
    .sort((a,b) => new Date(b.date) - new Date(a.date) || new Date(b.createdAt) - new Date(a.createdAt));
  const streak = getStreak(allTrades);
  const tpCount = allTrades.filter(t => t.type === 'TP').length;
  const slCount = allTrades.filter(t => t.type === 'SL').length;
  const winRate = allTrades.length ? ((tpCount / allTrades.length) * 100).toFixed(1) : '0.0';
  const pnl = folder.currentBalance - folder.startingBalance;
  const cur = folder.currency || 'USD';

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      ${streak.count >= 3 ? `<div class="streak-banner">🔥 ${streak.count} ${streak.type} Streak!</div>` : ''}
      <div class="page-header">
        <div>
          <button class="btn btn-ghost btn-sm" id="back-home" style="margin-bottom:8px;">← Back</button>
          <h1 class="page-title">${folder.name}</h1>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" id="import-csv-btn">📤 Import CSV</button>
          <button class="btn btn-primary" id="add-trade-btn">+ New Trade</button>
        </div>
      </div>
      <div class="tabs" id="dash-tabs">
        <button class="tab active" data-tab="trades">Trades</button>
        <button class="tab" data-tab="reports">Reports</button>
        <button class="tab" data-tab="analytics">Analytics</button>
        <button class="tab" data-tab="journal">Journal</button>
      </div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Current Balance</div>
          <div class="stat-value ${pnl >= 0 ? 'positive' : 'negative'}">${formatCurrency(folder.currentBalance, cur)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Starting Balance</div>
          <div class="stat-value">${formatCurrency(folder.startingBalance, cur)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">PnL</div>
          <div class="stat-value ${pnl >= 0 ? 'positive' : 'negative'}">${pnl >= 0 ? '+' : '-'}${formatCurrency(Math.abs(pnl), cur)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Win Rate</div>
          <div class="stat-value">${winRate}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Trades</div>
          <div class="stat-value">${allTrades.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">TP / SL</div>
          <div class="stat-value"><span class="positive">${tpCount}</span> / <span class="negative">${slCount}</span></div>
        </div>
      </div>
      <div id="tab-content">
        ${renderTradesTab(recentTrades, folder)}
      </div>
      <input type="file" id="csv-file-input" accept=".csv" style="display:none;">
    </div>
  `;
  bindNavbar();
  document.getElementById('back-home').addEventListener('click', () => navigate('/home'));
  document.getElementById('add-trade-btn').addEventListener('click', () => showAddTradeModal(folder));
  // Tab switching
  document.querySelectorAll('#dash-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#dash-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const tabName = tab.dataset.tab;
      if (tabName === 'trades') {
        document.getElementById('tab-content').innerHTML = renderTradesTab(recentTrades, folder);
        bindTradeActions(folder);
      } else if (tabName === 'reports') {
        navigate('/folder/' + folder.id + '/reports');
      } else if (tabName === 'analytics') {
        navigate('/folder/' + folder.id + '/analytics');
      } else if (tabName === 'journal') {
        navigate('/folder/' + folder.id + '/journal');
      }
    });
  });
  bindTradeActions(folder);
  // CSV import
  document.getElementById('import-csv-btn').addEventListener('click', () => {
    document.getElementById('csv-file-input').click();
  });
  document.getElementById('csv-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (results) => {
        let imported = 0;
        results.data.forEach(row => {
          const date = row.date || row.Date || new Date().toISOString().split('T')[0];
          const pair = row.pair || row.Pair || row.symbol || 'Unknown';
          const type = (row.type || row.Type || row.result || 'TP').toUpperCase().includes('TP') ? 'TP' : 'SL';
          const amount = Math.abs(parseFloat(row.amount || row.Amount || row.profit || row.pnl || 0));
          if (isNaN(amount) || amount === 0) return;
          const trade = {
            id: generateId(), date, pair, type, amount,
            notes: row.notes || row.Notes || '', session: row.session || row.Session || '',
            strategy: row.strategy || row.Strategy || '', balanceAfter: 0,
            createdAt: new Date().toISOString()
          };
          saveTrade(folder.id, trade);
          imported++;
        });
        if (imported > 0) {
          recalculateBalances(user, folder.id);
          showToast(`Imported ${imported} trades!`);
          renderDashboard(params);
        } else {
          showToast('No valid trades found in CSV', 'error');
        }
      }
    });
  });
}

function renderTradesTab(trades, folder) {
  const cur = folder.currency || 'USD';
  if (!trades.length) {
    return `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
      <h3>No trades this week</h3>
      <p>Click "+ New Trade" to log your first trade</p>
    </div>`;
  }
  return `
    <div style="margin-bottom:8px;color:var(--text-muted);font-size:var(--font-size-xs);">Showing trades from current week</div>
    <div class="trade-table-container">
      <table>
        <thead><tr>
          <th>Date</th><th>Pair</th><th>Result</th><th>Amount</th><th>Balance After</th><th>Session</th><th>Strategy</th><th>Notes</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${trades.map(t => `
            <tr>
              <td>${formatDate(t.date)}</td>
              <td style="font-weight:600">${t.pair}</td>
              <td><span class="badge ${t.type === 'TP' ? 'badge-tp' : 'badge-sl'}">${t.type}</span></td>
              <td class="${t.type === 'TP' ? 'positive' : 'negative'}" style="font-weight:600">${t.type === 'TP' ? '+' : '-'}${formatCurrency(t.amount, cur)}</td>
              <td>${formatCurrency(t.balanceAfter || 0, cur)}</td>
              <td style="color:var(--text-secondary);font-size:var(--font-size-xs)">${t.session || '—'}</td>
              <td style="color:var(--text-secondary);font-size:var(--font-size-xs)">${t.strategy || '—'}</td>
              <td style="color:var(--text-secondary);font-size:var(--font-size-xs);max-width:120px;overflow:hidden;text-overflow:ellipsis">${t.notes || '—'}</td>
              <td>
                <div style="display:flex;gap:4px;">
                  <button class="btn btn-ghost btn-sm edit-trade" data-id="${t.id}" title="Edit">✏️</button>
                  <button class="btn btn-ghost btn-sm delete-trade" data-id="${t.id}" title="Delete">🗑</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function bindTradeActions(folder) {
  const user = getCurrentUser();
  document.querySelectorAll('.edit-trade').forEach(btn => {
    btn.addEventListener('click', () => {
      const trade = getTrades(folder.id).find(t => t.id === btn.dataset.id);
      if (trade) showEditTradeModal(folder, trade);
    });
  });
  document.querySelectorAll('.delete-trade').forEach(btn => {
    btn.addEventListener('click', () => {
      showConfirm('Delete this trade? Balance will be recalculated.', () => {
        deleteTrade(folder.id, btn.dataset.id);
        recalculateBalances(user, folder.id);
        showToast('Trade deleted', 'error');
        renderDashboard({ id: folder.id });
      });
    });
  });
}

function tradeFormHtml(trade = null) {
  const isEdit = !!trade;
  const today = new Date().toISOString().split('T')[0];
  return `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Date</label>
        <input type="date" id="trade-date" value="${trade?.date || today}" required>
      </div>
      <div class="form-group">
        <label class="form-label">Currency Pair</label>
        <input list="pairs-list" id="trade-pair" value="${trade?.pair || ''}" placeholder="Select or type" required>
        <datalist id="pairs-list">${PAIRS.map(p => `<option value="${p}">`).join('')}</datalist>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Result</label>
        <div style="display:flex;gap:8px;">
          <label style="flex:1;display:flex;align-items:center;gap:6px;padding:10px;background:var(--bg-input);border-radius:var(--radius-md);border:1px solid var(--border-color);cursor:pointer;">
            <input type="radio" name="trade-type" value="TP" ${(!trade || trade.type === 'TP') ? 'checked' : ''} style="accent-color:var(--color-tp)"> <span style="color:var(--color-tp);font-weight:600;">TP</span>
          </label>
          <label style="flex:1;display:flex;align-items:center;gap:6px;padding:10px;background:var(--bg-input);border-radius:var(--radius-md);border:1px solid var(--border-color);cursor:pointer;">
            <input type="radio" name="trade-type" value="SL" ${trade?.type === 'SL' ? 'checked' : ''} style="accent-color:var(--color-sl)"> <span style="color:var(--color-sl);font-weight:600;">SL</span>
          </label>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" id="amount-label">${(!trade || trade.type === 'TP') ? 'Profit Earned ($)' : 'Loss Amount ($)'}</label>
        <input type="number" id="trade-amount" value="${trade?.amount || ''}" placeholder="e.g. 150" step="0.01" min="0.01" required>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Session (optional)</label>
        <select id="trade-session">
          <option value="">— Select —</option>
          ${SESSIONS.map(s => `<option value="${s}" ${trade?.session === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Strategy (optional)</label>
        <input list="strat-list" id="trade-strategy" value="${trade?.strategy || ''}" placeholder="Select or type">
        <datalist id="strat-list">${STRATEGIES.map(s => `<option value="${s}">`).join('')}</datalist>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Notes (optional)</label>
      <textarea id="trade-notes" rows="2" placeholder="What did you observe?">${trade?.notes || ''}</textarea>
    </div>`;
}

function showAddTradeModal(folder) {
  showModal(`
    <div class="modal-header">
      <h3 class="modal-title">Log New Trade</h3>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <form id="trade-form">${tradeFormHtml()}
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="trade-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Trade</button>
      </div>
    </form>
  `);
  bindTradeForm(folder, false);
}

function showEditTradeModal(folder, trade) {
  showModal(`
    <div class="modal-header">
      <h3 class="modal-title">Edit Trade</h3>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <form id="trade-form">${tradeFormHtml(trade)}
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="trade-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Update Trade</button>
      </div>
    </form>
  `);
  bindTradeForm(folder, true, trade.id);
}

function bindTradeForm(folder, isEdit, tradeId = null) {
  setTimeout(() => {
    document.getElementById('modal-close-btn')?.addEventListener('click', hideModal);
    document.getElementById('trade-cancel')?.addEventListener('click', hideModal);
    document.querySelectorAll('input[name="trade-type"]').forEach(r => {
      r.addEventListener('change', (e) => {
        const label = document.getElementById('amount-label');
        if (label) label.textContent = e.target.value === 'TP' ? 'Profit Earned ($)' : 'Loss Amount ($)';
      });
    });
    document.getElementById('trade-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const date = document.getElementById('trade-date').value;
      const pair = document.getElementById('trade-pair').value.trim();
      const type = document.querySelector('input[name="trade-type"]:checked')?.value;
      const amount = parseFloat(document.getElementById('trade-amount').value);
      const session = document.getElementById('trade-session').value;
      const strategy = document.getElementById('trade-strategy').value.trim();
      const notes = document.getElementById('trade-notes').value.trim();
      if (!date || !pair || !type || isNaN(amount) || amount <= 0) return showToast('Please fill required fields', 'error');
      const user = getCurrentUser();
      if (isEdit) {
        updateTrade(folder.id, tradeId, { date, pair, type, amount, session, strategy, notes });
      } else {
        saveTrade(folder.id, {
          id: generateId(), date, pair, type, amount, notes, session, strategy,
          balanceAfter: 0, createdAt: new Date().toISOString()
        });
      }
      recalculateBalances(user, folder.id);
      hideModal();
      showToast(isEdit ? 'Trade updated!' : 'Trade saved!');
      renderDashboard({ id: folder.id });
    });
  }, 50);
}
