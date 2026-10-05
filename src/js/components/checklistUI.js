// ============================================
// Checklist UI — pre-trade rule rows grouped by category (presentational)
// Vanilla ESM, no storage, no network, no business logic.
// Props in: grouped rules + per-rule check entries + optional why text.
// trade.js owns evaluation (ruleManager/decisionEngine) and persistence.
// ============================================

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

const MANUAL_TYPES = new Set(['CHECKBOX', 'BOOLEAN']);

function ruleIdOf(rule, idx) {
  if (rule && typeof rule === 'object') {
    const id = rule.id ?? rule.ruleId ?? rule.key;
    if (id !== undefined && id !== null && String(id) !== '') return String(id);
  }
  return `rule-${idx}`;
}

function ruleNameOf(rule) {
  if (!rule || typeof rule !== 'object') return 'Unnamed rule';
  const v = rule.name ?? rule.title ?? rule.text ?? rule.label ?? rule.id;
  const s = String(v ?? '').trim();
  return s || 'Unnamed rule';
}

function categoryOf(rule) {
  const c = rule && typeof rule === 'object' ? rule.category : '';
  const s = String(c ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return s || 'GENERAL';
}

function weightOf(rule) {
  const n = Number(rule && typeof rule === 'object' ? rule.weight : 1);
  if (!Number.isFinite(n) || n < 0) return 1;
  return n;
}

function isManual(rule) {
  const t = String((rule && rule.type) || '').trim().toUpperCase();
  if (MANUAL_TYPES.has(t)) return true;
  // Rules without a type behave as manual confirmations.
  if (!t) return true;
  return false;
}

function getCheck(checks, id) {
  if (!checks || typeof checks !== 'object') return undefined;
  if (typeof checks.get === 'function') {
    try {
      return checks.get(id);
    } catch {
      return undefined;
    }
  }
  if (Object.prototype.hasOwnProperty.call(checks, id)) return checks[id];
  return undefined;
}

function normalizeCheck(raw) {
  if (typeof raw === 'boolean') return { pass: raw, missing: false, reason: '', source: '' };
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {
    pass: typeof raw.pass === 'boolean' ? raw.pass : (typeof raw.checked === 'boolean' ? raw.checked : undefined),
    missing: raw.missing === true,
    reason: raw.reason !== undefined && raw.reason !== null ? String(raw.reason) : '',
    source: raw.source !== undefined && raw.source !== null ? String(raw.source) : '',
  };
  return out;
}

function statusOf(check) {
  if (!check || check.pass === undefined) return 'open'; // ○
  if (check.missing === true) return 'missing'; // !
  return check.pass === true ? 'pass' : 'fail'; // ✓ / ×
}

const STATUS_META = {
  pass: { icon: '✓', badge: 'badge-tp', label: 'PASS' },
  fail: { icon: '×', badge: 'badge-sl', label: 'FAIL' },
  missing: { icon: '!', badge: 'badge-gold', label: 'MISSING' },
  open: { icon: '○', badge: 'badge-gold', label: 'OPEN' },
};

function groupRules({ groupedRules, rules }) {
  if (groupedRules && typeof groupedRules === 'object' && !Array.isArray(groupedRules)) {
    const out = {};
    for (const [cat, list] of Object.entries(groupedRules)) {
      const key = String(cat || 'GENERAL').trim().toUpperCase().replace(/[\s-]+/g, '_') || 'GENERAL';
      out[key] = toArray(list);
    }
    return out;
  }
  const flat = toArray(rules);
  // Also accept { groupedRules: [{rule, category}] }? No — keep flat grouping.
  const out = {};
  flat.forEach((r) => {
    const key = categoryOf(r);
    if (!out[key]) out[key] = [];
    out[key].push(r);
  });
  return out;
}

function whyOf(rule, check) {
  const fromRule = rule && typeof rule === 'object'
    ? (rule.description ?? rule.text ?? rule.why ?? '')
    : '';
  if (fromRule && String(fromRule).trim()) return String(fromRule);
  if (check && check.reason) return check.reason;
  return '';
}

function rowHtml(rule, idx, check) {
  const id = ruleIdOf(rule, idx);
  const name = ruleNameOf(rule);
  const cat = categoryOf(rule);
  const weight = weightOf(rule);
  const required = rule && rule.required === true;
  const manual = isManual(rule);
  const st = statusOf(check);
  const meta = STATUS_META[st];
  const reason = check && check.reason ? check.reason : '';
  const source = check && check.source ? check.source : (rule && rule.source ? String(rule.source) : '');
  const why = whyOf(rule, check);
  const inputId = `chk-${escapeHtml(id)}`;
  const checked = check && check.pass === true;
  // Manual rows: interactive checkbox. Auto rows: read-only status, checkbox
  // disabled so keyboard/tab order skips it but the reason stays visible.
  const checkbox = manual
    ? `<input type="checkbox" id="${inputId}" data-rule-id="${escapeHtml(id)}" data-action="toggle" ${checked ? 'checked' : ''}
        style="width:22px;height:22px;min-width:22px;accent-color:var(--accent-gold);margin:0;flex:none;"
        aria-label="${escapeHtml(`Confirm: ${name}`)}">`
    : `<input type="checkbox" id="${inputId}" data-rule-id="${escapeHtml(id)}" data-action="toggle" data-auto="1" disabled ${checked ? 'checked' : ''}
        tabindex="-1" aria-hidden="true"
        style="width:22px;height:22px;min-width:22px;accent-color:var(--accent-gold);margin:0;flex:none;opacity:0.45;">`;

  return `
    <div class="checklist-row" data-rule-row="${escapeHtml(id)}" data-status="${escapeHtml(st)}"
      style="display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border-color);border-radius:var(--radius-md);padding:10px 12px;margin-bottom:8px;min-height:40px;">
      <label for="${inputId}" style="display:flex;align-items:center;min-width:40px;min-height:40px;justify-content:center;cursor:${manual ? 'pointer' : 'default'};margin:-10px 0 -10px -12px;padding:10px 6px 10px 12px;">
        ${checkbox}
      </label>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span aria-hidden="true" style="font-weight:700;">${escapeHtml(meta.icon)}</span>
          <span style="font-weight:600;flex:1;min-width:140px;">${escapeHtml(name)}</span>
          <span class="badge ${meta.badge}">${escapeHtml(meta.icon)} ${escapeHtml(meta.label)}</span>
          <span class="badge badge-gold" title="Category">${escapeHtml(cat)}</span>
          <span style="font-size:var(--font-size-xs);color:var(--text-muted);" title="Weight">W ${escapeHtml(String(weight))}</span>
          ${required ? `<span class="badge badge-sl">REQUIRED</span>` : ''}
        </div>
        ${reason ? `<div style="font-size:var(--font-size-xs);color:var(--text-secondary);margin-top:6px;">Current vs limit: ${escapeHtml(reason)}</div>` : ''}
        <div style="font-size:var(--font-size-xs);color:var(--text-muted);margin-top:2px;">Source: ${escapeHtml(source || 'My Trading Rules')}</div>
        ${why && why !== reason ? `<details style="font-size:var(--font-size-xs);color:var(--text-secondary);margin-top:4px;">
          <summary style="cursor:pointer;min-height:40px;display:inline-flex;align-items:center;">Why this rule</summary>
          <div style="margin-top:2px;">${escapeHtml(why)}</div>
        </details>` : ''}
      </div>
    </div>`;
}

/**
 * Render the checklist grouped by category. Returns an HTML string.
 * @param {Object} input
 * @param {Record<string, Array>} [input.groupedRules] category -> rules
 * @param {Array} [input.rules] flat rule list (grouped internally when groupedRules absent)
 * @param {Map|Record} [input.checks] ruleId -> {pass,missing,reason,source} | boolean
 * @param {Object} [input.results] optional decisionEngine output (used only for display fallback)
 * @returns {string}
 */
export function renderChecklist({ groupedRules, rules, checks, results } = {}) {
  const groups = groupRules({ groupedRules, rules });
  const cats = Object.keys(groups).sort();
  if (cats.length === 0) {
    return `<div class="card" id="checklist-root"><p style="color:var(--text-muted);font-size:var(--font-size-sm);margin:0;">○ No applicable rules — nothing to confirm.</p></div>`;
  }
  // Build a verdict fallback from decisionEngine output when a rule has no
  // direct check entry (display only — no evaluation here).
  const fallbackById = {};
  if (results && typeof results === 'object') {
    const buckets = [
      ...(toArray(results.passedRules ?? results.passed).map((e) => ({ e, pass: true }))),
      ...(toArray(results.failedRules ?? results.failed).map((e) => ({ e, pass: false }))),
      ...(toArray(results.missingRules ?? results.missing).map((e) => ({ e, pass: undefined, missing: true }))),
    ];
    for (const { e, pass, missing } of buckets) {
      const key = e && (e.id ?? e.ruleId ?? e.key);
      if (key === undefined || key === null) continue;
      fallbackById[String(key)] = { pass, missing: missing === true, reason: e.reason ? String(e.reason) : '', source: e.source ? String(e.source) : '' };
    }
  }

  let globalIdx = 0;
  const sections = cats.map((cat) => {
    const list = toArray(groups[cat]);
    const rows = list.map((rule) => {
      const idx = globalIdx++;
      const id = ruleIdOf(rule, idx);
      const raw = getCheck(checks, id);
      let check = normalizeCheck(raw);
      if (!check && fallbackById[id] !== undefined) check = fallbackById[id];
      return rowHtml(rule, idx, check);
    }).join('');
    return `
      <section aria-label="Checklist group ${escapeHtml(cat)}" style="margin-bottom:16px;">
        <h4 style="font-size:var(--font-size-sm);color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px;">
          ${escapeHtml(cat)} <span style="color:var(--text-muted);">(${escapeHtml(String(list.length))})</span>
        </h4>
        ${rows}
      </section>`;
  }).join('');

  return `<div class="card" id="checklist-root">${sections}</div>`;
}

/**
 * Delegate checkbox toggles. One listener on #checklist-root (falls back to
 * document). Returns a cleanup function.
 * @param {(ruleId: string, checked: boolean, event: Event) => void} onToggle
 * @returns {Function} cleanup
 */
export function bindChecklist(onToggle) {
  if (typeof onToggle !== 'function') return () => {};
  const root = document.getElementById('checklist-root') || document;
  const listener = (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'INPUT' || t.type !== 'checkbox') return;
    if (!t.matches('[data-action="toggle"]')) return;
    if (t.disabled) return;
    const ruleId = t.getAttribute('data-rule-id') || t.id || '';
    try {
      onToggle(ruleId, t.checked === true, e);
    } catch (err) {
      console.error('checklist onToggle failed:', err);
    }
  };
  root.addEventListener('change', listener);
  return () => {
    try {
      root.removeEventListener('change', listener);
    } catch { /* noop */ }
  };
}

if (typeof window !== 'undefined') {
  window.TradeLogComponents = {
    ...(window.TradeLogComponents || {}),
    renderChecklist,
    bindChecklist,
  };
}
