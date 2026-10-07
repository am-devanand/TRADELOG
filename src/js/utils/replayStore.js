// ============================================
// Replay Store — simulated replay runs + simulated trades (offline-first)
// Vanilla ESM, offline-first (localStorage-first).
// No side effects on import. No network. No Firebase.
//
// ISOLATION BOUNDARY: replay results are SIMULATED and must never feed real
// trades, account balance, prop state, calendar, reviews, or real-trade
// analytics. This module stores simulation output only. It never reads or
// writes real-trade stores and never imports executedTrades.js,
// propEngine.js, calendar.js, tradingAnalytics.js, storage.js, or
// firebase.js. Every stored simulated trade carries status 'SIMULATED' and
// any trade without exactly that status is refused on save, so simulation
// output cannot be mistaken for a real trade.
// ============================================

export function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function replaysKey(user) {
  return `tradelog_replays_${normalizeUser(user)}`;
}

function simTradesKey(user) {
  return `tradelog_simtrades_${normalizeUser(user)}`;
}

function safeParse(raw, fallback) {
  try {
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function deepCopy(v) {
  try {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  } catch {
    return Array.isArray(v) ? [...v] : v;
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeRunStatus(raw) {
  const s = String(raw ?? 'COMPLETED').trim().toUpperCase();
  return s === 'ABORTED' ? 'ABORTED' : 'COMPLETED';
}

function normalizeCandleRange(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { from: src.from ?? '', to: src.to ?? '' };
}

// Account snapshot captured at RUN time so RE-RUN can reproduce the original
// balances exactly. Old runs without it normalize to null (never a silent 0).
function normalizeAccountSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hasId = raw.accountId !== undefined && raw.accountId !== null && String(raw.accountId) !== '';
  const bal = Number(raw.balance);
  const start = Number(raw.startingBalance);
  const hasBal = Number.isFinite(bal);
  const hasStart = Number.isFinite(start);
  const hasCur = raw.currency !== undefined && raw.currency !== null && String(raw.currency) !== '';
  if (!hasId && !hasBal && !hasStart && !hasCur) return null;
  return {
    accountId: hasId ? String(raw.accountId) : '',
    balance: hasBal ? bal : null,
    startingBalance: hasStart ? start : null,
    currency: hasCur ? String(raw.currency) : '',
  };
}

function normalizeRun(raw, user) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const now = new Date().toISOString();
  return {
    id: src.id || generateId(),
    userId: normalizeUser(src.userId ?? user),
    createdAt: src.createdAt || now,
    updatedAt: src.updatedAt || now,
    strategyId: src.strategyId ?? '',
    strategyVersion: src.strategyVersion ?? '',
    ruleVersions: deepCopy(src.ruleVersions) ?? [],
    symbol: src.symbol ?? '',
    timeframe: src.timeframe ?? '',
    candleRange: normalizeCandleRange(src.candleRange),
    barCount: toFinite(src.barCount, 0),
    account: normalizeAccountSnapshot(src.account),
    options: src.options && typeof src.options === 'object' ? deepCopy(src.options) : {},
    summary: src.summary === undefined ? null : deepCopy(src.summary),
    entryCount: toFinite(src.entryCount ?? src.entries, 0),
    status: normalizeRunStatus(src.status),
  };
}

function readRunsRaw(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(replaysKey(user)), []);
}

function writeRunsRaw(user, runs) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(replaysKey(user), JSON.stringify(runs));
}

function readSimsRaw(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(simTradesKey(user)), []);
}

function writeSimsRaw(user, trades) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(simTradesKey(user), JSON.stringify(trades));
}

function sortRunsNewest(list) {
  return list.sort((a, b) => {
    const da = new Date(a && a.createdAt).getTime();
    const db = new Date(b && b.createdAt).getTime();
    if (Number.isFinite(db) && Number.isFinite(da) && db !== da) return db - da;
    const ia = String((a && a.id) ?? '');
    const ib = String((b && b.id) ?? '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

function matchFilter(run, filters) {
  const f = filters && typeof filters === 'object' ? filters : {};
  if (f.strategyId != null && f.strategyId !== '' && String(run.strategyId ?? '') !== String(f.strategyId)) return false;
  if (f.strategyVersion != null && f.strategyVersion !== '' && String(run.strategyVersion ?? '') !== String(f.strategyVersion)) return false;
  if (f.symbol != null && f.symbol !== '' && String(run.symbol ?? '') !== String(f.symbol)) return false;
  if (f.timeframe != null && f.timeframe !== '' && String(run.timeframe ?? '') !== String(f.timeframe)) return false;
  if (f.status != null && f.status !== '') {
    if (String(run.status ?? '').toUpperCase() !== String(f.status).trim().toUpperCase()) return false;
  }
  return true;
}

// ---- Replay runs ----

export function getReplayRuns(user, filters) {
  const clean = normalizeUser(user);
  const runs = readRunsRaw(clean).map((r) => normalizeRun(r, clean));
  const kept = runs.filter((r) => matchFilter(r, filters));
  return sortRunsNewest(kept);
}

export function getReplayRun(user, runId) {
  if (runId == null || runId === '') return undefined;
  const clean = normalizeUser(user);
  const found = readRunsRaw(clean).find((r) => r && String(r.id) === String(runId));
  return found ? normalizeRun(found, clean) : undefined;
}

// Resolve the account a RE-RUN must execute with, sourced ONLY from the
// persisted run record. Never falls back to 0: a run without a usable
// balance is an explicit error, not a silent recomputation.
export function resolveRunAccount(run) {
  const snap = run && typeof run === 'object' && run.account && typeof run.account === 'object' ? run.account : null;
  if (!snap) {
    return { ok: false, error: 'Saved run has no account snapshot — re-run needs the original balance. Run again from the workspace.' };
  }
  const bal = Number(snap.balance);
  if (Number.isFinite(bal)) {
    const account = { balance: bal };
    const start = Number(snap.startingBalance);
    if (Number.isFinite(start)) account.startingBalance = start;
    if (snap.currency !== undefined && snap.currency !== null && String(snap.currency) !== '') {
      account.currency = String(snap.currency);
    }
    return { ok: true, account };
  }
  const start = Number(snap.startingBalance);
  if (Number.isFinite(start)) {
    const account = { balance: start, startingBalance: start };
    if (snap.currency !== undefined && snap.currency !== null && String(snap.currency) !== '') {
      account.currency = String(snap.currency);
    }
    return { ok: true, account };
  }
  return { ok: false, error: 'Saved run account has no usable balance — re-run needs the original balance. Run again from the workspace.' };
}

export function saveReplayRun(user, run) {
  const clean = normalizeUser(user);
  if (!clean) throw new Error('User is required to save a replay run.');
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new Error('Replay run must be an object.');
  }
  const normalized = normalizeRun({ ...run, userId: clean }, clean);
  const all = readRunsRaw(clean);
  const idx = all.findIndex((r) => r && String(r.id) === String(normalized.id));
  if (idx === -1) all.push(normalized);
  else all[idx] = normalized;
  writeRunsRaw(clean, all);
  return { success: true, run: deepCopy(normalized) };
}

const IMMUTABLE_RUN_FIELDS = new Set(['id', 'userId', 'createdAt']);

export function updateReplayRun(user, runId, updates) {
  try {
    const clean = normalizeUser(user);
    if (!clean) return { success: false, error: 'User is required' };
    if (runId == null || runId === '') return { success: false, error: 'Run id is required' };
    const src = updates && typeof updates === 'object' && !Array.isArray(updates) ? updates : {};
    const cleanUpdates = {};
    for (const k of Object.keys(src)) {
      if (!IMMUTABLE_RUN_FIELDS.has(k)) cleanUpdates[k] = src[k];
    }
    const all = readRunsRaw(clean);
    const idx = all.findIndex((r) => r && String(r.id) === String(runId));
    if (idx === -1) return { success: false, error: `Replay run not found: "${runId}"` };
    const stored = normalizeRun(all[idx], clean);
    const merged = normalizeRun(
      { ...stored, ...deepCopy(cleanUpdates), updatedAt: new Date().toISOString() },
      clean,
    );
    all[idx] = merged;
    writeRunsRaw(clean, all);
    return { success: true, run: deepCopy(merged) };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to update replay run' };
  }
}

export function deleteReplayRun(user, runId) {
  try {
    const clean = normalizeUser(user);
    if (!clean) return { success: false, error: 'User is required' };
    if (runId == null || runId === '') return { success: false, error: 'Run id is required' };
    const all = readRunsRaw(clean);
    const idx = all.findIndex((r) => r && String(r.id) === String(runId));
    if (idx === -1) return { success: false, error: `Replay run not found: "${runId}"` };
    all.splice(idx, 1);
    writeRunsRaw(clean, all);
    const sims = readSimsRaw(clean);
    const kept = sims.filter((t) => !t || String(t.runId ?? '') !== String(runId));
    const deletedTrades = sims.length - kept.length;
    writeSimsRaw(clean, kept);
    return { success: true, deletedTrades };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to delete replay run' };
  }
}

// ---- Simulated trades ----
// Guard: every stored trade must carry status exactly 'SIMULATED'.
// saveSimulatedTrades throws on any other status and on duplicate ids
// within a run, so simulation output cannot be mistaken for a real trade.

function assertSimulatedBatch(clean, incoming, stored) {
  const seenByRun = new Map();
  for (const t of stored) {
    if (!t || typeof t !== 'object') continue;
    const runKey = String(t.runId ?? '');
    if (!seenByRun.has(runKey)) seenByRun.set(runKey, new Set());
    if (t.id != null && String(t.id) !== '') seenByRun.get(runKey).add(String(t.id));
  }
  for (const t of incoming) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      throw new Error('Each simulated trade must be an object.');
    }
    if (t.status !== 'SIMULATED') {
      throw new Error(
        `Refusing to store trade "${String(t.id ?? '')}" with status "${String(t.status ?? '')}": only status 'SIMULATED' is accepted in the replay store.`,
      );
    }
    const id = t.id != null && String(t.id) !== '' ? String(t.id) : '';
    if (id === '') throw new Error('Each simulated trade must have an id.');
    const runKey = String(t.runId ?? '');
    if (!seenByRun.has(runKey)) seenByRun.set(runKey, new Set());
    if (seenByRun.get(runKey).has(id)) {
      throw new Error(`Duplicate simulated trade id "${id}" within run "${runKey}".`);
    }
    seenByRun.get(runKey).add(id);
  }
  return seenByRun;
}

function normalizeSimTrade(raw, user) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    ...deepCopy(src),
    id: src.id || generateId(),
    userId: normalizeUser(src.userId ?? user),
    runId: src.runId ?? '',
    status: 'SIMULATED',
  };
}

export function getSimulatedTrades(user, runId) {
  const clean = normalizeUser(user);
  const all = readSimsRaw(clean).map((t) => ({ ...(t && typeof t === 'object' ? t : {}) }));
  if (runId == null || runId === '') return all;
  return all.filter((t) => String(t.runId ?? '') === String(runId));
}

export function saveSimulatedTrades(user, trades) {
  const clean = normalizeUser(user);
  if (!clean) throw new Error('User is required to save simulated trades.');
  const incoming = Array.isArray(trades) ? trades : [trades];
  const stored = readSimsRaw(clean);
  assertSimulatedBatch(clean, incoming, stored);
  const normalized = incoming.map((t) => normalizeSimTrade(t, clean));
  const merged = [...stored, ...normalized];
  writeSimsRaw(clean, merged);
  return { success: true, trades: deepCopy(normalized), count: normalized.length };
}

export function deleteSimulatedTrades(user, runId) {
  try {
    const clean = normalizeUser(user);
    if (!clean) return { success: false, error: 'User is required' };
    if (runId == null || runId === '') return { success: false, error: 'Run id is required' };
    const all = readSimsRaw(clean);
    const kept = all.filter((t) => !t || String(t.runId ?? '') !== String(runId));
    writeSimsRaw(clean, kept);
    return { success: true, deleted: all.length - kept.length };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to delete simulated trades' };
  }
}

export default {
  getReplayRuns,
  getReplayRun,
  resolveRunAccount,
  saveReplayRun,
  updateReplayRun,
  deleteReplayRun,
  getSimulatedTrades,
  saveSimulatedTrades,
  deleteSimulatedTrades,
};
