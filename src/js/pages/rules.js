// ============================================
// Rules page — MY TRADING RULES dashboard + builder
// Vanilla ESM, existing CSS system (.card/.btn/.badge/.form-group/.modal)
// Persists via ruleManager (localStorage key tradelog_rules_{user})
// ============================================
import '../../css/rules.css';
import { getCurrentUser } from '../utils/storage.js';
import { RULE_CATEGORIES, RULE_TYPES } from '../utils/models.js';
import {
  getRules,
  saveRule,
  updateRule,
  deleteRule,
  toggleRule,
} from '../utils/ruleManager.js';
import {
  navigate,
  showModal,
  hideModal,
  showToast,
  showConfirm,
  escapeHtml,
} from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import {
  renderTemplateGallery,
  bindTemplateGallery,
} from '../components/templateGallery.js';
import {
  renderChecklistPreview,
  bindChecklistPreview,
  refreshChecklistPreview,
} from '../components/checklistPreview.js';

const SESSIONS = ['London', 'New York', 'Asia', 'Overlap'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const OPERATORS = ['<=', '>=', '<', '>', '==', '!='];

const filters = { search: '', category: 'All', enabledOnly: false };

// ---- Canonical accessors (name/description only; bridge legacy title/text) ----
function ruleName(r) {
  return String(r?.name ?? r?.title ?? r?.text ?? r?.label ?? 'Unnamed rule');
}

function ruleDesc(r) {
  return String(r?.description ?? r?.text ?? '');
}

function ruleCategory(r) {
  const c = String(r?.category ?? 'GENERAL');
  return RULE_CATEGORIES.includes(c) ? c : 'GENERAL';
}

function ruleWeight(r) {
  const n = Number(r?.weight);
  return Number.isFinite(n) ? n : 1;
}

function ruleSessions(r) {
  if (Array.isArray(r?.applicableSessions) && r.applicableSessions.length) return r.applicableSessions;
  if (Array.isArray(r?.sessions) && r.sessions.length) return r.sessions;
  return [];
}

function ruleStrategies(r) {
  if (Array.isArray(r?.applicableStrategies) && r.applicableStrategies.length) return r.applicableStrategies;
  if (Array.isArray(r?.strategies) && r.strategies.length) return r.strategies;
  return [];
}

function rulePairs(r) {
  if (Array.isArray(r?.applicablePairs) && r.applicablePairs.length) return r.applicablePairs;
  if (Array.isArray(r?.pairs) && r.pairs.length) return r.pairs;
  return [];
}

function formatValidation(r) {
  const type = String(r?.type ?? 'CHECKBOX').toUpperCase();
  const v = r?.validation && typeof r.validation === 'object' ? r.validation : {};
  const op = v.operator ?? r?.operator ?? '';
  const val = v.value ?? r?.value ?? null;
  if (type === 'CHECKBOX') return 'Manual confirm';
  if (type === 'BOOLEAN') {
    if (val === 1 || val === '1' || val === true || val === 'yes' || val === 'Yes') return 'Answer must be YES';
    if (val === 0 || val === '0' || val === false || val === 'no' || val === 'No') return 'Answer must be NO';
    return 'Yes / No confirm';
  }
  if (type === 'TIME_RESTRICTION') {
    const s = ruleSessions(r);
    return s.length ? `Allowed: ${s.join(', ')}` : 'All sessions';
  }
  if (type === 'RR_LIMIT') return `min RR ${val ?? '—'}`;
  if (type === 'PERCENTAGE_LIMIT') return `${op || '<='} ${val ?? '—'}%`;
  if (val === null || val === undefined || val === '') return op || '—';
  return `${op || ''} ${val}`.trim();
}

function filteredRules(user) {
  const q = filters.search.trim().toLowerCase();
  return getRules(user).filter((r) => {
    if (!r) return false;
    if (filters.enabledOnly && r.enabled === false) return false;
    if (filters.category !== 'All' && ruleCategory(r) !== filters.category) return false;
    if (q) {
      const hay = `${ruleName(r)}\n${ruleDesc(r)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---- Page ----
export function renderRules() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">MY TRADING RULES</h1>
          <p class="page-subtitle">Discipline checklist — rules persist per user in this browser</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary" id="scroll-preview-btn">👁 Preview Checklist</button>
          <button class="btn btn-primary" id="create-rule-btn">+ Create Rule</button>
        </div>
      </div>
      <div class="rules-summary" id="rules-summary"></div>
      <section id="templates-section" style="margin-bottom:var(--space-xl);">
        <h2 style="margin-bottom:4px;">Rule templates</h2>
        <p class="page-subtitle" style="margin-bottom:12px;">Preview, customize, then add — only selected rules are installed, your rules are never overwritten.</p>
        <div class="rules-grid" id="templates-grid"></div>
      </section>
      <div class="rules-filters">
        <div class="form-group">
          <label class="form-label" for="rules-search">Search</label>
          <input type="text" id="rules-search" placeholder="Search name or Why..." value="${escapeHtml(filters.search)}">
        </div>
        <div class="form-group">
          <label class="form-label" for="rules-category">Category</label>
          <select id="rules-category">
            <option value="All">All categories</option>
            ${RULE_CATEGORIES.map((c) => `<option value="${escapeHtml(c)}" ${filters.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        </div>
        <label class="rules-toggle-wrap" for="rules-enabled-only">
          <input type="checkbox" id="rules-enabled-only" ${filters.enabledOnly ? 'checked' : ''}>
          Enabled only
        </label>
      </div>
      <div class="rules-grid" id="rules-grid"></div>
      <section id="preview-checklist-btn" style="margin-top:var(--space-xl);scroll-margin-top:16px;">
        <h2 style="margin-bottom:4px;">Pre-trade checklist preview</h2>
        <p class="page-subtitle" style="margin-bottom:12px;">Live score from your enabled rules with demo inputs. Preview only — nothing is executed.</p>
        <div id="checklist-preview-body"></div>
      </section>
    </div>
  `;
  bindNavbar();
  document.getElementById('create-rule-btn')?.addEventListener('click', () => openBuilder(user));
  document.getElementById('scroll-preview-btn')?.addEventListener('click', () => {
    document.getElementById('preview-checklist-btn')?.scrollIntoView({ behavior: 'smooth' });
  });
  document.getElementById('rules-search')?.addEventListener('input', (e) => {
    filters.search = e.target.value;
    refreshRulesList(user);
  });
  document.getElementById('rules-category')?.addEventListener('change', (e) => {
    filters.category = e.target.value;
    refreshRulesList(user);
  });
  document.getElementById('rules-enabled-only')?.addEventListener('change', (e) => {
    filters.enabledOnly = e.target.checked;
    refreshRulesList(user);
  });
  const tplGrid = document.getElementById('templates-grid');
  if (tplGrid) tplGrid.innerHTML = renderTemplateGallery();
  const previewBody = document.getElementById('checklist-preview-body');
  if (previewBody) previewBody.innerHTML = renderChecklistPreview();
  bindTemplateGallery(user, () => refreshRulesList(user));
  bindChecklistPreview(user);
  refreshRulesList(user);
}

function summaryHtml(user) {
  const all = getRules(user);
  const active = all.filter((r) => r && r.enabled !== false).length;
  const required = all.filter((r) => r && r.required === true).length;
  const perCat = RULE_CATEGORIES.map((c) => {
    const n = all.filter((r) => ruleCategory(r) === c).length;
    return `<span class="badge chip-cat">${escapeHtml(c)} · ${n}</span>`;
  }).join('');
  return `
    <span class="badge chip-active">Active · ${active}</span>
    <span class="badge chip-required">Required · ${required}</span>
    ${perCat}
  `;
}

function cardHtml(r) {
  const id = escapeHtml(String(r.id ?? ''));
  const name = escapeHtml(ruleName(r));
  const desc = escapeHtml(ruleDesc(r));
  const cat = escapeHtml(ruleCategory(r));
  const type = escapeHtml(String(r.type ?? 'CHECKBOX'));
  const weight = escapeHtml(String(ruleWeight(r)));
  const required = r.required === true;
  const enabled = r.enabled !== false;
  const validation = escapeHtml(formatValidation(r));
  const severity = escapeHtml(String(r.severity ?? 'MEDIUM'));
  return `
    <div class="card rule-card" data-id="${id}">
      <div class="rule-card-head">
        <div class="rule-card-name">${name}</div>
        <label class="toggle" title="Toggle rule ${enabled ? 'off' : 'on'}">
          <input type="checkbox" class="rule-toggle" data-id="${id}" ${enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      ${desc ? `<div class="rule-card-desc">${desc}</div>` : ''}
      <div class="rule-card-meta">
        <span class="badge badge-cat">${cat}</span>
        <span class="badge badge-weight">W ${weight}</span>
        ${required ? '<span class="badge badge-required">REQUIRED</span>' : ''}
        <span class="badge badge-weight">${enabled ? 'ON' : 'OFF'}</span>
      </div>
      <div class="rule-card-actions">
        <button class="btn btn-secondary btn-sm rule-edit" data-id="${id}">Edit</button>
        <button class="btn btn-danger btn-sm rule-delete" data-id="${id}">Delete</button>
      </div>
      <details class="rule-why">
        <summary>Why</summary>
        <dl>
          <dt>Why</dt><dd>${desc || '—'}</dd>
          <dt>Type</dt><dd>${type}</dd>
          <dt>Weight</dt><dd>${weight}</dd>
          <dt>Required</dt><dd>${required ? 'Yes' : 'No'}</dd>
          <dt>Severity</dt><dd>${severity}</dd>
          <dt>Validation</dt><dd>${validation}</dd>
        </dl>
      </details>
    </div>
  `;
}

function refreshRulesList(user) {
  const summary = document.getElementById('rules-summary');
  const grid = document.getElementById('rules-grid');
  if (!summary || !grid) return;
  summary.innerHTML = summaryHtml(user);
  const list = filteredRules(user);
  grid.innerHTML = list.length
    ? list.map(cardHtml).join('')
    : `<div class="empty-state"><h3>No rules match</h3><p>Click "+ Create Rule" to add your first rule</p></div>`;
  bindRuleCards(user);
  refreshChecklistPreview();
}

function bindRuleCards(user) {
  document.querySelectorAll('.rule-toggle').forEach((t) => {
    t.addEventListener('change', () => {
      const updated = toggleRule(user, t.dataset.id);
      if (updated) {
        showToast(updated.enabled !== false ? 'Rule enabled' : 'Rule disabled');
        refreshRulesList(user);
      }
    });
  });
  document.querySelectorAll('.rule-edit').forEach((b) => {
    b.addEventListener('click', () => {
      const rule = getRules(user).find((r) => r && String(r.id) === b.dataset.id);
      if (rule) openBuilder(user, rule);
    });
  });
  document.querySelectorAll('.rule-delete').forEach((b) => {
    b.addEventListener('click', () => {
      const rule = getRules(user).find((r) => r && String(r.id) === b.dataset.id);
      const label = rule ? ruleName(rule) : 'this rule';
      showConfirm(`Delete "${label}"? This cannot be undone.`, () => {
        if (deleteRule(user, b.dataset.id)) {
          showToast('Rule deleted', 'error');
          refreshRulesList(user);
        }
      });
    });
  });
}

// ---- Builder modal ----
function validationFieldsHtml(type, existing = null) {
  const v = existing?.validation && typeof existing.validation === 'object' ? existing.validation : {};
  const op = escapeHtml(String(v.operator ?? existing?.operator ?? '<='));
  const numVal = v.value ?? existing?.value ?? '';
  const opOptions = (sel) => OPERATORS.map((o) => `<option value="${o}" ${sel === o ? 'selected' : ''}>${o}</option>`).join('');
  switch (type) {
    case 'NUMERIC_LIMIT':
      return `
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="rule-v-op">Operator</label>
            <select id="rule-v-op">${opOptions(String(v.operator ?? '<='))}</select>
          </div>
          <div class="form-group">
            <label class="form-label" for="rule-v-value">Value</label>
            <input type="number" id="rule-v-value" step="any" value="${escapeHtml(String(numVal))}" placeholder="e.g. 5">
          </div>
        </div>`;
    case 'PERCENTAGE_LIMIT':
      return `
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="rule-v-op">Operator</label>
            <select id="rule-v-op">${opOptions(String(v.operator ?? '<='))}</select>
          </div>
          <div class="form-group">
            <label class="form-label" for="rule-v-value">Value (%)</label>
            <input type="number" id="rule-v-value" step="any" min="0" value="${escapeHtml(String(numVal))}" placeholder="e.g. 1">
          </div>
        </div>`;
    case 'COUNT_LIMIT':
      return `
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="rule-v-op">Operator</label>
            <select id="rule-v-op">${opOptions(String(v.operator ?? '<='))}</select>
          </div>
          <div class="form-group">
            <label class="form-label" for="rule-v-value">Count</label>
            <input type="number" id="rule-v-value" step="1" min="0" value="${escapeHtml(String(numVal))}" placeholder="e.g. 3">
          </div>
        </div>`;
    case 'RR_LIMIT':
      return `
        <div class="form-group">
          <label class="form-label" for="rule-v-rr">Min RR</label>
          <input type="number" id="rule-v-rr" step="0.1" min="0" value="${escapeHtml(String(numVal))}" placeholder="e.g. 2">
          <div class="rules-hint">Requires reward-to-risk &gt;= this value (strictest-wins across RR rules).</div>
        </div>`;
    case 'BOOLEAN': {
      const sel = String(numVal ?? '');
      const isYes = sel === '1' || sel === 'yes' || sel === 'Yes' || sel === 'true';
      const isNo = sel === '0' || sel === 'no' || sel === 'No' || sel === 'false';
      return `
        <div class="form-group">
          <label class="form-label" for="rule-v-bool">Required answer</label>
          <select id="rule-v-bool">
            <option value="yes" ${isYes ? 'selected' : ''}>Yes</option>
            <option value="no" ${isNo ? 'selected' : ''}>No</option>
          </select>
        </div>`;
    }
    case 'TIME_RESTRICTION': {
      const allowed = ruleSessions(existing);
      return `
        <div class="form-group">
          <label class="form-label">Allowed sessions</label>
          <div class="session-checks" id="rule-v-sessions">
            ${SESSIONS.map((s) => `
              <label><input type="checkbox" value="${escapeHtml(s)}" ${allowed.includes(s) ? 'checked' : ''}> ${escapeHtml(s)}</label>
            `).join('')}
          </div>
          <div class="rules-hint">Empty = all sessions allowed.</div>
        </div>`;
    }
    case 'CHECKBOX':
    default:
      return `<p class="rules-hint">No extra validation — manual confirm at checklist time.</p>`;
  }
}

function openBuilder(user, existing = null) {
  const isEdit = !!existing;
  const name = escapeHtml(ruleName(existing ?? { name: '' }) === 'Unnamed rule' && !existing ? '' : (existing ? ruleName(existing) : ''));
  const desc = escapeHtml(existing ? ruleDesc(existing) : '');
  const cat = existing ? ruleCategory(existing) : 'GENERAL';
  const type = String(existing?.type ?? 'CHECKBOX').toUpperCase();
  const weight = existing ? ruleWeight(existing) : 1;
  const required = existing?.required === true;
  const enabled = !existing || existing.enabled !== false;
  const severity = String(existing?.severity ?? 'MEDIUM');
  const pairs = escapeHtml(rulePairs(existing).join(', '));
  const appSessions = ruleSessions(existing);
  const strategies = escapeHtml(ruleStrategies(existing).join(', '));

  showModal(`
    <div class="modal-header">
      <h3 class="modal-title">${isEdit ? 'Edit Rule' : 'Create Rule'}</h3>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <form id="rule-builder-form">
      <div class="form-group">
        <label class="form-label" for="rule-name">Name (min 3 chars)</label>
        <input type="text" id="rule-name" value="${name}" placeholder="e.g. Risk at most 1% per trade" required>
      </div>
      <div class="form-group">
        <label class="form-label" for="rule-desc">Why (description)</label>
        <textarea id="rule-desc" rows="3" placeholder="Why does this rule protect you?">${desc}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="rule-category">Category</label>
          <select id="rule-category">
            ${RULE_CATEGORIES.map((c) => `<option value="${escapeHtml(c)}" ${cat === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="rule-type">Type</label>
          <select id="rule-type">
            ${RULE_TYPES.map((t) => `<option value="${escapeHtml(t)}" ${type === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="rule-weight">Weight (1–100)</label>
          <input type="number" id="rule-weight" min="1" max="100" step="1" value="${escapeHtml(String(weight))}" required>
        </div>
        <div class="form-group">
          <label class="form-label" for="rule-severity">Severity</label>
          <select id="rule-severity">
            ${SEVERITIES.map((s) => `<option value="${escapeHtml(s)}" ${severity === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="check-inline" for="rule-required"><input type="checkbox" id="rule-required" ${required ? 'checked' : ''}> Required (blocks trade)</label>
        </div>
        <div class="form-group">
          <label class="check-inline" for="rule-enabled"><input type="checkbox" id="rule-enabled" ${enabled ? 'checked' : ''}> Enabled</label>
        </div>
      </div>
      <div id="rule-validation-fields">${validationFieldsHtml(type, existing)}</div>
      <div class="form-group">
        <label class="form-label" for="rule-pairs">Pairs (comma-separated, empty = all)</label>
        <input type="text" id="rule-pairs" value="${pairs}" placeholder="e.g. EUR/USD, XAU/USD">
      </div>
      <div class="form-group" id="rule-app-sessions-wrap">
        <label class="form-label">Sessions (empty = all)</label>
        <div class="session-checks" id="rule-app-sessions">
          ${SESSIONS.map((s) => `
            <label><input type="checkbox" value="${escapeHtml(s)}" ${appSessions.includes(s) ? 'checked' : ''}> ${escapeHtml(s)}</label>
          `).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="rule-strategies">Strategies (comma-separated, empty = all)</label>
        <input type="text" id="rule-strategies" value="${strategies}" placeholder="e.g. Breakout, Scalp">
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="rule-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Update Rule' : 'Save Rule'}</button>
      </div>
    </form>
  `);

  setTimeout(() => {
    document.getElementById('modal-close-btn')?.addEventListener('click', hideModal);
    document.getElementById('rule-cancel')?.addEventListener('click', hideModal);
    document.getElementById('rule-type')?.addEventListener('change', (e) => {
      const t = e.target.value;
      const box = document.getElementById('rule-validation-fields');
      if (box) box.innerHTML = validationFieldsHtml(t, existing);
      const appWrap = document.getElementById('rule-app-sessions-wrap');
      if (appWrap) appWrap.style.display = t === 'TIME_RESTRICTION' ? 'none' : '';
    });
    if (type === 'TIME_RESTRICTION') {
      const appWrap = document.getElementById('rule-app-sessions-wrap');
      if (appWrap) appWrap.style.display = 'none';
    }
    document.getElementById('rule-builder-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      saveBuilder(user, existing);
    });
  }, 50);
}

function csvList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function checkedValues(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)).map((c) => c.value);
}

function buildValidation(type) {
  switch (type) {
    case 'NUMERIC_LIMIT': {
      const operator = document.getElementById('rule-v-op')?.value ?? '<=';
      const value = parseFloat(document.getElementById('rule-v-value')?.value ?? '');
      return { operator, value: Number.isFinite(value) ? value : 0, unit: 'value' };
    }
    case 'PERCENTAGE_LIMIT': {
      const operator = document.getElementById('rule-v-op')?.value ?? '<=';
      const value = parseFloat(document.getElementById('rule-v-value')?.value ?? '');
      return { operator, value: Number.isFinite(value) ? value : 0, unit: 'percent' };
    }
    case 'COUNT_LIMIT': {
      const operator = document.getElementById('rule-v-op')?.value ?? '<=';
      const value = parseInt(document.getElementById('rule-v-value')?.value ?? '', 10);
      return { operator, value: Number.isFinite(value) ? value : 0, unit: 'count' };
    }
    case 'RR_LIMIT': {
      const value = parseFloat(document.getElementById('rule-v-rr')?.value ?? '');
      return { operator: '>=', value: Number.isFinite(value) ? value : 0, unit: 'rr' };
    }
    case 'BOOLEAN': {
      const answer = document.getElementById('rule-v-bool')?.value ?? 'yes';
      return { operator: '==', value: answer === 'yes' ? 1 : 0, unit: 'boolean' };
    }
    case 'TIME_RESTRICTION':
      return { operator: 'in', value: null, unit: 'session' };
    case 'CHECKBOX':
    default:
      return { operator: '>=', value: 0, unit: 'count' };
  }
}

function saveBuilder(user, existing = null) {
  const isEdit = !!existing;
  const name = document.getElementById('rule-name')?.value.trim() ?? '';
  const description = document.getElementById('rule-desc')?.value.trim() ?? '';
  const category = document.getElementById('rule-category')?.value ?? 'GENERAL';
  const type = document.getElementById('rule-type')?.value ?? 'CHECKBOX';
  const weight = parseFloat(document.getElementById('rule-weight')?.value ?? '');
  const required = document.getElementById('rule-required')?.checked === true;
  const enabled = document.getElementById('rule-enabled')?.checked === true;
  const severity = document.getElementById('rule-severity')?.value ?? 'MEDIUM';

  if (name.length < 3) return showToast('Name must be at least 3 characters', 'error');
  if (!Number.isFinite(weight) || weight < 1 || weight > 100) {
    return showToast('Weight must be between 1 and 100', 'error');
  }

  const validation = buildValidation(type);
  let applicableSessions;
  if (type === 'TIME_RESTRICTION') {
    applicableSessions = checkedValues('rule-v-sessions');
  } else {
    applicableSessions = checkedValues('rule-app-sessions');
  }
  const pairs = csvList(document.getElementById('rule-pairs')?.value);
  const strategies = csvList(document.getElementById('rule-strategies')?.value);

  // Canonical shape (name/description) + bridge aliases (title/text,
  // sessions/strategies/pairs) for the ruleManager storage layer.
  const payload = {
    name,
    description,
    title: name,
    text: description,
    category,
    type,
    weight,
    required,
    severity,
    enabled,
    validation,
    operator: validation.operator,
    value: validation.value,
    applicableSessions,
    sessions: applicableSessions,
    strategies,
    applicableStrategies: strategies,
    pairs,
    applicablePairs: pairs,
  };

  try {
    if (isEdit) {
      const updated = updateRule(user, existing.id, payload);
      if (!updated) return showToast('Rule not found', 'error');
      showToast('Rule updated!');
    } else {
      saveRule(user, payload);
      showToast('Rule created!');
    }
  } catch (err) {
    return showToast(err?.message || 'Could not save rule', 'error');
  }
  hideModal();
  refreshRulesList(user);
}
