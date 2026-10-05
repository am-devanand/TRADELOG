import { PROP_RULE_TYPES } from './models.js';

export { PROP_RULE_TYPES };

export const PROP_DIRECTIONS = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'];

const VALID_TYPES = new Set(PROP_RULE_TYPES);
const VALID_DIRECTIONS = new Set(PROP_DIRECTIONS);

export function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function currentSessionUser() {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem('tradelog_session') || '';
  } catch {
    return '';
  }
}

function resolveUser(explicit) {
  const e = normalizeUser(explicit);
  if (e) return e;
  return normalizeUser(currentSessionUser());
}

function propConfigKey(user) {
  return `tradelog_propconfig_${normalizeUser(user)}`;
}

function safeParseObj(raw, fallback) {
  try {
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return fallback;
  } catch {
    return fallback;
  }
}

function round2(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function deepCopy(v) {
  try {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  } catch {
    return Array.isArray(v) ? [...v] : v;
  }
}

function readStore(user) {
  if (typeof localStorage === 'undefined') return {};
  return safeParseObj(localStorage.getItem(propConfigKey(user)), {});
}

function writeStore(user, store) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(propConfigKey(user), JSON.stringify(store && typeof store === 'object' ? store : {}));
}

function readFolders(user) {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`tradelog_folders_${normalizeUser(user)}`);
    if (raw == null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function startingBalanceFor(accountId, user) {
  if (!accountId) return 0;
  const folders = readFolders(user);
  const folder = folders.find((f) => f && f.id === accountId);
  const start = folder ? Number(folder.startingBalance) : NaN;
  return Number.isFinite(start) && start > 0 ? start : 0;
}

function normalizeType(raw, fallback) {
  const t = String(raw ?? fallback ?? 'CUSTOM').trim().toUpperCase();
  return VALID_TYPES.has(t) ? t : 'CUSTOM';
}

function normalizeDirection(raw, fallback) {
  const d = String(raw ?? fallback ?? 'LOWER_IS_BETTER').trim().toUpperCase();
  return VALID_DIRECTIONS.has(d) ? d : 'LOWER_IS_BETTER';
}

function ruleBaseline(id) {
  switch (id) {
    case 'profit_target':
      return { name: 'Profit Target', type: 'PROFIT_TARGET', direction: 'HIGHER_IS_BETTER', description: 'Net profit needed to pass the evaluation.' };
    case 'daily_loss':
      return { name: 'Daily Loss Limit', type: 'DAILY_LOSS', direction: 'LOWER_IS_BETTER', description: 'Max loss allowed on any single trading day.' };
    case 'max_drawdown':
      return { name: 'Max Drawdown', type: 'MAX_DRAWDOWN', direction: 'LOWER_IS_BETTER', description: 'Max peak-to-trough decline on realized balance.' };
    case 'min_trading_days':
      return { name: 'Minimum Trading Days', type: 'MIN_TRADING_DAYS', direction: 'HIGHER_IS_BETTER', description: 'Minimum distinct days with at least one executed trade.' };
    case 'consistency':
      return { name: 'Consistency', type: 'CONSISTENCY', direction: 'LOWER_IS_BETTER', description: 'Best single-day profit as % of total net profit (lower is more consistent).' };
    case 'max_risk_per_trade':
      return { name: 'Max Risk Per Trade', type: 'MAX_RISK_PER_TRADE', direction: 'LOWER_IS_BETTER', description: 'Max risk amount allowed on any single trade.' };
    case 'max_open_risk':
      return { name: 'Max Open Risk', type: 'MAX_OPEN_RISK', direction: 'LOWER_IS_BETTER', description: 'Max combined risk across all open trades.' };
    default:
      return { name: 'Custom Rule', type: 'CUSTOM', direction: 'LOWER_IS_BETTER', description: 'User-defined threshold.' };
  }
}

function coerceThreshold(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}

export function defaultPropRules(startingBalance = 0) {
  const src = startingBalance && typeof startingBalance === 'object' && !Array.isArray(startingBalance)
    ? startingBalance.startingBalance ?? startingBalance.start ?? startingBalance.balance ?? 0
    : startingBalance;
  const start = toFinite(src, 0) > 0 ? toFinite(src, 0) : 0;
  const defs = [
    { id: 'profit_target', limit: round2(start * 0.1), warningThreshold: 70, criticalThreshold: 90, enabled: true },
    { id: 'daily_loss', limit: round2(start * 0.05), warningThreshold: 70, criticalThreshold: 90, enabled: true },
    { id: 'max_drawdown', limit: round2(start * 0.1), warningThreshold: 70, criticalThreshold: 90, enabled: true },
    { id: 'min_trading_days', limit: 10, warningThreshold: 50, criticalThreshold: 80, enabled: true },
    { id: 'consistency', limit: 30, warningThreshold: 75, criticalThreshold: 90, enabled: false },
    { id: 'max_risk_per_trade', limit: round2(start * 0.01), warningThreshold: 80, criticalThreshold: 95, enabled: true },
    { id: 'max_open_risk', limit: round2(start * 0.03), warningThreshold: 80, criticalThreshold: 95, enabled: true },
    { id: 'custom', limit: 0, warningThreshold: 70, criticalThreshold: 90, enabled: false },
  ];
  return defs.map((d) => {
    const base = ruleBaseline(d.id);
    return {
      id: d.id,
      name: base.name,
      type: base.type,
      enabled: d.enabled,
      limit: d.limit,
      warningThreshold: d.warningThreshold,
      criticalThreshold: d.criticalThreshold,
      direction: base.direction,
      description: base.description,
    };
  });
}

function normalizeRule(raw, startingBalance = 0) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaults = defaultPropRules(startingBalance);
  const byId = {};
  for (const d of defaults) byId[d.id] = d;
  const id = String(src.id ?? '').trim() || 'custom';
  const base = byId[id] || ruleBaseline(id);
  const type = normalizeType(src.type, base.type);
  const direction = normalizeDirection(src.direction, base.direction);
  const limitRaw = Number(src.limit);
  return {
    id,
    name: String(src.name ?? base.name ?? id),
    type,
    enabled: src.enabled !== false,
    limit: Number.isFinite(limitRaw) && limitRaw >= 0 ? limitRaw : toFinite(base.limit, 0),
    warningThreshold: coerceThreshold(src.warningThreshold, toFinite(base.warningThreshold, 70)),
    criticalThreshold: coerceThreshold(src.criticalThreshold, toFinite(base.criticalThreshold, 90)),
    direction,
    description: String(src.description ?? base.description ?? ''),
  };
}

function normalizeConfig(accountId, raw, startingBalance) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawRules = Array.isArray(src.rules) ? src.rules : Array.isArray(raw) ? raw : [];
  const defaults = defaultPropRules(startingBalance);
  const storedById = {};
  for (const r of rawRules) {
    if (r && typeof r === 'object' && r.id) storedById[String(r.id)] = r;
  }
  const rules = defaults.map((d) => (storedById[d.id] ? normalizeRule({ ...d, ...storedById[d.id] }, startingBalance) : d));
  for (const r of rawRules) {
    if (!r || typeof r !== 'object' || !r.id) continue;
    if (rules.some((x) => x.id === String(r.id))) continue;
    rules.push(normalizeRule(r, startingBalance));
  }
  return {
    accountId: String(accountId ?? src.accountId ?? ''),
    startingBalance: toFinite(src.startingBalance, startingBalance),
    rules,
    updatedAt: src.updatedAt || new Date().toISOString(),
  };
}

function resolveArgs(accountId, maybeUser) {
  const user = resolveUser(maybeUser);
  return { id: String(accountId ?? ''), user };
}

export function getPropConfig(accountId, user) {
  try {
    const { id, user: clean } = resolveArgs(accountId, user);
    const start = startingBalanceFor(id, clean);
    if (!id) return normalizeConfig('', null, 0);
    const store = readStore(clean);
    const stored = store && typeof store === 'object' ? store[id] : null;
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      return normalizeConfig(id, stored, start);
    }
    return normalizeConfig(id, null, start);
  } catch {
    return normalizeConfig(String(accountId ?? ''), null, 0);
  }
}

export function getPropRules(accountId, user) {
  try {
    return getPropConfig(accountId, user).rules;
  } catch {
    return defaultPropRules(0);
  }
}

export function savePropConfig(accountId, config, user) {
  try {
    let actualConfig = config;
    let actualUser = user;
    if (config === undefined && actualUser === undefined) {
      return { success: false, error: 'Config is required' };
    }
    const { id, user: clean } = resolveArgs(accountId, actualUser);
    if (!id) return { success: false, error: 'Account id is required' };
    const start = startingBalanceFor(id, clean);
    const normalized = normalizeConfig(id, actualConfig, start);
    normalized.updatedAt = new Date().toISOString();
    const store = readStore(clean);
    store[id] = deepCopy(normalized);
    writeStore(clean, store);
    return { success: true, config: deepCopy(normalized) };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to save prop config' };
  }
}

const UPDATABLE_FIELDS = new Set(['name', 'type', 'enabled', 'limit', 'warningThreshold', 'criticalThreshold', 'direction', 'description']);

export function updatePropRule(accountId, ruleId, updates, user) {
  try {
    const { id, user: clean } = resolveArgs(accountId, user);
    if (!id) return { success: false, error: 'Account id is required' };
    if (!ruleId) return { success: false, error: 'Rule id is required' };
    const src = updates && typeof updates === 'object' && !Array.isArray(updates) ? updates : {};
    const config = getPropConfig(id, clean);
    const idx = config.rules.findIndex((r) => r && r.id === String(ruleId));
    if (idx === -1) return { success: false, error: `Rule not found: "${ruleId}"` };
    const patch = {};
    for (const key of Object.keys(src)) {
      if (UPDATABLE_FIELDS.has(key)) patch[key] = src[key];
    }
    const merged = { ...config.rules[idx], ...patch, id: config.rules[idx].id };
    config.rules[idx] = normalizeRule(merged, config.startingBalance);
    config.updatedAt = new Date().toISOString();
    const store = readStore(clean);
    store[id] = deepCopy(config);
    writeStore(clean, store);
    return { success: true, rule: deepCopy(config.rules[idx]), config: deepCopy(config) };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to update prop rule' };
  }
}

export function resetPropConfig(accountId, user) {
  try {
    const { id, user: clean } = resolveArgs(accountId, user);
    if (!id) return { success: false, error: 'Account id is required' };
    const start = startingBalanceFor(id, clean);
    const fresh = normalizeConfig(id, null, start);
    fresh.updatedAt = new Date().toISOString();
    const store = readStore(clean);
    store[id] = deepCopy(fresh);
    writeStore(clean, store);
    return { success: true, config: deepCopy(fresh) };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to reset prop config' };
  }
}

export default {
  PROP_RULE_TYPES,
  PROP_DIRECTIONS,
  defaultPropRules,
  getPropConfig,
  getPropRules,
  savePropConfig,
  updatePropRule,
  resetPropConfig,
};
