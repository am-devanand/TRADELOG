import { loginUser } from '../utils/storage.js';
import { navigate, showToast } from '../utils/helpers.js';

export function renderLogin() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-logo">
          <svg viewBox="0 0 40 40" fill="none" style="width:48px;height:48px;margin-bottom:8px"><rect width="40" height="40" rx="10" fill="url(#lg)"/><path d="M10 26l6-12 6 7 8-14" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="lg" x1="0" y1="0" x2="40" y2="40"><stop stop-color="#d4a017"/><stop offset="1" stop-color="#e8b420"/></linearGradient></defs></svg>
          <h1>TradeLog</h1>
          <p>Sign in to your trading journal</p>
        </div>
        <form id="login-form">
          <div class="form-group">
            <label class="form-label">Username</label>
            <input type="text" id="login-username" placeholder="Enter username" required autocomplete="username">
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" id="login-password" placeholder="Enter password" required autocomplete="current-password">
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:8px;">Sign In</button>
        </form>
        <div class="auth-footer">
          Don't have an account? <a href="#/register">Create one</a>
        </div>
      </div>
    </div>
  `;
  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username || !password) return showToast('Please fill all fields', 'error');
    const result = loginUser(username, password);
    if (result.success) {
      showToast('Welcome back, ' + username + '!');
      navigate('/home');
    } else {
      showToast(result.error, 'error');
    }
  });
}
