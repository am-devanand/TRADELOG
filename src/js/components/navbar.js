import { getCurrentUser, logoutUser, getTheme, setTheme } from '../utils/storage.js';
import { navigate } from '../utils/helpers.js';

export function renderNavbar() {
  const user = getCurrentUser();
  const theme = getTheme();
  if (!user) return '';
  return `
    <nav class="navbar">
      <a class="navbar-brand" href="#/home" id="nav-brand">
        <svg viewBox="0 0 28 28" fill="none"><rect width="28" height="28" rx="6" fill="url(#g)"/><path d="M7 18l4-8 4 5 6-10" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="g" x1="0" y1="0" x2="28" y2="28"><stop stop-color="#d4a017"/><stop offset="1" stop-color="#e8b420"/></linearGradient></defs></svg>
        TradeLog
      </a>
      <div class="navbar-actions">
        <label class="toggle" title="Toggle theme">
          <input type="checkbox" id="theme-toggle" ${theme === 'light' ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <button class="btn btn-ghost btn-sm" id="nav-risk-calc" title="Risk Calculator">🧮</button>
        <span style="color:var(--text-secondary);font-size:var(--font-size-sm)">👤 ${user}</span>
        <button class="btn btn-ghost btn-sm" id="nav-logout">Logout</button>
      </div>
    </nav>
  `;
}

export function bindNavbar() {
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
}
