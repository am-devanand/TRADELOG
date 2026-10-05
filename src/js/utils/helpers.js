// ============================================
// UI Helpers — toast, modal, confirm, router
// ============================================

// ---- Toast Notifications ----
export function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ---- Modal ----
export function showModal(content) {
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `<div class="modal">${content}</div>`;
  overlay.classList.add('active');
  // Use onclick (not addEventListener) so repeated showModal calls don't stack listeners
  overlay.onclick = (e) => {
    if (e.target === overlay) hideModal();
  };
}

export function hideModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('active');
  setTimeout(() => { overlay.innerHTML = ''; }, 300);
}

// ---- Confirm Dialog ----
export function showConfirm(message, onConfirm) {
  showModal(`
    <div class="confirm-dialog">
      <div class="modal-header"><h3 class="modal-title">Confirm</h3></div>
      <p>${message}</p>
      <div class="confirm-actions">
        <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
        <button class="btn btn-danger" id="confirm-ok">Delete</button>
      </div>
    </div>
  `);
  setTimeout(() => {
    document.getElementById('confirm-cancel')?.addEventListener('click', hideModal);
    document.getElementById('confirm-ok')?.addEventListener('click', () => { hideModal(); onConfirm(); });
  }, 50);
}

// ---- Simple Router ----
const routes = {};
let currentRoute = null;

export function registerRoute(path, handler) {
  routes[path] = handler;
}

export function navigate(path) {
  window.location.hash = path;
}

export function startRouter() {
  function handleRoute() {
    const hash = window.location.hash.slice(1) || '/login';
    const parts = hash.split('/').filter(Boolean);
    let matched = false;
    // Try exact match first
    if (routes[hash]) {
      currentRoute = hash;
      routes[hash]({});
      matched = true;
    } else {
      // Try pattern matching: /folder/:id, /folder/:id/reports, etc.
      for (const pattern of Object.keys(routes)) {
        const patternParts = pattern.split('/').filter(Boolean);
        if (patternParts.length !== parts.length) continue;
        const params = {};
        let match = true;
        for (let i = 0; i < patternParts.length; i++) {
          if (patternParts[i].startsWith(':')) {
            params[patternParts[i].slice(1)] = parts[i];
          } else if (patternParts[i] !== parts[i]) {
            match = false;
            break;
          }
        }
        if (match) {
          currentRoute = pattern;
          routes[pattern](params);
          matched = true;
          break;
        }
      }
    }
    if (!matched) navigate('/login');
  }
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

// ---- Utility ----
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function formatCurrency(amount, currency = 'USD') {
  const symbols = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹' };
  const sym = symbols[currency] || '$';
  const num = Number(amount);
  const safe = Number.isFinite(num) ? num : 0;
  return `${safe < 0 ? '-' : ''}${sym}${Math.abs(safe).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateShort(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.getFullYear(), now.getMonth(), diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

export function isMonday() {
  return new Date().getDay() === 1;
}
