// ============================================
// Decision Engine — pre-trade discipline check
// Pure vanilla ESM, no UI, no dependencies.
//
// Combines GLOBAL USER RULES + STRATEGY + ACCOUNT/PROP + RISK checks
// (spec hierarchy). The caller prefilters `rules` by session/strategy and
// pre-resolves every `checks[ruleId]` entry (including reason + source).
// This module never fetches rules and never emits trading signals — it
// only returns discipline states: READY | WAITING | NO_TRADE.
//
// Transparency (spec section 54): every failed/missing rule keeps its
// caller-supplied `reason` + `source` so Phase 3 UI can render the score
// + decision card with reasons.
//
// RR conflicts (e.g. Strategy requires ≥2R but Prop requires ≥3R):
// strictest-wins. The CALLER must evaluate against the strictest limit
// and explain it in `reason` (e.g. "RR 2.4 < strictest limit 3.0 (Prop)").
// This engine does NOT merge, compare, or override RR limits — it passes
// `reason` through untouched.
// ============================================

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {string} [name]
 * @property {number} [weight] - default 1 when missing/invalid
 * @property {boolean} [required] - default false
 * @property {boolean} [enabled] - false = skipped; missing = treated as enabled
 * @property {string} [category]
 *
 * @typedef {Object} CheckInput
 * @property {boolean} [pass]
 * @property {boolean} [missing]
 * @property {string} [reason]
 * @property {string} [source] - e.g. "My Trading Rules" | "Strategy" | "Prop" | "Risk"
 *
 * @typedef {Object} DecisionResult
 * @property {number} score - 0-100, rounded to 1 decimal
 * @property {'READY'|'WAITING'|'NO_TRADE'} state
 * @property {Array} passedRules
 * @property {Array} failedRules
 * @property {Array} missingRules
 * @property {Array} warnings - failed optional rules
 * @property {Array} blockers - failed required rules
 */

const DEFAULT_THRESHOLDS = Object.freeze({ ready: 80, waiting: 60 });

function normalizeThresholds(thresholds) {
  const merged = { ...DEFAULT_THRESHOLDS, ...(thresholds ?? {}) };
  for (const key of ['ready', 'waiting']) {
    const v = merged[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
      throw new RangeError(`thresholds.${key} must be a number in 0-100, got ${String(v)}`);
    }
  }
  if (merged.waiting > merged.ready) {
    throw new RangeError(
      `thresholds.waiting (${merged.waiting}) must not exceed thresholds.ready (${merged.ready})`
    );
  }
  return merged;
}

function toWeight(value) {
  const n = Number(value);
  if (value === undefined || value === null || value === '') return 1;
  if (!Number.isFinite(n) || n < 0) return 1;
  return n;
}

function getCheck(checks, ruleId) {
  if (!checks) return undefined;
  if (typeof checks.get === 'function') {
    try {
      return checks.get(ruleId);
    } catch {
      return undefined;
    }
  }
  if (typeof checks === 'object') {
    return Object.prototype.hasOwnProperty.call(checks, ruleId) ? checks[ruleId] : undefined;
  }
  return undefined;
}

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const s = String(value);
  return s || fallback;
}

/**
 * Evaluate a pre-trade discipline checklist.
 *
 * Score = passedWeight / totalApplicableWeight * 100 (1 decimal).
 * A failed `required` rule forces NO_TRADE regardless of score.
 *
 * @param {Object} input
 * @param {Rule[]} input.rules
 * @param {Map<string, CheckInput>|Record<string, CheckInput>} input.checks
 * @param {{ready:number, waiting:number}} [input.thresholds]
 * @returns {DecisionResult}
 */
export function evaluateChecklist({ rules, checks, thresholds = DEFAULT_THRESHOLDS } = {}) {
  if (!Array.isArray(rules)) {
    throw new TypeError('rules must be an array');
  }
  if (checks === undefined || checks === null) {
    throw new TypeError('checks must be a Map or object keyed by rule id');
  }
  const isMap = typeof checks.get === 'function';
  const isPlainObject = typeof checks === 'object';
  if (!isMap && !isPlainObject) {
    throw new TypeError('checks must be a Map or object keyed by rule id');
  }

  const { ready, waiting } = normalizeThresholds(thresholds);

  // Applicable = enabled only. Caller prefilters session/strategy scope.
  const applicable = rules.filter((r) => r && r.enabled !== false);

  const passedRules = [];
  const failedRules = [];
  const missingRules = [];
  const warnings = [];
  const blockers = [];

  let passedWeight = 0;
  let totalWeight = 0;

  if (applicable.length === 0) {
    return {
      score: 0,
      state: 'NO_TRADE',
      passedRules,
      failedRules,
      missingRules,
      warnings,
      blockers: [
        {
          id: '__no_applicable_rules__',
          name: 'No applicable rules',
          category: undefined,
          weight: 0,
          required: true,
          reason: 'No applicable rules: checklist is empty after skipping disabled rules.',
          source: '',
        },
      ],
    };
  }

  for (const rule of applicable) {
    const id = rule?.id ?? rule?.ruleId ?? rule?.key;
    const weight = toWeight(rule?.weight);
    const required = rule?.required === true;
    const name = text(rule?.name, text(id, 'Unnamed rule'));
    const category = rule?.category;
    totalWeight += weight;

    const raw = id === undefined || id === null ? undefined : getCheck(checks, id);

    // Tolerate shorthand: checks[ruleId] === true/false.
    const entry =
      typeof raw === 'boolean' ? { pass: raw } : raw && typeof raw === 'object' ? raw : undefined;

    const hasVerdict = !!entry && typeof entry.pass === 'boolean';
    const flaggedMissing = !!entry && entry.missing === true;

    if (!hasVerdict || flaggedMissing) {
      const reason = entry
        ? text(entry.reason, `No check value recorded for "${name}".`)
        : `No check value recorded for "${name}".`;
      const source = entry ? text(entry.source, '') : '';
      missingRules.push({ id, name, category, weight, required, reason, source });
      continue;
    }

    if (entry.pass === true) {
      passedWeight += weight;
      passedRules.push({
        id,
        name,
        category,
        weight,
        required,
        reason: text(entry.reason, ''),
        source: text(entry.source, ''),
      });
    } else {
      // Reason + source pass through verbatim (strictest-wins already
      // resolved by the caller — never silently overridden here).
      const failed = {
        id,
        name,
        category,
        weight,
        required,
        reason: text(entry.reason, `"${name}" failed.`),
        source: text(entry.source, ''),
      };
      failedRules.push(failed);
      if (required) {
        blockers.push(failed);
      } else {
        warnings.push(failed);
      }
    }
  }

  const score =
    totalWeight <= 0 ? 0 : Math.round((passedWeight / totalWeight) * 1000) / 10;

  let state;
  if (blockers.length > 0) {
    state = 'NO_TRADE';
  } else if (score >= ready) {
    state = 'READY';
  } else if (score >= waiting) {
    state = 'WAITING';
  } else {
    state = 'NO_TRADE';
  }

  return { score, state, passedRules, failedRules, missingRules, warnings, blockers };
}
