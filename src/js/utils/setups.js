import { DEFAULT_SETUP, SETUP_STATUSES, makeSetup } from './models.js';
import { generateId } from './helpers.js';

export { DEFAULT_SETUP, SETUP_STATUSES, makeSetup };

export function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function setupsKey(user) {
  return `tradelog_setups_${normalizeUser(user)}`;
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

function toFiniteNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDirection(raw) {
  const d = String(raw ?? 'LONG').trim().toUpperCase();
  if (d === 'BUY' || d === 'LONG') return 'LONG';
  if (d === 'SELL' || d === 'SHORT') return 'SHORT';
  return 'LONG';
}

function normalizeStatus(raw) {
  const s = String(raw ?? 'DRAFT').trim().toUpperCase();
  return SETUP_STATUSES.includes(s) ? s : 'DRAFT';
}

function readRaw(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(setupsKey(user)), []);
}

function writeAll(user, setups) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(setupsKey(user), JSON.stringify(setups));
}

function normalizeSetup(raw, user, touch = true) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const now = new Date().toISOString();
  return {
    ...DEFAULT_SETUP,
    ...src,
    id: src.id || generateId(),
    userId: normalizeUser(src.userId ?? user),
    accountId: src.accountId ?? '',
    pair: src.pair ?? '',
    direction: normalizeDirection(src.direction),
    strategyId: src.strategyId ?? '',
    session: src.session ?? '',
    timeframe: src.timeframe ?? '',
    setupType: src.setupType ?? '',
    entryPrice: toFiniteNumber(src.entryPrice, 0),
    stopLoss: toFiniteNumber(src.stopLoss, 0),
    takeProfit: toFiniteNumber(src.takeProfit, 0),
    riskPercent: toFiniteNumber(src.riskPercent, 0),
    riskAmount: toFiniteNumber(src.riskAmount, 0),
    potentialLoss: toFiniteNumber(src.potentialLoss, 0),
    potentialProfit: toFiniteNumber(src.potentialProfit, 0),
    rr: toFiniteNumber(src.rr, 0),
    checklistScore: toFiniteNumber(src.checklistScore, 0),
    checklistResults: Array.isArray(src.checklistResults) ? [...src.checklistResults] : [],
    decision: src.decision ?? '',
    blockers: Array.isArray(src.blockers) ? [...src.blockers] : [],
    warnings: Array.isArray(src.warnings) ? [...src.warnings] : [],
    status: normalizeStatus(src.status),
    screenshotIds: Array.isArray(src.screenshotIds) ? [...src.screenshotIds] : [],
    notes: src.notes ?? '',
    createdAt: src.createdAt || now,
    updatedAt: touch ? now : src.updatedAt || now,
  };
}

export function getSetups(user) {
  return readRaw(user).map((s) => normalizeSetup(s, user, false));
}

export function getSetup(user, id) {
  if (!id) return undefined;
  return getSetups(user).find((s) => s && s.id === id);
}

export function saveSetup(user, setup) {
  try {
    if (!setup || typeof setup !== 'object' || Array.isArray(setup)) {
      return { success: false, error: 'Setup must be an object' };
    }
    const all = readRaw(user);
    const normalized = normalizeSetup(setup, user);
    if (all.some((s) => s && s.id === normalized.id)) {
      return { success: false, error: `Duplicate setup id: "${normalized.id}"` };
    }
    all.push(normalized);
    writeAll(user, all);
    return { success: true, setup: normalized };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function updateSetup(user, id, updates = {}) {
  if (!id) return { success: false, error: 'Setup id is required' };
  const all = readRaw(user);
  const idx = all.findIndex((s) => s && s.id === id);
  if (idx === -1) return { success: false, error: 'Setup not found' };
  try {
    const src = updates && typeof updates === 'object' && !Array.isArray(updates) ? updates : {};
    const merged = { ...all[idx], ...src, id: all[idx].id };
    const normalized = normalizeSetup({ ...merged, createdAt: all[idx].createdAt || merged.createdAt }, user);
    normalized.updatedAt = new Date().toISOString();
    all[idx] = normalized;
    writeAll(user, all);
    return { success: true, setup: normalized };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function deleteSetup(user, id) {
  if (!id) return false;
  const all = readRaw(user);
  const next = all.filter((s) => !s || s.id !== id);
  if (next.length === all.length) return false;
  writeAll(user, next);
  return true;
}

export function getSetupsByStatus(user, status) {
  const s = normalizeStatus(status);
  return getSetups(user).filter((x) => x && x.status === s);
}
