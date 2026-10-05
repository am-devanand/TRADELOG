// ============================================
// Trading Lock — user-controlled trading lock (presentational + thin binding)
// Vanilla ESM, no side effects on import.
// Owns its own small localStorage helpers on key tradelog_lock_{clean}.
// Semantics: the lock blocks NEW EXECUTION only — open-trade management
// and closing remain available. Pages consult canExecute(user) before
// executing; this module never blocks anything by itself.
// ============================================

import { escapeHtml } from '../utils/helpers.js';

export const LOCK_REASONS = ['DAILY_LIMIT', 'MAX_DRAWDOWN', 'USER_LOCK', 'CUSTOM'];

const KEY_PREFIX = 'tradelog_lock_';

const REASON_LABELS = {
  DAILY_LIMIT: 'Daily limit reached',
  MAX_DRAWDOWN: 'Max drawdown hit',
  USER_LOCK: 'Locked by me',
  CUSTOM: 'Custom reason',
};

function cleanUser(user) {
  const raw = typeof user === 'string' ? user : (user?.id ?? user?.userId ?? user?.email ?? '');
  const s = String(raw ?? '').trim().toLowerCase();
  const cleaned = s.replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'anon';
}

function keyFor(user) {
  return `${KEY_PREFIX}${cleanUser(user)}`;
}

function defaultState() {
  return { enabled: false, reason: '', customReason: '', expiresAt: '', createdAt: '' };
}

function normalizeReason(reason) {
  const r = String(reason ?? '').trim().toUpperCase();
  return LOCK_REASONS.includes(r) ? r : '';
}

function normalizeRecord(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    enabled: raw.enabled === true,
    reason: normalizeReason(raw.reason),
    customReason: String(raw.customReason ?? ''),
    expiresAt: String(raw.expiresAt ?? ''),
    createdAt: String(raw.createdAt ?? ''),
  };
}

function isExpiredRecord(record) {
  if (!record || record.enabled !== true) return false;
  if (!record.expiresAt) return false;
  const t = new Date(record.expiresAt).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

function readStored(user) {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(keyFor(user));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Current lock state for a user. An EXPIRED lock (expiresAt in the past)
 * auto-resolves to unlocked (and the stale record is cleared).
 */
export function getLockState(user) {
  const record = normalizeRecord(readStored(user));
  if (isExpiredRecord(record)) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(keyFor(user));
    } catch {
      /* storage unavailable — still report unlocked */
    }
    return defaultState();
  }
  return record;
}

/**
 * Persist a lock record for a user. Returns the stored record.
 */
export function setLock(user, { enabled, reason, expiresAt, customReason } = {}) {
  const record = {
    enabled: enabled === true,
    reason: normalizeReason(reason),
    customReason: String(customReason ?? ''),
    expiresAt: String(expiresAt ?? ''),
    createdAt: '',
  };
  const prev = normalizeRecord(readStored(user));
  record.createdAt = record.enabled
    ? (prev.enabled ? (prev.createdAt || new Date().toISOString()) : new Date().toISOString())
    : '';
  if (!record.enabled) {
    record.reason = '';
    record.customReason = '';
    record.expiresAt = '';
  }
  try {
    if (typeof localStorage !== 'undefined') {
      if (!record.enabled && !prev.enabled && !readStored(user)) {
        localStorage.removeItem(keyFor(user));
      } else if (!record.enabled) {
        localStorage.removeItem(keyFor(user));
      } else {
        localStorage.setItem(keyFor(user), JSON.stringify(record));
      }
    }
  } catch {
    /* storage unavailable — return record anyway */
  }
  return record.enabled ? { ...record } : defaultState();
}

/** Boolean convenience over getLockState (expiry-aware). */
export function isLocked(user) {
  return getLockState(user).enabled === true;
}

/**
 * Execution gate for pages: lock blocks NEW EXECUTION only.
 * Open-trade management and closing remain available.
 * @returns {{allowed:boolean, reason:string}} reason is the lock reason code when blocked, '' when allowed.
 */
export function canExecute(user) {
  const state = getLockState(user);
  if (state.enabled === true) {
    return { allowed: false, reason: state.reason || 'USER_LOCK' };
  }
  return { allowed: true, reason: '' };
}

function toInputDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateTime(iso) {
  if (!iso) return 'No expiry — stays on until you unlock';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No expiry — stays on until you unlock';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Render the trading-lock card. Returns an HTML string (no DOM writes).
 * @param {Object} [state] lock record {enabled, reason, customReason, expiresAt, createdAt}
 */
export function renderTradingLock(state = {}) {
  const s = normalizeRecord(state && typeof state === 'object' ? state : {});
  const locked = s.enabled === true && !isExpiredRecord(s);
  const badge = locked
    ? `<span class="badge badge-sl">🔒 LOCKED — NEW TRADES BLOCKED</span>`
    : `<span class="badge badge-tp">🔓 UNLOCKED</span>`;
  const reasonLabel = s.reason ? (REASON_LABELS[s.reason] || s.reason) : '—';
  const options = LOCK_REASONS.map((r) => {
    const sel = s.reason === r ? ' selected' : '';
    return `<option value="${escapeHtml(r)}"${sel}>${escapeHtml(REASON_LABELS[r] || r)}</option>`;
  }).join('');
  const showCustom = s.reason === 'CUSTOM' ? '' : ' hidden';

  return `
    <section class="card p8-lock" data-locked="${locked ? 'true' : 'false'}" aria-live="polite" aria-label="Trading lock: ${locked ? 'locked' : 'unlocked'}">
      <div class="p8-lock-head">
        <h3 class="p8-title">Trading lock</h3>
        ${badge}
      </div>
      <p class="p8-sub">
        Lock blocks <strong>new executions only</strong> — managing open trades
        and closing positions remain available.
      </p>
      ${locked ? `
      <dl class="p8-kv">
        <div><dt>Reason</dt><dd>${escapeHtml(reasonLabel)}${s.reason === 'CUSTOM' && s.customReason ? ` — ${escapeHtml(s.customReason)}` : ''}</dd></div>
        <div><dt>Expires</dt><dd>${escapeHtml(fmtDateTime(s.expiresAt))}</dd></div>
      </dl>` : `
      <p class="p8-muted">No lock is active. New executions are allowed.</p>`}
      <form id="p8-lock-form" class="p8-form" novalidate>
        <div class="form-group p8-checkrow">
          <input type="checkbox" id="p8-lock-enabled" ${locked ? 'checked' : ''}>
          <label class="form-label" for="p8-lock-enabled">Lock new executions</label>
        </div>
        <div class="form-group">
          <label class="form-label" for="p8-lock-reason">Reason</label>
          <select id="p8-lock-reason">
            <option value="">— Select a reason —</option>
            ${options}
          </select>
        </div>
        <div class="form-group" id="p8-lock-custom-wrap"${showCustom}>
          <label class="form-label" for="p8-lock-custom">Custom reason</label>
          <input type="text" id="p8-lock-custom" maxlength="140" placeholder="e.g. Taking the rest of the day off"
            value="${escapeHtml(s.customReason)}">
        </div>
        <div class="form-group">
          <label class="form-label" for="p8-lock-expires">Expires at (optional)</label>
          <input type="datetime-local" id="p8-lock-expires" value="${escapeHtml(toInputDateTime(s.expiresAt))}">
          <p class="p8-hint">Leave empty for no expiry. A past expiry unlocks immediately.</p>
        </div>
        <div class="p8-actions">
          <button type="submit" class="btn btn-primary" id="p8-lock-save">Save lock</button>
          <button type="button" class="btn btn-secondary" id="p8-lock-unlock" ${locked ? '' : 'disabled'}>Unlock</button>
        </div>
      </form>
    </section>`;
}

/**
 * Wire the trading-lock form. Safe to call after innerHTML insert; no-ops when absent.
 * Collects a draft {enabled, reason, customReason, expiresAt} and passes it to onChange —
 * the page owns persistence via setLock().
 * @param {{onChange?:Function}} handlers
 * @returns {Function} cleanup
 */
export function bindTradingLock({ onChange } = {}) {
  const cleanups = [];
  const on = (el, evt, fn) => {
    if (!el) return;
    el.addEventListener(evt, fn);
    cleanups.push(() => el.removeEventListener(evt, fn));
  };
  const form = document.getElementById('p8-lock-form');
  if (!form) return () => {};
  const enabledEl = document.getElementById('p8-lock-enabled');
  const reasonEl = document.getElementById('p8-lock-reason');
  const customEl = document.getElementById('p8-lock-custom');
  const customWrap = document.getElementById('p8-lock-custom-wrap');
  const expiresEl = document.getElementById('p8-lock-expires');
  const unlockBtn = document.getElementById('p8-lock-unlock');

  const collect = () => ({
    enabled: enabledEl ? enabledEl.checked === true : false,
    reason: reasonEl ? normalizeReason(reasonEl.value) : '',
    customReason: customEl ? String(customEl.value ?? '') : '',
    expiresAt: expiresEl && expiresEl.value ? new Date(expiresEl.value).toISOString() : '',
  });

  on(reasonEl, 'change', () => {
    if (!customWrap) return;
    if (normalizeReason(reasonEl.value) === 'CUSTOM') customWrap.removeAttribute('hidden');
    else customWrap.setAttribute('hidden', '');
  });
  on(form, 'submit', (e) => {
    e.preventDefault();
    if (typeof onChange === 'function') onChange(collect());
  });
  on(unlockBtn, 'click', () => {
    if (typeof onChange === 'function') {
      onChange({ enabled: false, reason: '', customReason: '', expiresAt: '' });
    }
  });
  return () => { cleanups.forEach((fn) => { try { fn(); } catch { /* noop */ } }); };
}
