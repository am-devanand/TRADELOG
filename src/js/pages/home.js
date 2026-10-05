import { getCurrentUser, getFolders, saveFolder, deleteFolder, updateFolder, getTrades } from '../utils/storage.js';
import { navigate, showModal, hideModal, showToast, showConfirm, generateId, formatCurrency, escapeHtml, isMonday } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';

function getWeeklyBanner(user) {
  if (!isMonday()) return '';
  const folders = getFolders(user);
  let totalPnl = 0, totalTrades = 0, totalTP = 0;
  const lastWeekStart = new Date(); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(); lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
  folders.forEach(f => {
    const trades = getTrades(f.id);
    trades.forEach(t => {
      const d = new Date(t.date);
      if (d >= lastWeekStart && d <= lastWeekEnd) {
        totalTrades++;
        if (t.type === 'TP') { totalPnl += t.amount; totalTP++; }
        else totalPnl -= t.amount;
      }
    });
  });
  if (totalTrades === 0) return '';
  const wr = ((totalTP / totalTrades) * 100).toFixed(0);
  const sign = totalPnl >= 0 ? '+' : '-';
  return `<div class="weekly-banner">
    <h4>📊 Last Week's Summary</h4>
    <p>${totalTrades} trades | ${wr}% win rate | ${sign}${formatCurrency(Math.abs(totalPnl))} PnL</p>
  </div>`;
}

export function renderHome() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const folders = getFolders(user);
  const pinned = folders.filter(f => f.pinned).sort((a,b) => a.name.localeCompare(b.name));
  const unpinned = folders.filter(f => !f.pinned).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  const sorted = [...pinned, ...unpinned];

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      ${getWeeklyBanner(user)}
      <div class="page-header">
        <div>
          <h1 class="page-title">Your Accounts</h1>
          <p class="page-subtitle">Manage your trading accounts and track performance</p>
        </div>
      </div>
      <div class="folder-grid">
        ${sorted.map(f => {
          const trades = getTrades(f.id);
          const tpCount = trades.filter(t => t.type === 'TP').length;
          const slCount = trades.filter(t => t.type === 'SL').length;
          const winRate = trades.length ? ((tpCount / trades.length) * 100).toFixed(1) : '0.0';
          const pnl = f.currentBalance - f.startingBalance;
          const pnlClass = pnl >= 0 ? 'positive' : 'negative';
          const pnlSign = pnl >= 0 ? '+' : '-';
          const currSym = { USD:'$',EUR:'€',GBP:'£',JPY:'¥',INR:'₹' }[f.currency||'USD'] || '$';
          return `
          <div class="folder-card ${f.pinned ? 'pinned' : ''}" data-id="${f.id}">
            <div class="folder-name">
              ${f.pinned ? '📌 ' : ''}${escapeHtml(f.name)}
              <span class="badge badge-gold" style="margin-left:auto;font-size:10px;">${escapeHtml(f.currency || 'USD')}</span>
            </div>
            <div class="folder-balance ${pnlClass}">${currSym}${f.currentBalance.toLocaleString('en-US',{minimumFractionDigits:2})}</div>
            <div style="font-size:var(--font-size-xs);color:var(--text-muted);">
              Start: ${currSym}${f.startingBalance.toLocaleString()} · PnL: <span class="${pnlClass}">${pnlSign}${formatCurrency(Math.abs(pnl), f.currency)}</span>
            </div>
            <div class="folder-meta">
              <span class="folder-meta-item">📊 ${trades.length} trades</span>
              <span class="folder-meta-item" style="color:var(--color-tp)">✓ ${tpCount} TP</span>
              <span class="folder-meta-item" style="color:var(--color-sl)">✕ ${slCount} SL</span>
              <span class="folder-meta-item">🎯 ${winRate}%</span>
            </div>
            <div class="folder-actions-row">
              <button class="btn btn-ghost btn-sm pin-folder-btn" data-id="${f.id}" title="${f.pinned?'Unpin':'Pin'}">${f.pinned?'📌':'📍'}</button>
              <button class="btn btn-danger btn-sm delete-folder-btn" data-id="${f.id}" title="Delete">🗑</button>
            </div>
          </div>`;
        }).join('')}
        <div class="add-folder-card" id="add-folder-btn">
          <div class="add-folder-icon">+</div>
          <span style="color:var(--text-muted);font-size:var(--font-size-sm);">New Account</span>
        </div>
      </div>
    </div>
  `;
  bindNavbar();
  // Folder click
  document.querySelectorAll('.folder-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.pin-folder-btn') || e.target.closest('.delete-folder-btn')) return;
      navigate('/folder/' + card.dataset.id);
    });
  });
  // Pin
  document.querySelectorAll('.pin-folder-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const folder = getFolders(user).find(f => f.id === btn.dataset.id);
      updateFolder(user, btn.dataset.id, { pinned: !folder.pinned });
      showToast(folder.pinned ? 'Unpinned' : 'Pinned to top');
      renderHome();
    });
  });
  // Delete
  document.querySelectorAll('.delete-folder-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showConfirm('Delete this folder and all its trades? This cannot be undone.', () => {
        deleteFolder(user, btn.dataset.id);
        showToast('Folder deleted', 'error');
        renderHome();
      });
    });
  });
  // Add folder
  document.getElementById('add-folder-btn').addEventListener('click', showAddFolderModal);
}

function showAddFolderModal() {
  showModal(`
    <div class="modal-header">
      <h3 class="modal-title">New Account</h3>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <form id="add-folder-form">
      <div class="form-group">
        <label class="form-label">Account Name</label>
        <input type="text" id="folder-name" placeholder='e.g. "Deriv Account", "Prop Firm"' required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Starting Balance</label>
          <input type="number" id="folder-balance" placeholder="e.g. 10000" step="0.01" min="0" required>
        </div>
        <div class="form-group">
          <label class="form-label">Currency</label>
          <select id="folder-currency">
            <option value="USD">USD ($)</option>
            <option value="EUR">EUR (€)</option>
            <option value="GBP">GBP (£)</option>
            <option value="JPY">JPY (¥)</option>
            <option value="INR">INR (₹)</option>
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="add-folder-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Account</button>
      </div>
    </form>
  `);
  setTimeout(() => {
    document.getElementById('modal-close-btn')?.addEventListener('click', hideModal);
    document.getElementById('add-folder-cancel')?.addEventListener('click', hideModal);
    document.getElementById('add-folder-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('folder-name').value.trim();
      const balance = parseFloat(document.getElementById('folder-balance').value);
      const currency = document.getElementById('folder-currency').value;
      if (!name || isNaN(balance)) return showToast('Please fill all fields', 'error');
      const user = getCurrentUser();
      saveFolder(user, {
        id: generateId(), name, startingBalance: balance, currentBalance: balance,
        currency, pinned: false, createdAt: new Date().toISOString()
      });
      hideModal();
      showToast('Account created!');
      renderHome();
    });
  }, 50);
}
