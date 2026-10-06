// ============================================
// Strategies page — Strategy Builder 2.0 (Phase 9C)
// Vanilla ESM, existing CSS system (.card/.btn/.badge/.form-group).
// Persists via strategyStore (localStorage); shapes via models.js.
// Editing a material field creates a new version (engine-owned logic in
// updateStrategy/createStrategyVersion); past replays keep the version
// they ran with via resolveStrategyAtTime/getStrategyVersion.
// ============================================
import '../../css/phase9.css';
import { getCurrentUser } from '../utils/storage.js';
import {
  DEFAULT_STRATEGY,
  STRATEGY_CONDITION_TYPES,
  STRATEGY_SL_MODELS,
  STRATEGY_TP_MODELS,
  STRATEGY_EXIT_MODELS,
  STRATEGY_DIRECTIONS,
  STRATEGY_STATUSES,
} from '../utils/models.js';
import {
  getStrategies,
  getStrategy,
  saveStrategy,
  deleteStrategy,
  createStrategyVersion,
  getStrategyHistory,
  getCurrentStrategyVersion,
  getStrategyTemplates,
} from '../utils/strategyStore.js';
import { getRules } from '../utils/ruleManager.js';
import {
  navigate,
  showToast,
  showConfirm,
  escapeHtml,
} from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';

// Module flag: delegated listeners bind once (repo duplicate-listener guard).
let bound = false;
let editingId = '';
let historyId = '';
let templateDraft = null;
let entryRows = [];
let confirmRows = [];
let rowSeq = 0;

function blankConditionRow() {
  rowSeq += 1;
  return { key: `row_${rowSeq}`, type: 'PRICE_ABOVE', paramKey: 'level', paramValue: '' };
}

function toCondition(row) {
  const params = {};
  const k = String(row.paramKey || '').trim();
  if (k) {
    const raw = String(row.paramValue ?? '').trim();
    const n = Number(raw);
    params[k] = raw !== '' && Number.isFinite(n) ? n : raw;
  }
  return { id: row.key, type: String(row.type || 'CUSTOM'), params };
}

function fromConditions(list) {
  if (!Array.isArray(list) || list.length === 0) return [blankConditionRow()];
  return list.map((c) => {
    rowSeq += 1;
    const params = c && c.params && typeof c.params === 'object' ? c.params : {};
    const keys = Object.keys(params);
    return {
      key: String(c && c.id ? c.id : `row_${rowSeq}`),
      type: String(c && c.type ? c.type : 'CUSTOM'),
      paramKey: keys[0] || '',
      paramValue: keys[0] ? String(params[keys[0]]) : '',
    };
  });
}

function csvToList(raw) {
  return String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function numOrNull(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmtList(v) {
  return Array.isArray(v) && v.length ? v.join(', ') : 'All';
}

function conditionSummary(list) {
  if (!Array.isArray(list) || list.length === 0) return '—';
  return list.map((c) => String(c && c.type ? c.type : 'CUSTOM')).join(' + ');
}

function strategyMetaLine(s) {
  const parts = [
    `v${escapeHtml(String(s && s.version != null ? s.version : 1))}`,
    escapeHtml(String(s && s.direction ? s.direction : 'AUTO')),
    `minRR ${s && s.minRR != null && s.minRR !== '' ? escapeHtml(String(s.minRR)) : '—'}`,
    `risk ${s && s.riskPercent != null && s.riskPercent !== '' ? `${escapeHtml(String(s.riskPercent))}%` : 'inherit'}`,
  ];
  return parts.join(' · ');
}

function templateCardsHtml() {
  const defs = [
    { key: 'BREAKOUT', blurb: 'Range-break entry, structure stop, fixed-RR target.' },
    { key: 'PULLBACK', blurb: 'Pullback-into-level entry with trend bias.' },
    { key: 'REVERSAL', blurb: 'Reversal-cross entry, fixed-points stop.' },
  ];
  return defs.map((d) => `
    <div class="card p9-template-card">
      <h3>${escapeHtml(d.key)}</h3>
      <p class="p9-muted">${escapeHtml(d.blurb)}</p>
      <button type="button" class="btn btn-secondary" data-action="from-template" data-template="${escapeHtml(d.key)}">
        From template
      </button>
    </div>`).join('');
}

function strategyListHtml(user) {
  const list = getStrategies(user);
  if (!list.length) {
    return `<div class="empty-state" role="status"><h3>No strategies yet</h3>
      <p>Start from a template above, or fill in the builder below.</p></div>`;
  }
  return `<div class="p9-grid">${list.map((s) => {
    const id = escapeHtml(String(s.id ?? ''));
    const status = String(s.status || 'DRAFT').toUpperCase();
    const badge = status === 'ACTIVE' ? 'badge-tp' : status === 'ARCHIVED' ? 'badge-sl' : 'badge-gold';
    return `
    <article class="card" data-strategy-id="${id}">
      <div class="p9-row-head">
        <strong>${escapeHtml(String(s.name || 'Unnamed strategy'))}</strong>
        <span class="badge ${badge}">${escapeHtml(status)}</span>
      </div>
      ${s.description ? `<p class="p9-muted">${escapeHtml(String(s.description))}</p>` : ''}
      <p class="p9-meta">${strategyMetaLine(s)}</p>
      <p class="p9-meta">Pairs: ${escapeHtml(fmtList(s.pairs))}</p>
      <p class="p9-meta">Sessions: ${escapeHtml(fmtList(s.sessions))}</p>
      <p class="p9-meta">Timeframes: ${escapeHtml(fmtList(s.timeframes))}</p>
      <p class="p9-meta">Entry: ${escapeHtml(conditionSummary(s.entryConditions))}</p>
      <div class="p9-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-id="${id}">Edit</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="history" data-id="${id}">Versions</button>
        <button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${id}">Delete</button>
      </div>
    </article>`;
  }).join('')}</div>`;
}

function conditionRowsHtml(rows, group) {
  return rows.map((r, i) => `
    <div class="p9-cond-row" data-cond-group="${escapeHtml(group)}" data-cond-key="${escapeHtml(r.key)}">
      <div class="form-group">
        <label class="form-label" for="p9-${escapeHtml(group)}-type-${i}">Type</label>
        <select id="p9-${escapeHtml(group)}-type-${i}" data-cond-field="type">
          ${STRATEGY_CONDITION_TYPES.map((t) => `<option value="${escapeHtml(t)}" ${r.type === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="p9-${escapeHtml(group)}-key-${i}">Param key</label>
        <input type="text" id="p9-${escapeHtml(group)}-key-${i}" data-cond-field="paramKey" value="${escapeHtml(r.paramKey)}" placeholder="e.g. level">
      </div>
      <div class="form-group">
        <label class="form-label" for="p9-${escapeHtml(group)}-val-${i}">Param value</label>
        <input type="text" id="p9-${escapeHtml(group)}-val-${i}" data-cond-field="paramValue" value="${escapeHtml(r.paramValue)}" placeholder="e.g. 1.0850">
      </div>
      <button type="button" class="btn btn-ghost btn-sm p9-cond-remove" data-action="remove-cond" data-group="${escapeHtml(group)}" data-key="${escapeHtml(r.key)}" aria-label="Remove condition row">✕</button>
    </div>`).join('');
}

function builderHtml(user) {
  const editing = editingId ? getStrategy(user, editingId) : null;
  const d = editing || templateDraft || DEFAULT_STRATEGY;
  const rules = (() => { try { return getRules(user) || []; } catch { return []; } })();
  const refs = Array.isArray(d.ruleRefs) ? d.ruleRefs.map(String) : [];
  const sl = d.stopLoss && typeof d.stopLoss === 'object' ? d.stopLoss : {};
  const tp = d.takeProfit && typeof d.takeProfit === 'object' ? d.takeProfit : {};
  return `
  <section class="card" aria-label="Strategy builder">
    <h2>${editing ? `Edit strategy — ${escapeHtml(String(d.name || ''))} (v${escapeHtml(String(d.version ?? 1))})` : 'New strategy'}</h2>
    <p class="p9-muted">Editing a material field (conditions, direction, risk, stops, targets, scope, status, name) creates a new version. Past replays keep the version they ran with.</p>
    <form id="p9-strategy-form">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="p9-name">Name</label>
          <input type="text" id="p9-name" value="${escapeHtml(String(d.name || ''))}" required>
        </div>
        <div class="form-group">
          <label class="form-label" for="p9-status">Status</label>
          <select id="p9-status">
            ${STRATEGY_STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${String(d.status).toUpperCase() === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="p9-desc">Description</label>
        <textarea id="p9-desc" rows="2">${escapeHtml(String(d.description || ''))}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="p9-direction">Direction</label>
          <select id="p9-direction">
            ${STRATEGY_DIRECTIONS.map((x) => `<option value="${escapeHtml(x)}" ${String(d.direction).toUpperCase() === x ? 'selected' : ''}>${escapeHtml(x)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="p9-minrr">Min RR</label>
          <input type="number" id="p9-minrr" step="0.1" min="0" value="${d.minRR != null ? escapeHtml(String(d.minRR)) : ''}" placeholder="e.g. 2">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="p9-risk">Risk % (blank = inherit user rule)</label>
          <input type="number" id="p9-risk" step="0.1" min="0" value="${d.riskPercent != null ? escapeHtml(String(d.riskPercent)) : ''}" placeholder="blank = inherit">
        </div>
        <div class="form-group">
          <label class="form-label" for="p9-maxhold">Max hold candles (blank = none)</label>
          <input type="number" id="p9-maxhold" step="1" min="1" value="${d.maxHoldCandles != null ? escapeHtml(String(d.maxHoldCandles)) : ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="p9-pairs">Pairs (comma-separated, empty = all)</label>
          <input type="text" id="p9-pairs" value="${escapeHtml((d.pairs || []).join(', '))}">
        </div>
        <div class="form-group">
          <label class="form-label" for="p9-sessions">Sessions (comma-separated, empty = all)</label>
          <input type="text" id="p9-sessions" value="${escapeHtml((d.sessions || []).join(', '))}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="p9-tfs">Timeframes (comma-separated, empty = all)</label>
        <input type="text" id="p9-tfs" value="${escapeHtml((d.timeframes || []).join(', '))}">
      </div>
      <h3>Entry conditions</h3>
      <div id="p9-entry-rows">${conditionRowsHtml(entryRows, 'entry')}</div>
      <button type="button" class="btn btn-ghost btn-sm" data-action="add-cond" data-group="entry">+ Add entry condition</button>
      <h3>Confirmation conditions</h3>
      <div id="p9-confirm-rows">${conditionRowsHtml(confirmRows, 'confirm')}</div>
      <button type="button" class="btn btn-ghost btn-sm" data-action="add-cond" data-group="confirm">+ Add confirmation</button>
      <div class="form-row" style="margin-top:var(--space-md);">
        <div class="form-group">
          <label class="form-label" for="p9-sl-model">Stop-loss model</label>
          <select id="p9-sl-model">
            ${STRATEGY_SL_MODELS.map((m) => `<option value="${escapeHtml(m)}" ${String(sl.model).toUpperCase() === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="p9-sl-value">Stop-loss value (blank = auto)</label>
          <input type="number" id="p9-sl-value" step="any" min="0" value="${sl.value != null ? escapeHtml(String(sl.value)) : ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="p9-tp-model">Take-profit model</label>
          <select id="p9-tp-model">
            ${STRATEGY_TP_MODELS.map((m) => `<option value="${escapeHtml(m)}" ${String(tp.model).toUpperCase() === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="p9-tp-value">Take-profit value (blank = auto)</label>
          <input type="number" id="p9-tp-value" step="any" min="0" value="${tp.value != null ? escapeHtml(String(tp.value)) : ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="p9-exit">Exit model</label>
          <select id="p9-exit">
            ${STRATEGY_EXIT_MODELS.map((m) => `<option value="${escapeHtml(m)}" ${String(d.exitModel).toUpperCase() === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="p9-rulerefs">Linked rules (multi-select)</label>
          <select id="p9-rulerefs" multiple size="${rules.length ? Math.min(6, rules.length) : 2}">
            ${rules.length ? rules.map((r) => `<option value="${escapeHtml(String(r.id))}" ${refs.includes(String(r.id)) ? 'selected' : ''}>${escapeHtml(String(r.name || r.id))}</option>`).join('') : '<option value="" disabled>No rules yet</option>'}
          </select>
        </div>
      </div>
      <div class="form-actions">
        ${editing ? '<button type="button" class="btn btn-secondary" data-action="cancel-edit">Cancel</button>' : ''}
        <button type="submit" class="btn btn-primary">${editing ? 'Save as new version' : 'Save strategy'}</button>
      </div>
    </form>
  </section>`;
}

function historyHtml(user) {
  if (!historyId) return '';
  const s = getStrategy(user, historyId);
  if (!s) return '';
  const hist = getStrategyHistory(user, historyId);
  if (!hist.length) {
    return `<section class="card" aria-label="Version history"><h2>Version history — ${escapeHtml(String(s.name || ''))}</h2>
      <div class="empty-state"><h3>No versions recorded</h3><p>This strategy predates versioning.</p></div></section>`;
  }
  return `<section class="card" aria-label="Version history">
    <h2>Version history — ${escapeHtml(String(s.name || ''))}</h2>
    <p class="p9-muted">Current: v${escapeHtml(String(s.version ?? 1))}. Replays always pin the version they ran with.</p>
    <div class="trade-table-container"><table>
      <thead><tr><th>Version</th><th>Created</th><th>Changes</th></tr></thead>
      <tbody>${hist.map((v) => {
        const changes = v && v.changes && typeof v.changes === 'object' ? Object.keys(v.changes) : [];
        return `<tr><td>v${escapeHtml(String(v.version))}</td><td>${escapeHtml(String(v.createdAt || '—'))}</td><td>${changes.length ? escapeHtml(changes.join(', ')) : '—'}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
  </section>`;
}

export function renderStrategies() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const app = document.getElementById('app');
  if (!editingId) {
    entryRows = [blankConditionRow()];
    confirmRows = [blankConditionRow()];
  }
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page" data-page-root="strategies">
      <div class="page-header"><div>
        <h1 class="page-title">Strategies</h1>
        <p class="page-subtitle">Strategy Builder 2.0 — versioned, replay-pinned definitions</p>
      </div></div>
      <h2>From template</h2>
      <div class="p9-grid p9-templates">${templateCardsHtml()}</div>
      <h2>Your strategies</h2>
      <div id="p9-strategy-list">${strategyListHtml(user)}</div>
      <div id="p9-builder">${builderHtml(user)}</div>
      <div id="p9-history">${historyHtml(user)}</div>
    </div>`;
  bindNavbar();
  bindOnce();
}

function refreshListAndBuilder(user) {
  const list = document.getElementById('p9-strategy-list');
  const builder = document.getElementById('p9-builder');
  const hist = document.getElementById('p9-history');
  if (list) list.innerHTML = strategyListHtml(user);
  if (builder) builder.innerHTML = builderHtml(user);
  if (hist) hist.innerHTML = historyHtml(user);
}

function syncCondRowsFromDom(group) {
  const rows = group === 'entry' ? entryRows : confirmRows;
  document.querySelectorAll(`[data-cond-group="${group}"]`).forEach((el) => {
    const key = el.getAttribute('data-cond-key');
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    el.querySelectorAll('[data-cond-field]').forEach((input) => {
      const f = input.getAttribute('data-cond-field');
      if (f === 'type' || f === 'paramKey' || f === 'paramValue') row[f] = input.value;
    });
  });
}

function readForm() {
  syncCondRowsFromDom('entry');
  syncCondRowsFromDom('confirm');
  const val = (id) => document.getElementById(id)?.value ?? '';
  const ruleRefs = Array.from(document.getElementById('p9-rulerefs')?.selectedOptions || [])
    .map((o) => o.value).filter(Boolean);
  return {
    name: val('p9-name').trim(),
    description: val('p9-desc').trim(),
    status: val('p9-status') || 'DRAFT',
    direction: val('p9-direction') || 'AUTO',
    minRR: numOrNull(val('p9-minrr')),
    riskPercent: numOrNull(val('p9-risk')),
    pairs: csvToList(val('p9-pairs')),
    sessions: csvToList(val('p9-sessions')),
    timeframes: csvToList(val('p9-tfs')),
    entryConditions: entryRows.map(toCondition),
    confirmationConditions: confirmRows.map(toCondition),
    stopLoss: { model: val('p9-sl-model') || 'STRUCTURE', value: numOrNull(val('p9-sl-value')) },
    takeProfit: { model: val('p9-tp-model') || 'FIXED_TP', value: numOrNull(val('p9-tp-value')) },
    exitModel: val('p9-exit') || 'FIXED_RR',
    maxHoldCandles: (() => { const s = val('p9-maxhold').trim(); if (!s) return null; const n = Number(s); return Number.isInteger(n) ? n : null; })(),
    ruleRefs,
  };
}

function bindOnce() {
  if (bound) return;
  bound = true;
  const app = document.getElementById('app');
  app.addEventListener('click', (e) => {
    const root = document.querySelector('[data-page-root="strategies"]');
    if (!root || !root.contains(e.target)) return;
    const user = getCurrentUser();
    if (!user) return;
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'add-cond') {
      syncCondRowsFromDom('entry');
      syncCondRowsFromDom('confirm');
      const group = btn.getAttribute('data-group') === 'confirm' ? 'confirm' : 'entry';
      (group === 'entry' ? entryRows : confirmRows).push(blankConditionRow());
      refreshListAndBuilder(user);
    } else if (action === 'remove-cond') {
      syncCondRowsFromDom('entry');
      syncCondRowsFromDom('confirm');
      const group = btn.getAttribute('data-group') === 'confirm' ? 'confirm' : 'entry';
      const key = btn.getAttribute('data-key');
      const arr = group === 'entry' ? entryRows : confirmRows;
      const next = arr.filter((r) => r.key !== key);
      if (group === 'entry') entryRows = next.length ? next : [blankConditionRow()];
      else confirmRows = next.length ? next : [blankConditionRow()];
      refreshListAndBuilder(user);
    } else if (action === 'from-template') {
      const key = btn.getAttribute('data-template');
      let draft = null;
      try { draft = getStrategyTemplates(key); } catch { draft = null; }
      if (!draft) return showToast('Unknown template', 'error');
      editingId = '';
      templateDraft = draft;
      entryRows = fromConditions(draft.entryConditions);
      confirmRows = fromConditions(draft.confirmationConditions);
      refreshListAndBuilder(user);
      document.getElementById('p9-name')?.focus();
      showToast(`${key} template loaded — review and save`, 'info');
    } else if (action === 'edit') {
      const id = btn.getAttribute('data-id');
      const s = getStrategy(user, id);
      if (!s) return showToast('Strategy not found', 'error');
      editingId = id;
      historyId = id;
      entryRows = fromConditions(s.entryConditions);
      confirmRows = fromConditions(s.confirmationConditions);
      refreshListAndBuilder(user);
      document.getElementById('p9-builder')?.scrollIntoView({ behavior: 'smooth' });
    } else if (action === 'cancel-edit') {
      editingId = '';
      templateDraft = null;
      entryRows = [blankConditionRow()];
      confirmRows = [blankConditionRow()];
      refreshListAndBuilder(user);
    } else if (action === 'history') {
      historyId = btn.getAttribute('data-id');
      const builder = document.getElementById('p9-builder');
      const hist = document.getElementById('p9-history');
      if (builder) builder.innerHTML = builderHtml(user);
      if (hist) {
        hist.innerHTML = historyHtml(user);
        hist.scrollIntoView({ behavior: 'smooth' });
      }
    } else if (action === 'delete') {
      const id = btn.getAttribute('data-id');
      const s = getStrategy(user, id);
      showConfirm(`Delete "${s ? s.name : 'this strategy'}" and its versions? Saved replays keep their pinned snapshots.`, () => {
        if (deleteStrategy(user, id)) {
          if (editingId === id) editingId = '';
          if (historyId === id) historyId = '';
          showToast('Strategy deleted', 'error');
          refreshListAndBuilder(user);
        }
      });
    }
  });
  app.addEventListener('submit', (e) => {
    const root = document.querySelector('[data-page-root="strategies"]');
    if (!root || !root.contains(e.target)) return;
    if (e.target.id !== 'p9-strategy-form') return;
    e.preventDefault();
    const user = getCurrentUser();
    if (!user) return navigate('/login');
    const payload = readForm();
    if (!payload.name) return showToast('Strategy must have a name', 'error');
    if (editingId) {
      const before = getCurrentStrategyVersion(user, editingId);
      const res = createStrategyVersion(user, editingId, payload);
      if (!res || res.success !== true) return showToast((res && res.error) || 'Could not save version', 'error');
      const bumped = before && res.strategy && Number(res.strategy.version) !== Number(before.version);
      showToast(bumped ? `Saved as v${res.strategy.version}` : 'Saved (no material change — version unchanged)');
      editingId = '';
    } else {
      const res = saveStrategy(user, payload);
      if (!res || res.success !== true) return showToast((res && res.error) || 'Could not save strategy', 'error');
      historyId = res.strategy.id;
      showToast(`Strategy saved (v1)${payload.riskPercent == null ? ' — risk inherits your rule' : ''}`);
    }
    entryRows = [blankConditionRow()];
    confirmRows = [blankConditionRow()];
    templateDraft = null;
    refreshListAndBuilder(user);
  });
}

export default { renderStrategies };
