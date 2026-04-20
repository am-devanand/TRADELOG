import { registerUser } from '../utils/storage.js';
import { navigate, showToast } from '../utils/helpers.js';

export function renderRegister() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-logo">
          <svg viewBox="0 0 40 40" fill="none" style="width:48px;height:48px;margin-bottom:8px"><rect width="40" height="40" rx="10" fill="url(#lg2)"/><path d="M10 26l6-12 6 7 8-14" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="lg2" x1="0" y1="0" x2="40" y2="40"><stop stop-color="#d4a017"/><stop offset="1" stop-color="#e8b420"/></linearGradient></defs></svg>
          <h1>TradeLog</h1>
          <p>Create your trading journal account</p>
        </div>
        <form id="register-form">
          <div class="form-group">
            <label class="form-label">Username</label>
            <input type="text" id="reg-username" placeholder="Choose a username" required>
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" id="reg-password" placeholder="Create a password" required>
          </div>
          <div class="form-group">
            <label class="form-label">Confirm Password</label>
            <input type="password" id="reg-confirm" placeholder="Confirm your password" required>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:8px;">Create Account</button>
        </form>
        <div class="auth-footer">
          Already have an account? <a href="#/login">Sign in</a>
        </div>
      </div>
    </div>
  `;
  document.getElementById('register-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm = document.getElementById('reg-confirm').value;
    if (!username || !password) return showToast('Please fill all fields', 'error');
    if (password !== confirm) return showToast('Passwords do not match', 'error');
    if (password.length < 4) return showToast('Password must be at least 4 characters', 'error');
    const result = registerUser(username, password);
    if (result.success) {
      showToast('Account created! Please sign in.');
      navigate('/login');
    } else {
      showToast(result.error, 'error');
    }
  });
}
