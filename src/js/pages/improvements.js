// ============================================
// Improvements (Phase 7)
// Vanilla ESM. Observed patterns via utils/improvementEngine.js
// (read-only, never auto-creates). Records via utils/improvements.js.
// Charts: none required here; destroyAllCharts() still called so no
// stray Chart.js instances survive navigation from other pages.
// ============================================
import '../../css/analytics.css';
import '../../css/pagesAnalytics.css';
import { getCurrentUser } from '../utils/storage.js';
import { getClosedTrades } from '../utils/executedTrades.js';
import { getTradeDataset } from '../utils/tradingAnalytics.js';
import { getImprovementPatterns } from '../utils/improvementEngine.js';
import {
  getImprovements,
  getActiveImprovements,
  createImprovement,
  updateImprovement,
  deleteImprovement,
  IMPROVEMENT_STATUSES,
} from '../utils/improvements.js';
import { ANALYTICS_THRESHOLDS } from '../utils/models.js';
import {
  DEFAULT_FILTERS,
  renderAnalyticsFilters,
  bindAnalyticsFilters,
  clearFilters,
} from '../components/analyticsFilters.js';
import { destroyAllCharts } from '../components/analytics/chartCard.js';
import { renderSampleBadge } from '../components/analytics/sampleBadge.js';
import {
  navigate,
  escapeHtml,
  showToast,
  showModal,
  hideModal,
  showConfirm,
  formatDate,
} from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';

let filters = { ...clearFilters() };
let lastUser = '';
const PREF_KEY = 'tradelog_analytics_filters_improvements';

function ensureUser() {
  const user = getCurrentUser() || '';
  if (user !== lastUser) {
    lastUser = user;
    filters = { ...clearFilters() };
    try {
      const raw = localStorage.getItem(`${PREF_KEY}_${String(user).toLowerCase()}`);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') filters = { ...clearFilters(), ...saved };
      }
    } catch { /* prefs best-effort */ }
  }
  return user;
}

function savePrefs() {
  try {
    if (lastUser) localStorage.setItem(`${PREF_KEY}_${String(lastUser).toLowerCase()}`, JSON.stringify(filters));
  } catch { /* offline-safe */ }
}

function toEngineFilters(f) {
  return {
    accountId: f.account && f.account !== 'ALL' ? f.account : '',
    strategies: [...(f.strategies || [])],
    pairs: [...(f.pairs || [])],
    sessions: [...(f.sessions || [])],
    timeframes: [...(f.timeframes || [])],
    setupTypes: [...(f.setups || [])],
    outcomes: f.outcome && f.outcome !== 'ALL' ? [f.outcome] : null,
    reviewStatus: f.reviewStatus || 'ALL',
    dateFrom: f.dateFrom || '',
    dateTo: f.dateTo || '',
  };
}

function distinctOptions(user) {
  let trades = [];
  try {
    trades = getClosedTrades(user, filters.account && filters.account !== 'ALL' ? filters.account : undefined) || [];
  } catch { trades = []; }
  const uniq = (fn) => {
    const seen = new Set();
    const out = [];
    for (const t of trades) {
      const v = String(fn(t) ?? '').trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out.sort();
  };
  return {
    strategies: uniq((t) => t.strategyId ?? t.strategy),
    pairs: uniq((t) => t.pair),
    sessions: uniq((t) => t.session),
    timeframes: uniq((t) => t.timeframe),
    setupTypes: uniq((t) => t.setupType),
  };
}

function tabsHtml(active) {
  const tab = (href, label, key) => `<a class="analytics-tab" href="${escapeHtml(href)}"${active === key ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  return `
    <nav class="analytics-tabs" aria-label="Analytics sections">
      ${tab('#/analytics/strategies', 'Strategies', 'strategies')}
      ${tab('#/analytics/process', 'Process', 'process')}
      ${tab('#/analytics/improvements', 'Improvements', 'improvements')}
    </nav>`;
}

function patternCardsHtml(patterns) {
  if (!patterns.length) {
    return '<div class="empty-state"><h3>Not enough data for this analysis.</h3><p>Repeated patterns appear after enough completed reviews (minimum sample applies). Reviews are descriptive observations only.</p></div>';
  }
  return `<div class="analytics-cards-grid">${patterns
    .map((p) => `
      <div class="card analytics-pattern-card">
        <div class="analytics-status-row">
          <span class="badge badge-gold">${escapeHtml(String(p.category || 'PATTERN'))}</span>
          ${renderSampleBadge(p.sampleSize ?? 0, { minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}
        </div>
        <h3 class="analytics-card-title">${escapeHtml(String(p.title || 'Observed pattern'))}</h3>
        <p class="analytics-evidence">${escapeHtml(String(p.evidence || ''))}</p>
        ${p.suggestedReviewQuestion ? `<p class="analytics-review-q">Review question: ${escapeHtml(String(p.suggestedReviewQuestion))}</p>` : ''}
        <div class="analytics-card-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="pattern-to-improvement" data-pattern-id="${escapeHtml(String(p.id || ''))}" data-pattern-title="${escapeHtml(String(p.title || ''))}">Create improvement from this</button>
        </div>
      </div>`)
    .join('')}</div>`;
}

function improvementCardHtml(rec) {
  const statusOpts = (IMPROVEMENT_STATUSES || []).map(
    (s) => `<option value="${escapeHtml(s)}"${rec.status === s ? ' selected' : ''}>${escapeHtml(s)}</option>`,
  ).join('');
  return `
    <div class="card analytics-improvement-card" data-improvement="${escapeHtml(String(rec.id))}">
      <div class="analytics-status-row">
        <span class="badge ${rec.status === 'COMPLETED' ? 'badge-tp' : rec.status === 'ARCHIVED' ? 'badge-sl' : 'badge-gold'}">${escapeHtml(String(rec.status))}</span>
        <span class="analytics-muted">${escapeHtml(String(rec.category || 'GENERAL'))}${rec.evidenceCount ? ` · evidence N = ${escapeHtml(String(rec.evidenceCount))}` : ''}</span>
      </div>
      <h3 class="analytics-card-title">${escapeHtml(String(rec.title || '(untitled)'))}</h3>
      ${rec.description ? `<p class="analytics-evidence">${escapeHtml(String(rec.description))}</p>` : ''}
      ${rec.sourceType || rec.sourceId ? `<p class="analytics-muted">Source: ${escapeHtml(String(rec.sourceType || '—'))} ${escapeHtml(String(rec.sourceId || ''))}</p>` : ''}
      <p class="analytics-muted">Created ${escapeHtml(formatDate(rec.createdAt))}${rec.completedAt ? ` · completed ${escapeHtml(formatDate(rec.completedAt))}` : ''}</p>
      <div class="analytics-card-actions">
        <label class="analytics-status-row">Status
          <select data-action="status" data-id="${escapeHtml(String(rec.id))}" aria-label="Change status for ${escapeHtml(String(rec.title || rec.id))}">${statusOpts}</select>
        </label>
        <button type="button" class="btn btn-ghost btn-sm" data-action="delete" data-id="${escapeHtml(String(rec.id))}">Delete</button>
      </div>
    </div>`;
}

function openCreateModal(user, preset = {}) {
  const p = preset && typeof preset === 'object' ? preset : {};
  showModal(`
    <form class="analytics-form" id="improvement-form">
      <div class="modal-header"><h3 class="modal-title">New improvement</h3></div>
      <div class="form-group">
        <label class="form-label" for="imp-title">Title *</label>
        <input id="imp-title" name="title" required maxlength="120" value="${escapeHtml(String(p.title || ''))}" placeholder="What will you work on?">
      </div>
      <div class="form-group">
        <label class="form-label" for="imp-desc">Description</label>
        <textarea id="imp-desc" name="description" maxlength="2000" placeholder="Your own notes (optional)">${escapeHtml(String(p.description || ''))}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label" for="imp-cat">Category</label>
        <input id="imp-cat" name="category" maxlength="60" value="${escapeHtml(String(p.category || 'GENERAL'))}">
      </div>
      <div class="form-group">
        <label class="form-label" for="imp-source-type">Source type (optional)</label>
        <input id="imp-source-type" name="sourceType" maxlength="60" value="${escapeHtml(String(p.sourceType || ''))}" placeholder="e.g. PATTERN">
      </div>
      <div class="form-group">
        <label class="form-label" for="imp-source-id">Source id (optional)</label>
        <input id="imp-source-id" name="sourceId" maxlength="120" value="${escapeHtml(String(p.sourceId || ''))}">
      </div>
      <div class="form-group">
        <label class="form-label" for="imp-evidence">Evidence count (optional)</label>
        <input id="imp-evidence" name="evidenceCount" type="number" min="0" step="1" value="${escapeHtml(String(p.evidenceCount ?? ''))}">
      </div>
      <div class="confirm-actions">
        <button type="button" class="btn btn-secondary" id="imp-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Create</button>
      </div>
    </form>
  `);
  setTimeout(() => {
    document.getElementById('imp-cancel')?.addEventListener('click', hideModal);
    document.getElementById('improvement-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target;
      const data = {
        title: form.title?.value?.trim() || '',
        description: form.description?.value?.trim() || '',
        category: form.category?.value?.trim() || 'GENERAL',
        sourceType: form.sourceType?.value?.trim() || '',
        sourceId: form.sourceId?.value?.trim() || '',
        evidenceCount: form.evidenceCount?.value === '' ? 0 : Number(form.evidenceCount?.value),
      };
      const res = createImprovement(user, data);
      if (res && res.success) {
        hideModal();
        showToast('Improvement created', 'success');
        renderImprovements();
      } else {
        showToast((res && res.error) || 'Could not create improvement', 'error');
      }
    });
  }, 50);
}

export function renderImprovements() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  ensureUser();
  destroyAllCharts();

  // Patterns are computed from review data in the current filter slice.
  // improvementEngine is read-only; nothing here auto-creates records.
  const dataset = getTradeDataset(user, { ...toEngineFilters(filters), user });
  const reviews = dataset.map((r) => r.review).filter((r) => r && typeof r === 'object');
  let patterns = [];
  try {
    patterns = getImprovementPatterns({ reviews }) || [];
  } catch { patterns = []; }
  if (!Array.isArray(patterns)) patterns = [];

  const all = getImprovements(user);
  const active = getActiveImprovements(user);
  const done = all.filter((r) => r && (r.status === 'COMPLETED' || r.status === 'ARCHIVED'));
  const options = distinctOptions(user);
  const patternById = new Map(patterns.map((p) => [String(p.id), p]));

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <div class="page-header analytics-page-head">
        <div>
          <h1 class="page-title">Improvements</h1>
          <p class="analytics-page-sub">Observed patterns are descriptive only. Only you create improvements — nothing is created automatically. ${renderSampleBadge(reviews.length, { minimumSample: ANALYTICS_THRESHOLDS.minimumSample })}</p>
        </div>
        <button type="button" class="btn btn-primary" id="new-improvement">+ New improvement</button>
      </div>
      ${tabsHtml('improvements')}
      <div class="analytics-layout">
        <div class="analytics-region-filters">${renderAnalyticsFilters({ ...filters, account: filters.account }, options)}</div>
        <div class="analytics-content">
          <section aria-label="Observed patterns">
            <h3 class="analytics-section-title">Observed patterns (${escapeHtml(String(patterns.length))})</h3>
            ${patternCardsHtml(patterns)}
          </section>
          <section aria-label="Active improvements">
            <h3 class="analytics-section-title">Active improvements (${escapeHtml(String(active.length))})</h3>
            ${active.length ? `<div class="analytics-cards-grid">${active.map(improvementCardHtml).join('')}</div>` : '<div class="empty-state"><h3>No active improvements.</h3><p>Create one from an observed pattern or from scratch — your choice.</p></div>'}
          </section>
          <section aria-label="Completed and archived">
            <h3 class="analytics-section-title">Completed / archived (${escapeHtml(String(done.length))})</h3>
            ${done.length ? `<div class="analytics-cards-grid">${done.map(improvementCardHtml).join('')}</div>` : '<p class="analytics-muted">Nothing completed or archived yet.</p>'}
          </section>
        </div>
      </div>
    </div>
  `;
  bindNavbar();
  bindAnalyticsFilters({
    onChange: (next) => {
      filters = { ...clearFilters(), ...next };
      savePrefs();
      renderImprovements();
    },
  });

  document.getElementById('new-improvement')?.addEventListener('click', () => openCreateModal(user));

  document.querySelectorAll('[data-action="pattern-to-improvement"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pid = btn.getAttribute('data-pattern-id') || '';
      const p = patternById.get(pid);
      openCreateModal(user, {
        title: '',
        description: p?.suggestedReviewQuestion || '',
        category: p?.category || 'GENERAL',
        sourceType: 'PATTERN',
        sourceId: pid,
        evidenceCount: p?.sampleSize ?? 0,
      });
    });
  });

  document.querySelectorAll('select[data-action="status"]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const id = sel.getAttribute('data-id') || '';
      const res = updateImprovement(user, id, { status: sel.value });
      if (res && res.success) {
        showToast(`Marked ${sel.value}`, 'success');
        renderImprovements();
      } else {
        showToast((res && res.error) || 'Could not update status', 'error');
      }
    });
  });

  document.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id') || '';
      showConfirm('Delete this improvement? This cannot be undone.', () => {
        const res = deleteImprovement(user, id);
        if (res && res.success) {
          showToast('Improvement deleted', 'success');
          renderImprovements();
        } else {
          showToast((res && res.error) || 'Could not delete improvement', 'error');
        }
      });
    });
  });
}

export default { renderImprovements };
