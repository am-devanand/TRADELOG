// ============================================
// Checklist Preview — pre-trade checklist demo driven by user rules.
// Vanilla ESM, no side effects on import.
// Demo context form drives live score recalculation via decisionEngine.
// Phase 3 (New Trade Analysis) will reuse this preview logic.
// ============================================
import { getApplicableRules, evaluateRule } from '../utils/ruleManager.js';
import { evaluateChecklist } from '../utils/decisionEngine.js';
import { escapeHtml } from '../utils/helpers.js';
import { inferCategory, ruleDisplayName, ruleWhy } from './templateGallery.js';

const SESSIONS = ['', 'London', 'New York', 'Asia', 'Overlap'];

const MANUAL_TYPES = new Set(['CHECKBOX', 'BOOLEAN']);

function toNumberOrUndefined(v) {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function ruleLimitValue(rule) {
  const v = rule.validation || {};
  const raw = v.value ?? rule.value ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toDecisionRule(rule) {
  const w = Number(rule.weight);
  return {
    id: rule.id,
    name: ruleDisplayName(rule),
    category: inferCategory(rule),
    weight: rule.weight === undefined || rule.weight === null || rule.weight === '' || !Number.isFinite(w) || w < 0 ? 1 : w,
    required: rule.required === true,
    enabled: rule.enabled !== false,
  };
}

// ---- Static shell: demo form + empty results (pure, no DOM writes) ----

export function renderChecklistPreview() {
  return `
    <div class="card" style="margin-bottom:var(--space-lg);">
      <h3 style="margin-bottom:4px;">Demo trade context</h3>
      <p style="color:var(--text-secondary);font-size:var(--font-size-sm);margin-bottom:12px;">
        These demo inputs drive the live preview below. Nothing is executed — preview only.
      </p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-md);">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label" for="cp-risk">Risk %</label>
          <input type="number" id="cp-risk" value="1" min="0" step="0.1">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label" for="cp-rr">Reward : Risk</label>
          <input type="number" id="cp-rr" value="2" min="0" step="0.1">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label" for="cp-session">Session</label>
          <select id="cp-session">
            ${SESSIONS.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s === '' ? '— Any —' : s)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label" for="cp-trades">Trades today</label>
          <input type="number" id="cp-trades" value="0" min="0" step="1">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label" for="cp-losses">Consec. losses</label>
          <input type="number" id="cp-losses" value="0" min="0" step="1">
        </div>
      </div>
    </div>
    <div id="cp-result"></div>
  `;
}

// ---- Live computation ----

function readDemoContext(root) {
  const q = (sel) => root.querySelector(sel);
  return {
    riskPercent: toNumberOrUndefined(q('#cp-risk')?.value),
    rr: toNumberOrUndefined(q('#cp-rr')?.value),
    session: q('#cp-session')?.value || '',
    tradesToday: toNumberOrUndefined(q('#cp-trades')?.value),
    consecutiveLosses: toNumberOrUndefined(q('#cp-losses')?.value),
  };
}

function stateBadge(state) {
  if (state === 'READY') return `<span class="badge badge-tp">READY</span>`;
  if (state === 'WAITING') return `<span class="badge badge-gold">WAITING</span>`;
  return `<span class="badge badge-sl">NO_TRADE</span>`;
}

function verdictBadge(pass) {
  return pass
    ? `<span class="badge badge-tp">PASS</span>`
    : `<span class="badge badge-sl">FAIL</span>`;
}

function itemHtml(entry, pass, opts = {}) {
  const req = entry.required
    ? `<span class="badge badge-sl" style="margin-left:6px;">REQUIRED</span>`
    : '';
  const missing = opts.missing
    ? `<span class="badge badge-gold" style="margin-left:6px;">MISSING</span>`
    : '';
  return `<div style="border:1px solid var(--border-color);border-radius:var(--radius-md);padding:10px 12px;margin-bottom:8px;">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      ${opts.toggle || ''}
      <span style="font-weight:600;flex:1;min-width:140px;">${escapeHtml(entry.name)}</span>
      ${verdictBadge(pass)}${req}${missing}
      <span style="font-size:var(--font-size-xs);color:var(--text-muted);">w ${escapeHtml(String(entry.weight))}</span>
    </div>
    <div style="font-size:var(--font-size-xs);color:var(--text-secondary);margin-top:6px;">
      Why: ${escapeHtml(entry.reason || '—')}
    </div>
    <div style="font-size:var(--font-size-xs);color:var(--text-muted);margin-top:2px;">
      Source: ${escapeHtml(entry.source || 'My Trading Rules')}
    </div>
  </div>`;
}

export function computePreview(user, demoCtx, manualChecks) {
  const applicable = getApplicableRules(user, { session: demoCtx.session || undefined });
  const checks = {};
  const evaluated = [];

  for (const rule of applicable) {
    const type = String(rule.type || '').trim().toUpperCase();
    let res;
    if (MANUAL_TYPES.has(type)) {
      res = evaluateRule(rule, { ...demoCtx, checked: manualChecks.get(rule.id) === true });
    } else {
      res = evaluateRule(rule, demoCtx);
    }
    checks[rule.id] = { pass: res.pass === true, reason: res.reason || '', source: res.source || 'My Trading Rules' };
    evaluated.push(rule);
  }

  const decisionRules = evaluated.map(toDecisionRule);
  const result = evaluateChecklist({ rules: decisionRules, checks });

  // Strictest-wins: max RR threshold among applicable RR_LIMIT rules.
  const rrRules = evaluated.filter((r) => String(r.type || '').trim().toUpperCase() === 'RR_LIMIT');
  let strictest = null;
  if (rrRules.length >= 2) {
    let best = null;
    for (const r of rrRules) {
      const v = ruleLimitValue(r);
      if (v === null) continue;
      if (!best || v > best.value) best = { value: v, name: ruleDisplayName(r) };
    }
    if (best) strictest = { ...best, count: rrRules.length };
  }

  return { applicable: evaluated, decisionRules, result, strictest };
}

export function renderPreviewResult(preview, manualChecks) {
  const { applicable, decisionRules, result, strictest } = preview;
  if (!applicable.length) {
    return `<div class="empty-state">
      <h3>No applicable rules</h3>
      <p>Install a template above or enable rules to preview the checklist.</p>
    </div>`;
  }
  const byId = new Map(decisionRules.map((r) => [r.id, r]));
  const entryById = new Map();
  for (const e of [...result.passedRules, ...result.failedRules, ...result.missingRules]) {
    entryById.set(e.id, e);
  }
  // Group applicable rules by category, preserving first-seen order.
  const groups = new Map();
  for (const rule of applicable) {
    const cat = inferCategory(rule);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(rule);
  }
  const failedIds = new Set(result.failedRules.map((r) => r.id));
  const missingIds = new Set(result.missingRules.map((r) => r.id));

  const groupsHtml = [...groups.entries()]
    .map(([cat, rules]) => {
      const items = rules.map((rule) => {
        const dec = byId.get(rule.id) || toDecisionRule(rule);
        const entry = entryById.get(rule.id) || { ...dec, reason: '', source: 'My Trading Rules' };
        const type = String(rule.type || '').trim().toUpperCase();
        const isManual = MANUAL_TYPES.has(type);
        const checked = manualChecks.get(rule.id) === true;
        const toggle = isManual
          ? `<input type="checkbox" class="cp-manual" data-id="${escapeHtml(String(rule.id))}" ${checked ? 'checked' : ''} title="Manual confirm" style="width:auto;accent-color:var(--accent-gold);">`
          : `<span title="Auto evaluated" style="font-size:var(--font-size-xs);color:var(--text-muted);">🤖 auto</span>`;
        if (missingIds.has(rule.id)) return itemHtml(entry, false, { toggle, missing: true });
        return itemHtml(entry, !failedIds.has(rule.id), { toggle });
      }).join('');
      return `<div style="margin-bottom:16px;">
        <h4 style="font-size:var(--font-size-sm);text-transform:uppercase;letter-spacing:0.5px;color:var(--text-secondary);margin-bottom:8px;">${escapeHtml(cat)}</h4>
        ${items}
      </div>`;
    })
    .join('');

  const missingHtml = result.missingRules.length
    ? `<div class="card" style="margin-top:12px;border-color:var(--accent-gold);">
        <h4 style="margin-bottom:8px;">⚠ Missing (${result.missingRules.length})</h4>
        ${result.missingRules.map((m) => `<div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-bottom:4px;">${escapeHtml(m.name)} — ${escapeHtml(m.reason)} <span style="color:var(--text-muted);">(Source: ${escapeHtml(m.source || 'My Trading Rules')})</span></div>`).join('')}
      </div>`
    : '';

  const blockersHtml = result.blockers.length
    ? `<div class="card" style="margin-top:12px;border-color:var(--color-sl-border);">
        <h4 style="margin-bottom:8px;color:var(--color-sl);">⛔ Blockers — required rule${result.blockers.length === 1 ? '' : 's'} failed, trade blocked</h4>
        ${result.blockers.map((b) => `<div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-bottom:4px;">${escapeHtml(b.name)} — ${escapeHtml(b.reason)}</div>`).join('')}
      </div>`
    : '';

  const strictestHtml = strictest
    ? `<div style="margin-top:8px;font-size:var(--font-size-sm);color:var(--text-secondary);">⚖️ Effective requirement: RR ≥ ${escapeHtml(String(strictest.value))} — strictest of ${strictest.count} RR rules (won by “${escapeHtml(strictest.name)}”).</div>`
    : '';

  const pct = Math.max(0, Math.min(100, result.score));
  const barColor = result.state === 'READY' ? 'var(--color-tp)' : result.state === 'WAITING' ? 'var(--accent-gold)' : 'var(--color-sl)';
  return `
    <div class="card" style="margin-bottom:var(--space-lg);">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
        <span style="font-size:var(--font-size-2xl);font-weight:700;">${escapeHtml(String(result.score))}%</span>
        ${stateBadge(result.state)}
        <span style="font-size:var(--font-size-xs);color:var(--text-muted);">
          ${result.passedRules.length} passed · ${result.failedRules.length} failed · ${result.missingRules.length} missing · ${applicable.length} applicable
        </span>
      </div>
      <div style="height:10px;border-radius:999px;background:var(--bg-input);overflow:hidden;margin-bottom:4px;">
        <div style="height:100%;width:${pct}%;background:${barColor};transition:width 0.2s ease;"></div>
      </div>
      <div style="font-size:var(--font-size-xs);color:var(--text-muted);">Score = passed weight ÷ total applicable weight × 100 · READY ≥ 80 · WAITING ≥ 60 · required fail forces NO_TRADE</div>
      ${strictestHtml}
    </div>
    ${groupsHtml}
    ${blockersHtml}
    ${missingHtml}
  `;
}

// ---- Wiring: live recalculation on every toggle/input ----

// Module-level so manual ☑ state survives page re-renders (e.g. after install).
const previewManual = new Map();
let latestRecalc = null;

export function refreshChecklistPreview() {
  if (typeof latestRecalc === 'function') latestRecalc();
}

export function bindChecklistPreview(user) {
  const root = document.getElementById('checklist-preview-body');
  const out = document.getElementById('cp-result');
  if (!root || !out) return;
  const manualChecks = previewManual;

  const recalc = () => {
    const ctx = readDemoContext(root);
    // Session scoping can hide rules; drop manual state for rules no longer applicable.
    const preview = computePreview(user, ctx, manualChecks);
    const ids = new Set(preview.applicable.map((r) => r.id));
    for (const k of [...manualChecks.keys()]) {
      if (!ids.has(k)) manualChecks.delete(k);
    }
    out.innerHTML = renderPreviewResult(preview, manualChecks);
  };

  root.addEventListener('input', (e) => {
    if (e.target && e.target.id && e.target.id.startsWith('cp-')) recalc();
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id && t.id.startsWith('cp-')) { recalc(); return; }
    if (t.classList && t.classList.contains('cp-manual')) {
      manualChecks.set(t.dataset.id, t.checked === true);
      recalc();
    }
  });

  recalc();

  latestRecalc = recalc;
}
