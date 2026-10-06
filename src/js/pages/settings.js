import '../../css/phase8.css';
import '../../css/pagesPhase8.css';
import Papa from 'papaparse';
import { getCurrentUser, getFolders } from '../utils/storage.js';
import { getExecutedTrades } from '../utils/executedTrades.js';
import { getReviews } from '../utils/tradeReviews.js';
import { getSetups } from '../utils/setups.js';
import { getRules } from '../utils/ruleManager.js';
import { getAuditLog } from '../utils/auditLog.js';
import { listVersionedRules, getRuleHistory } from '../utils/ruleHistory.js';
import { exportBackup, downloadBackup, restoreBackup } from '../utils/backup.js';
import {
  getTradeDataset,
  getDailyPnlSeries,
  getAllStrategyStats,
} from '../utils/tradingAnalytics.js';
import {
  renderBackupManager,
  bindBackupManager,
} from '../components/backupManager.js';
import {
  getLockState,
  setLock,
  renderTradingLock,
  bindTradingLock,
} from '../components/tradingLock.js';
import { renderAuditTimeline } from '../components/auditTimeline.js';
import {
  navigate,
  escapeHtml,
  showToast,
} from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import { bindSyncStatus, startAllSyncStatusWatchers } from '../components/syncStatus.js';

function fmtBytes(n) {
  const bytes = Number(n);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

function safeCount(fn) {
  try {
    const v = fn();
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

function downloadCsv(filename, rows) {
  if (!rows.length) {
    showToast('Nothing to export', 'error');
    return;
  }
  try {
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Exported ${rows.length} rows`);
  } catch {
    showToast('CSV export failed', 'error');
  }
}

function numOrEmpty(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

function exportTradesCsv(user) {
  let trades = [];
  try {
    trades = getExecutedTrades(user) || [];
  } catch {
    trades = [];
  }
  downloadCsv('tradelog-trades.csv', trades.map((t) => ({
    id: t?.id ?? '',
    accountId: t?.accountId ?? '',
    pair: t?.pair ?? '',
    direction: t?.direction ?? '',
    status: t?.status ?? '',
    entryPrice: numOrEmpty(t?.entryPrice),
    exitPrice: numOrEmpty(t?.exitPrice),
    stopLoss: numOrEmpty(t?.stopLoss),
    takeProfit: numOrEmpty(t?.takeProfit),
    lotSize: numOrEmpty(t?.lotSize),
    pnl: numOrEmpty(t?.pnl),
    rMultiple: numOrEmpty(t?.rMultiple),
    openedAt: t?.openedAt ?? '',
    closedAt: t?.closedAt ?? '',
    closeReason: t?.closeReason ?? '',
  })));
}

function exportReviewsCsv(user) {
  let reviews = [];
  try {
    reviews = getReviews(user) || [];
  } catch {
    reviews = [];
  }
  downloadCsv('tradelog-reviews.csv', reviews.map((r) => ({
    id: r?.id ?? '',
    tradeId: r?.tradeId ?? '',
    pair: r?.pair ?? '',
    outcome: r?.outcome ?? '',
    status: r?.status ?? '',
    total: numOrEmpty(r?.total),
    ruleAdherence: numOrEmpty(r?.ruleAdherence),
    followedPlan: r?.followedPlan === true ? 'yes' : 'no',
    createdAt: r?.createdAt ?? '',
    updatedAt: r?.updatedAt ?? '',
  })));
}

function collectAllRows(user) {
  let folders = [];
  try {
    folders = getFolders(user) || [];
  } catch {
    folders = [];
  }
  const rows = [];
  for (const f of folders) {
    try {
      const ds = getTradeDataset(String(f.id), { user });
      if (Array.isArray(ds)) rows.push(...ds);
    } catch {
      /* skip unreadable account */
    }
  }
  return rows;
}

function exportDailyCsv(user) {
  let series = [];
  try {
    series = getDailyPnlSeries(collectAllRows(user)) || [];
  } catch {
    series = [];
  }
  downloadCsv('tradelog-daily-aggregates.csv', series.map((d) => ({
    date: d?.dateISO ?? d?.date ?? '',
    trades: d?.trades ?? '',
    pnl: numOrEmpty(d?.pnl),
    totalR: numOrEmpty(d?.totalR ?? d?.r),
  })));
}

function exportStrategyCsv(user) {
  let groups = [];
  try {
    groups = getAllStrategyStats(collectAllRows(user)) || [];
  } catch {
    groups = [];
  }
  downloadCsv('tradelog-strategy-analytics.csv', groups.map((g) => ({
    strategy: g?.key ?? '',
    trades: g?.trades ?? '',
    wins: g?.wins ?? '',
    losses: g?.losses ?? '',
    winRate: numOrEmpty(g?.winRate),
    totalPnl: numOrEmpty(g?.totalPnl),
    avgR: numOrEmpty(g?.avgR),
    totalR: numOrEmpty(g?.totalR),
  })));
}

function handleExport(user, kind) {
  if (kind === 'json') {
    try {
      const backup = exportBackup(user);
      const res = downloadBackup(backup);
      if (res && res.success) showToast('Backup downloading');
      else showToast((res && res.error) || 'Backup failed', 'error');
    } catch {
      showToast('Backup failed', 'error');
    }
    return;
  }
  if (kind === 'csv-trades') return exportTradesCsv(user);
  if (kind === 'csv-reviews') return exportReviewsCsv(user);
  if (kind === 'csv-daily') return exportDailyCsv(user);
  if (kind === 'csv-strategy') return exportStrategyCsv(user);
  showToast(`Unknown export: ${kind}`, 'error');
}

function handleRestore(user, parsed, mode) {
  try {
    const res = mode === 'replace'
      ? restoreBackup(user, parsed, { mode: 'replace', confirm: true })
      : restoreBackup(user, parsed, { mode: 'copy' });
    if (res && res.success) {
      const counts = res.counts ? Object.entries(res.counts).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
      showToast(`Restore (${res.mode}) complete${counts ? ` — ${counts}` : ''}`);
    } else {
      showToast((res && res.error) || 'Restore failed', 'error');
    }
  } catch {
    showToast('Restore failed', 'error');
  }
}

async function paintStorageEstimate() {
  const el = document.getElementById('p8-storage-estimate');
  if (!el) return;
  try {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return;
    const est = await navigator.storage.estimate();
    const usage = Number(est?.usage);
    const quota = Number(est?.quota);
    if (Number.isFinite(usage) && usage >= 0) {
      const u = fmtBytes(usage);
      el.textContent = Number.isFinite(quota) && quota > 0 ? `${u} of ${fmtBytes(quota)} used` : `${u} used`;
    }
  } catch {
    /* keep the component fallback text */
  }
}

function paintLock(user) {
  const box = document.getElementById('settings-lock');
  if (!box) return;
  box.innerHTML = renderTradingLock(getLockState(user));
  bindTradingLock({
    onChange: (draft) => {
      setLock(user, draft);
      showToast(draft.enabled ? 'Trading locked' : 'Trading unlocked');
      paintLock(user);
    },
  });
}

function ruleHistoryHtml(user) {
  let ids = [];
  try {
    ids = listVersionedRules(user) || [];
  } catch {
    ids = [];
  }
  if (!ids.length) {
    return `
    <section class="card" aria-label="Rule history">
      <h3 class="p8-title">Rule history</h3>
      <p class="p8-sub">No versioned rules yet — versions are recorded the first time a rule is observed.</p>
    </section>`;
  }
  const rows = ids.slice(0, 20).map((id) => {
    let versions = 0;
    try {
      versions = (getRuleHistory(id, user) || []).length;
    } catch {
      versions = 0;
    }
    return `<li>${escapeHtml(String(id))} — <strong>v${escapeHtml(String(versions))}</strong></li>`;
  }).join('');
  return `
    <section class="card" aria-label="Rule history">
      <div class="p8-lock-head">
        <h3 class="p8-title">Rule history</h3>
        <span class="badge badge-gold">${escapeHtml(String(ids.length))} VERSIONED</span>
      </div>
      <ul class="p8-preview-list">${rows}</ul>
      ${ids.length > 20 ? `<p class="p8-muted">Showing 20 of ${escapeHtml(String(ids.length))}.</p>` : ''}
    </section>`;
}

export function renderSettings() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');

  const stats = {
    counts: {
      trades: safeCount(() => getExecutedTrades(user)),
      reviews: safeCount(() => getReviews(user)),
      setups: safeCount(() => getSetups(user)),
      rules: safeCount(() => getRules(user)),
    },
  };

  let auditEntries = [];
  try {
    auditEntries = getAuditLog(user, { limit: 50 }) || [];
  } catch {
    auditEntries = [];
  }
  const timelineEntries = [...auditEntries].reverse().map((e) => {
    const meta = e && e.metadata && typeof e.metadata === 'object' ? e.metadata : {};
    const keys = Object.keys(meta);
    return {
      ...e,
      detail: keys.length ? keys.map((k) => `${k}: ${String(meta[k])}`).join(' · ') : '',
    };
  });

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page settings-page">
      <div class="page-header">
        <div>
          <h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Data, trading lock, and audit trail</p>
        </div>
      </div>
      <div class="settings-grid">
        <section aria-label="Data">
          <div class="p8-lock-head" style="margin-bottom:8px;"><h2 class="p8-title">Data</h2></div>
          ${renderBackupManager({ stats })}
          <div class="card" aria-label="Sync status" style="margin-top:8px;">
            <div data-sync-status-root data-sync-compact="false"></div>
          </div>
          <div class="p8-actions">
            <a class="btn btn-secondary" href="#/settings/integrity">INTEGRITY CHECK</a>
          </div>
        </section>
        <section aria-label="Trading lock">
          <div class="p8-lock-head" style="margin-bottom:8px;"><h2 class="p8-title">Trading lock</h2></div>
          <div id="settings-lock"></div>
        </section>
        <section aria-label="Audit log">
          <div class="p8-lock-head" style="margin-bottom:8px;">
            <h2 class="p8-title">Audit log</h2>
            <span class="badge badge-gold">${escapeHtml(String(auditEntries.length))} RECENT</span>
          </div>
          ${renderAuditTimeline(timelineEntries, { emptyMessage: 'No audit entries yet — actions like executing trades or editing rules are recorded here.' })}
        </section>
        ${ruleHistoryHtml(user)}
      </div>
    </div>`;

  bindNavbar();
  bindSyncStatus();
  startAllSyncStatusWatchers();
  bindBackupManager({
    onExport: (kind) => handleExport(user, kind),
    onRestoreFile: (parsed, mode) => handleRestore(user, parsed, mode),
    onRunIntegrity: () => navigate('/settings/integrity'),
  });
  paintLock(user);
  void paintStorageEstimate();
}

export default { renderSettings };
