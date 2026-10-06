import { getCurrentUser, logoutUser, getTheme, setTheme } from '../utils/storage.js';
import { navigate } from '../utils/helpers.js';
import { bindSyncStatus, startSyncStatusWatcher } from './syncStatus.js';

export function renderNavbar() {
  const user = getCurrentUser();
  const theme = getTheme();
  if (!user) return '';
  return `
    <nav class="navbar">
      <a class="navbar-brand" href="#/home" id="nav-brand">
        <svg viewBox="0 0 28 28" fill="none"><rect width="28" height="28" rx="6" fill="url(#nav-logo-grad)"/><path d="M7 18l4-8 4 5 6-10" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="nav-logo-grad" x1="0" y1="0" x2="28" y2="28"><stop stop-color="#d4a017"/><stop offset="1" stop-color="#e8b420"/></linearGradient></defs></svg>
        TradeLog
      </a>
      <div class="navbar-actions">
        <a class="btn btn-ghost btn-sm" href="#/command" id="nav-command" title="Command Center">⌂ Command</a>
        <a class="btn btn-ghost btn-sm" href="#/home" id="nav-home" title="Accounts">🏠 Home</a>
        <a class="btn btn-ghost btn-sm" href="#/trade" id="nav-trade" title="Trade Analysis">📈 Trade</a>
        <a class="btn btn-ghost btn-sm" href="#/rules" id="nav-rules" title="My Trading Rules">📋 Rules</a>
        <a class="btn btn-ghost btn-sm" href="#/prop" id="nav-prop" title="Prop Dashboard">🛡 Prop</a>
        <a class="btn btn-ghost btn-sm" href="#/analytics" id="nav-analytics" title="Analytics">📊 Analytics</a>
        <a class="btn btn-ghost btn-sm" href="#/strategies" id="nav-strategies" title="Strategies">♟ Strategies</a>
        <a class="btn btn-ghost btn-sm" href="#/replay" id="nav-replay" title="Replay (simulation)">↺ Replay</a>
        <a class="btn btn-ghost btn-sm" href="#/settings" id="nav-settings" title="Settings">⚙ Settings</a>
        <label class="toggle" title="Toggle theme">
          <input type="checkbox" id="theme-toggle" ${theme === 'light' ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span data-sync-status-root data-sync-compact="true"></span>
        <button class="btn btn-ghost btn-sm" id="nav-risk-calc" title="Risk Calculator">🧮</button>
        <span style="color:var(--text-secondary);font-size:var(--font-size-sm)">👤 ${user}</span>
        <button class="btn btn-ghost btn-sm" id="nav-logout">Logout</button>
      </div>
    </nav>
  `;
}

export function bindNavbar() {
  // Delegated + watcher binds are module-guarded: safe on every render.
  bindSyncStatus();
  document.querySelectorAll('[data-sync-status-root]').forEach((el) => {
    try {
      startSyncStatusWatcher(el, { compact: el.getAttribute('data-sync-compact') === 'true' });
    } catch {
      /* sync indicator must never break the navbar */
    }
  });
  document.getElementById('nav-logout')?.addEventListener('click', () => {
    logoutUser();
    navigate('/login');
  });
  document.getElementById('theme-toggle')?.addEventListener('change', (e) => {
    setTheme(e.target.checked ? 'light' : 'dark');
  });
  document.getElementById('nav-risk-calc')?.addEventListener('click', () => {
    import('./riskCalcModal.js').then(m => m.showRiskCalcModal());
  });
  document.getElementById('nav-command')?.addEventListener('click', () => {
    navigate('/command');
  });
  document.getElementById('nav-home')?.addEventListener('click', () => {
    navigate('/home');
  });
  document.getElementById('nav-settings')?.addEventListener('click', () => {
    navigate('/settings');
  });
  document.getElementById('nav-trade')?.addEventListener('click', () => {
    navigate('/trade');
  });
  document.getElementById('nav-rules')?.addEventListener('click', () => {
    navigate('/rules');
  });
  document.getElementById('nav-prop')?.addEventListener('click', () => {
    navigate('/prop');
  });
  document.getElementById('nav-analytics')?.addEventListener('click', () => {
    navigate('/analytics');
  });
}
