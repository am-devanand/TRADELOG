// ============================================
// Rule History — immutable per-rule version snapshots
// Vanilla ESM, offline-first (localStorage-first).
// READ-ONLY w.r.t. ruleManager / executedTrades: this module never
// mutates rules or trades. It only appends to its own store:
//   tradelog_rulehistory_{clean}
// A trade keeps referring to the rule version recorded at its trade
// time — historical trade checklist snapshots are never rewritten here.
//
// Version semantics:
// - Version 1 is created on first observation of a rule.
// - A MATERIAL change bumps the version by 1 and stores a full
//   immutable snapshot { version, rule, changes, createdAt }.
// - Cosmetic-only changes (id casing, timestamps, userId, unknown
//   future fields, array reorder) do NOT bump the version.
// Material fields (exhaustive): name, type, category, weight,
// required, enabled, validation.operator/value/unit,
// applicableSessions/Strategies/Pairs, severity, description.
// ============================================
import { getRules } from './ruleManager.js';

function normalizeUser(user) {
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

function historyKey(user) {
  return `tradelog_rulehistory_${resolveUser(user)}`;
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

function deepCopy(v) {
  try {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  } catch {
    return Array.isArray(v) ? [...v] : v;
  }
}

function readStore(user) {
  if (typeof localStorage === 'undefined') return {};
  const store = safeParseObj(localStorage.getItem(historyKey(user)), {});
  for (const k of Object.keys(store)) {
    if (!Array.isArray(store[k])) delete store[k];
  }
  return store;
}

function writeStore(user, store) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(historyKey(user), JSON.stringify(store && typeof store === 'object' ? store : {}));
}

function asString(v) {
  return String(v ?? '');
}

function upperTrim(v) {
  return String(v ?? '').trim().toUpperCase();
}

function sortedStrings(arr) {
  const list = Array.isArray(arr) ? arr : [];
  return list.map((x) => String(x)).sort();
}

function sameStringArray(a, b) {
  const sa = sortedStrings(a);
  const sb = sortedStrings(b);
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

// Material diff between two rule snapshots. Returns an array of changed
// field paths (e.g. ["weight", "validation.value"]). Empty = cosmetic-only.
function materialDiff(oldRule, newRule) {
  const o = oldRule && typeof oldRule === 'object' ? oldRule : {};
  const n = newRule && typeof newRule === 'object' ? newRule : {};
  const changed = [];
  if (asString(o.name).trim() !== asString(n.name).trim()) changed.push('name');
  if (upperTrim(o.type) !== upperTrim(n.type)) changed.push('type');
  if (upperTrim(o.category) !== upperTrim(n.category)) changed.push('category');
  const ow = Number(o.weight);
  const nw = Number(n.weight);
  const wSame = (Number.isFinite(ow) ? ow : 0) === (Number.isFinite(nw) ? nw : 0);
  if (!wSame) changed.push('weight');
  if ((o.required === true) !== (n.required === true)) changed.push('required');
  if ((o.enabled !== false) !== (n.enabled !== false)) changed.push('enabled');
  const ov = o.validation && typeof o.validation === 'object' ? o.validation : {};
  const nv = n.validation && typeof n.validation === 'object' ? n.validation : {};
  if (asString(ov.operator ?? o.operator) !== asString(nv.operator ?? n.operator)) {
    changed.push('validation.operator');
  }
  const oval = Number(ov.value ?? o.value ?? 0);
  const nval = Number(nv.value ?? n.value ?? 0);
  const oFin = Number.isFinite(oval) ? oval : 0;
  const nFin = Number.isFinite(nval) ? nval : 0;
  if (oFin !== nFin) changed.push('validation.value');
  if (asString(ov.unit) !== asString(nv.unit)) changed.push('validation.unit');
  if (!sameStringArray(o.applicableSessions ?? o.sessions, n.applicableSessions ?? n.sessions)) {
    changed.push('applicableSessions');
  }
  if (!sameStringArray(o.applicableStrategies ?? o.strategies, n.applicableStrategies ?? n.strategies)) {
    changed.push('applicableStrategies');
  }
  if (!sameStringArray(o.applicablePairs ?? o.pairs, n.applicablePairs ?? n.pairs)) {
    changed.push('applicablePairs');
  }
  if (upperTrim(o.severity) !== upperTrim(n.severity)) changed.push('severity');
  if (asString(o.description).trim() !== asString(n.description).trim()) changed.push('description');
  return changed;
}

function liveRuleById(ruleId, user) {
  try {
    const rules = getRules(resolveUser(user)) || [];
    return rules.find((r) => r && String(r.id) === String(ruleId)) || null;
  } catch {
    return null;
  }
}

function copyVersion(v) {
  if (!v || typeof v !== 'object') return null;
  return {
    version: v.version,
    rule: deepCopy(v.rule),
    changes: deepCopy(v.changes ?? {}),
    createdAt: v.createdAt ?? '',
  };
}

// Unwrap the flexible `changes` argument into { candidateRule, note }.
// Accepts a full rule object, a partial patch, or { rule, changes, user }.
function unwrapChanges(ruleId, changes) {
  const src = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : {};
  if (src.rule && typeof src.rule === 'object' && !Array.isArray(src.rule)) {
    const explicit = src.changes !== undefined ? src.changes : (src.note ?? src.reason ?? {});
    return {
      candidate: { ...deepCopy(src.rule), id: String(src.rule.id ?? ruleId) },
      note: explicit && typeof explicit === 'object' ? deepCopy(explicit) : {},
      userHint: src.user ?? src.userId ?? src.rule.userId ?? '',
    };
  }
  const candidate = { ...deepCopy(src), id: String(src.id ?? ruleId) };
  // Only an explicit note/reason travels into the change record — the
  // material field diff itself is the record for full snapshots/patches.
  const note = src.note ?? src.reason ?? {};
  const userHint = src.user ?? src.userId ?? '';
  return {
    candidate,
    note: note && typeof note === 'object' ? deepCopy(note) : {},
    userHint,
  };
}

function versionsFor(store, ruleId) {
  const list = store[String(ruleId)];
  return Array.isArray(list) ? list : [];
}

// ---- Reads ----

export function getRuleHistory(ruleId, user) {
  if (!ruleId) return [];
  const clean = resolveUser(user);
  const store = readStore(clean);
  let list = versionsFor(store, ruleId);
  if (list.length === 0) {
    const live = liveRuleById(ruleId, clean);
    if (live) {
      createRuleVersion(ruleId, live, clean);
      return getRuleHistory(ruleId, clean);
    }
    return [];
  }
  return list
    .slice()
    .sort((a, b) => Number(a.version) - Number(b.version))
    .map(copyVersion)
    .filter(Boolean);
}

export function getRuleVersion(ruleId, version, user) {
  if (!ruleId) return null;
  const vnum = Number(version);
  if (!Number.isFinite(vnum)) return null;
  const history = getRuleHistory(ruleId, user);
  const found = history.find((v) => Number(v.version) === vnum);
  return found ? copyVersion(found) : null;
}

export function getCurrentRuleVersion(ruleId, user) {
  if (!ruleId) return null;
  const history = getRuleHistory(ruleId, user);
  if (history.length === 0) return null;
  return copyVersion(history[history.length - 1]);
}

export function listVersionedRules(user) {
  const store = readStore(resolveUser(user));
  return Object.keys(store).filter((k) => Array.isArray(store[k]) && store[k].length > 0).sort();
}

// ---- Write (own store only; never touches rules or trades) ----

export function createRuleVersion(ruleId, changes, user) {
  if (!ruleId) return null;
  const unwrapped = unwrapChanges(ruleId, changes);
  const clean = resolveUser(user ?? unwrapped.userHint);
  const store = readStore(clean);
  const key = String(ruleId);
  const list = versionsFor(store, key).slice().sort((a, b) => Number(a.version) - Number(b.version));

  // First observation → version 1 (full immutable snapshot).
  if (list.length === 0) {
    const live = liveRuleById(key, clean);
    const hasName = asString(unwrapped.candidate.name ?? unwrapped.candidate.title).trim() !== '';
    const base = live || (hasName ? unwrapped.candidate : null);
    if (!base) return null;
    const snapshot = { ...deepCopy(base), id: key };
    const entry = {
      version: 1,
      rule: snapshot,
      changes: { initialized: true },
      createdAt: new Date().toISOString(),
    };
    store[key] = [entry];
    writeStore(clean, store);
    return copyVersion(entry);
  }

  const current = list[list.length - 1];
  const looksFull =
    asString(unwrapped.candidate.name ?? unwrapped.candidate.title).trim() !== '' &&
    asString(unwrapped.candidate.type).trim() !== '';
  const candidate = looksFull
    ? { ...deepCopy(unwrapped.candidate), id: key }
    : { ...deepCopy(current.rule), ...deepCopy(unwrapped.candidate), id: key };
  const diff = materialDiff(current.rule, candidate);
  if (diff.length === 0) {
    return copyVersion(current);
  }
  const entry = {
    version: Number(current.version) + 1,
    rule: candidate,
    changes: {
      fields: [...diff],
      ...(unwrapped.note && typeof unwrapped.note === 'object' ? unwrapped.note : {}),
    },
    createdAt: new Date().toISOString(),
  };
  list.push(entry);
  store[key] = list;
  writeStore(clean, store);
  return copyVersion(entry);
}

export default {
  getRuleHistory,
  getRuleVersion,
  createRuleVersion,
  getCurrentRuleVersion,
  listVersionedRules,
};
