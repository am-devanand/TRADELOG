// ============================================
// Template Gallery — rule template cards + Preview/Customize/Install flow
// Vanilla ESM, no side effects on import.
// Install path: Template -> Preview -> Customize -> Add via ruleManager.
// Never overwrites/deletes existing rules; name+category+type dupes skipped.
// ============================================
import { getTemplates, getRules, saveRule } from '../utils/ruleManager.js';
import { escapeHtml, showModal, hideModal, showToast } from '../utils/helpers.js';

export const TEMPLATE_META = [
  {
    key: 'conservative',
    name: 'Conservative',
    icon: '🛡️',
    blurb: 'Capital preservation first: tight risk, high RR, few trades.',
  },
  {
    key: 'breakout',
    name: 'Breakout',
    icon: '🚀',
    blurb: 'Momentum entries: breakout + retest in liquid sessions.',
  },
  {
    key: 'discipline',
    name: 'Discipline',
    icon: '🧠',
    blurb: 'Psychology guardrails: loss limits, journaling, no revenge.',
  },
];

// Map a rule (template or stored) to a display category. Templates from
// getTemplates() carry no category, so derive one from type/metric.
export function inferCategory(rule = {}) {
  if (typeof rule.category === 'string' && rule.category.trim()) {
    return rule.category.trim().toUpperCase().replace(/[\s-]+/g, '_');
  }
  const type = String(rule.type || '').trim().toUpperCase();
  const metric = String(rule.metric || rule.field || '').trim().toLowerCase();
  if (type === 'PERCENTAGE_LIMIT' || metric === 'riskpercent') return 'RISK';
  if (type === 'RR_LIMIT' || metric === 'rr') return 'ENTRY';
  if (type === 'SESSION' || type === 'TIME_RESTRICTION') return 'SESSION';
  if (type === 'COUNT_LIMIT') {
    return metric === 'consecutivelosses' ? 'PSYCHOLOGY' : 'EXECUTION';
  }
  if (type === 'BOOLEAN' || type === 'CHECKBOX') {
    const hay = `${rule.title || ''} ${rule.text || ''} ${rule.description || ''}`.toLowerCase();
    if (/revenge|calm|journal|accept|psych|emotion|fomo/.test(hay)) return 'PSYCHOLOGY';
    return 'GENERAL';
  }
  return 'GENERAL';
}

export function ruleDisplayName(rule = {}) {
  return rule.title || rule.text || rule.name || rule.label || String(rule.type || 'Rule');
}

export function ruleWhy(rule = {}) {
  return rule.text || rule.description || rule.title || rule.name || '';
}

function templateLimitLabel(rule) {
  const v = rule.validation || {};
  const value = v.value ?? rule.value;
  if (value === null || value === undefined) return '';
  const op = v.operator || rule.operator || '';
  if (rule.type === 'RR_LIMIT') return `RR ${op} ${value}`;
  if (rule.type === 'PERCENTAGE_LIMIT') return `Risk ${op} ${value}%`;
  if (rule.type === 'COUNT_LIMIT') return `${op} ${value}`;
  return `${op} ${value}`;
}

function dupKey(rule) {
  const name = String(ruleDisplayName(rule)).trim().toLowerCase();
  return `${name}|${inferCategory(rule)}|${String(rule.type || '').trim().toUpperCase()}`;
}

// ---- Gallery HTML (pure, no DOM writes) ----

export function renderTemplateGallery() {
  let all;
  try {
    all = getTemplates();
  } catch {
    return `<div class="empty-state"><h3>Templates unavailable</h3></div>`;
  }
  const cards = TEMPLATE_META.map((meta) => {
    const rules = Array.isArray(all[meta.key]) ? all[meta.key] : [];
    const items = rules
      .map((r) => {
        const limit = templateLimitLabel(r);
        return `<li style="margin-bottom:6px;font-size:var(--font-size-sm);color:var(--text-secondary);">
          <span style="color:var(--text-primary);">${escapeHtml(ruleDisplayName(r))}</span>
          ${limit ? `<span class="badge badge-gold" style="margin-left:6px;">${escapeHtml(limit)}</span>` : ''}
          <span style="color:var(--text-muted);font-size:var(--font-size-xs);"> · ${escapeHtml(r.type || '')}</span>
        </li>`;
      })
      .join('');
    return `<div class="card" data-template="${escapeHtml(meta.key)}">
      <div style="font-size:28px;margin-bottom:8px;">${meta.icon}</div>
      <h3 style="margin-bottom:4px;">${escapeHtml(meta.name)}</h3>
      <p style="color:var(--text-secondary);font-size:var(--font-size-sm);margin-bottom:12px;">${escapeHtml(meta.blurb)}</p>
      <ul style="list-style:none;padding:0;margin:0 0 16px;">${items}</ul>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm tpl-preview-btn" data-template="${escapeHtml(meta.key)}">👁 Preview</button>
        <button class="btn btn-primary btn-sm tpl-install-btn" data-template="${escapeHtml(meta.key)}">＋ Install</button>
      </div>
    </div>`;
  }).join('');
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:var(--space-lg);">${cards}</div>`;
}

// ---- Preview modal with per-row customize ----

function previewRowHtml(rule, idx) {
  const name = ruleDisplayName(rule);
  const why = ruleWhy(rule);
  const limit = templateLimitLabel(rule);
  const sessions = Array.isArray(rule.applicableSessions) && rule.applicableSessions.length
    ? rule.applicableSessions.join(', ')
    : '';
  return `<div class="tpl-row" data-idx="${idx}" style="border:1px solid var(--border-color);border-radius:var(--radius-md);padding:10px 12px;margin-bottom:8px;">
    <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;">
      <input type="checkbox" class="tpl-include" data-idx="${idx}" checked style="width:auto;margin-top:4px;accent-color:var(--accent-gold);">
      <span style="flex:1;">
        <span style="font-weight:600;">${escapeHtml(name)}</span>
        ${limit ? `<span class="badge badge-gold" style="margin-left:6px;">${escapeHtml(limit)}</span>` : ''}
        <br><span style="font-size:var(--font-size-xs);color:var(--text-secondary);">${escapeHtml(why)}</span>
        ${sessions ? `<br><span style="font-size:var(--font-size-xs);color:var(--text-muted);">Sessions: ${escapeHtml(sessions)}</span>` : ''}
        <span style="font-size:var(--font-size-xs);color:var(--text-muted);"> · ${escapeHtml(rule.type || '')} · ${escapeHtml(inferCategory(rule))}</span>
      </span>
    </label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
      <div>
        <label class="form-label" style="margin-bottom:2px;">Weight</label>
        <input type="number" class="tpl-weight" data-idx="${idx}" value="1" min="0" step="0.5">
      </div>
      <label style="display:flex;gap:6px;align-items:center;font-size:var(--font-size-sm);color:var(--text-secondary);">
        <input type="checkbox" class="tpl-required" data-idx="${idx}" style="width:auto;accent-color:var(--color-sl);"> Required (blocks trade)
      </label>
    </div>
  </div>`;
}

function openPreviewModal(templateKey, user, onInstalled) {
  let rules;
  try {
    rules = getTemplates(templateKey);
  } catch {
    showToast('Unknown template', 'error');
    return;
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    showToast('Template is empty', 'error');
    return;
  }
  const meta = TEMPLATE_META.find((m) => m.key === templateKey);
  showModal(`
    <div class="modal-header">
      <h3 class="modal-title">${escapeHtml(meta ? meta.icon + ' ' + meta.name : templateKey)} — Customize</h3>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <p style="color:var(--text-secondary);font-size:var(--font-size-sm);margin-bottom:12px;">
      Uncheck to exclude a rule. Adjust weight / required per row, then Add.
      Existing rules are never overwritten.
    </p>
    <div id="tpl-preview-list" style="max-height:50vh;overflow-y:auto;">
      ${rules.map((r, i) => previewRowHtml(r, i)).join('')}
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" id="tpl-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="tpl-add">Add selected</button>
    </div>
  `);
  setTimeout(() => {
    document.getElementById('modal-close-btn')?.addEventListener('click', hideModal);
    document.getElementById('tpl-cancel')?.addEventListener('click', hideModal);
    document.getElementById('tpl-add')?.addEventListener('click', () => {
      const selected = [];
      rules.forEach((r, i) => {
        const inc = document.querySelector(`.tpl-include[data-idx="${i}"]`);
        if (!inc || !inc.checked) return;
        const wEl = document.querySelector(`.tpl-weight[data-idx="${i}"]`);
        const rEl = document.querySelector(`.tpl-required[data-idx="${i}"]`);
        let weight = parseFloat(wEl?.value);
        if (!Number.isFinite(weight) || weight < 0) weight = 1;
        selected.push({ ...r, weight, required: rEl?.checked === true });
      });
      const result = installRules(user, selected);
      hideModal();
      showToast(
        result.installed > 0
          ? `Installed ${result.installed} rule${result.installed === 1 ? '' : 's'}${result.skipped > 0 ? `, skipped ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'}` : ''}`
          : result.skipped > 0
            ? `Skipped ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} — nothing new to install`
            : 'Nothing selected',
        result.installed > 0 ? 'success' : 'info',
      );
      if (typeof onInstalled === 'function') onInstalled(result);
    });
  }, 50);
}

// ---- Install (additive only) ----

/**
 * Add selected template rules to the user's store.
 * Never overwrites/deletes: existing rules are only read for dupe detection.
 * Duplicate = same name + category + type (case-insensitive name).
 * Returns { installed, skipped }.
 */
export function installRules(user, selectedRules) {
  const selected = Array.isArray(selectedRules) ? selectedRules : [];
  if (selected.length === 0) return { installed: 0, skipped: 0 };
  const existing = new Set(getRules(user).map(dupKey));
  let installed = 0;
  let skipped = 0;
  for (const r of selected) {
    if (!r || typeof r !== 'object') { skipped += 1; continue; }
    const candidate = {
      ...r,
      category: inferCategory(r),
      title: ruleDisplayName(r),
      text: ruleWhy(r) || ruleDisplayName(r),
    };
    if (existing.has(dupKey(candidate))) { skipped += 1; continue; }
    try {
      saveRule(user, candidate);
      existing.add(dupKey(candidate));
      installed += 1;
    } catch {
      skipped += 1;
    }
  }
  return { installed, skipped };
}

// ---- Wiring ----

export function bindTemplateGallery(user, onChanged) {
  const after = (result) => {
    if (typeof onChanged === 'function') onChanged(result);
  };
  document.querySelectorAll('.tpl-preview-btn').forEach((btn) => {
    btn.addEventListener('click', () => openPreviewModal(btn.dataset.template, user, after));
  });
  document.querySelectorAll('.tpl-install-btn').forEach((btn) => {
    btn.addEventListener('click', () => openPreviewModal(btn.dataset.template, user, after));
  });
}
