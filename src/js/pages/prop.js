// ============================================
// Prop dashboard — /prop
// Vanilla ESM, reuses .card/.badge/.btn/.stat-card/.progress from base.css.
// READ-ONLY over accounts: never writes balances/trades. Prop config edits
// persist via propRules.updatePropRule/resetPropConfig (or a localStorage
// fallback key when the engine modules are absent). Engine imports are
// dynamic with @vite-ignore so build+runtime never crash when absent.
// ============================================
import '../../css/prop.css';
import { getCurrentUser, getFolders, getTrades } from '../utils/storage.js';
import {
  navigate,
  showModal,
  hideModal,
  showToast,
  escapeHtml,
} from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import { appendAudit } from '../utils/auditLog.js';

function safeAudit(user, entry) {
  try {
    appendAudit(user, entry);
  } catch {
    /* audit must never break prop config operations */
  }
}

function auditPropConfigUpdated(user, accountId) {
  safeAudit(user, {
    entityType: 'propConfig',
    entityId: String(accountId ?? ''),
    action: 'PROP_CONFIG_UPDATED',
    metadata: {},
  });
}
import { renderPropSummary } from '../components/prop/propSummary.js';
import { renderPropRuleCard } from '../components/prop/propRuleCard.js';
import { renderDrawdownMeter } from '../components/prop/drawdownMeter.js';
import { renderConsistencyCard } from '../components/prop/consistencyCard.js';
import { statusBadge, normalizeStatus, fmtMoney } from '../components/prop/propStatus.js';

// ---- Defensive engine loading (modules may not exist yet) ----
let engineMod = null;
let rulesMod = null;
let enginesChecked = false;
let enginesUnavailable = false;

async function loadEngines() {
  if (enginesChecked) return;
  enginesChecked = true;
  try {
    engineMod = await import(/* @vite-ignore */ '../utils/propEngine.js');
  } catch { engineMod = null; }
  try {
    rulesMod = await import(/* @vite-ignore */ '../utils/propRules.js');
  } catch { rulesMod = null; }
  enginesUnavailable = !engineMod && !rulesMod;
}

function callFirst(mod, names, argsList) {
  if (!mod) return undefined;
  for (const name of names) {
    const fn = mod[name] ?? mod.default?.[name];
    if (typeof fn !== 'function') continue;
    for (const args of argsList) {
      try {
        const out = fn(...args);
        if (out !== undefined && out !== null) return out;
      } catch { /* try next signature */ }
    }
  }
  return undefined;
}

// ---- Selected account (per user) ----
function propSelKey(user) {
  return `tradelog_prop_account_${String(user || '').trim().toLowerCase()}`;
}

function propCfgKey(user, accountId) {
  return `tradelog_propconfig_${String(user || '').trim().toLowerCase()}_${String(accountId || '')}`;
}

function getSelectedAccountId(user, folders) {
  let sel = null;
  try { sel = localStorage.getItem(propSelKey(user)); } catch { sel = null; }
  if (sel && folders.some((f) => String(f.id) === String(sel))) return sel;
  return folders.length ? folders[0].id : '';
}

function setSelectedAccountId(user, id) {
  try { localStorage.setItem(propSelKey(user), String(id)); } catch { /* offline-safe */ }
}

// ---- Signed P/L (read-only; supports executed shape + legacy TP/SL log) ----
function signedPnl(t) {
  if (!t || typeof t !== 'object') return 0;
  const cands = [t.pnl, t.realizedPL, t.realizedPnl, t.netPnl, t.profit];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  const amt = Number(t.amount);
  if (Number.isFinite(amt)) {
    const type = String(t.type || '').toUpperCase();
    if (type === 'SL') return -Math.abs(amt);
    if (type === 'TP') return Math.abs(amt);
    return amt;
  }
  return 0;
}

function tradeDateKey(t) {
  const raw = t?.date ?? t?.closedAt ?? t?.openedAt ?? t?.createdAt ?? '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function isOpenStatus(t) {
  const s = String(t?.status ?? '').trim().toUpperCase();
  return s === 'OPEN' || s === 'PARTIALLY_CLOSED';
}

// ---- Local fallback config (sized off starting balance) ----
function defaultLocalConfig(account) {
  const size = Number(account?.startingBalance);
  const base = Number.isFinite(size) ? size : 0;
  const pct = (p) => Math.round(base * p * 100) / 100;
  return {
    profitTarget: { id: 'profitTarget', name: 'Profit Target', target: pct(0.10), warningPct: 70, criticalPct: 90, enabled: true },
    dailyLoss: { id: 'dailyLoss', name: 'Daily Loss', limit: pct(0.05), warningPct: 70, criticalPct: 90, enabled: true },
    maxDrawdown: { id: 'maxDrawdown', name: 'Max Drawdown', limit: pct(0.10), warningPct: 70, criticalPct: 90, enabled: true },
    tradingDays: { id: 'tradingDays', name: 'Trading Days', required: 10, enabled: true },
    consistency: { id: 'consistency', name: 'Consistency', limitPct: 30, enabled: true },
  };
}

function readLocalConfig(user, accountId, account) {
  const fallback = defaultLocalConfig(account);
  try {
    const raw = localStorage.getItem(propCfgKey(user, accountId));
    if (!raw) return { config: fallback, isDefault: true };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { config: fallback, isDefault: true };
    return { config: { ...fallback, ...parsed }, isDefault: false };
  } catch {
    return { config: fallback, isDefault: true };
  }
}

function resolveConfig(user, account) {
  const accountId = account?.id;
  // Prefer the prop engine's config when present.
  if (rulesMod) {
    const fromEngine = callFirst(rulesMod, ['getPropConfig', 'getPropRules'], [
      [user, accountId],
      [accountId],
      [user],
    ]);
    const cfg = normalizeEngineConfig(fromEngine) || normalizeEngineConfig(rulesMod?.defaultPropRules);
    if (cfg) return { config: { ...defaultLocalConfig(account), ...cfg }, isDefault: false };
    // Engine present but no config stored for this account.
    return { config: defaultLocalConfig(account), isDefault: true };
  }
  return readLocalConfig(user, accountId, account);
}

function numOrUndef(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeEngineConfig(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
  };
  const out = {};
  const pt = raw.profitTarget ?? raw.profit_target ?? raw.target;
  if (pt !== undefined) {
    const o = typeof pt === 'object' ? pt : { target: pt };
    out.profitTarget = {
      id: 'profitTarget', name: 'Profit Target',
      target: numOrUndef(pick(o, ['target', 'limit', 'value'])) ?? 0,
      warningPct: numOrUndef(pick(o, ['warningPct', 'warning', 'warnAt'])) ?? 70,
      criticalPct: numOrUndef(pick(o, ['criticalPct', 'critical', 'critAt'])) ?? 90,
      enabled: o.enabled !== false,
    };
  }
  const dl = raw.dailyLoss ?? raw.daily_loss ?? raw.daily;
  if (dl !== undefined) {
    const o = typeof dl === 'object' ? dl : { limit: dl };
    out.dailyLoss = {
      id: 'dailyLoss', name: 'Daily Loss',
      limit: numOrUndef(pick(o, ['limit', 'maxLoss', 'value'])) ?? 0,
      warningPct: numOrUndef(pick(o, ['warningPct', 'warning', 'warnAt'])) ?? 70,
      criticalPct: numOrUndef(pick(o, ['criticalPct', 'critical', 'critAt'])) ?? 90,
      enabled: o.enabled !== false,
    };
  }
  const md = raw.maxDrawdown ?? raw.max_drawdown ?? raw.drawdown;
  if (md !== undefined) {
    const o = typeof md === 'object' ? md : { limit: md };
    out.maxDrawdown = {
      id: 'maxDrawdown', name: 'Max Drawdown',
      limit: numOrUndef(pick(o, ['limit', 'maxDrawdown', 'value'])) ?? 0,
      warningPct: numOrUndef(pick(o, ['warningPct', 'warning', 'warnAt'])) ?? 70,
      criticalPct: numOrUndef(pick(o, ['criticalPct', 'critical', 'critAt'])) ?? 90,
      enabled: o.enabled !== false,
    };
  }
  const td = raw.tradingDays ?? raw.trading_days ?? raw.minDays;
  if (td !== undefined) {
    const o = typeof td === 'object' ? td : { required: td };
    out.tradingDays = {
      id: 'tradingDays', name: 'Trading Days',
      required: numOrUndef(pick(o, ['required', 'minDays', 'value'])) ?? 10,
      enabled: o.enabled !== false,
    };
  }
  const cs = raw.consistency;
  if (cs !== undefined) {
    const o = typeof cs === 'object' ? cs : { limitPct: cs };
    out.consistency = {
      id: 'consistency', name: 'Consistency',
      limitPct: numOrUndef(pick(o, ['limitPct', 'limit', 'maxPct', 'value'])) ?? 30,
      enabled: o.enabled !== false,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

// ---- Status helpers ----
function ratioStatus(ratio, rule) {
  if (!rule || rule.enabled === false) return 'DISABLED';
  const w = (Number(rule.warningPct) || 70) / 100;
  const c = (Number(rule.criticalPct) || 90) / 100;
  if (!Number.isFinite(ratio)) return 'SAFE';
  if (ratio >= 1) return 'BREACH';
  if (ratio >= c) return 'CRITICAL';
  if (ratio >= w) return 'WARNING';
  return 'SAFE';
}

function worstStatus(list) {
  const rank = { SAFE: 0, DISABLED: 0, WARNING: 1, CRITICAL: 2, BREACH: 3 };
  let worst = 'SAFE';
  for (const s of list) {
    const n = normalizeStatus(s);
    if ((rank[n] ?? 0) > (rank[worst] ?? 0)) worst = n;
  }
  return worst;
}

// ---- Local state computation (read-only over storage) ----
function computeLocalState(account, trades, config) {
  const size = Number(account?.startingBalance);
  const startBal = Number.isFinite(size) ? size : 0;
  const curBalRaw = Number(account?.currentBalance);
  const balance = Number.isFinite(curBalRaw) ? curBalRaw : startBal;
  const currency = account?.currency || 'USD';

  const openTrades = (trades || []).filter(isOpenStatus);
  // Never fabricate equity: no mark-price feed locally, so equity is
  // unavailable unless the engine reports it.
  const equityAvailable = false;
  const equity = null;

  const profit = balance - startBal;
  const ptTarget = Number(config?.profitTarget?.target) || 0;
  const ptPct = ptTarget > 0 ? (profit / ptTarget) * 100 : 0;

  const today = new Date().toISOString().slice(0, 10);
  let todayPnl = 0;
  const byDay = new Map();
  for (const t of trades || []) {
    const key = tradeDateKey(t);
    if (!key) continue;
    const p = signedPnl(t);
    byDay.set(key, (byDay.get(key) || 0) + p);
    if (key === today) todayPnl += p;
  }
  const dailyUsed = Math.max(0, -todayPnl);
  const dailyLimit = Number(config?.dailyLoss?.limit) || 0;
  const dailyStatus = dailyLimit > 0 ? ratioStatus(dailyUsed / dailyLimit, config?.dailyLoss) : 'SAFE';

  // Max drawdown used: peak-to-current over balanceAfter trail (fall back to start/current).
  let peak = startBal;
  const ordered = [...(trades || [])]
    .map((t) => ({ t, at: new Date(t?.date ?? t?.closedAt ?? t?.createdAt ?? 0).getTime() }))
    .filter((x) => !Number.isNaN(x.at))
    .sort((a, b) => a.at - b.at);
  for (const { t } of ordered) {
    const b = Number(t?.balanceAfter);
    if (Number.isFinite(b) && b > peak) peak = b;
  }
  if (balance > peak) peak = balance;
  const ddUsed = Math.max(0, peak - balance);
  const ddLimit = Number(config?.maxDrawdown?.limit) || 0;
  const ddStatus = ddLimit > 0 ? ratioStatus(ddUsed / ddLimit, config?.maxDrawdown) : 'SAFE';

  const dayCount = byDay.size;
  const daysRequired = Number(config?.tradingDays?.required) || 10;
  const daysStatus = config?.tradingDays?.enabled === false ? 'DISABLED'
    : dayCount >= daysRequired ? 'SAFE' : 'WARNING';

  let consPct = null;
  if (profit > 0 && byDay.size) {
    const best = Math.max(...[...byDay.values()]);
    consPct = (best / profit) * 100;
  }
  const consLimit = Number(config?.consistency?.limitPct);
  const consEnabled = config?.consistency?.enabled !== false;
  const consStatus = !consEnabled ? 'DISABLED'
    : consPct === null ? 'SAFE'
    : consPct > (Number.isFinite(consLimit) ? consLimit : 30) ? 'BREACH' : 'SAFE';

  const rules = [
    {
      id: 'profitTarget', name: 'Profit Target',
      status: config?.profitTarget?.enabled === false ? 'DISABLED' : 'SAFE',
      current: profit, limit: ptTarget,
      currentLabel: fmtMoney(profit), limitLabel: fmtMoney(ptTarget),
      reason: `Net profit ${fmtMoney(profit)} of ${fmtMoney(ptTarget)} target (${ptPct.toFixed(1)}%).`,
      enabled: config?.profitTarget?.enabled !== false,
    },
    {
      id: 'dailyLoss', name: 'Daily Loss',
      status: dailyStatus, current: dailyUsed, limit: dailyLimit,
      currentLabel: fmtMoney(dailyUsed), limitLabel: fmtMoney(dailyLimit),
      reason: dailyStatus === 'BREACH'
        ? `Today's loss ${fmtMoney(dailyUsed)} reached the ${fmtMoney(dailyLimit)} daily limit. No new risk today.`
        : `Today's loss ${fmtMoney(dailyUsed)} of ${fmtMoney(dailyLimit)} daily limit.`,
      enabled: config?.dailyLoss?.enabled !== false,
    },
    {
      id: 'maxDrawdown', name: 'Max Drawdown',
      status: ddStatus, current: ddUsed, limit: ddLimit,
      currentLabel: fmtMoney(ddUsed), limitLabel: fmtMoney(ddLimit),
      reason: `Drawdown ${fmtMoney(ddUsed)} from peak ${fmtMoney(peak)} against a ${fmtMoney(ddLimit)} limit.`,
      enabled: config?.maxDrawdown?.enabled !== false,
    },
    {
      id: 'tradingDays', name: 'Trading Days',
      status: daysStatus, current: dayCount, limit: daysRequired,
      currentLabel: `${dayCount}`, limitLabel: `${daysRequired} required`,
      reason: `Traded on ${dayCount} of ${daysRequired} required days.`,
      enabled: config?.tradingDays?.enabled !== false,
    },
    {
      id: 'consistency', name: 'Consistency',
      status: consStatus,
      current: consPct, limit: Number.isFinite(consLimit) ? consLimit : 30,
      currentLabel: consPct === null ? '—' : `${consPct.toFixed(1)}%`,
      limitLabel: `${Number.isFinite(consLimit) ? consLimit : 30}% limit`,
      reason: !consEnabled ? 'Consistency rule is disabled.'
        : consPct === null ? 'Not enough profit history to measure consistency yet.'
        : `Best day is ${consPct.toFixed(1)}% of total profit (limit ${(Number.isFinite(consLimit) ? consLimit : 30).toFixed(1)}%).`,
      enabled: consEnabled,
    },
  ];

  const overall = worstStatus(rules.map((r) => r.status));
  return {
    size: startBal, balance, equity, equityAvailable, currency,
    openCount: openTrades.length,
    profit: { current: profit, target: ptTarget, pct: ptPct },
    daily: { used: dailyUsed, limit: dailyLimit, status: dailyStatus },
    dd: { used: ddUsed, limit: ddLimit, status: ddStatus, peak },
    days: { count: dayCount, required: daysRequired, status: daysStatus },
    cons: { pct: consPct, limit: Number.isFinite(consLimit) ? consLimit : 30, enabled: consEnabled, status: consStatus },
    rules, overall,
  };
}

// ---- Overall banner ----
function overallBadge(overall) {
  const s = normalizeStatus(overall);
  if (s === 'BREACH') return `<span class="badge badge-sl">× BREACH</span>`;
  if (s === 'CRITICAL') return `<span class="badge prop-badge-critical">! CRITICAL</span>`;
  if (s === 'WARNING') return `<span class="badge prop-badge-warning">! WARNING</span>`;
  return `<span class="badge badge-tp">✓ SAFE</span>`;
}

function renderStatusBanner(state) {
  const overall = normalizeStatus(state?.overall);
  const rules = Array.isArray(state?.rules) ? state.rules : [];
  const okCount = rules.filter((r) => normalizeStatus(r.status, r.enabled) === 'SAFE').length;
  const riskRules = rules.filter((r) => ['dailyLoss', 'maxDrawdown'].includes(String(r.id)));
  const riskOk = riskRules.filter((r) => ['SAFE', 'DISABLED'].includes(normalizeStatus(r.status, r.enabled))).length;
  const cls = overall.toLowerCase();
  return `
    <section class="prop-status-banner is-${escapeHtml(cls)}" aria-label="Account status">
      <div class="prop-banner-title">ACCOUNT STATUS ${overallBadge(overall)}</div>
      <div class="prop-banner-lines">
        <div>Rules OK: ${escapeHtml(String(okCount))}/${escapeHtml(String(rules.length))}</div>
        <div>Risk OK: ${escapeHtml(String(riskOk))}/${escapeHtml(String(riskRules.length))} (daily loss + max drawdown)</div>
      </div>
    </section>
  `;
}

// ---- Page ----
let propBound = false;

export function renderProp() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page" id="prop-page">
      <div class="page-header">
        <div>
          <h1 class="page-title">Prop Dashboard</h1>
          <p class="page-subtitle">Funded-account guardrails — read-only, never touches balances</p>
        </div>
        <button class="btn btn-secondary" id="prop-edit-btn">EDIT RULES</button>
      </div>
      <div id="prop-body" aria-live="polite"><div class="empty-state"><h3>Loading prop state…</h3></div></div>
    </div>
  `;
  bindNavbar();
  if (!propBound) {
    propBound = true;
    document.getElementById('app')?.addEventListener('click', onPropClick);
    document.getElementById('app')?.addEventListener('change', onPropChange);
  }
  void refreshProp();
}

async function refreshProp() {
  const user = getCurrentUser();
  const body = document.getElementById('prop-body');
  if (!user || !body) return;
  await loadEngines();

  let folders = [];
  try { folders = getFolders(user) || []; } catch { folders = []; }
  if (!folders.length) {
    body.innerHTML = `<div class="empty-state"><h3>No accounts yet</h3><p>Create an account first, then return to the prop dashboard.</p></div>`;
    document.getElementById('prop-edit-btn')?.setAttribute('disabled', 'true');
    return;
  }
  document.getElementById('prop-edit-btn')?.removeAttribute('disabled');

  const accountId = getSelectedAccountId(user, folders);
  setSelectedAccountId(user, accountId);
  const account = folders.find((f) => String(f.id) === String(accountId)) || folders[0];

  let trades = [];
  try { trades = getTrades(account.id) || []; } catch { trades = []; }

  const { config, isDefault } = resolveConfig(user, account);
  let state = computeLocalState(account, trades, config);
  let engineNote = '';

  // Prefer engine state when the module exists and returns a usable shape.
  if (engineMod) {
    try {
      const raw = callFirst(engineMod, ['getAccountPropState', 'getPropState'], [
        [user, account.id], [account.id], [user], [account],
      ]);
      const merged = mergeEngineState(raw, state);
      if (merged) { state = merged; engineNote = ''; }
    } catch { /* local fallback stands */ }
    try {
      const evaled = callFirst(engineMod, ['evaluatePropRules'], [
        [user, account.id, trades], [account.id, trades], [trades],
      ]);
      const mergedRules = normalizeEngineRules(evaled);
      if (mergedRules && mergedRules.length) {
        state = { ...state, rules: mergedRules, overall: worstStatus(mergedRules.map((r) => r.status)) };
      }
    } catch { /* local fallback stands */ }
    try {
      const st = callFirst(engineMod, ['getPropStatus'], [
        [user, account.id], [account.id], [state],
      ]);
      const norm = normalizeStatus(typeof st === 'string' ? st : st?.status ?? st?.overall);
      if (st !== undefined && (typeof st === 'string' || st?.status || st?.overall)) {
        state = { ...state, overall: norm };
      }
    } catch { /* local fallback stands */ }
  }

  const engineBanner = enginesUnavailable
    ? `<div class="card" role="note" style="margin-bottom:var(--space-lg);"><p class="prop-card-note">Prop engine unavailable — showing local read-only estimates from recorded trades.</p></div>`
    : '';
  const configNote = isDefault
    ? `<div class="card" role="note" style="margin-bottom:var(--space-lg);"><p class="prop-card-note">No custom prop config for this account — using default rule limits. Use EDIT RULES to configure.</p></div>`
    : '';
  const tradesNote = !trades.length
    ? `<div class="empty-state"><h3>No trades yet for this account</h3><p>Prop cards below show limits with zero usage until the first trade is recorded.</p></div>`
    : '';

  const pt = state.profit;
  const ptPct = Number.isFinite(pt.pct) ? pt.pct : 0;
  const ptBarMax = pt.target > 0 ? pt.target : 100;

  body.innerHTML = `
    ${engineBanner}
    <div class="prop-selector-row">
      <div class="form-group">
        <label class="form-label" for="prop-account">Account</label>
        <select id="prop-account">
          ${folders.map((f) => `<option value="${escapeHtml(String(f.id))}" ${String(f.id) === String(account.id) ? 'selected' : ''}>${escapeHtml(String(f.name || 'Account'))} (${escapeHtml(String(f.currency || 'USD'))})</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="prop-account-header"><h2>PROP ACCOUNT — ${escapeHtml(String(account.name || 'Account'))}</h2></div>
    <div class="prop-summary-grid">
      ${renderPropSummary({ size: state.size, balance: state.balance, equity: state.equity, equityAvailable: state.equityAvailable, currency: state.currency })}
    </div>
    ${configNote}
    ${tradesNote}
    ${engineNote}
    <h3 class="prop-section-title">Targets &amp; limits</h3>
    <div class="prop-grid">
      <div class="card" aria-label="Profit target">
        <div class="prop-card-head"><h3>PROFIT TARGET</h3>${statusBadge(state.rules.find((r) => r.id === 'profitTarget')?.status)}</div>
        <div class="prop-card-vals"><strong>${escapeHtml(fmtMoney(pt.current))}</strong><span> / ${escapeHtml(fmtMoney(pt.target))} · ${escapeHtml(ptPct.toFixed(1))}%</span></div>
        ${renderDrawdownMeter({ value: Math.max(0, pt.current), max: ptBarMax, status: 'SAFE', label: '', ariaLabel: 'Profit target progress' })}
      </div>
      <div class="card" aria-label="Daily loss">
        <div class="prop-card-head"><h3>DAILY LOSS</h3>${statusBadge(state.daily.status, config?.dailyLoss?.enabled)}</div>
        <div class="prop-card-vals"><strong>${escapeHtml(fmtMoney(state.daily.used))}</strong><span> / ${escapeHtml(fmtMoney(state.daily.limit))}</span></div>
        ${renderDrawdownMeter({ value: state.daily.used, max: state.daily.limit > 0 ? state.daily.limit : 100, status: state.daily.status, enabled: config?.dailyLoss?.enabled, label: '', ariaLabel: 'Daily loss usage' })}
      </div>
      <div class="card" aria-label="Max drawdown">
        <div class="prop-card-head"><h3>MAX DRAWDOWN</h3>${statusBadge(state.dd.status, config?.maxDrawdown?.enabled)}</div>
        <div class="prop-card-vals"><strong>${escapeHtml(fmtMoney(state.dd.used))}</strong><span> / ${escapeHtml(fmtMoney(state.dd.limit))}</span></div>
        ${renderDrawdownMeter({ value: state.dd.used, max: state.dd.limit > 0 ? state.dd.limit : 100, status: state.dd.status, enabled: config?.maxDrawdown?.enabled, label: '', ariaLabel: 'Max drawdown usage' })}
      </div>
      <div class="card" aria-label="Trading days">
        <div class="prop-card-head"><h3>TRADING DAYS</h3>${statusBadge(state.days.status, config?.tradingDays?.enabled)}</div>
        <div class="prop-card-vals"><strong>${escapeHtml(String(state.days.count))}</strong><span> / ${escapeHtml(String(state.days.required))} required</span></div>
      </div>
      ${renderConsistencyCard({ pct: state.cons.pct, limit: state.cons.limit, enabled: state.cons.enabled, status: state.cons.status })}
    </div>
    <h3 class="prop-section-title">Rule monitor</h3>
    <div class="prop-rule-list" id="prop-rule-list">
      ${state.rules.map((r) => renderPropRuleCard({ rule: r })).join('')}
    </div>
    ${renderStatusBanner(state)}
  `;
}

function mergeEngineState(raw, fallback) {
  if (!raw || typeof raw !== 'object') return null;
  const pickNum = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };
  const size = pickNum(raw.size, raw.accountSize, raw.startingBalance, fallback.size);
  const balance = pickNum(raw.balance, raw.currentBalance, fallback.balance);
  const equity = pickNum(raw.equity);
  const equityAvailable = raw.equityAvailable === true || (equity !== undefined && raw.equityAvailable !== false && (raw.hasOpenPositions === true || raw.openPositions > 0 || fallback.openCount > 0));
  return {
    ...fallback,
    size: size ?? fallback.size,
    balance: balance ?? fallback.balance,
    // Never fabricate: only adopt engine equity when explicitly available + finite.
    equity: equityAvailable && equity !== undefined ? equity : null,
    equityAvailable: equityAvailable === true && equity !== undefined ? true : false,
    currency: raw.currency || fallback.currency,
  };
}

function normalizeEngineRules(evaled) {
  const list = Array.isArray(evaled) ? evaled : evaled?.rules;
  if (!Array.isArray(list) || !list.length) return null;
  return list.map((r) => {
    if (!r || typeof r !== 'object') return null;
    const cur = r.current ?? r.used ?? r.value ?? null;
    const lim = r.limit ?? r.max ?? r.threshold ?? null;
    return {
      id: String(r.id ?? r.ruleId ?? r.key ?? Math.random().toString(36).slice(2)),
      name: String(r.name ?? r.label ?? r.title ?? 'Rule'),
      status: normalizeStatus(r.status ?? r.state, r.enabled),
      current: Number.isFinite(Number(cur)) ? Number(cur) : cur,
      limit: Number.isFinite(Number(lim)) ? Number(lim) : lim,
      currentLabel: r.currentLabel ?? (Number.isFinite(Number(cur)) ? fmtMoney(cur) : '—'),
      limitLabel: r.limitLabel ?? (Number.isFinite(Number(lim)) ? fmtMoney(lim) : '—'),
      reason: String(r.reason ?? r.message ?? r.detail ?? ''),
      enabled: r.enabled !== false,
    };
  }).filter(Boolean);
}

// ---- Events (delegated; survives re-renders) ----
function onPropClick(e) {
  const page = document.getElementById('prop-page');
  if (!page) return;
  if (e.target?.closest?.('#prop-edit-btn')) {
    openEditModal();
    return;
  }
  const toggle = e.target?.closest?.('[data-action="prop-toggle-rule"]');
  if (toggle && page.contains(toggle)) {
    const card = toggle.closest('.prop-rule-row');
    const reason = card?.querySelector('.prop-rule-reason');
    if (reason) {
      const hidden = reason.hasAttribute('hidden');
      if (hidden) reason.removeAttribute('hidden');
      else reason.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', hidden ? 'true' : 'false');
    }
    return;
  }
  if (e.target?.closest?.('#prop-modal-close')) { hideModal(); return; }
  if (e.target?.closest?.('#prop-edit-cancel')) { hideModal(); return; }
  if (e.target?.closest?.('#prop-reset-defaults')) { void resetConfig(); return; }
  if (e.target?.closest?.('#prop-edit-save')) { void saveConfig(); }
}

function onPropChange(e) {
  const page = document.getElementById('prop-page');
  if (!page) return;
  if (e.target?.id === 'prop-account') {
    const user = getCurrentUser();
    if (user) setSelectedAccountId(user, e.target.value);
    void refreshProp();
  }
}

// ---- Edit modal ----
async function openEditModal() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  await loadEngines();
  let folders = [];
  try { folders = getFolders(user) || []; } catch { folders = []; }
  const accountId = getSelectedAccountId(user, folders);
  const account = folders.find((f) => String(f.id) === String(accountId)) || folders[0];
  if (!account) return showToast('No account selected', 'error');
  const { config } = resolveConfig(user, account);

  const numField = (ruleKey, field, label, value, step = 'any') => `
    <div class="form-group" style="margin-bottom:0;">
      <label class="form-label" for="prop-${escapeHtml(ruleKey)}-${escapeHtml(field)}">${escapeHtml(label)}</label>
      <input type="number" step="${escapeHtml(step)}" min="0" id="prop-${escapeHtml(ruleKey)}-${escapeHtml(field)}" value="${escapeHtml(String(value ?? ''))}">
    </div>
  `;
  const ruleBlock = (ruleKey, title, cfg, limitLabel, limitField, limitValue) => `
    <div class="prop-edit-row" data-rule="${escapeHtml(ruleKey)}">
      <h4>${escapeHtml(title)}</h4>
      <div class="prop-edit-grid">
        ${numField(ruleKey, limitField, limitLabel, limitValue)}
        ${ruleKey === 'tradingDays' ? '' : numField(ruleKey, 'warningPct', 'Warning %', cfg?.warningPct ?? 70)}
        ${ruleKey === 'tradingDays' || ruleKey === 'consistency' ? '' : numField(ruleKey, 'criticalPct', 'Critical %', cfg?.criticalPct ?? 90)}
        ${ruleKey === 'consistency' ? numField(ruleKey, 'limitPct', 'Limit %', cfg?.limitPct ?? 30) : ''}
      </div>
      <label class="prop-edit-check" style="margin-top:8px;">
        <input type="checkbox" id="prop-${escapeHtml(ruleKey)}-enabled" ${cfg?.enabled !== false ? 'checked' : ''}> Enabled
      </label>
    </div>
  `;

  showModal(`
    <div class="modal-header">
      <h3 class="modal-title">Edit prop rules — ${escapeHtml(String(account.name || 'Account'))}</h3>
      <button class="modal-close" id="prop-modal-close">×</button>
    </div>
    ${ruleBlock('profitTarget', 'Profit Target', config.profitTarget, 'Target $', 'target', config.profitTarget?.target)}
    ${ruleBlock('dailyLoss', 'Daily Loss', config.dailyLoss, 'Limit $', 'limit', config.dailyLoss?.limit)}
    ${ruleBlock('maxDrawdown', 'Max Drawdown', config.maxDrawdown, 'Limit $', 'limit', config.maxDrawdown?.limit)}
    ${ruleBlock('tradingDays', 'Trading Days', config.tradingDays, 'Required days', 'required', config.tradingDays?.required)}
    ${ruleBlock('consistency', 'Consistency', config.consistency, 'Limit %', 'limitPct', config.consistency?.limitPct)}
    <div class="form-actions">
      <button type="button" class="btn btn-ghost btn-sm" id="prop-reset-defaults">RESET TO DEFAULTS</button>
      <button type="button" class="btn btn-secondary" id="prop-edit-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="prop-edit-save">SAVE</button>
    </div>
  `);
}

function readEditForm() {
  const val = (id) => document.getElementById(id)?.value ?? '';
  const checked = (id) => document.getElementById(id)?.checked === true;
  const n = (id) => {
    const raw = val(id);
    if (raw === '') return undefined;
    const x = Number(raw);
    return Number.isFinite(x) ? x : undefined;
  };
  return {
    profitTarget: { target: n('prop-profitTarget-target'), warningPct: n('prop-profitTarget-warningPct'), criticalPct: n('prop-profitTarget-criticalPct'), enabled: checked('prop-profitTarget-enabled') },
    dailyLoss: { limit: n('prop-dailyLoss-limit'), warningPct: n('prop-dailyLoss-warningPct'), criticalPct: n('prop-dailyLoss-criticalPct'), enabled: checked('prop-dailyLoss-enabled') },
    maxDrawdown: { limit: n('prop-maxDrawdown-limit'), warningPct: n('prop-maxDrawdown-warningPct'), criticalPct: n('prop-maxDrawdown-criticalPct'), enabled: checked('prop-maxDrawdown-enabled') },
    tradingDays: { required: n('prop-tradingDays-required'), enabled: checked('prop-tradingDays-enabled') },
    consistency: { limitPct: n('prop-consistency-limitPct'), enabled: checked('prop-consistency-enabled') },
  };
}

function cleanUpdates(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function saveConfig() {
  const user = getCurrentUser();
  let folders = [];
  try { folders = getFolders(user) || []; } catch { folders = []; }
  const accountId = getSelectedAccountId(user, folders);
  if (!accountId) return showToast('No account selected', 'error');
  const edits = readEditForm();

  if (rulesMod && typeof (rulesMod.updatePropRule ?? rulesMod.default?.updatePropRule) === 'function') {
    const updateFn = rulesMod.updatePropRule ?? rulesMod.default.updatePropRule;
    let ok = true;
    for (const [ruleId, updates] of Object.entries(edits)) {
      const clean = cleanUpdates(updates);
      let saved = false;
      for (const args of [[user, accountId, ruleId, clean], [accountId, ruleId, clean], [ruleId, clean]]) {
        try {
          const r = updateFn(...args);
          if (r && typeof r.then === 'function') await r;
          saved = true;
          break;
        } catch { /* next signature */ }
      }
      if (!saved) ok = false;
    }
    if (!ok) return showToast('Some rules could not be saved', 'error');
  } else {
    // Local fallback persistence (separate key — never touches balances).
    try {
      const account = folders.find((f) => String(f.id) === String(accountId));
      const { config: base } = readLocalConfig(user, accountId, account);
      const merged = {};
      for (const [k, v] of Object.entries(edits)) {
        merged[k] = { ...(base[k] || {}), ...cleanUpdates(v) };
      }
      localStorage.setItem(propCfgKey(user, accountId), JSON.stringify(merged));
    } catch {
      return showToast('Could not save prop config', 'error');
    }
  }
  auditPropConfigUpdated(user, accountId);
  hideModal();
  showToast('Prop rules saved');
  void refreshProp();
}

async function resetConfig() {
  const user = getCurrentUser();
  let folders = [];
  try { folders = getFolders(user) || []; } catch { folders = []; }
  const accountId = getSelectedAccountId(user, folders);
  if (!accountId) return showToast('No account selected', 'error');

  if (rulesMod && typeof (rulesMod.resetPropConfig ?? rulesMod.default?.resetPropConfig) === 'function') {
    const resetFn = rulesMod.resetPropConfig ?? rulesMod.default.resetPropConfig;
    let done = false;
    for (const args of [[user, accountId], [accountId], [user]]) {
      try {
        const r = resetFn(...args);
        if (r && typeof r.then === 'function') await r;
        done = true;
        break;
      } catch { /* next signature */ }
    }
    if (!done) return showToast('Could not reset prop config', 'error');
  } else {
    try { localStorage.removeItem(propCfgKey(user, accountId)); } catch { /* offline-safe */ }
  }
  auditPropConfigUpdated(user, accountId);
  hideModal();
  showToast('Prop config reset to defaults');
  void refreshProp();
}
