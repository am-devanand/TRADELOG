import '../../css/phase8.css';
import '../../css/pagesPhase8.css';
import { getCurrentUser, getFolders } from '../utils/storage.js';
import { getOpenTrades, getClosedTrades } from '../utils/executedTrades.js';
import { getSetupsByStatus } from '../utils/setups.js';
import { getReviewByTradeId } from '../utils/tradeReviews.js';
import { getAccountPropState } from '../utils/propEngine.js';
import { getTradeDataset, getCoreMetrics } from '../utils/tradingAnalytics.js';
import {
  getLockState,
  setLock,
  canExecute,
  renderTradingLock,
  bindTradingLock,
} from '../components/tradingLock.js';
import {
  navigate,
  escapeHtml,
  formatCurrency,
} from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import { bindSyncStatus, startAllSyncStatusWatchers } from '../components/syncStatus.js';

function accountSelKey(user) {
  return `tradelog_command_account_${String(user || '').trim().toLowerCase()}`;
}

function getSelectedAccount(user, folders) {
  let sel = null;
  try {
    sel = localStorage.getItem(accountSelKey(user));
  } catch {
    sel = null;
  }
  if (sel && folders.some((f) => String(f.id) === String(sel))) return sel;
  try {
    const propSel = localStorage.getItem(`tradelog_prop_account_${String(user || '').trim().toLowerCase()}`);
    if (propSel && folders.some((f) => String(f.id) === String(propSel))) return propSel;
  } catch {
    /* ignore */
  }
  return folders.length ? folders[0].id : '';
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function setupPair(s) {
  const v = s?.pair ?? s?.market?.pair ?? '';
  return String(v || '—');
}

function setupDirection(s) {
  const v = s?.direction ?? s?.market?.direction ?? '';
  return String(v || '').toUpperCase();
}

function propBannerHtml(state, accountName) {
  const status = String(state?.status || 'SAFE').toUpperCase();
  const badge = status === 'BREACH'
    ? '<span class="badge badge-sl">× BREACH</span>'
    : status === 'CRITICAL'
      ? '<span class="badge badge-sl">! CRITICAL</span>'
      : status === 'WARNING'
        ? '<span class="badge badge-gold">! WARNING</span>'
        : '<span class="badge badge-tp">✓ SAFE</span>';
  const rules = Array.isArray(state?.rules) ? state.rules : [];
  const okCount = rules.filter((r) => String(r?.status || '').toUpperCase() === 'SAFE').length;
  return `
    <section class="card cc-prop" aria-label="Account prop status" data-cc="prop">
      <div class="p8-lock-head">
        <h2 class="p8-title">Prop status — ${escapeHtml(accountName)}</h2>
        ${badge}
      </div>
      <p class="p8-sub">Rules OK: ${escapeHtml(String(okCount))}/${escapeHtml(String(rules.length))} · funded-account guardrails stay read-only here.</p>
      <div class="p8-actions">
        <a class="btn btn-secondary" href="#/prop">OPEN PROP DASHBOARD</a>
      </div>
    </section>`;
}

function kpiHtml(kind, label, value, sub, valueCls) {
  return `
    <section class="card cc-kpi" aria-label="${escapeHtml(label)}" data-cc="${escapeHtml(kind)}">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value ${escapeHtml(valueCls || '')}">${value}</div>
      ${sub ? `<div class="p8-muted">${sub}</div>` : ''}
    </section>`;
}

function tradeRowHtml(t) {
  const id = escapeHtml(String(t?.id ?? ''));
  const pair = escapeHtml(String(t?.pair ?? '—'));
  const dir = String(t?.direction || '').toUpperCase();
  const dirCls = dir === 'SHORT' ? 'trade-dir-short' : 'trade-dir-long';
  const dirArrow = dir === 'SHORT' ? '▼ SHORT' : '▲ LONG';
  const entry = t?.entryPrice ?? t?.entry;
  const sl = t?.stopLoss ?? t?.currentSL;
  const tp = t?.takeProfit ?? t?.currentTP;
  const status = String(t?.status || 'OPEN').toUpperCase();
  const statusBadge = status === 'PARTIALLY_CLOSED'
    ? '<span class="badge badge-gold">◐ PARTIAL</span>'
    : '<span class="badge badge-tp">● OPEN</span>';
  return `
    <article class="card cc-row" data-trade-id="${id}">
      <div class="cc-row-head">
        <span class="setup-card-pair">${pair} <span class="trade-dir ${dirCls}">${escapeHtml(dirArrow)}</span></span>
        ${statusBadge}
      </div>
      <div class="cc-row-meta">
        <span>Entry <strong>${entry != null && entry !== '' ? escapeHtml(fmtNum(entry)) : '—'}</strong></span>
        <span>SL <strong>${sl != null && sl !== '' ? escapeHtml(fmtNum(sl)) : '—'}</strong></span>
        <span>TP <strong>${tp != null && tp !== '' ? escapeHtml(fmtNum(tp)) : '—'}</strong></span>
      </div>
      <div class="p8-actions">
        <a class="btn btn-primary" href="#/trade/${id}">MANAGE</a>
        <a class="btn btn-secondary" href="#/trade/${id}">CLOSE</a>
      </div>
    </article>`;
}

function setupRowHtml(s, locked) {
  const id = escapeHtml(String(s?.id ?? ''));
  const pair = escapeHtml(setupPair(s));
  const dir = setupDirection(s);
  const dirCls = dir === 'SHORT' ? 'trade-dir-short' : 'trade-dir-long';
  const score = s?.checklistScore ?? s?.score;
  const enter = locked
    ? '<button class="btn btn-secondary" disabled aria-disabled="true" title="Trading is locked — new executions are blocked">🔒 LOCKED</button>'
    : `<a class="btn btn-primary" href="#/trade/new" data-enter-setup="${id}">ENTER TRADE</a>`;
  return `
    <article class="card cc-row" data-setup-id="${id}">
      <div class="cc-row-head">
        <span class="setup-card-pair">${pair} ${dir ? `<span class="trade-dir ${dirCls}">${escapeHtml(dir === 'SHORT' ? '▼ SHORT' : '▲ LONG')}</span>` : ''}</span>
        <span class="badge badge-gold">SETUP</span>
      </div>
      <div class="cc-row-meta">
        <span>Score <strong>${score != null && score !== '' ? escapeHtml(String(score)) : '—'}</strong></span>
        <span>Session <strong>${escapeHtml(String(s?.session ?? s?.market?.session ?? '—'))}</strong></span>
        <span>TF <strong>${escapeHtml(String(s?.timeframe ?? s?.market?.timeframe ?? '—'))}</strong></span>
      </div>
      <div class="p8-actions">
        ${enter}
      </div>
    </article>`;
}

function reviewRowHtml(t) {
  const id = escapeHtml(String(t?.id ?? ''));
  const pair = escapeHtml(String(t?.pair ?? '—'));
  const r = t?.rMultiple ?? t?.realizedR;
  const rTxt = r != null && Number.isFinite(Number(r)) ? `${Number(r) >= 0 ? '+' : '−'}${Math.abs(Number(r)).toFixed(2)}R` : '—';
  return `
    <article class="card cc-row" data-trade-id="${id}">
      <div class="cc-row-head">
        <span class="setup-card-pair">${pair}</span>
        <span class="badge badge-gold">○ REVIEW PENDING</span>
      </div>
      <div class="cc-row-meta"><span>R <strong>${escapeHtml(rTxt)}</strong></span></div>
      <div class="p8-actions">
        <a class="btn btn-secondary" href="#/trade/${id}/review">REVIEW</a>
        <a class="btn btn-ghost" href="#/trade/${id}">VIEW</a>
      </div>
    </article>`;
}

export function renderCommandCenter() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const folders = (() => {
    try {
      return getFolders(user) || [];
    } catch {
      return [];
    }
  })();
  const app = document.getElementById('app');

  if (!folders.length) {
    app.innerHTML = `
      ${renderNavbar()}
      <div class="page">
        <div class="page-header"><div>
          <h1 class="page-title">Command Center</h1>
          <p class="page-subtitle">Today at a glance</p>
        </div></div>
        <div class="empty-state"><h3>No accounts yet</h3><p>Create an account on the Home page to unlock the command view.</p>
        <p><a class="btn btn-primary" href="#/home">GO TO HOME</a></p></div>
      </div>`;
    bindNavbar();
    return;
  }

  const accountId = getSelectedAccount(user, folders);
  try {
    localStorage.setItem(accountSelKey(user), String(accountId));
  } catch {
    /* ignore */
  }
  const account = folders.find((f) => String(f.id) === String(accountId)) || folders[0];
  const currency = account?.currency || 'USD';

  let propState = null;
  try {
    propState = getAccountPropState(String(account.id), user);
  } catch {
    propState = null;
  }

  let openTrades = [];
  let closedTrades = [];
  try {
    openTrades = getOpenTrades(user, String(account.id)) || [];
  } catch {
    openTrades = [];
  }
  try {
    closedTrades = getClosedTrades(user, String(account.id)) || [];
  } catch {
    closedTrades = [];
  }
  const closedToday = closedTrades.filter((t) => isToday(t?.closedAt));
  const todayPnl = closedToday.reduce((sum, t) => sum + (Number.isFinite(Number(t?.pnl)) ? Number(t.pnl) : 0), 0);

  let readySetups = [];
  let waitingSetups = [];
  try {
    readySetups = getSetupsByStatus(user, 'READY').filter((s) => !s?.accountId || String(s.accountId) === String(account.id));
  } catch {
    readySetups = [];
  }
  try {
    waitingSetups = getSetupsByStatus(user, 'WAITING').filter((s) => !s?.accountId || String(s.accountId) === String(account.id));
  } catch {
    waitingSetups = [];
  }

  let reviewQueue = [];
  try {
    reviewQueue = closedTrades.filter((t) => {
      if (!t || !t.id) return false;
      const r = getReviewByTradeId(user, t.id);
      return !r || String(r.status || '').toUpperCase() !== 'COMPLETED';
    });
  } catch {
    reviewQueue = [];
  }

  let processKpi = '—';
  let processSub = 'No completed data yet';
  try {
    const dataset = getTradeDataset(String(account.id), { user });
    const metrics = getCoreMetrics(dataset);
    if (metrics && metrics.avgProcessScore != null) {
      processKpi = escapeHtml(String(fmtNum(metrics.avgProcessScore)));
      processSub = `Avg process score · n=${escapeHtml(String(metrics.sampleSize ?? 0))}`;
    } else if (metrics) {
      processSub = `n=${escapeHtml(String(metrics.sampleSize ?? 0))} · no scores yet`;
    }
  } catch {
    /* keep placeholder */
  }

  const lockState = getLockState(user);
  const gate = canExecute(user);
  const locked = gate.allowed !== true;

  const balance = Number(account?.currentBalance);
  const balanceTxt = Number.isFinite(balance) ? escapeHtml(formatCurrency(balance, currency)) : '—';
  const pnlCls = todayPnl > 0 ? 'positive' : todayPnl < 0 ? 'negative' : '';
  const pnlTxt = `${todayPnl > 0 ? '+' : todayPnl < 0 ? '−' : ''}${escapeHtml(formatCurrency(Math.abs(todayPnl), currency).replace('-', ''))}`;

  app.innerHTML = `
    ${renderNavbar()}
    <div class="page cc-page">
      <div class="page-header">
        <div>
          <h1 class="page-title">Command Center</h1>
          <p class="page-subtitle">Today at a glance — status, exposure, and what needs you next</p>
        </div>
        <div class="form-group" style="margin-bottom:0;min-width:200px;">
          <label class="form-label" for="cc-account">Account</label>
          <select id="cc-account">
            ${folders.map((f) => `<option value="${escapeHtml(String(f.id))}" ${String(f.id) === String(account.id) ? 'selected' : ''}>${escapeHtml(String(f.name || 'Account'))}</option>`).join('')}
          </select>
        </div>
      </div>
      ${locked ? '<div class="card cc-locked-strip" role="alert"><span class="badge badge-sl">🔒 LOCKED — NEW TRADES BLOCKED</span><span class="p8-muted">Managing open trades and closing remain available.</span></div>' : ''}
      <div class="card cc-section" aria-label="Sync status" data-cc="sync">
        <div data-sync-status-root data-sync-compact="false"></div>
      </div>
      <div class="cc-grid">
        ${propState && propState.success !== false ? propBannerHtml(propState, account.name || 'Account') : `
        <section class="card cc-prop" aria-label="Account prop status" data-cc="prop">
          <div class="p8-lock-head"><h2 class="p8-title">Prop status — ${escapeHtml(String(account.name || 'Account'))}</h2>
          <span class="badge">? N/A</span></div>
          <p class="p8-sub">Prop state unavailable — showing account data only.</p>
          <div class="p8-actions"><a class="btn btn-secondary" href="#/prop">OPEN PROP DASHBOARD</a></div>
        </section>`}
        ${kpiHtml('balance', 'Balance', balanceTxt, escapeHtml(String(account.name || '')))}
        ${kpiHtml('today', "Today's P/L", pnlTxt, `${escapeHtml(String(closedToday.length))} closed today`, pnlCls)}
        ${kpiHtml('process', 'Process KPI', processKpi, processSub)}
        <section class="card cc-section" aria-label="Active trades" data-cc="active">
          <div class="p8-lock-head"><h2 class="p8-title">Active trades</h2>
          <span class="badge badge-tp">● ${escapeHtml(String(openTrades.length))} OPEN</span></div>
          ${openTrades.length ? `<div class="cc-rows">${openTrades.map((t) => tradeRowHtml(t)).join('')}</div>`
            : '<div class="empty-state"><h3>No active trades</h3><p>Executed OPEN trades appear here for management.</p></div>'}
        </section>
        <section class="card cc-section" aria-label="Ready setups" data-cc="ready">
          <div class="p8-lock-head"><h2 class="p8-title">Ready setups</h2>
          ${locked ? '<span class="badge badge-sl">🔒 LOCKED</span>' : `<span class="badge badge-tp">✓ ${escapeHtml(String(readySetups.length))} READY</span>`}</div>
          ${locked ? '<p class="p8-sub">New executions are blocked while locked — existing setups stay visible.</p>' : ''}
          ${readySetups.length ? `<div class="cc-rows">${readySetups.map((s) => setupRowHtml(s, locked)).join('')}</div>`
            : '<div class="empty-state"><h3>No ready setups</h3><p>Setups that pass every check appear here.</p></div>'}
        </section>
        <section class="card cc-section" aria-label="Waiting setups" data-cc="waiting">
          <div class="p8-lock-head"><h2 class="p8-title">Waiting setups</h2>
          <span class="badge badge-gold">○ ${escapeHtml(String(waitingSetups.length))} WAITING</span></div>
          ${waitingSetups.length ? `<div class="cc-rows">${waitingSetups.map((s) => setupRowHtml(s, true)).join('')}</div>`
            : '<div class="empty-state"><h3>No waiting setups</h3><p>Incomplete ideas wait here until they qualify.</p></div>'}
        </section>
        <section class="card cc-section" aria-label="Review queue" data-cc="review">
          <div class="p8-lock-head"><h2 class="p8-title">Review queue</h2>
          <span class="badge badge-gold">○ ${escapeHtml(String(reviewQueue.length))} PENDING</span></div>
          ${reviewQueue.length ? `<div class="cc-rows">${reviewQueue.slice(0, 6).map(reviewRowHtml).join('')}</div>`
            : '<div class="empty-state"><h3>Review queue clear</h3><p>Closed trades without a completed review appear here.</p></div>'}
        </section>
        <section class="card cc-section" aria-label="Trading lock" data-cc="lock">
          ${renderTradingLock(lockState)}
        </section>
        <section class="card cc-section" aria-label="Today's trading summary" data-cc="summary">
          <div class="p8-lock-head"><h2 class="p8-title">Today&apos;s summary</h2></div>
          <div class="cc-summary-grid">
            <div><div class="stat-label">Closed today</div><div class="stat-value">${escapeHtml(String(closedToday.length))}</div></div>
            <div><div class="stat-label">Realized P/L</div><div class="stat-value ${pnlCls}">${pnlTxt}</div></div>
            <div><div class="stat-label">Open now</div><div class="stat-value">${escapeHtml(String(openTrades.length))}</div></div>
            <div><div class="stat-label">Awaiting review</div><div class="stat-value">${escapeHtml(String(reviewQueue.length))}</div></div>
          </div>
          <div class="p8-actions">
            <a class="btn btn-secondary" href="#/trade">OPEN TRADE DESK</a>
            <a class="btn btn-ghost" href="#/analytics">ANALYTICS</a>
          </div>
        </section>
      </div>
    </div>`;

  bindNavbar();
  bindSyncStatus();
  startAllSyncStatusWatchers();
  document.getElementById('cc-account')?.addEventListener('change', (e) => {
    try {
      localStorage.setItem(accountSelKey(user), String(e.target.value));
    } catch {
      /* ignore */
    }
    renderCommandCenter();
  });
  bindTradingLock({
    onChange: (draft) => {
      setLock(user, draft);
      renderCommandCenter();
    },
  });
  document.querySelectorAll('[data-enter-setup]').forEach((el) => {
    el.addEventListener('click', () => {
      try {
        sessionStorage.setItem('tradelog_reopen_setup', el.getAttribute('data-enter-setup') || '');
      } catch {
        /* ignore */
      }
    });
  });
}

export default { renderCommandCenter };
