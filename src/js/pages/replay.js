// ============================================
// Replay pages — workspace (/replay) + results (/replay/:runId) (Phase 9C)
// Vanilla ESM, existing CSS system. SIMULATION ONLY: every surface carries
// a SIMULATION marker; simulated results never touch account balance, prop
// status, the calendar, or real-trade analytics.
//
// Engine calls only — no scoring/risk/RR logic reimplemented here:
//   runReplay / evaluateBar (single-bar gate: setup -> entry -> stops ->
//   risk guards -> checklist verdict) / resolveExit / simulateTrade
//   (replayEngine.js — the single source of truth for all gating)
//   getReplaySummary / getReplayStatsByDimension / getRiskDistribution /
//   compareReplays / getDeterminismDigest (replayAnalytics.js)
// ============================================
import '../../css/phase9.css';
import Papa from 'papaparse';
import Chart from 'chart.js/auto';
import { getCurrentUser, getFolders } from '../utils/storage.js';
import { getRules } from '../utils/ruleManager.js';
import {
  getStrategies,
  getStrategy,
  getCurrentStrategyVersion,
  getStrategyVersion,
} from '../utils/strategyStore.js';
import {
  runReplay,
  evaluateBar,
  normalizeCandles,
  resolveExit,
  simulateTrade,
  cursorNavState,
} from '../utils/replayEngine.js';
import {
  getReplayRuns,
  getReplayRun,
  resolveRunAccount,
  saveReplayRun,
  deleteReplayRun,
  getSimulatedTrades,
  saveSimulatedTrades,
  deleteSimulatedTrades,
} from '../utils/replayStore.js';
import {
  getReplaySummary,
  getReplayStatsByDimension,
  getRiskDistribution,
  compareReplays,
  getDeterminismDigest,
} from '../utils/replayAnalytics.js';
import {
  navigate,
  showToast,
  showConfirm,
  escapeHtml,
} from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import {
  renderChartCard,
  registerChart,
  destroyAllCharts,
} from '../components/analytics/chartCard.js';

// Module flags: delegated listeners bind once (repo duplicate-listener guard).
let workspaceBound = false;
let detailBound = false;

// Workspace state (session-scoped; candles also persisted per run for re-run).
let candles = [];
let candleErrors = [];
let candleNotices = [];
let candleSource = '';
let cursor = 0;
let lastResult = null;
let lastRunMeta = null;
let compareWith = '';

function candlesKey(user, runId) {
  return `tradelog_replay_candles_${String(user || '').trim().toLowerCase()}_${String(runId)}`;
}

function loadCandlesForRun(user, runId) {
  try {
    const raw = localStorage.getItem(candlesKey(user, runId));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function storeCandlesForRun(user, runId, list) {
  try { localStorage.setItem(candlesKey(user, runId), JSON.stringify(list)); } catch { /* offline-safe */ }
}

function simBannerHtml() {
  return `
    <div class="p9-sim-banner" role="note" aria-label="Simulation notice">
      <span class="badge badge-gold">SIMULATION</span>
      <span>Replay output is <strong>simulated</strong> — it does not affect account balance, prop status, the calendar, or real-trade analytics.</span>
    </div>`;
}

function fmtN(v, digits = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function fmtMaybe(v, suffix = '') {
  if (v === null || v === undefined) return 'N/A';
  const n = Number(v);
  return Number.isFinite(n) ? `${n}${suffix}` : 'N/A';
}

// ---- Deterministic sample series (clearly labelled generator) ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSampleSeries() {
  const rand = mulberry32(42);
  const out = [];
  let price = 100;
  const base = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 160; i += 1) {
    const drift = (rand() - 0.48) * 1.6;
    const o = price;
    const c = Math.max(1, o + drift);
    const h = Math.max(o, c) + rand() * 0.5;
    const l = Math.min(o, c) - rand() * 0.5;
    out.push({ t: base + i * 3600000, o, h, l, c, v: Math.round(500 + rand() * 500) });
    price = c;
  }
  return out;
}

// ---- CSV import (PapaParse; columns time/timestamp,open,high,low,close,volume) ----
function pickField(row, names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') return row[n];
  }
  const lower = {};
  for (const k of Object.keys(row || {})) lower[String(k).toLowerCase()] = row[k];
  for (const n of names) {
    const v = lower[String(n).toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

function parseCandlesCsv(rows) {
  const good = [];
  const errors = [];
  rows.forEach((row, i) => {
    const line = i + 2;
    const tRaw = pickField(row, ['time', 'timestamp', 'date', 'datetime']);
    const o = Number(pickField(row, ['open']));
    const h = Number(pickField(row, ['high']));
    const l = Number(pickField(row, ['low']));
    const c = Number(pickField(row, ['close']));
    const vRaw = pickField(row, ['volume', 'vol']);
    let t = Number(tRaw);
    if (!Number.isFinite(t)) {
      const parsed = Date.parse(String(tRaw ?? ''));
      t = Number.isFinite(parsed) ? parsed : NaN;
    }
    const problems = [];
    if (!Number.isFinite(t)) problems.push('bad time/timestamp');
    if (!Number.isFinite(o)) problems.push('bad open');
    if (!Number.isFinite(h)) problems.push('bad high');
    if (!Number.isFinite(l)) problems.push('bad low');
    if (!Number.isFinite(c)) problems.push('bad close');
    if (problems.length) {
      errors.push(`Row ${line}: ${problems.join(', ')} — skipped`);
      return;
    }
    good.push({ t, o, h, l, c, v: Number.isFinite(Number(vRaw)) ? Number(vRaw) : 0 });
  });
  return { good, errors };
}

// ---- Account + strategy selectors ----
function accountOptionsHtml(user, selectedId) {
  let folders = [];
  try { folders = getFolders(user) || []; } catch { folders = []; }
  if (!folders.length) return '<option value="">No accounts — create one on Home</option>';
  return folders.map((f) => `<option value="${escapeHtml(String(f.id))}" ${String(f.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(String(f.name || 'Account'))}</option>`).join('');
}

function accountById(user, id) {
  try {
    const list = getFolders(user) || [];
    return list.find((f) => String(f.id) === String(id)) || list[0] || null;
  } catch { return null; }
}

function accountBalance(acct) {
  if (!acct) return 0;
  for (const k of ['currentBalance', 'balance', 'startingBalance']) {
    const n = Number(acct[k]);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function strategyOptionsHtml(user, selectedId) {
  const list = getStrategies(user);
  if (!list.length) return '<option value="">No strategies — build one first</option>';
  return list.map((s) => `<option value="${escapeHtml(String(s.id))}" ${String(s.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(String(s.name || 'Unnamed'))} (v${escapeHtml(String(s.version ?? 1))} · ${escapeHtml(String(s.status || 'DRAFT'))})</option>`).join('');
}

// ---- Decision panel: single engine gate at cursor (display only) ----
// The gate lives in replayEngine.evaluateBar — this panel only renders the
// returned values and enables SIMULATE ENTRY from canSimulate. Nothing is
// recomputed here.
function verdictAtCursor(strategy, rules, riskPercent, account) {
  if (!candles.length || cursor < 0 || cursor >= candles.length || !strategy) return null;
  const rp = Number.isFinite(Number(riskPercent)) ? Number(riskPercent) : 0;
  return evaluateBar({
    candles, cursor, strategy, rules,
    account: { balance: accountBalance(account) },
    riskPercent: rp,
  });
}

function decisionPanelHtml(user) {
  if (!candles.length) {
    return `<div class="empty-state" role="status"><h3>No candles loaded</h3><p>Import a CSV or load the sample series to step through bars.</p></div>`;
  }
  const strategyId = document.getElementById('p9-strategy')?.value || '';
  const strategy = strategyId ? getCurrentStrategyVersion(user, strategyId) : null;
  if (!strategy) {
    return `<div class="empty-state" role="status"><h3>No strategy selected</h3><p>Pick a strategy to evaluate each bar.</p></div>`;
  }
  let rules = [];
  try { rules = getRules(user) || []; } catch { rules = []; }
  const riskPct = Number(document.getElementById('p9-riskpct')?.value);
  const acct = accountById(user, document.getElementById('p9-account')?.value);
  const v = verdictAtCursor(strategy, rules, riskPct, acct);
  if (!v) return '';
  const verdict = v.verdict || { state: 'NO_TRADE', score: 0, passedRules: [], failedRules: [] };
  const state = String(verdict.state || 'NO_TRADE').toUpperCase();
  const stateBadge = state === 'READY' ? 'badge-tp' : state === 'WAITING' ? 'badge-gold' : 'badge-sl';
  const score = Number(verdict.score);
  const passed = Array.isArray(verdict.passedRules) ? verdict.passedRules : [];
  const failed = Array.isArray(verdict.failedRules) ? verdict.failedRules : [];
  const nav = cursorNavState(cursor, candles.length);
  const riskShown = v.entry && v.stops ? fmtN(v.riskAmount) : '—';
  const rrShown = v.riskReward != null && Number.isFinite(v.riskReward) ? fmtN(v.riskReward) : '—';
  return `
    <div class="p9-cursor-bar" role="group" aria-label="Replay cursor">
      <button type="button" class="btn btn-secondary" data-action="cursor-prev" aria-label="Previous candle"
        ${nav.canPrev ? '' : 'disabled aria-disabled="true" title="Already at the first candle"'}>◀ PREV</button>
      <span class="p9-cursor-pos" aria-live="polite">Candle ${escapeHtml(String(cursor + 1))} / ${escapeHtml(String(candles.length))}</span>
      <button type="button" class="btn btn-secondary" data-action="cursor-next" aria-label="Next candle"
        ${nav.canNext ? '' : 'disabled aria-disabled="true" title="Already at the last candle"'}>NEXT CANDLE ▶</button>
    </div>
    <section class="card" aria-label="Engine decision at cursor" aria-live="polite">
      <div class="p9-row-head">
        <strong>Engine decision @ bar ${escapeHtml(String(cursor + 1))}</strong>
        <span class="badge ${stateBadge}">${escapeHtml(state)}</span>
      </div>
      <p class="p9-meta">Setup ${v.setup && v.setup.pass ? 'PASSED' : 'did not pass'} · direction ${escapeHtml(v.direction || '—')} · score ${escapeHtml(fmtN(score, 1))} · risk ${escapeHtml(riskShown)} · RR ${escapeHtml(rrShown)}</p>
      ${v.setup && v.setup.checks.length ? `<ul class="p9-checks">${v.setup.checks.map((c) => `<li>${c.pass ? '✓' : '✕'} <strong>${escapeHtml(String(c.id))}</strong> — ${escapeHtml(String(c.reason || ''))}</li>`).join('')}</ul>` : '<p class="p9-muted">No condition checks at this bar.</p>'}
      ${failed.length ? `<p class="p9-meta">Failed: ${escapeHtml(failed.map((f) => String(f.id || f.name || '')).join(', '))}</p>` : ''}
      ${v.blockedReason ? `<p class="p9-meta">Gate: ${escapeHtml(v.blockedReason)}</p>` : ''}
      <p class="p9-meta">Passed ${escapeHtml(String(passed.length))} check(s). Verdict: engine evaluateBar — never recomputed in the UI.</p>
      <div class="p9-actions">
        <button type="button" class="btn btn-primary" data-action="simulate-entry" ${v.canSimulate ? '' : 'disabled aria-disabled="true" title="Enabled only when the engine reports READY"'}>SIMULATE ENTRY</button>
      </div>
    </section>`;
}

function resultChartHtml() {
  if (!lastResult || !lastResult.entries) return '';
  const n = lastResult.entries.length;
  if (n === 0) {
    const reason = lastResult.summary && lastResult.summary.noTradeReason
      ? lastResult.summary.noTradeReason : 'no entries produced';
    return `<section class="card" aria-label="Replay result"><h3>Replay finished — zero entries</h3>
      <p class="p9-muted">This strategy produced zero entries on this series. Engine reason: ${escapeHtml(String(reason))}.</p></section>`;
  }
  return renderChartCard({ title: `Simulated price series — ${n} simulated entr${n === 1 ? 'y' : 'ies'}`, canvasId: 'p9-replay-chart', n });
}

function drawResultChart() {
  const canvas = document.getElementById('p9-replay-chart');
  if (!canvas || !lastResult || !candles.length) return;
  const labels = candles.map((_, i) => String(i + 1));
  const closes = candles.map((c) => c.c);
  const entries = lastResult.entries || [];
  const entryIdx = new Set(entries.map((t) => t.entryIndex));
  const exitIdx = new Map(entries.map((t) => [t.exitIndex, t]));
  const entryPts = candles.map((c, i) => (entryIdx.has(i) ? c.c : null));
  const exitPts = candles.map((c, i) => (exitIdx.has(i) ? c.c : null));
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Close (simulated series)', data: closes, borderColor: '#d4a017', backgroundColor: 'rgba(212,160,23,0.1)', fill: false, tension: 0.2, pointRadius: 0, pointHoverRadius: 3 },
        { label: 'Simulated entries', data: entryPts, type: 'scatter', backgroundColor: '#00e676', pointRadius: 6, pointStyle: 'triangle' },
        { label: 'Simulated exits', data: exitPts, type: 'scatter', backgroundColor: '#ff4757', pointRadius: 6, pointStyle: 'rectRot' },
      ],
    },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: '#8b95a8' } } }, scales: { x: { ticks: { color: '#5a6478', maxTicksLimit: 12 } }, y: { ticks: { color: '#5a6478' } } } },
  });
  registerChart('p9-replay-chart', chart);
}

function runsListHtml(user) {
  let runs = [];
  try { runs = getReplayRuns(user) || []; } catch { runs = []; }
  if (!runs.length) {
    return `<div class="empty-state" role="status"><h3>No replay runs yet</h3><p>Run a replay above — saved simulated runs appear here.</p></div>`;
  }
  return `<div class="trade-table-container"><table>
    <thead><tr><th>Run</th><th>Symbol</th><th>TF</th><th>Entries</th><th></th></tr></thead>
    <tbody>${runs.map((r) => `
      <tr>
        <td><span class="badge badge-gold">SIMULATED</span> ${escapeHtml(String(r.id).slice(0, 18))}</td>
        <td>${escapeHtml(String(r.symbol || '—'))}</td>
        <td>${escapeHtml(String(r.timeframe || '—'))}</td>
        <td>${escapeHtml(String(r.entryCount ?? 0))}</td>
        <td><a class="btn btn-secondary btn-sm" href="#/replay/${escapeHtml(String(r.id))}">OPEN</a></td>
      </tr>`).join('')}</tbody>
  </table></div>`;
}

// ================= WORKSPACE =================
export function renderReplay() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  destroyAllCharts();
  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page" data-page-root="replay">
      <div class="page-header"><div>
        <h1 class="page-title">Replay <span class="badge badge-gold">SIMULATION</span></h1>
        <p class="page-subtitle">Deterministic historical replay — no market data, no broker</p>
      </div></div>
      ${simBannerHtml()}
      <section class="card" aria-label="Replay inputs">
        <h2>Setup</h2>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="p9-strategy">Strategy (current version shown)</label>
            <select id="p9-strategy">${strategyOptionsHtml(user, document.getElementById('p9-strategy')?.value || '')}</select>
          </div>
          <div class="form-group">
            <label class="form-label" for="p9-account">Account (balance source only — never written)</label>
            <select id="p9-account">${accountOptionsHtml(user, '')}</select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="p9-riskpct">Risk %</label>
            <input type="number" id="p9-riskpct" step="0.1" min="0" value="1">
          </div>
          <div class="form-group">
            <label class="form-label" for="p9-symbol">Symbol</label>
            <input type="text" id="p9-symbol" value="EUR/USD">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="p9-timeframe">Timeframe</label>
            <input type="text" id="p9-timeframe" value="H1">
          </div>
          <div class="form-group">
            <label class="form-label" for="p9-maxtrades">Max trades (blank = all)</label>
            <input type="number" id="p9-maxtrades" step="1" min="1" placeholder="blank = all">
          </div>
        </div>
        <h3>Candle source</h3>
        <p class="p9-muted">No market-data API is integrated (out of scope). Supply candles via CSV or the deterministic sample generator.</p>
        <div class="p9-actions" style="justify-content:flex-start;">
          <label class="btn btn-secondary" for="p9-csv-file" style="cursor:pointer;">IMPORT CSV</label>
          <input type="file" id="p9-csv-file" accept=".csv,text/csv" hidden>
          <button type="button" class="btn btn-ghost" data-action="load-sample">LOAD SAMPLE SERIES</button>
        </div>
        <p class="p9-muted">CSV columns: time/timestamp, open, high, low, close, volume.</p>
        <div id="p9-candle-status" aria-live="polite">${candleStatusHtml()}</div>
        <div class="p9-actions" style="justify-content:flex-start;margin-top:var(--space-md);">
          <button type="button" class="btn btn-primary" data-action="run-replay">RUN REPLAY</button>
        </div>
      </section>
      <div id="p9-result">${lastResult ? resultChartHtml() : ''}</div>
      <div id="p9-cursor">${decisionPanelHtml(user)}</div>
      <h2>Replay runs</h2>
      <div id="p9-runs">${runsListHtml(user)}</div>
    </div>`;
  bindNavbar();
  bindWorkspaceOnce();
  drawResultChart();
}

// Single choke point for every candle series entering the workspace: rows
// are normalised (ascending timestamp, duplicate timestamps de-duplicated
// last-wins) before anything consumes them, and the user is told what changed
// instead of silently losing rows or replaying out of order.
function acceptCandleSeries(raw, source) {
  const list = Array.isArray(raw) ? raw : [];
  const ordered = list.every((c, i) => i === 0 || Number(list[i - 1]?.t) <= Number(c?.t));
  candles = normalizeCandles(list);
  candleSource = source;
  candleNotices = [];
  const dropped = list.length - candles.length;
  if (dropped > 0) {
    candleNotices.push(`${dropped} duplicate timestamp row(s) dropped — last occurrence kept.`);
  }
  if (!ordered && list.length > 0) {
    candleNotices.push('Rows were not chronological — sorted oldest-first before replay.');
  }
  cursor = 0;
  lastResult = null;
  lastRunMeta = null;
}

function candleStatusHtml() {
  if (!candles.length && !candleErrors.length) {
    return `<div class="empty-state" role="status"><h3>No candles loaded</h3><p>Import a CSV or load the sample series.</p></div>`;
  }
  const errs = candleErrors.slice(0, 10).map((e) => `<li>${escapeHtml(e)}</li>`).join('');
  const notes = candleNotices.map((n) => `<p class="p9-meta">${escapeHtml(n)}</p>`).join('');
  return `
    <p class="p9-meta">${escapeHtml(String(candles.length))} candles loaded from ${escapeHtml(candleSource || 'unknown source')}.</p>
    ${notes}
    ${candleErrors.length ? `<p class="p9-meta">${escapeHtml(String(candleErrors.length))} row error(s):</p><ul class="p9-checks">${errs}</ul>${candleErrors.length > 10 ? `<p class="p9-muted">…and ${escapeHtml(String(candleErrors.length - 10))} more.</p>` : ''}` : ''}`;
}

function refreshWorkspacePanels(user) {
  const status = document.getElementById('p9-candle-status');
  const result = document.getElementById('p9-result');
  const cur = document.getElementById('p9-cursor');
  const runs = document.getElementById('p9-runs');
  destroyAllCharts();
  if (status) status.innerHTML = candleStatusHtml();
  if (result) result.innerHTML = lastResult ? resultChartHtml() : '';
  if (cur) cur.innerHTML = decisionPanelHtml(user);
  if (runs) runs.innerHTML = runsListHtml(user);
  drawResultChart();
}

function bindWorkspaceOnce() {
  if (workspaceBound) return;
  workspaceBound = true;
  const app = document.getElementById('app');
  app.addEventListener('click', (e) => {
    const root = document.querySelector('[data-page-root="replay"]');
    if (!root || !root.contains(e.target)) return;
    const user = getCurrentUser();
    if (!user) return;
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const action = btn.getAttribute('data-action');
    if (action === 'load-sample') {
      acceptCandleSeries(buildSampleSeries(), 'sample generator (deterministic, seed 42)');
      candleErrors = [];
      showToast(`Sample series loaded — ${candles.length} simulated candles`, 'info');
      refreshWorkspacePanels(user);
    } else if (action === 'cursor-prev') {
      cursor = Math.max(0, cursor - 1);
      const cur = document.getElementById('p9-cursor');
      if (cur) cur.innerHTML = decisionPanelHtml(user);
    } else if (action === 'cursor-next') {
      cursor = Math.min(Math.max(0, candles.length - 1), cursor + 1);
      const cur = document.getElementById('p9-cursor');
      if (cur) cur.innerHTML = decisionPanelHtml(user);
    } else if (action === 'run-replay') {
      runReplayFromWorkspace(user);
    } else if (action === 'simulate-entry') {
      simulateEntryAtCursor(user);
    }
  });
  app.addEventListener('change', (e) => {
    const root = document.querySelector('[data-page-root="replay"]');
    if (!root || !root.contains(e.target)) return;
    const user = getCurrentUser();
    if (!user) return;
    if (e.target.id === 'p9-csv-file' && e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (results) => {
          const { good, errors } = parseCandlesCsv(results.data || []);
          acceptCandleSeries(good, `CSV ${file.name}`);
          candleErrors = errors;
          cursor = 0;
          e.target.value = '';
          const notes = candleNotices.length ? ` (${candleNotices.join(' ')})` : '';
          if (!candles.length) showToast('No valid candle rows in CSV', 'error');
          else showToast(`${candles.length} candles loaded${errors.length ? `, ${errors.length} row(s) skipped` : ''}${notes}`, (errors.length || candleNotices.length) ? 'info' : 'success');
          refreshWorkspacePanels(user);
        },
        error: () => showToast('Could not parse CSV', 'error'),
      });
    }
    if (['p9-strategy', 'p9-account', 'p9-riskpct'].includes(e.target.id)) {
      const cur = document.getElementById('p9-cursor');
      if (cur && candles.length) cur.innerHTML = decisionPanelHtml(user);
    }
  });
}

function readWorkspaceInputs(user) {
  const strategyId = document.getElementById('p9-strategy')?.value || '';
  const strategy = strategyId ? getCurrentStrategyVersion(user, strategyId) || getStrategy(user, strategyId) : null;
  const acct = accountById(user, document.getElementById('p9-account')?.value);
  const riskRaw = document.getElementById('p9-riskpct')?.value ?? '';
  const maxRaw = document.getElementById('p9-maxtrades')?.value ?? '';
  return {
    strategyId, strategy, acct,
    riskPercent: riskRaw.trim() === '' ? 1 : Number(riskRaw),
    symbol: document.getElementById('p9-symbol')?.value.trim() || 'UNKNOWN',
    timeframe: document.getElementById('p9-timeframe')?.value.trim() || 'UNKNOWN',
    maxTrades: maxRaw.trim() === '' ? undefined : Math.max(1, Math.floor(Number(maxRaw)) || 1),
  };
}

function runReplayFromWorkspace(user) {
  if (!candles.length) return showToast('Load candles first (CSV or sample series)', 'error');
  const inp = readWorkspaceInputs(user);
  if (!inp.strategy) return showToast('Select a strategy first', 'error');
  let rules = [];
  try { rules = getRules(user) || []; } catch { rules = []; }
  const account = { balance: accountBalance(inp.acct), symbol: inp.symbol };
  let result;
  try {
    result = runReplay({
      candles, strategy: inp.strategy, rules, account,
      options: { symbol: inp.symbol, timeframe: inp.timeframe, riskPercent: inp.riskPercent, startIndex: 0, endIndex: candles.length - 1, maxTrades: inp.maxTrades },
    });
  } catch (err) {
    return showToast(`Replay failed: ${err?.message || err}`, 'error');
  }
  lastResult = result;
  lastRunMeta = { strategyId: inp.strategyId, riskPercent: inp.riskPercent };
  try {
    const from = candles[0] ? new Date(candles[0].t).toISOString() : '';
    const to = candles[candles.length - 1] ? new Date(candles[candles.length - 1].t).toISOString() : '';
    saveReplayRun(user, {
      id: result.runId, strategyId: inp.strategyId, strategyVersion: result.strategyVersion,
      ruleVersions: result.ruleVersions, symbol: result.symbol, timeframe: result.timeframe,
      candleRange: { from, to }, barCount: candles.length,
      account: {
        accountId: inp.acct ? String(inp.acct.id ?? '') : '',
        balance: accountBalance(inp.acct),
        startingBalance: Number.isFinite(Number(inp.acct?.startingBalance)) ? Number(inp.acct.startingBalance) : null,
        currency: inp.acct?.currency ?? '',
      },
      options: { symbol: inp.symbol, timeframe: inp.timeframe, riskPercent: inp.riskPercent, startIndex: 0, endIndex: candles.length - 1, maxTrades: inp.maxTrades },
      summary: result.summary, entryCount: result.entries.length, status: 'COMPLETED',
    });
    storeCandlesForRun(user, result.runId, candles);
    deleteSimulatedTrades(user, result.runId);
    if (result.entries.length) {
      saveSimulatedTrades(user, result.entries.map((t) => ({ ...t, userId: String(user).trim().toLowerCase() })));
    }
  } catch (err) {
    showToast(`Replay ran, but saving failed: ${err?.message || err}`, 'error');
  }
  if (!result.entries.length) {
    showToast(`Replay finished — zero entries (${result.summary.noTradeReason || 'no reason'})`, 'info');
  } else {
    showToast(`Replay saved — ${result.entries.length} simulated entries`, 'success');
  }
  refreshWorkspacePanels(user);
}

function simulateEntryAtCursor(user) {
  if (!lastResult) return showToast('Run a replay first, then simulate entries', 'error');
  const inp = readWorkspaceInputs(user);
  if (!inp.strategy) return showToast('Select a strategy first', 'error');
  let rules = [];
  try { rules = getRules(user) || []; } catch { rules = []; }
  const v = verdictAtCursor(inp.strategy, rules, inp.riskPercent, inp.acct);
  if (!v || !v.canSimulate || !v.entry || !v.stops || !v.verdict) {
    return showToast('Engine verdict is not READY at this bar', 'error');
  }
  const exit = resolveExit({
    candles, entryIndex: v.entry.index, direction: v.direction,
    stopLoss: v.stops.stopLoss, takeProfit: v.stops.takeProfit, strategy: inp.strategy,
  });
  const trade = simulateTrade({
    runId: lastResult.runId, symbol: inp.symbol, timeframe: inp.timeframe,
    entryIndex: v.entry.index, direction: v.direction, entryPrice: v.entry.price,
    stopLoss: v.stops.stopLoss, takeProfit: v.stops.takeProfit, exit,
    strategy: inp.strategy, verdict: v.verdict,
    account: { balance: accountBalance(inp.acct), symbol: inp.symbol },
    riskPercent: inp.riskPercent, rules,
  });
  trade.entryTime = Number(candles[v.entry.index]?.t) || 0;
  trade.exitTime = Number(candles[exit.exitIndex]?.t) || 0;
  try {
    saveSimulatedTrades(user, [{ ...trade, userId: String(user).trim().toLowerCase() }]);
    showToast('Simulated entry saved to this run', 'success');
  } catch (err) {
    showToast(`Entry already simulated at this bar: ${err?.message || err}`, 'error');
  }
}

// ================= RESULTS DETAIL =================
export function renderReplayDetail(params) {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const runId = params && params.runId ? String(params.runId) : '';
  destroyAllCharts();
  const run = getReplayRun(user, runId);
  const app = document.getElementById('app');
  if (!run) {
    app.innerHTML = `${renderNavbar()}<div class="page" data-page-root="replay-detail">
      <div class="empty-state" role="status"><h3>Replay run not found</h3>
      <p>It may have been deleted.</p><p><a class="btn btn-secondary" href="#/replay">BACK TO REPLAY</a></p></div></div>`;
    bindNavbar();
    return;
  }
  const trades = getSimulatedTrades(user, runId);
  const summary = getReplaySummary(user, runId);
  const digest = getDeterminismDigest(user, runId);
  const risk = getRiskDistribution(user, runId);
  const dims = ['exitReason', 'symbol', 'timeframe', 'strategyVersion'].map((dim) => {
    let rows = [];
    try { rows = getReplayStatsByDimension(user, runId, dim) || []; } catch { rows = []; }
    return { dim, rows };
  });
  let runs = [];
  try { runs = getReplayRuns(user) || []; } catch { runs = []; }
  const others = runs.filter((r) => String(r.id) !== runId);
  let cmp = null;
  if (compareWith && others.some((r) => String(r.id) === String(compareWith))) {
    try { cmp = compareReplays(user, [runId, compareWith]); } catch { cmp = null; }
  }
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page" data-page-root="replay-detail" data-run-id="${escapeHtml(runId)}">
      <div class="page-header"><div>
        <h1 class="page-title">Replay result <span class="badge badge-gold">SIMULATED</span></h1>
        <p class="page-subtitle">Run ${escapeHtml(runId.slice(0, 24))} · strategy ${escapeHtml(String(run.strategyId || '—'))} v${escapeHtml(String(run.strategyVersion ?? '—'))}</p>
      </div>
      <div class="p9-actions">
        <button type="button" class="btn btn-secondary" data-action="rerun">RE-RUN</button>
        <button type="button" class="btn btn-danger" data-action="delete-run">DELETE</button>
      </div></div>
      ${simBannerHtml()}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Entries (simulated)</div><div class="stat-value">${escapeHtml(String(summary.entries ?? 0))}</div></div>
        <div class="stat-card"><div class="stat-label">Win rate</div><div class="stat-value">${summary.winRate == null ? 'N/A' : `${escapeHtml(fmtN(summary.winRate))}%`}</div></div>
        <div class="stat-card"><div class="stat-label">Total R</div><div class="stat-value">${escapeHtml(fmtN(summary.totalR ?? 0))}</div></div>
        <div class="stat-card"><div class="stat-label">Average R</div><div class="stat-value">${summary.averageR == null ? 'N/A' : escapeHtml(fmtN(summary.averageR))}</div></div>
        <div class="stat-card"><div class="stat-label">Profit factor</div><div class="stat-value">${summary.profitFactor == null ? 'N/A' : escapeHtml(fmtN(summary.profitFactor))}</div></div>
        <div class="stat-card"><div class="stat-label">Max drawdown</div><div class="stat-value">${escapeHtml(fmtN(summary.maxDrawdown ?? 0))}</div></div>
      </div>
      ${summary.entries === 0 ? `<section class="card"><h3>Zero simulated entries</h3><p class="p9-muted">Nothing to analyse — the engine reported no entries for this run.</p></section>` : ''}
      <section class="card" aria-label="Determinism digest">
        <h3>Determinism digest</h3>
        <p class="p9-meta">Digest <code>${escapeHtml(String(digest))}</code> — RE-RUN must reproduce it identically.</p>
        <p class="p9-muted">Digest covers run inputs + simulated trades (volatile ids/timestamps stripped).</p>
      </section>
      ${dims.map(({ dim, rows }) => `
        <section class="card" aria-label="Breakdown by ${escapeHtml(dim)}">
          <h3>By ${escapeHtml(dim)}</h3>
          ${rows.length ? `<div class="trade-table-container"><table>
            <thead><tr><th>${escapeHtml(dim)}</th><th>Trades</th><th>Win rate</th><th>Total R</th><th>Avg R</th><th>PnL</th></tr></thead>
            <tbody>${rows.map((r) => `<tr><td>${escapeHtml(String(r.dimensionValue))}</td><td>${escapeHtml(String(r.trades))}</td><td>${r.winRate == null ? 'N/A' : `${escapeHtml(fmtN(r.winRate))}%`}</td><td>${escapeHtml(fmtN(r.totalR))}</td><td>${r.averageR == null ? 'N/A' : escapeHtml(fmtN(r.averageR))}</td><td>${escapeHtml(fmtN(r.pnl))}</td></tr>`).join('')}</tbody>
          </table></div>` : '<p class="p9-muted">No simulated trades for this breakdown.</p>'}
        </section>`).join('')}
      <section class="card" aria-label="Risk distribution">
        <h3>Risk distribution (simulated)</h3>
        ${risk.bins.length ? `<div class="trade-table-container"><table>
          <thead><tr><th>Risk bin</th><th>Simulated trades</th></tr></thead>
          <tbody>${risk.bins.map((b) => `<tr><td>${escapeHtml(String(b.label))}</td><td>${escapeHtml(String(b.count))}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="p9-muted">No risk data — no simulated trades.</p>'}
      </section>
      <section class="card" aria-label="Simulated trades">
        <h3>Simulated trades</h3>
        ${trades.length ? `<div class="trade-table-container"><table>
          <thead><tr><th></th><th>Dir</th><th>Entry</th><th>Exit</th><th>SL</th><th>TP</th><th>R</th><th>P/L</th></tr></thead>
          <tbody>${trades.map((t) => `
            <tr>
              <td><span class="badge badge-gold">SIMULATED</span></td>
              <td>${escapeHtml(String(t.direction || '—'))}</td>
              <td>${escapeHtml(fmtN(t.entryPrice))}</td>
              <td>${escapeHtml(fmtN(t.exitPrice))}</td>
              <td>${escapeHtml(fmtN(t.stopLoss))}</td>
              <td>${escapeHtml(fmtN(t.takeProfit))}</td>
              <td>${escapeHtml(fmtN(t.rMultiple))}</td>
              <td>${escapeHtml(fmtN(t.pnl))}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty-state"><h3>No simulated trades</h3><p>This run produced zero entries.</p></div>'}
      </section>
      <section class="card" aria-label="Compare replays">
        <h3>Compare (simulated vs simulated)</h3>
        ${others.length ? `
        <div class="form-group">
          <label class="form-label" for="p9-compare">Compare with run</label>
          <select id="p9-compare">
            <option value="">— select a run —</option>
            ${others.map((r) => `<option value="${escapeHtml(String(r.id))}" ${String(compareWith) === String(r.id) ? 'selected' : ''}>${escapeHtml(String(r.id).slice(0, 18))} (${escapeHtml(String(r.entryCount ?? 0))} entries)</option>`).join('')}
          </select>
        </div>
        ${cmp ? `<div class="trade-table-container"><table>
          <thead><tr><th>Run</th><th>Entries</th><th>Win rate</th><th>Total R</th><th>Total PnL</th><th>Δ entries</th><th>Δ R</th></tr></thead>
          <tbody>${cmp.rows.map((r) => `<tr><td>${escapeHtml(String(r.runId).slice(0, 14))}${String(cmp.baselineRunId) === String(r.runId) ? ' (baseline)' : ''}</td>
            <td>${escapeHtml(String(r.entries))}</td><td>${r.winRate == null ? 'N/A' : `${escapeHtml(fmtN(r.winRate))}%`}</td>
            <td>${escapeHtml(fmtN(r.totalR))}</td><td>${escapeHtml(fmtN(r.totalPnl))}</td>
            <td>${escapeHtml(String(r.deltaVsBaseline.entries))}</td><td>${r.deltaVsBaseline.totalR == null ? 'N/A' : escapeHtml(fmtN(r.deltaVsBaseline.totalR))}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="p9-muted">Select a run to compare two simulated results.</p>'}` : '<div class="empty-state"><h3>Nothing to compare</h3><p>Only one replay run exists.</p></div>'}
      </section>
      <p><a class="btn btn-secondary" href="#/replay">BACK TO REPLAY</a></p>
    </div>`;
  bindNavbar();
  bindDetailOnce();
}

function bindDetailOnce() {
  if (detailBound) return;
  detailBound = true;
  const app = document.getElementById('app');
  app.addEventListener('click', (e) => {
    const root = document.querySelector('[data-page-root="replay-detail"]');
    if (!root || !root.contains(e.target)) return;
    const user = getCurrentUser();
    if (!user) return;
    const runId = root.getAttribute('data-run-id');
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'delete-run') {
      showConfirm('Delete this simulated replay run and its simulated trades? Real data is untouched.', () => {
        const res = deleteReplayRun(user, runId);
        if (res && res.success !== false) {
          try { localStorage.removeItem(candlesKey(user, runId)); } catch { /* noop */ }
          showToast('Simulated run deleted', 'error');
          navigate('/replay');
        } else {
          showToast((res && res.error) || 'Could not delete run', 'error');
        }
      });
    } else if (action === 'rerun') {
      rerunIdentical(user, runId);
    }
  });
  app.addEventListener('change', (e) => {
    const root = document.querySelector('[data-page-root="replay-detail"]');
    if (!root || !root.contains(e.target)) return;
    if (e.target.id === 'p9-compare') {
      compareWith = e.target.value || '';
      renderReplayDetail({ runId: root.getAttribute('data-run-id') });
    }
  });
}

function rerunIdentical(user, runId) {
  const run = getReplayRun(user, runId);
  if (!run) return showToast('Run not found', 'error');
  const series = loadCandlesForRun(user, runId);
  if (!series.length) return showToast('Original candle series is unavailable — cannot re-run', 'error');
  const before = getDeterminismDigest(user, runId);
  const strategy = run.strategyVersion != null && run.strategyVersion !== ''
    ? getStrategyVersion(user, run.strategyId, run.strategyVersion)
    : getCurrentStrategyVersion(user, run.strategyId);
  if (!strategy) return showToast('Pinned strategy version is unavailable — cannot re-run', 'error');
  let rules = [];
  try { rules = getRules(user) || []; } catch { rules = []; }
  const opts = run.options && typeof run.options === 'object' ? run.options : {};
  const resolved = resolveRunAccount(run);
  if (!resolved.ok) return showToast(resolved.error, 'error');
  const account = { ...resolved.account, symbol: run.symbol };
  let result;
  try {
    result = runReplay({
      candles: series, strategy, rules, account,
      options: { symbol: run.symbol, timeframe: run.timeframe, riskPercent: Number(opts.riskPercent ?? 1), startIndex: Number(opts.startIndex ?? 0), endIndex: Number(opts.endIndex ?? series.length - 1), maxTrades: opts.maxTrades, runId },
    });
  } catch (err) {
    return showToast(`Re-run failed: ${err?.message || err}`, 'error');
  }
  try {
    saveReplayRun(user, { ...run, summary: result.summary, entryCount: result.entries.length, updatedAt: new Date().toISOString() });
    deleteSimulatedTrades(user, runId);
    if (result.entries.length) {
      saveSimulatedTrades(user, result.entries.map((t) => ({ ...t, userId: String(user).trim().toLowerCase() })));
    }
  } catch (err) {
    return showToast(`Re-run computed, but saving failed: ${err?.message || err}`, 'error');
  }
  const after = getDeterminismDigest(user, runId);
  showToast(after === before ? `Re-run reproduced digest ${after}` : `Digest changed (${before} → ${after}): inputs drifted`, after === before ? 'success' : 'error');
  renderReplayDetail({ runId });
}

export default { renderReplay, renderReplayDetail };
