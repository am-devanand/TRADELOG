// ============================================
// Rule Manager — My Trading Rules (localStorage-first)
// Vanilla ESM, no framework, no side effects on import.
// Canonical shape lives in ./models.js (DEFAULT_RULE, makeRule,
// RULE_CATEGORIES, RULE_TYPES). Checklist UI (Phase 3) calls
// getApplicableRules + getEnabledRules + evaluateRule.
// ============================================
import { DEFAULT_RULE, RULE_CATEGORIES, RULE_TYPES, makeRule } from './models.js';
import { generateId } from './helpers.js';
import { appendAudit } from './auditLog.js';
import { db } from './firebase.js';
import { doc, setDoc } from 'firebase/firestore';

function safeAudit(user, entry) {
  try {
    appendAudit(user, entry);
  } catch {
    /* audit must never break rule operations */
  }
}

function sortedStrings(arr) {
  const list = Array.isArray(arr) ? arr : [];
  return list.map((x) => String(x)).sort();
}

function sameStringList(a, b) {
  const sa = sortedStrings(a);
  const sb = sortedStrings(b);
  if (sa.length !== sb.length) return false;
  return sa.every((v, i) => v === sb[i]);
}

function hasMaterialRuleChange(oldRule, newRule) {
  const o = oldRule && typeof oldRule === 'object' ? oldRule : {};
  const n = newRule && typeof newRule === 'object' ? newRule : {};
  if (String(o.name ?? '').trim() !== String(n.name ?? '').trim()) return true;
  if (String(o.type ?? '').trim().toUpperCase() !== String(n.type ?? '').trim().toUpperCase()) return true;
  if (String(o.category ?? '').trim().toUpperCase() !== String(n.category ?? '').trim().toUpperCase()) return true;
  if (Number(o.weight) !== Number(n.weight)) return true;
  if ((o.required === true) !== (n.required === true)) return true;
  if ((o.enabled !== false) !== (n.enabled !== false)) return true;
  const ov = o.validation && typeof o.validation === 'object' ? o.validation : {};
  const nv = n.validation && typeof n.validation === 'object' ? n.validation : {};
  if (String(ov.operator ?? o.operator ?? '') !== String(nv.operator ?? n.operator ?? '')) return true;
  if (Number(ov.value ?? o.value ?? 0) !== Number(nv.value ?? n.value ?? 0)) return true;
  if (String(ov.unit ?? '') !== String(nv.unit ?? '')) return true;
  if (!sameStringList(o.applicableSessions ?? o.sessions, n.applicableSessions ?? n.sessions)) return true;
  if (!sameStringList(o.applicableStrategies ?? o.strategies, n.applicableStrategies ?? n.strategies)) return true;
  if (!sameStringList(o.applicablePairs ?? o.pairs, n.applicablePairs ?? n.pairs)) return true;
  if (String(o.severity ?? '').trim().toUpperCase() !== String(n.severity ?? '').trim().toUpperCase()) return true;
  if (String(o.description ?? '').trim() !== String(n.description ?? '').trim()) return true;
  return false;
}

// Re-export canonical model bits so existing import sites keep working.
export { DEFAULT_RULE, RULE_CATEGORIES, RULE_TYPES, makeRule };

// ---- Key + parsing ----

export function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function rulesKey(user) {
  return `tradelog_rules_${normalizeUser(user)}`;
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

function readRawRules(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(rulesKey(user)), []);
}

function writeRules(user, rules) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(rulesKey(user), JSON.stringify(rules));
}

// ---- Canonical shape + legacy migration ----

const VALID_CATEGORIES = new Set(RULE_CATEGORIES);
const VALID_TYPES = new Set(RULE_TYPES);

// Legacy type alias: pre-canonical templates stored 'SESSION'.
const LEGACY_TYPE_ALIAS = { SESSION: 'TIME_RESTRICTION' };

const VALID_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

function defaultUnitFor(type) {
  switch (type) {
    case 'PERCENTAGE_LIMIT':
      return 'percent';
    case 'RR_LIMIT':
      return 'ratio';
    default:
      return 'count';
  }
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function aliasType(rawType) {
  const t = String(rawType ?? '').trim().toUpperCase();
  return LEGACY_TYPE_ALIAS[t] ?? t;
}

/**
 * Migrate any stored rule (canonical or legacy) to the canonical shape.
 * Legacy mappings: title->name, text->description, strategies->
 * applicableStrategies, pairs->applicablePairs, sessions->
 * applicableSessions, top-level operator->validation.operator.
 * Migration defaults: weight 10, required false, severity MEDIUM,
 * category GENERAL, type CHECKBOX.
 * Non-canonical evaluation hints (metric/field) are preserved when present.
 */
export function migrateRuleToCanonical(raw, user = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const now = new Date().toISOString();
  let type = aliasType(raw.type ?? 'CHECKBOX');
  if (!VALID_TYPES.has(type)) type = 'CHECKBOX';
  let category = String(raw.category ?? 'GENERAL').trim().toUpperCase();
  if (!VALID_CATEGORIES.has(category)) category = 'GENERAL';
  const name = String(raw.name ?? raw.title ?? raw.label ?? raw.text ?? '').trim();
  const description = String(raw.description ?? raw.text ?? '').trim();
  const weightRaw = Number(raw.weight);
  const severity = String(raw.severity ?? 'MEDIUM').trim().toUpperCase();
  const vSrc = raw.validation && typeof raw.validation === 'object' ? raw.validation : {};
  const operator = vSrc.operator ?? raw.operator ?? (type === 'RR_LIMIT' ? '>=' : '<=');
  const value = vSrc.value ?? raw.value ?? 0;
  const unit = vSrc.unit ?? defaultUnitFor(type);
  const out = {
    id: raw.id || generateId(),
    name,
    description,
    category,
    type,
    weight: Number.isFinite(weightRaw) ? weightRaw : 10,
    required: raw.required === true,
    enabled: raw.enabled !== false,
    severity: VALID_SEVERITIES.has(severity) ? severity : 'MEDIUM',
    applicableSessions: [...asArray(raw.applicableSessions ?? raw.sessions)],
    applicableStrategies: [...asArray(raw.applicableStrategies ?? raw.strategies)],
    applicablePairs: [...asArray(raw.applicablePairs ?? raw.pairs)],
    validation: { operator, value, unit },
    userId: raw.userId ?? normalizeUser(user),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
  };
  if (raw.metric !== undefined) out.metric = raw.metric;
  if (raw.field !== undefined) out.field = raw.field;
  return out;
}

function readRules(user) {
  const raw = readRawRules(user);
  let dirty = false;
  const migrated = raw.map((r) => {
    if (!r || typeof r !== 'object') return r;
    const next = migrateRuleToCanonical(r, user);
    if (JSON.stringify(next) !== JSON.stringify(r)) dirty = true;
    return next;
  });
  if (dirty) writeRules(user, migrated);
  return migrated;
}

// ---- Validation ----

function validateRuleShape(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error('Rule must be an object');
  }
  const type = aliasType(rule.type);
  if (!type) throw new Error('Rule must have a string "type"');
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Unknown rule type: ${rule.type}`);
  }
  const name = String(rule.name ?? rule.title ?? rule.text ?? rule.label ?? '').trim();
  if (!name) {
    throw new Error('Rule must have a name (title/text/label accepted for compatibility)');
  }
  let category = String(rule.category ?? 'GENERAL').trim().toUpperCase();
  if (!VALID_CATEGORIES.has(category)) category = 'GENERAL';
  return { type, name, category };
}

function normalizeRule(rule, user) {
  const { type, name, category } = validateRuleShape(rule);
  const migrated = migrateRuleToCanonical(rule, user);
  const now = new Date().toISOString();
  const built = makeRule(
    {
      ...migrated,
      name,
      category,
      type,
      id: migrated.id,
      userId: migrated.userId || normalizeUser(user),
      createdAt: migrated.createdAt || now,
      updatedAt: now,
    },
    migrated.userId || normalizeUser(user),
  );
  return built;
}

function isDuplicate(rules, name, category, type, excludeId = null) {
  const n = name.toLowerCase();
  return rules.some(
    (r) =>
      r &&
      r.id !== excludeId &&
      String(r.name ?? '').toLowerCase() === n &&
      r.category === category &&
      r.type === type,
  );
}

// ---- Firebase sync (debounced, merge-only) ----

const SESSION_KEY = 'tradelog_session';

function currentSessionUser() {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(SESSION_KEY) || '';
  } catch {
    return '';
  }
}

let rulesSyncTimer = null;

/**
 * Debounced write of { rules } into users/{clean} with merge:true.
 * Never full-overwrites the user doc. Safe to call after every mutation.
 */
export function syncRulesToFirebase(user) {
  const target = normalizeUser(user ?? currentSessionUser());
  if (!target || typeof localStorage === 'undefined') return;
  if (rulesSyncTimer) clearTimeout(rulesSyncTimer);
  rulesSyncTimer = setTimeout(async () => {
    try {
      const rules = readRawRules(target);
      await setDoc(doc(db, 'users', target), { rules }, { merge: true });
    } catch (e) {
      console.error('Failed to sync rules to Firebase:', e);
    }
  }, 1000);
}

function scheduleSync(user) {
  syncRulesToFirebase(user ?? currentSessionUser());
}

// ---- CRUD ----

export function getRules(user) {
  return readRules(user);
}

export function getEnabledRules(user) {
  return readRules(user).filter((r) => r && r.enabled !== false);
}

/**
 * Save a new rule. Returns { success, rule, error }.
 * Rejects exact name+category+type duplicates (case-insensitive name).
 */
export function saveRule(user, rule) {
  try {
    const { type, name, category } = validateRuleShape(rule);
    const rules = readRules(user);
    if (isDuplicate(rules, name, category, type)) {
      return { success: false, error: `Duplicate rule: "${name}" already exists in ${category}/${type}` };
    }
    const normalized = normalizeRule(rule, user);
    if (!rule || !rule.createdAt) normalized.createdAt = normalized.createdAt || new Date().toISOString();
    normalized.updatedAt = new Date().toISOString();
    rules.push(normalized);
    writeRules(user, rules);
    scheduleSync(user);
    safeAudit(user, {
      entityType: 'rule',
      entityId: String(normalized.id),
      action: 'RULE_CREATED',
      metadata: {
        name: String(normalized.name ?? ''),
        category: String(normalized.category ?? ''),
        type: String(normalized.type ?? ''),
      },
    });
    return { success: true, rule: normalized };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Update a rule by id. Returns { success, rule, error }.
 */
export function updateRule(user, id, updates = {}) {
  if (!id) return { success: false, error: 'Rule id is required' };
  const rules = readRules(user);
  const idx = rules.findIndex((r) => r && r.id === id);
  if (idx === -1) return { success: false, error: 'Rule not found' };
  try {
    const merged = { ...rules[idx], ...updates, id: rules[idx].id };
    const { type, name, category } = validateRuleShape(merged);
    if (isDuplicate(rules, name, category, type, id)) {
      return { success: false, error: `Duplicate rule: "${name}" already exists in ${category}/${type}` };
    }
    const normalized = normalizeRule({ ...merged, createdAt: rules[idx].createdAt }, user);
    normalized.updatedAt = new Date().toISOString();
    const previous = rules[idx];
    rules[idx] = normalized;
    writeRules(user, rules);
    scheduleSync(user);
    if (hasMaterialRuleChange(previous, normalized)) {
      safeAudit(user, {
        entityType: 'rule',
        entityId: String(normalized.id),
        action: 'RULE_UPDATED',
        metadata: { name: String(normalized.name ?? '') },
      });
    }
    return { success: true, rule: normalized };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function deleteRule(user, id) {
  if (!id) return false;
  const rules = readRules(user);
  const next = rules.filter((r) => !r || r.id !== id);
  if (next.length === rules.length) return false;
  writeRules(user, next);
  scheduleSync(user);
  return true;
}

export function toggleRule(user, id) {
  if (!id) return null;
  const rules = readRules(user);
  const idx = rules.findIndex((r) => r && r.id === id);
  if (idx === -1) return null;
  const current = rules[idx].enabled !== false;
  rules[idx] = { ...rules[idx], enabled: !current, updatedAt: new Date().toISOString() };
  writeRules(user, rules);
  scheduleSync(user);
  if (current === true && rules[idx].enabled === false) {
    safeAudit(user, {
      entityType: 'rule',
      entityId: String(id),
      action: 'RULE_DISABLED',
      metadata: { name: String(rules[idx].name ?? '') },
    });
  }
  return rules[idx];
}

// ---- Applicability (Checklist UI pre-filter) ----

function matchesList(list, value) {
  if (list.length === 0) return true;
  if (value == null || value === '') return true;
  return list.includes(value);
}

/**
 * Rules applicable to a trading context. A rule is applicable when it is
 * enabled and none of its scope restrictions (sessions/strategies/pairs)
 * exclude the given context. Session-scoped rules (TIME_RESTRICTION) are
 * hidden — not failed — when the context session is outside their list.
 */
export function getApplicableRules(user, context = {}) {
  const { session, strategy, pair } = context;
  return getEnabledRules(user).filter((rule) => {
    if (!rule) return false;
    const sessions = asArray(
      rule.applicableSessions && rule.applicableSessions.length
        ? rule.applicableSessions
        : rule.sessions,
    );
    const strategies = asArray(
      rule.applicableStrategies && rule.applicableStrategies.length
        ? rule.applicableStrategies
        : rule.strategies,
    );
    const pairs = asArray(
      rule.applicablePairs && rule.applicablePairs.length ? rule.applicablePairs : rule.pairs,
    );
    return (
      matchesList(sessions, session) &&
      matchesList(strategies, strategy) &&
      matchesList(pairs, pair)
    );
  });
}

// ---- Evaluation ----

const SOURCE = 'My Trading Rules';

function compareNumbers(actual, operator, expected) {
  const a = Number(actual);
  const e = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(e)) return null;
  switch (operator) {
    case '<=': return a <= e;
    case '>=': return a >= e;
    case '<': return a < e;
    case '>': return a > e;
    case '==':
    case '=':
    case '===': return a === e;
    case '!=':
    case '!==': return a !== e;
    default: return a <= e;
  }
}

function ruleLimit(rule) {
  const v = rule.validation || {};
  return {
    operator: v.operator || rule.operator || '<=',
    value: v.value ?? rule.value ?? null,
  };
}

function metricFor(rule, context) {
  if (rule.metric && context[rule.metric] !== undefined) return { key: rule.metric, actual: context[rule.metric] };
  if (rule.field && context[rule.field] !== undefined) return { key: rule.field, actual: context[rule.field] };
  switch (rule.type) {
    case 'PERCENTAGE_LIMIT':
      return { key: 'riskPercent', actual: context.riskPercent };
    case 'RR_LIMIT':
      return { key: 'rr', actual: context.rr };
    case 'COUNT_LIMIT':
      if (context.tradesToday !== undefined) return { key: 'tradesToday', actual: context.tradesToday };
      return { key: 'consecutiveLosses', actual: context.consecutiveLosses };
    case 'NUMERIC_LIMIT':
      for (const k of ['riskPercent', 'rr', 'tradesToday', 'consecutiveLosses']) {
        if (context[k] !== undefined) return { key: k, actual: context[k] };
      }
      return { key: 'value', actual: undefined };
    default:
      return { key: 'value', actual: undefined };
  }
}

/** Light alias view so legacy in-memory rules evaluate identically. */
function aliasForEval(rule) {
  return {
    ...rule,
    type: aliasType(rule.type),
    applicableSessions: asArray(rule.applicableSessions ?? rule.sessions),
    applicableStrategies: asArray(rule.applicableStrategies ?? rule.strategies),
    applicablePairs: asArray(rule.applicablePairs ?? rule.pairs),
  };
}

/**
 * Evaluate a single rule against a trading context.
 * Pure/deterministic: no Date.now, no randomness, no I/O.
 *
 * Context keys: { riskPercent, rr, session, tradesToday, consecutiveLosses, checked }
 *
 * STRICTEST-WINS NOTE: when several RR_LIMIT rules exist (e.g. one demands
 * rr >= 1.5 and another rr >= 2), the caller enforces the strictest one by
 * picking the maximum validation.value among applicable RR rules. Each
 * individual evaluateRule call still reports its own threshold in `reason`.
 */
export function evaluateRule(rule, context = {}) {
  if (!rule || typeof rule !== 'object') {
    return { pass: false, reason: 'Invalid rule', source: SOURCE };
  }
  const r = aliasForEval(rule);
  const type = String(r.type || '').trim().toUpperCase();
  const title = r.name || r.title || r.text || r.label || r.description || type;

  if (type === 'CHECKBOX' || type === 'BOOLEAN') {
    const pass = context.checked === true;
    return {
      pass,
      reason: pass ? `"${title}" confirmed` : `"${title}" not confirmed`,
      source: SOURCE,
    };
  }

  if (type === 'TIME_RESTRICTION' || type === 'SESSION') {
    const sessions = asArray(r.applicableSessions);
    if (sessions.length === 0) return { pass: true, reason: `"${title}": no session restriction`, source: SOURCE };
    if (context.session == null || context.session === '') {
      return { pass: true, reason: `"${title}": session unknown, restriction skipped`, source: SOURCE };
    }
    const pass = sessions.includes(context.session);
    return {
      pass,
      reason: pass
        ? `"${title}": session "${context.session}" allowed`
        : `"${title}": session "${context.session}" not in [${sessions.join(', ')}]`,
      source: SOURCE,
    };
  }

  if (
    type === 'PERCENTAGE_LIMIT' ||
    type === 'NUMERIC_LIMIT' ||
    type === 'COUNT_LIMIT' ||
    type === 'RR_LIMIT'
  ) {
    const { operator, value } = ruleLimit(r);
    const { key, actual } = metricFor({ ...r, type }, context);
    if (actual === undefined || actual === null || value === undefined || value === null) {
      return { pass: true, reason: `"${title}": nothing to compare, skipped`, source: SOURCE };
    }
    const ok = compareNumbers(actual, operator, value);
    if (ok === null) {
      return { pass: true, reason: `"${title}": non-numeric input, skipped`, source: SOURCE };
    }
    const extra =
      type === 'RR_LIMIT'
        ? ' (strictest-wins: caller applies the max RR threshold across rules)'
        : '';
    return {
      pass: ok,
      reason: ok
        ? `"${title}": ${key} ${actual} ${operator} ${value} — OK${extra}`
        : `"${title}": ${key} ${actual} violates ${operator} ${value}${extra}`,
      source: SOURCE,
    };
  }

  return { pass: true, reason: `"${title}": unknown type "${type}", skipped`, source: SOURCE };
}

// ---- Templates (spec section 8) ----
// Pure data in canonical shape: no ids, no userId, no timestamps — the
// caller fills those in via saveRule(). No Date.now here, deterministic.
// Templates are never auto-seeded into user data.

function templateRule(partial) {
  const base = {
    name: '',
    description: '',
    category: 'GENERAL',
    type: 'CHECKBOX',
    weight: 10,
    required: false,
    enabled: true,
    severity: 'MEDIUM',
    applicableSessions: [],
    applicableStrategies: [],
    applicablePairs: [],
    validation: { operator: '<=', value: 0, unit: 'count' },
  };
  return {
    ...base,
    ...partial,
    applicableSessions: [...(partial.applicableSessions ?? [])],
    applicableStrategies: [...(partial.applicableStrategies ?? [])],
    applicablePairs: [...(partial.applicablePairs ?? [])],
    validation: { ...base.validation, ...(partial.validation ?? {}) },
  };
}

const TEMPLATES = {
  conservative: [
    templateRule({
      name: 'Risk at most 1% per trade',
      description: 'Risk at most 1% per trade',
      category: 'RISK',
      type: 'PERCENTAGE_LIMIT',
      weight: 10,
      required: true,
      severity: 'HIGH',
      validation: { operator: '<=', value: 1, unit: 'percent' },
    }),
    templateRule({
      name: 'Minimum 1:2 reward-to-risk',
      description: 'Minimum 1:2 reward-to-risk',
      category: 'RISK',
      type: 'RR_LIMIT',
      weight: 10,
      required: true,
      severity: 'HIGH',
      validation: { operator: '>=', value: 2, unit: 'ratio' },
    }),
    templateRule({
      name: 'Max 3 trades per day',
      description: 'Max 3 trades per day',
      category: 'TRADE_MANAGEMENT',
      type: 'COUNT_LIMIT',
      severity: 'MEDIUM',
      validation: { operator: '<=', value: 3, unit: 'count' },
    }),
    templateRule({
      name: 'Trade only London / New York sessions',
      description: 'Trade only London / New York sessions',
      category: 'SESSION',
      type: 'TIME_RESTRICTION',
      severity: 'MEDIUM',
      applicableSessions: ['London', 'New York'],
    }),
    templateRule({
      name: 'I confirm trend alignment on higher timeframe',
      description: 'I confirm trend alignment on higher timeframe',
      category: 'TECHNICAL',
      type: 'CHECKBOX',
      severity: 'LOW',
    }),
  ],
  breakout: [
    templateRule({
      name: 'Risk at most 2% per trade',
      description: 'Risk at most 2% per trade',
      category: 'RISK',
      type: 'PERCENTAGE_LIMIT',
      weight: 10,
      required: true,
      severity: 'HIGH',
      validation: { operator: '<=', value: 2, unit: 'percent' },
    }),
    templateRule({
      name: 'Minimum 1:1.5 reward-to-risk',
      description: 'Minimum 1:1.5 reward-to-risk',
      category: 'RISK',
      type: 'RR_LIMIT',
      weight: 10,
      required: true,
      severity: 'HIGH',
      validation: { operator: '>=', value: 1.5, unit: 'ratio' },
    }),
    templateRule({
      name: 'Trade only London / New York sessions',
      description: 'Trade only London / New York sessions',
      category: 'SESSION',
      type: 'TIME_RESTRICTION',
      severity: 'MEDIUM',
      applicableSessions: ['London', 'New York'],
    }),
    templateRule({
      name: 'I confirm breakout + retest before entry',
      description: 'I confirm breakout + retest before entry',
      category: 'ENTRY',
      type: 'CHECKBOX',
      severity: 'MEDIUM',
    }),
    templateRule({
      name: 'No trading in the first 15 minutes after open',
      description: 'No trading in the first 15 minutes after open',
      category: 'SESSION',
      type: 'TIME_RESTRICTION',
      severity: 'MEDIUM',
      applicableSessions: ['London', 'New York'],
    }),
  ],
  discipline: [
    templateRule({
      name: 'Max 2 consecutive losses, then stop',
      description: 'Max 2 consecutive losses, then stop',
      category: 'PSYCHOLOGY',
      type: 'COUNT_LIMIT',
      weight: 10,
      required: true,
      severity: 'HIGH',
      validation: { operator: '<=', value: 2, unit: 'count' },
    }),
    templateRule({
      name: 'Max 5 trades per day',
      description: 'Max 5 trades per day',
      category: 'TRADE_MANAGEMENT',
      type: 'COUNT_LIMIT',
      severity: 'MEDIUM',
      validation: { operator: '<=', value: 5, unit: 'count' },
    }),
    templateRule({
      name: 'I journaled my last trade before the next entry',
      description: 'I journaled my last trade before the next entry',
      category: 'PSYCHOLOGY',
      type: 'CHECKBOX',
      severity: 'LOW',
    }),
    templateRule({
      name: 'No revenge trading — I am calm and following plan',
      description: 'No revenge trading — I am calm and following plan',
      category: 'PSYCHOLOGY',
      type: 'BOOLEAN',
      severity: 'MEDIUM',
    }),
    templateRule({
      name: 'I accept the risk on this trade',
      description: 'I accept the risk on this trade',
      category: 'PSYCHOLOGY',
      type: 'CHECKBOX',
      severity: 'MEDIUM',
    }),
  ],
};

/**
 * Return rule templates. Called with no args returns all three sets:
 * { conservative: [...], breakout: [...], discipline: [...] }.
 * Called with a name ('conservative' | 'breakout' | 'discipline') returns
 * a fresh copy of that array. Copies are fresh each call so callers can
 * mutate freely. No userId/id/timestamps — caller fills via saveRule().
 */
export function getTemplates(name) {
  const clone = (arr) => arr.map((r) => ({
    ...r,
    applicableSessions: [...(r.applicableSessions || [])],
    applicableStrategies: [...(r.applicableStrategies || [])],
    applicablePairs: [...(r.applicablePairs || [])],
    validation: { ...(r.validation || {}) },
  }));
  if (name == null || name === '') {
    return {
      conservative: clone(TEMPLATES.conservative),
      breakout: clone(TEMPLATES.breakout),
      discipline: clone(TEMPLATES.discipline),
    };
  }
  const key = String(name).trim().toLowerCase();
  if (!TEMPLATES[key]) throw new Error(`Unknown template: ${name}`);
  return clone(TEMPLATES[key]);
}
