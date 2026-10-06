// ============================================
// Sync Status Indicator — visible UI surface for syncManager.js
// Vanilla ESM. Read-only view: never touches the engine, never
// calls initSyncManager. Renders only user-safe strings.
// ============================================
import '../../css/sync.css';
import {
  SYNC_STATES,
  getSyncState,
  subscribeSyncState,
  retryNow,
  formatSyncStatus,
} from '../utils/syncManager.js';
import { escapeHtml, showToast } from '../utils/helpers.js';

const RETRY_ACTION = 'sync-retry';

// ---- SINGLE delegated binding (module-guarded, never stacks) ----
let delegatedBound = false;
let currentOnRetry = null;

async function defaultOnRetry() {
  try {
    const res = await retryNow();
    if (res && res.success === false && res.error) {
      showToast(escapeHtml(String(res.error)), 'info');
    }
  } catch {
    showToast('Sync retry failed. Changes stay saved on this device.', 'error');
  }
}

async function handleSyncClick(e) {
  const btn = e.target && typeof e.target.closest === 'function'
    ? e.target.closest(`[data-action="${RETRY_ACTION}"]`)
    : null;
  if (!btn) return;
  e.preventDefault();
  const fn = typeof currentOnRetry === 'function' ? currentOnRetry : defaultOnRetry;
  btn.setAttribute('disabled', 'true');
  btn.setAttribute('aria-disabled', 'true');
  try {
    await fn();
  } catch {
    try {
      showToast('Sync retry failed. Changes stay saved on this device.', 'error');
    } catch {
      /* toast must never break the page */
    }
  } finally {
    try {
      if (btn.isConnected) {
        btn.removeAttribute('disabled');
        btn.removeAttribute('aria-disabled');
      }
    } catch {
      /* re-render may have replaced the node — harmless */
    }
  }
}

/**
 * Attach ONE document-level delegated click listener for the retry action.
 * Module-guarded: safe to call on every page render, never stacks.
 * Updates the onRetry callback on every call.
 * @param {{ onRetry?: () => (void|Promise<void>) }} [handlers]
 * @returns {Function} unbind (clears callback; the guarded listener stays)
 */
export function bindSyncStatus({ onRetry } = {}) {
  currentOnRetry = typeof onRetry === 'function' ? onRetry : null;
  if (!delegatedBound) {
    document.addEventListener('click', handleSyncClick);
    delegatedBound = true;
  }
  return () => {
    currentOnRetry = null;
  };
}

// ---- Relative time ----

/**
 * @param {string|null|undefined} iso
 * @returns {string} "just now" / "5m ago" / "3h ago" / "2d ago" / "—"
 */
export function formatRelativeTime(iso) {
  if (iso == null || iso === '') return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---- Render ----

const STATE_CLASS = Object.freeze({
  [SYNC_STATES.IDLE]: 'sync-idle',
  [SYNC_STATES.SYNCING]: 'sync-busy',
  [SYNC_STATES.SYNCED]: 'sync-ok',
  [SYNC_STATES.OFFLINE]: 'sync-offline',
  [SYNC_STATES.RETRYING]: 'sync-busy',
  [SYNC_STATES.ERROR]: 'sync-error',
});

const NEEDS_RETRY = new Set([SYNC_STATES.OFFLINE, SYNC_STATES.RETRYING, SYNC_STATES.ERROR]);

function normalizeState(state) {
  const fallback = getSyncState();
  const s = state && typeof state === 'object' ? state : fallback;
  const status = s.status && SYNC_STATES[s.status] ? s.status : SYNC_STATES.IDLE;
  return {
    status,
    lastSyncedAt: s.lastSyncedAt ?? fallback.lastSyncedAt ?? null,
    // Render ONLY the user-safe message. lastError never leaves this module.
    message: typeof s.message === 'string' && s.message ? s.message : '',
  };
}

/**
 * Render the sync indicator. Status is always symbol + text (never colour alone).
 * Compact = single icon+text pill (navbar). Full = pill + "last synced"
 * relative time + message, plus a RETRY button for OFFLINE/RETRYING/ERROR.
 * IDLE with no successful sync never claims "Synced".
 * @param {object} state syncManager state snapshot
 * @param {{ compact?: boolean }} [opts]
 * @returns {string} HTML string
 */
export function renderSyncStatus(state, { compact = false } = {}) {
  const norm = normalizeState(state);
  let symbol = '';
  let text = '';
  try {
    ({ symbol, text } = formatSyncStatus(norm));
  } catch {
    symbol = '○';
    text = 'Not synced yet';
  }
  const cls = STATE_CLASS[norm.status] || STATE_CLASS[SYNC_STATES.IDLE];
  const label = `${symbol} ${text}`;
  const ariaLabel = `Sync status: ${text}`;

  if (compact) {
    return `<span class="badge sync-pill ${cls}" role="status" aria-live="polite" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(norm.message)}">`
      + `<span class="sync-symbol" aria-hidden="true">${escapeHtml(symbol)}</span>`
      + `<span class="sync-text">${escapeHtml(text)}</span>`
      + `</span>`;
  }

  const rel = formatRelativeTime(norm.lastSyncedAt);
  const showRetry = NEEDS_RETRY.has(norm.status);
  return `<div class="sync-full" role="status" aria-live="polite" aria-label="${escapeHtml(ariaLabel)}">`
    + `<span class="badge sync-pill ${cls}">`
    + `<span class="sync-symbol" aria-hidden="true">${escapeHtml(symbol)}</span>`
    + `<span class="sync-text">${escapeHtml(text)}</span>`
    + `</span>`
    + `<span class="sync-meta">Last synced: <strong>${escapeHtml(rel)}</strong></span>`
    + (norm.message ? `<span class="sync-message">${escapeHtml(norm.message)}</span>` : '')
    + (showRetry
      ? `<button type="button" class="btn btn-secondary btn-sm sync-retry" data-action="${escapeHtml(RETRY_ACTION)}">RETRY</button>`
      : '')
    + `</div>`;
}

function paintRoot(root, compact) {
  try {
    if (!root || !root.isConnected) return false;
    root.innerHTML = renderSyncStatus(getSyncState(), { compact });
    return true;
  } catch {
    return false;
  }
}

// Active watchers keyed by root element identity: re-calling with the same
// root cleans the previous subscription first, so navigation + re-render
// can never stack subscriptions or leak timers/observers.
const activeWatchers = new WeakMap();

function cleanupWatcher(root) {
  const entry = root ? activeWatchers.get(root) : null;
  if (!entry) return;
  activeWatchers.delete(root);
  try {
    if (typeof entry.unsub === 'function') entry.unsub();
  } catch {
    /* unsubscribe never throws */
  }
  try {
    if (entry.observer) entry.observer.disconnect();
  } catch {
    /* ignore */
  }
}

/**
 * Subscribe to sync state and re-render ONLY the status root element.
 * Safe to call on every page render: same-root re-calls replace (never
 * stack) the subscription, and a MutationObserver auto-cleans when the
 * root leaves the DOM (route change), so nothing leaks.
 * @param {Element} root element hosting the indicator
 * @param {{ compact?: boolean }} [opts]
 * @returns {Function} cleanup function
 */
export function startSyncStatusWatcher(root, { compact = false } = {}) {
  if (!root || typeof root !== 'object') return () => {};
  // Same-root re-call (e.g. bindNavbar ran twice for one navbar): drop the
  // old subscription before creating a new one — single subscription max.
  cleanupWatcher(root);
  bindSyncStatus();
  paintRoot(root, compact);

  let unsub = () => {};
  try {
    unsub = subscribeSyncState(() => {
      if (!paintRoot(root, compact)) cleanupWatcher(root);
    });
  } catch {
    unsub = () => {};
  }

  let observer = null;
  try {
    observer = new MutationObserver(() => {
      try {
        if (!root.isConnected) cleanupWatcher(root);
      } catch {
        cleanupWatcher(root);
      }
    });
    const watchTarget = document.body || document.documentElement;
    if (watchTarget) observer.observe(watchTarget, { childList: true, subtree: true });
  } catch {
    observer = null;
  }

  activeWatchers.set(root, { unsub, observer });
  return () => cleanupWatcher(root);
}

/**
 * Start watchers for every sync-status root currently in the DOM.
 * Idempotent: safe to call after every page render.
 * @returns {Function} cleanup-all function
 */
export function startAllSyncStatusWatchers() {
  const cleanups = [];
  try {
    document.querySelectorAll('[data-sync-status-root]').forEach((el) => {
      try {
        cleanups.push(startSyncStatusWatcher(el, { compact: el.getAttribute('data-sync-compact') === 'true' }));
      } catch {
        /* one bad root must not break the page */
      }
    });
  } catch {
    /* query must never break the page */
  }
  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  };
}

if (typeof window !== 'undefined') {
  window.TradeLogComponents = {
    ...(window.TradeLogComponents || {}),
    renderSyncStatus,
    bindSyncStatus,
    startSyncStatusWatcher,
    startAllSyncStatusWatchers,
    formatRelativeTime,
  };
}
