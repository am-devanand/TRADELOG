// ============================================
// Strategy Store — versioned strategy storage (localStorage-first)
// Vanilla ESM, offline-first, no Firebase import, no import-time side effects.
// Canonical shape lives in ./models.js (DEFAULT_STRATEGY, makeStrategy).
// Strategies never influence real trading decisions.
// ============================================
import { DEFAULT_STRATEGY, STRATEGY_STATUSES, makeStrategy } from './models.js';
import { generateId } from './helpers.js';
import { schedulePush } from './syncManager.js';

export { DEFAULT_STRATEGY, STRATEGY_STATUSES, makeStrategy };

export function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function strategiesKey(user) {
  return `tradelog_strategies_${normalizeUser(user)}`;
}

function versionsKey(user) {
  return `tradelog_strategyversions_${normalizeUser(user)}`;
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

function readRawStrategies(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(strategiesKey(user)), []);
}

function writeStrategies(user, list) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(strategiesKey(user), JSON.stringify(list));
}

function readRawVersions(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(versionsKey(user)), []);
}

function writeVersions(user, list) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(versionsKey(user), JSON.stringify(list));
}

function deepCopy(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return Array.isArray(v) ? [...v] : v;
  }
}

function scheduleSync(user) {
  try {
    const clean = normalizeUser(user);
    if (!clean || typeof localStorage === 'undefined') return;
    schedulePush(clean);
  } catch {
    // scheduling never blocks a local write
  }
}

// Material change = anything the replay engine would execute differently,
// plus identity/lifecycle fields. description and updatedAt are cosmetic:
// they never change versioned behavior so they never bump the version.
const MATERIAL_FIELDS = [
  'name',
  'direction',
  'entryConditions',
  'confirmationConditions',
  'minRR',
  'riskPercent',
  'stopLoss',
  'takeProfit',
  'exitModel',
  'maxHoldCandles',
  'ruleRefs',
  'pairs',
  'sessions',
  'timeframes',
  'status',
];

function sortedStrings(arr) {
  return (Array.isArray(arr) ? arr : []).map((x) => String(x)).sort();
}

function stableStringify(v) {
  if (v == null) return 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function sameValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return stableStringify(a) === stableStringify(b);
}

function sameStringList(a, b) {
  const sa = sortedStrings(a);
  const sb = sortedStrings(b);
  if (sa.length !== sb.length) return false;
  return sa.every((v, i) => v === sb[i]);
}

function sameConditions(a, b) {
  const norm = (list) => (Array.isArray(list) ? list : []).map((c) => ({
    id: String(c && c.id != null ? c.id : ''),
    type: String(c && c.type != null ? c.type : '').trim().toUpperCase(),
    params: c && c.params && typeof c.params === 'object' ? c.params : {},
  })).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return stableStringify(norm(a)) === stableStringify(norm(b));
}

function sameLevel(a, b) {
  const x = a && typeof a === 'object' ? a : {};
  const y = b && typeof b === 'object' ? b : {};
  return String(x.model ?? '') === String(y.model ?? '') && sameValue(x.value ?? null, y.value ?? null);
}

export function hasMaterialStrategyChange(oldStrategy, newStrategy) {
  const o = oldStrategy && typeof oldStrategy === 'object' ? oldStrategy : {};
  const n = newStrategy && typeof newStrategy === 'object' ? newStrategy : {};
  for (const field of MATERIAL_FIELDS) {
    if (field === 'pairs' || field === 'sessions' || field === 'timeframes' || field === 'ruleRefs') {
      if (!sameStringList(o[field], n[field])) return true;
    } else if (field === 'entryConditions' || field === 'confirmationConditions') {
      if (!sameConditions(o[field], n[field])) return true;
    } else if (field === 'stopLoss' || field === 'takeProfit') {
      if (!sameLevel(o[field], n[field])) return true;
    } else if (field === 'minRR' || field === 'riskPercent' || field === 'maxHoldCandles') {
      const ov = o[field] == null || o[field] === '' ? null : Number(o[field]);
      const nv = n[field] == null || n[field] === '' ? null : Number(n[field]);
      if (ov !== nv) return true;
    } else if (field === 'name') {
      if (String(o[field] ?? '') !== String(n[field] ?? '')) return true;
    } else {
      if (String(o[field] ?? '').trim().toUpperCase() !== String(n[field] ?? '').trim().toUpperCase()) return true;
    }
  }
  return false;
}

function normalizeStored(raw, user) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return makeStrategy(
    { ...src, userId: src.userId || normalizeUser(user) },
    normalizeUser(user),
  );
}

function appendVersionSnapshot(user, strategy, changes) {
  const all = readRawVersions(user);
  all.push({
    version: strategy.version,
    strategyId: strategy.id,
    strategy: deepCopy(strategy),
    changes: changes && typeof changes === 'object' && !Array.isArray(changes) ? deepCopy(changes) : {},
    createdAt: strategy.versionCreatedAt || new Date().toISOString(),
  });
  all.sort((a, b) => Number(a.version) - Number(b.version) || String(a.createdAt).localeCompare(String(b.createdAt)));
  writeVersions(user, all);
}

// ---- CRUD ----

export function getStrategies(user) {
  return readRawStrategies(user).map((s) => normalizeStored(s, user));
}

export function getStrategy(user, id) {
  if (!id) return undefined;
  return getStrategies(user).find((s) => s && s.id === id);
}

export function getActiveStrategies(user) {
  return getStrategies(user).filter((s) => s && String(s.status).toUpperCase() === 'ACTIVE');
}

export function saveStrategy(user, strategy) {
  try {
    if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy)) {
      return { success: false, error: 'Strategy must be an object' };
    }
    const clean = normalizeUser(user);
    if (!String(strategy.name ?? '').trim()) {
      return { success: false, error: 'Strategy must have a name' };
    }
    const all = readRawStrategies(user);
    const normalized = makeStrategy(
      { ...strategy, id: strategy.id || generateId(), userId: clean, version: 1 },
      clean,
    );
    normalized.versionCreatedAt = normalized.createdAt;
    if (all.some((s) => s && s.id === normalized.id)) {
      return { success: false, error: `Duplicate strategy id: "${normalized.id}"` };
    }
    all.push(normalized);
    writeStrategies(user, all);
    appendVersionSnapshot(user, normalized, { created: true });
    scheduleSync(user);
    return { success: true, strategy: normalized };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function updateStrategy(user, id, updates = {}) {
  if (!id) return { success: false, error: 'Strategy id is required' };
  const all = readRawStrategies(user);
  const idx = all.findIndex((s) => s && s.id === id);
  if (idx === -1) return { success: false, error: 'Strategy not found' };
  try {
    const src = updates && typeof updates === 'object' && !Array.isArray(updates) ? updates : {};
    const previous = normalizeStored(all[idx], user);
    const merged = makeStrategy(
      { ...previous, ...src, id: previous.id, userId: previous.userId, createdAt: previous.createdAt },
      normalizeUser(user),
    );
    if (!String(merged.name ?? '').trim()) {
      return { success: false, error: 'Strategy must have a name' };
    }
    if (hasMaterialStrategyChange(previous, merged)) {
      merged.version = (Number.isInteger(previous.version) ? previous.version : 1) + 1;
      merged.versionCreatedAt = new Date().toISOString();
      merged.updatedAt = merged.versionCreatedAt;
      appendVersionSnapshot(user, merged, deepCopy(src));
    } else {
      merged.version = previous.version;
      merged.versionCreatedAt = previous.versionCreatedAt;
      merged.updatedAt = new Date().toISOString();
    }
    all[idx] = merged;
    writeStrategies(user, all);
    scheduleSync(user);
    return { success: true, strategy: merged };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function deleteStrategy(user, id) {
  if (!id) return false;
  const all = readRawStrategies(user);
  const next = all.filter((s) => !s || s.id !== id);
  if (next.length === all.length) return false;
  writeStrategies(user, next);
  scheduleSync(user);
  return true;
}

// ---- Versioning ----

export function createStrategyVersion(user, strategyId, changes = {}) {
  if (!strategyId) return { success: false, error: 'Strategy id is required' };
  const src = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : {};
  return updateStrategy(user, strategyId, src);
}

export function getStrategyHistory(user, strategyId) {
  if (!strategyId) return [];
  return readRawVersions(user)
    .filter((v) => v && v.strategyId === strategyId)
    .sort((a, b) => Number(a.version) - Number(b.version));
}

export function getStrategyVersion(user, strategyId, version) {
  if (!strategyId || version == null) return undefined;
  const hit = getStrategyHistory(user, strategyId).find((v) => Number(v.version) === Number(version));
  return hit ? deepCopy(hit.strategy) : undefined;
}

export function getCurrentStrategyVersion(user, strategyId) {
  const history = getStrategyHistory(user, strategyId);
  if (history.length > 0) return deepCopy(history[history.length - 1].strategy);
  const current = getStrategy(user, strategyId);
  return current ? deepCopy(current) : undefined;
}

// resolveStrategyAtTime exists so a historical replay uses the strategy as it
// was defined at that instant — never today's version.
export function resolveStrategyAtTime(user, strategyId, asOfIso) {
  if (!strategyId || asOfIso == null || asOfIso === '') return undefined;
  const asOf = new Date(asOfIso).getTime();
  if (!Number.isFinite(asOf)) return undefined;
  const history = getStrategyHistory(user, strategyId)
    .filter((v) => v && Number.isFinite(new Date(v.createdAt).getTime()))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  let current = null;
  for (const entry of history) {
    if (new Date(entry.createdAt).getTime() <= asOf) current = entry;
    else break;
  }
  if (current) return deepCopy(current.strategy);
  const live = getStrategy(user, strategyId);
  if (live && Number.isFinite(new Date(live.createdAt).getTime()) && new Date(live.createdAt).getTime() <= asOf) {
    return deepCopy(live);
  }
  return undefined;
}

// ---- Templates (pure data; caller persists via saveStrategy) ----

function templateStrategy(partial) {
  return {
    id: '',
    userId: '',
    name: '',
    description: '',
    status: 'DRAFT',
    version: 1,
    pairs: [],
    sessions: [],
    timeframes: [],
    direction: 'AUTO',
    entryConditions: [],
    confirmationConditions: [],
    minRR: 2,
    riskPercent: null,
    stopLoss: { model: 'STRUCTURE', value: null },
    takeProfit: { model: 'FIXED_RR', value: null },
    exitModel: 'FIXED_RR',
    maxHoldCandles: null,
    ruleRefs: [],
    createdAt: '',
    updatedAt: '',
    versionCreatedAt: '',
    ...partial,
    pairs: [...(partial.pairs ?? [])],
    sessions: [...(partial.sessions ?? [])],
    timeframes: [...(partial.timeframes ?? [])],
    entryConditions: (partial.entryConditions ?? []).map((c) => ({ ...c, params: { ...(c.params ?? {}) } })),
    confirmationConditions: (partial.confirmationConditions ?? []).map((c) => ({ ...c, params: { ...(c.params ?? {}) } })),
    stopLoss: { ...(partial.stopLoss ?? { model: 'STRUCTURE', value: null }) },
    takeProfit: { ...(partial.takeProfit ?? { model: 'FIXED_RR', value: null }) },
    ruleRefs: [...(partial.ruleRefs ?? [])],
  };
}

const STRATEGY_TEMPLATES = {
  BREAKOUT: templateStrategy({
    name: 'Breakout',
    description: 'Enter on range-break with structure stop and fixed-RR target.',
    direction: 'AUTO',
    entryConditions: [{ id: 'entry-break', type: 'BREAKS_STRUCTURE', params: {} }],
    confirmationConditions: [{ id: 'confirm-close', type: 'CANDLE_CLOSE', params: {} }],
    minRR: 2,
    stopLoss: { model: 'STRUCTURE', value: null },
    takeProfit: { model: 'FIXED_RR', value: null },
    exitModel: 'FIXED_RR',
  }),
  PULLBACK: templateStrategy({
    name: 'Pullback',
    description: 'Enter on pullback into level with trend bias and fixed-RR target.',
    direction: 'AUTO',
    entryConditions: [{ id: 'entry-touch', type: 'TOUCHES_LEVEL', params: {} }],
    confirmationConditions: [{ id: 'confirm-htf', type: 'HTF_BIAS', params: {} }],
    minRR: 2,
    stopLoss: { model: 'STRUCTURE', value: null },
    takeProfit: { model: 'FIXED_RR', value: null },
    exitModel: 'FIXED_RR',
  }),
  REVERSAL: templateStrategy({
    name: 'Reversal',
    description: 'Enter on reversal cross with fixed-points stop and fixed target.',
    direction: 'AUTO',
    entryConditions: [{ id: 'entry-cross', type: 'CROSS_UP', params: {} }],
    confirmationConditions: [{ id: 'confirm-range', type: 'INSIDE_RANGE', params: {} }],
    minRR: 1.5,
    stopLoss: { model: 'FIXED_POINTS', value: null },
    takeProfit: { model: 'FIXED_TP', value: null },
    exitModel: 'FIXED_TP',
  }),
};

export function getStrategyTemplates(name) {
  const clone = (s) => templateStrategy({ ...s });
  if (name == null || name === '') {
    return { BREAKOUT: clone(STRATEGY_TEMPLATES.BREAKOUT), PULLBACK: clone(STRATEGY_TEMPLATES.PULLBACK), REVERSAL: clone(STRATEGY_TEMPLATES.REVERSAL) };
  }
  const key = String(name).trim().toUpperCase();
  if (!STRATEGY_TEMPLATES[key]) throw new Error(`Unknown strategy template: ${name}`);
  return clone(STRATEGY_TEMPLATES[key]);
}
