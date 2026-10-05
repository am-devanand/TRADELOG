// ============================================
// Analytics Filters — ONE shared filter bar for every analytics page
// Vanilla ESM, presentational only. No business logic, no storage,
// no network, no analytics computation. All data arrives via props.
// Pages own filter state + data filtering (tradingAnalytics.js);
// this module only renders controls + reports user intent via onChange.
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

function toIsoDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function cloneFilters(f) {
  return {
    account: f?.account ?? 'ALL',
    preset: f?.preset ?? 'ALL_TIME',
    dateFrom: f?.dateFrom ?? '',
    dateTo: f?.dateTo ?? '',
    strategies: [...toArray(f?.strategies)],
    pairs: [...toArray(f?.pairs)],
    sessions: [...toArray(f?.sessions)],
    timeframes: [...toArray(f?.timeframes)],
    setups: [...toArray(f?.setups ?? f?.setupTypes)],
    outcome: f?.outcome ?? 'ALL',
    reviewStatus: f?.reviewStatus ?? 'ALL',
  };
}

/**
 * Canonical empty filter state. Pages spread-override per context
 * (e.g. `{ ...DEFAULT_FILTERS, account: folderId }`).
 */
export const DEFAULT_FILTERS = Object.freeze({
  account: 'ALL',
  preset: 'ALL_TIME',
  dateFrom: '',
  dateTo: '',
  strategies: Object.freeze([]),
  pairs: Object.freeze([]),
  sessions: Object.freeze([]),
  timeframes: Object.freeze([]),
  setups: Object.freeze([]),
  outcome: 'ALL',
  reviewStatus: 'ALL',
});

/** Fresh mutable copy of DEFAULT_FILTERS. */
export function clearFilters() {
  return cloneFilters(DEFAULT_FILTERS);
}

const PRESET_OPTIONS = [
  { value: 'ALL_TIME', label: 'All time' },
  { value: '7D', label: 'Last 7 days' },
  { value: '30D', label: 'Last 30 days' },
  { value: '90D', label: 'Last 90 days' },
  { value: 'THIS_MONTH', label: 'This month' },
  { value: 'THIS_YEAR', label: 'This year' },
  { value: 'CUSTOM', label: 'Custom range' },
];

const OUTCOME_OPTIONS = [
  { value: 'ALL', label: 'All outcomes' },
  { value: 'WIN', label: 'Win' },
  { value: 'LOSS', label: 'Loss' },
  { value: 'BREAKEVEN', label: 'Breakeven' },
];

const REVIEW_OPTIONS = [
  { value: 'ALL', label: 'All reviews' },
  { value: 'REVIEWED', label: 'Reviewed' },
  { value: 'UNREVIEWED', label: 'Unreviewed' },
];

/**
 * Map a date preset to an inclusive { dateFrom, dateTo } ISO pair.
 * CUSTOM returns empty strings so the page keeps the user's typed range.
 * ALL_TIME returns empty strings meaning "unbounded".
 *
 * @param {string} preset
 * @param {{ dateFrom?: string, dateTo?: string }} [custom]
 * @returns {{ dateFrom: string, dateTo: string }}
 */
export function resolveDatePreset(preset, custom = {}) {
  const p = String(preset ?? 'ALL_TIME').trim().toUpperCase();
  const now = new Date();
  const today = toIsoDate(now);
  const daysAgo = (n) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
    return toIsoDate(d);
  };
  switch (p) {
    case '7D':
      return { dateFrom: daysAgo(6), dateTo: today };
    case '30D':
      return { dateFrom: daysAgo(29), dateTo: today };
    case '90D':
      return { dateFrom: daysAgo(89), dateTo: today };
    case 'THIS_MONTH':
      return { dateFrom: toIsoDate(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: today };
    case 'THIS_YEAR':
      return { dateFrom: toIsoDate(new Date(now.getFullYear(), 0, 1)), dateTo: today };
    case 'CUSTOM':
      return {
        dateFrom: custom?.dateFrom ? String(custom.dateFrom) : '',
        dateTo: custom?.dateTo ? String(custom.dateTo) : '',
      };
    case 'ALL_TIME':
    default:
      return { dateFrom: '', dateTo: '' };
  }
}

function uniqStrings(list) {
  const seen = new Set();
  const out = [];
  for (const raw of toArray(list)) {
    const s = String(raw ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function singleSelectHtml({ name, label, value, options, labelledBy }) {
  const opts = options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${String(value) === String(o.value) ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
    )
    .join('');
  return `
    <div class="form-group analytics-field">
      <label class="form-label" for="af-${escapeHtml(name)}"${labelledBy ? ` id="${escapeHtml(labelledBy)}"` : ''}>${escapeHtml(label)}</label>
      <select id="af-${escapeHtml(name)}" data-filter="${escapeHtml(name)}" aria-label="${escapeHtml(label)}">${opts}</select>
    </div>`;
}

/**
 * Compact multi-select: native <details>/<summary> popover wrapping a
 * keyboard-accessible checkbox group. <details> gives free keyboard
 * toggle (Enter/Space on summary); checkboxes are natively tabbable.
 */
function multiSelectHtml({ name, label, selected, options }) {
  const opts = uniqStrings(options);
  const sel = new Set(toArray(selected).map((s) => String(s)));
  const activeCount = opts.filter((o) => sel.has(o)).length;
  // Keep unknown-but-selected values visible so re-render never drops state.
  const extras = toArray(selected).map((s) => String(s)).filter((s) => s && !opts.includes(s));
  const all = [...opts, ...extras.filter((e) => !opts.includes(e))];
  const summaryLabel = activeCount > 0 ? `${label} (${activeCount})` : `All ${label.toLowerCase()}`;
  const boxes = all.length
    ? all
        .map((opt, i) => {
          const id = `af-${name}-${i}`;
          const checked = sel.has(opt);
          return `
        <label class="analytics-check" for="${escapeHtml(id)}">
          <input type="checkbox" id="${escapeHtml(id)}" data-filter-multi="${escapeHtml(name)}" value="${escapeHtml(opt)}"${checked ? ' checked' : ''} aria-label="${escapeHtml(`${label}: ${opt}`)}">
          <span>${escapeHtml(opt)}</span>
        </label>`;
        })
        .join('')
    : `<p class="analytics-check-empty">No ${escapeHtml(label.toLowerCase())} found.</p>`;
  return `
    <div class="form-group analytics-field">
      <span class="form-label" id="af-legend-${escapeHtml(name)}">${escapeHtml(label)}</span>
      <details class="analytics-ms" data-ms="${escapeHtml(name)}">
        <summary aria-labelledby="af-legend-${escapeHtml(name)}" aria-label="${escapeHtml(`${label}. ${summaryLabel}`)}">${escapeHtml(summaryLabel)}</summary>
        <div class="analytics-ms-pop" role="group" aria-label="${escapeHtml(label)} options">${boxes}</div>
      </details>
    </div>`;
}

/**
 * Describe active (non-default) filters as chip data. Pages render these
 * inside [data-chips]; chip removal is handled by the delegated click
 * listener in bindAnalyticsFilters. Pure — no DOM writes.
 *
 * @param {Object} filters
 * @returns {Array<{ key: string, label: string, value: string }>}
 */
export function getActiveFilterChips(filters = {}) {
  const f = { ...cloneFilters(filters), ...filters };
  const chips = [];
  if (f.account && String(f.account) !== 'ALL') chips.push({ key: 'account', label: 'Account', value: String(f.account) });
  if (f.preset && String(f.preset) !== 'ALL_TIME') chips.push({ key: 'preset', label: 'Range', value: String(f.preset) });
  if (f.dateFrom) chips.push({ key: 'dateFrom', label: 'From', value: String(f.dateFrom) });
  if (f.dateTo) chips.push({ key: 'dateTo', label: 'To', value: String(f.dateTo) });
  for (const [key, label] of [
    ['strategies', 'Strategy'],
    ['pairs', 'Pair'],
    ['sessions', 'Session'],
    ['timeframes', 'Timeframe'],
    ['setups', 'Setup'],
  ]) {
    for (const v of toArray(f[key])) {
      if (String(v).trim() !== '') chips.push({ key, label, value: String(v) });
    }
  }
  if (f.outcome && String(f.outcome) !== 'ALL') chips.push({ key: 'outcome', label: 'Outcome', value: String(f.outcome) });
  if (f.reviewStatus && String(f.reviewStatus) !== 'ALL') chips.push({ key: 'reviewStatus', label: 'Review', value: String(f.reviewStatus) });
  return chips;
}

function chipsHtml(filters) {
  const chips = getActiveFilterChips(filters);
  if (!chips.length) return `<p class="analytics-chips-empty">No filters applied — showing everything.</p>`;
  return chips
    .map(
      (c) => `
      <span class="badge badge-gold analytics-chip">
        ${escapeHtml(c.label)}: ${escapeHtml(c.value)}
        <button type="button" class="analytics-chip-x" data-action="remove-chip" data-chip-key="${escapeHtml(c.key)}" data-chip-value="${escapeHtml(c.value)}" aria-label="Remove filter ${escapeHtml(c.label)} ${escapeHtml(c.value)}">✕</button>
      </span>`,
    )
    .join('');
}

/**
 * Render the shared filter bar. Returns an HTML string (no DOM writes).
 * The page inserts it once, then calls bindAnalyticsFilters; re-rendering
 * on state change is fine because binding is delegated + bound only once.
 *
 * @param {Object} [currentFilters]
 * @param {Object} [options] option lists for multi-selects
 * @returns {string}
 */
export function renderAnalyticsFilters(currentFilters = {}, options = {}) {
  const f = cloneFilters({ ...DEFAULT_FILTERS, ...currentFilters });
  // Alias: accept setupTypes under either key.
  if (!toArray(currentFilters.setups).length && toArray(currentFilters.setupTypes).length) {
    f.setups = [...toArray(currentFilters.setupTypes)];
  }
  const strategies = uniqStrings(options.strategies);
  const pairs = uniqStrings(options.pairs);
  const sessions = uniqStrings(options.sessions);
  const timeframes = uniqStrings(options.timeframes);
  const setupTypes = uniqStrings(options.setupTypes ?? options.setups);
  const account = String(f.account ?? 'ALL');
  const accountOpts = [{ value: 'ALL', label: 'All accounts' }];
  if (account !== 'ALL' && account !== '') accountOpts.push({ value: account, label: account });
  const isCustom = String(f.preset).toUpperCase() === 'CUSTOM';

  return `
    <section class="card analytics-filters" data-analytics-filters aria-label="Analytics filters">
      <div class="analytics-filters-head">
        <h3 class="analytics-filters-title">Filters</h3>
        <button type="button" class="btn btn-ghost btn-sm" data-action="clear-filters" aria-label="Clear all analytics filters">Clear</button>
      </div>
      <div class="analytics-filters-grid">
        <div class="form-group analytics-field">
          <label class="form-label" for="af-account">Account</label>
          <select id="af-account" data-filter="account" aria-label="Account">
            ${accountOpts.map((o) => `<option value="${escapeHtml(o.value)}"${account === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
          </select>
        </div>
        ${singleSelectHtml({ name: 'preset', label: 'Date range', value: f.preset, options: PRESET_OPTIONS })}
        <div class="form-group analytics-field" data-custom-dates${isCustom ? '' : ' hidden'}>
          <label class="form-label" for="af-dateFrom">From</label>
          <input type="date" id="af-dateFrom" data-filter="dateFrom" value="${escapeHtml(f.dateFrom)}" aria-label="Custom range start date">
        </div>
        <div class="form-group analytics-field" data-custom-dates${isCustom ? '' : ' hidden'}>
          <label class="form-label" for="af-dateTo">To</label>
          <input type="date" id="af-dateTo" data-filter="dateTo" value="${escapeHtml(f.dateTo)}" aria-label="Custom range end date">
        </div>
        ${multiSelectHtml({ name: 'strategies', label: 'Strategy', selected: f.strategies, options: strategies })}
        ${multiSelectHtml({ name: 'pairs', label: 'Pair', selected: f.pairs, options: pairs })}
        ${multiSelectHtml({ name: 'sessions', label: 'Session', selected: f.sessions, options: sessions })}
        ${multiSelectHtml({ name: 'timeframes', label: 'Timeframe', selected: f.timeframes, options: timeframes })}
        ${multiSelectHtml({ name: 'setups', label: 'Setup', selected: f.setups, options: setupTypes })}
        ${singleSelectHtml({ name: 'outcome', label: 'Outcome', value: f.outcome, options: OUTCOME_OPTIONS })}
        ${singleSelectHtml({ name: 'reviewStatus', label: 'Review status', value: f.reviewStatus, options: REVIEW_OPTIONS })}
      </div>
      <div class="analytics-chips" data-chips aria-live="polite" aria-label="Active filters">${chipsHtml(f)}</div>
    </section>`;
}

function readMulti(root, name) {
  return [...root.querySelectorAll(`[data-filter-multi="${CSS.escape(name)}"]`)]
    .filter((el) => el.checked)
    .map((el) => el.value);
}

/** Read current filter state from a rendered filter bar root. */
function collectFilters(root) {
  const val = (name) => root.querySelector(`[data-filter="${CSS.escape(name)}"]`)?.value ?? '';
  const preset = val('preset') || 'ALL_TIME';
  let dateFrom = val('dateFrom') || '';
  let dateTo = val('dateTo') || '';
  if (String(preset).toUpperCase() !== 'CUSTOM') {
    const resolved = resolveDatePreset(preset);
    dateFrom = resolved.dateFrom;
    dateTo = resolved.dateTo;
  }
  return {
    account: val('account') || 'ALL',
    preset,
    dateFrom,
    dateTo,
    strategies: readMulti(root, 'strategies'),
    pairs: readMulti(root, 'pairs'),
    sessions: readMulti(root, 'sessions'),
    timeframes: readMulti(root, 'timeframes'),
    setups: readMulti(root, 'setups'),
    outcome: val('outcome') || 'ALL',
    reviewStatus: val('reviewStatus') || 'ALL',
  };
}

// ---- SINGLE delegated binding (module-guarded, never stacks) ----
let delegatedBound = false;
let currentOnChange = null;

function findRoot(target) {
  if (!target || typeof target.closest !== 'function') return null;
  return target.closest('[data-analytics-filters]');
}

function handleChange(e) {
  const root = findRoot(e.target);
  if (!root) return;
  if (typeof currentOnChange !== 'function') return;
  const t = e.target;
  const single = t?.getAttribute?.('data-filter');
  const multi = t?.getAttribute?.('data-filter-multi');
  if (!single && !multi) return;
  try {
    currentOnChange(collectFilters(root), single || multi);
  } catch (err) {
    console.error('analytics filters onChange failed:', err);
  }
}

function handleClick(e) {
  const actionEl = e.target?.closest?.('[data-action="clear-filters"], [data-action="remove-chip"]');
  if (!actionEl) return;
  const root = findRoot(actionEl) || document.querySelector('[data-analytics-filters]');
  if (!root || typeof currentOnChange !== 'function') return;
  const action = actionEl.getAttribute('data-action');
  try {
    if (action === 'clear-filters') {
      currentOnChange(clearFilters(), 'clear');
    } else if (action === 'remove-chip') {
      const key = actionEl.getAttribute('data-chip-key') || '';
      const value = actionEl.getAttribute('data-chip-value') ?? '';
      const next = collectFilters(root);
      if (['strategies', 'pairs', 'sessions', 'timeframes', 'setups'].includes(key)) {
        next[key] = toArray(next[key]).filter((v) => String(v) !== String(value));
      } else if (key === 'dateFrom' || key === 'dateTo') {
        next[key] = '';
        if (next.preset === 'CUSTOM') {
          // keep CUSTOM so the user's other bound survives
        }
      } else if (key === 'preset') {
        next.preset = 'ALL_TIME';
        next.dateFrom = '';
        next.dateTo = '';
      } else if (key === 'account') {
        next.account = 'ALL';
      } else if (key === 'outcome') {
        next.outcome = 'ALL';
      } else if (key === 'reviewStatus') {
        next.reviewStatus = 'ALL';
      }
      currentOnChange(next, key);
    }
  } catch (err) {
    console.error('analytics filters chip action failed:', err);
  }
}

/**
 * Bind ONE delegated change+click listener pair (document-level, guarded so
 * repeat calls after re-render never stack). Updates the onChange callback
 * on every call. Returns an unbind function that detaches the callback
 * (listeners stay, guarded, for the page lifetime).
 *
 * @param {{ onChange?: (filters: Object, changedKey: string) => void }} [handlers]
 * @returns {Function} unbind
 */
export function bindAnalyticsFilters({ onChange } = {}) {
  currentOnChange = typeof onChange === 'function' ? onChange : null;
  if (!delegatedBound) {
    document.addEventListener('change', handleChange);
    document.addEventListener('click', handleClick);
    delegatedBound = true;
  }
  return () => {
    currentOnChange = null;
  };
}

if (typeof window !== 'undefined') {
  window.TradeLogComponents = {
    ...(window.TradeLogComponents || {}),
    DEFAULT_FILTERS,
    renderAnalyticsFilters,
    bindAnalyticsFilters,
    resolveDatePreset,
    getActiveFilterChips,
    clearFilters,
  };
}
