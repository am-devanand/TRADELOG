// ============================================
// AI Provider — OPTIONAL, non-authoritative adapter
// Vanilla ESM. Zero side effects on import. No network.
// No SDKs, no fetch, no storage, no persistence.
//
// Phase 7 invariant: "analytics observes, it does not
// become the trading system." This module is an
// observational layer only. It is fully functional
// as a no-op when unconfigured (the default).
//
// If a future phase adds a real provider, setAiProvider
// is the SINGLE seam: pass { enabled, provider, model,
// endpoint } plus an injected `handler` function. This
// module ships with NO built-in transport, so without an
// injected handler every generation entry point returns
// the unavailable result below — it NEVER fabricates
// observations and NEVER emits canned fallback text
// presented as AI.
//
// ---- FORBIDDEN ACTIONS (AI must NEVER) ----
// - create / modify / delete trades
// - modify SL, TP, risk, lot size, balance
// - modify prop rules, user rules, checklists, setups
// - approve / reject READY setups, execute orders
// - write AI output into any trading record, store,
//   cache, or review (output is returned to the caller
//   only, kept separate from authoritative data)
// - emit trading signals, entry/exit suggestions,
//   directional opinions, or execution instructions
// - read or transmit credentials, auth tokens, firebase
//   config, uid/username, account identifiers, or any
//   unrelated user data
// ============================================

export const AI_STATUS = Object.freeze({
  UNAVAILABLE: 'UNAVAILABLE',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  ERROR: 'ERROR',
  OK: 'OK',
});

export const AI_LABEL = 'AI OBSERVATIONS';

export const AI_DISCLAIMER =
  'These are observations generated from your recorded data. They are not trading signals or execution instructions.';

export const AI_UNAVAILABLE_ERROR =
  'AI observations unavailable. Your trading data and analytics are unaffected.';

// Documents the forbidden-actions list in code (see header).
// Frozen: callers can read it for UI/docs, never mutate it.
export const AI_FORBIDDEN_ACTIONS = Object.freeze([
  'create/modify/delete trades',
  'modify SL, TP, risk, lot size, or balance',
  'modify prop rules, user rules, checklists, or setups',
  'approve/reject READY setups',
  'execute orders',
  'store AI output in trading records',
  'provide trading signals, entry/exit suggestions, or directional opinions',
  'read or transmit credentials, auth tokens, firebase config, uid/username, account identifiers, or unrelated user data',
]);

const SECRET_KEYS = Object.freeze([
  'apiKey',
  'apikey',
  'key',
  'secret',
  'token',
  'authToken',
  'auth',
  'authorization',
  'bearer',
  'password',
  'credential',
  'credentials',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toCleanString(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.slice(0, 500);
}

// In-memory only. Never persisted. Never exported raw.
let providerConfig = {
  enabled: false,
  provider: '',
  model: '',
  endpoint: '',
};

// Injected transport for a future phase. Stays null unless a caller
// explicitly passes a function via setAiProvider({ handler }).
// This module never creates its own network caller.
let providerHandler = null;

function sanitizedConfig() {
  return {
    enabled: providerConfig.enabled === true,
    provider: providerConfig.provider,
    model: providerConfig.model,
    endpoint: providerConfig.endpoint,
  };
}

function unavailableResult(status) {
  return Object.freeze({
    success: false,
    status,
    error: AI_UNAVAILABLE_ERROR,
  });
}

/**
 * True only when explicitly enabled AND an endpoint is configured.
 * Default: false (enabled:false, no endpoint).
 */
export function isAiEnabled() {
  return providerConfig.enabled === true && providerConfig.endpoint !== '';
}

/**
 * getAiProviderConfig — returns ONLY safe fields.
 * NEVER returns secrets (apiKey/token/auth/... are dropped).
 */
export function getAiProviderConfig() {
  return { ...sanitizedConfig() };
}

/**
 * getAiStatus — machine-readable state without secrets.
 * { enabled, configured, status, provider, model, endpoint, label, disclaimer }
 */
export function getAiStatus() {
  const enabled = providerConfig.enabled === true;
  const configured = providerConfig.endpoint !== '';
  let status = AI_STATUS.NOT_CONFIGURED;
  if (enabled && configured && providerHandler != null) status = AI_STATUS.OK;
  else if (!enabled || !configured) status = AI_STATUS.NOT_CONFIGURED;
  else status = AI_STATUS.UNAVAILABLE;
  return Object.freeze({
    enabled,
    configured,
    status,
    provider: providerConfig.provider,
    model: providerConfig.model,
    endpoint: providerConfig.endpoint,
    label: AI_LABEL,
    disclaimer: AI_DISCLAIMER,
  });
}

/**
 * setAiProvider — the SINGLE seam for a future real provider.
 * Accepts { enabled, provider, model, endpoint, handler? }.
 * - `handler`, when provided, must be a function
 *   (payload) => Promise<{ observations[], themes[], questions[] }>.
 * - Any secret-bearing keys are accepted but held in memory only
 *   and NEVER returned by getAiProviderConfig().
 * - Passing { enabled:false } or {} disables AI (safe default).
 * - Pure w.r.t. trading data: touches no trades, rules, or storage.
 */
export function setAiProvider(config) {
  try {
    if (config == null) {
      providerConfig = { enabled: false, provider: '', model: '', endpoint: '' };
      providerHandler = null;
      return Object.freeze({ success: true, status: AI_STATUS.NOT_CONFIGURED, config: sanitizedConfig() });
    }
    if (!isPlainObject(config)) {
      return Object.freeze({ success: false, status: AI_STATUS.ERROR, error: AI_UNAVAILABLE_ERROR });
    }
    const keys = Object.keys(config);
    for (const k of keys) {
      const low = String(k).toLowerCase();
      if (SECRET_KEYS.some((s) => low.includes(s.toLowerCase()))) continue;
      if (['enabled', 'provider', 'model', 'endpoint', 'handler', 'transport', 'invoke'].includes(k)) continue;
      // Unknown keys are ignored (never stored, never forwarded).
    }
    const enabled = config.enabled === true;
    const provider = toCleanString(config.provider ?? '');
    const model = toCleanString(config.model ?? '');
    const endpoint = toCleanString(config.endpoint ?? '');
    const candidate =
      typeof config.handler === 'function'
        ? config.handler
        : typeof config.transport === 'function'
          ? config.transport
          : typeof config.invoke === 'function'
            ? config.invoke
            : null;
    providerConfig = { enabled, provider, model, endpoint };
    // A handler alone never enables AI: enabled flag + endpoint still required.
    providerHandler = candidate;
    const active = enabled && endpoint !== '' && providerHandler != null;
    return Object.freeze({
      success: true,
      status: active ? AI_STATUS.OK : AI_STATUS.NOT_CONFIGURED,
      config: sanitizedConfig(),
    });
  } catch {
    return Object.freeze({ success: false, status: AI_STATUS.ERROR, error: AI_UNAVAILABLE_ERROR });
  }
}

/**
 * requestAiObservations — low-level seam used by aiReview.js.
 * Default (no handler / disabled / unconfigured): returns the
 * unavailable result. NEVER fabricates observations, NEVER returns
 * canned fallback text presented as AI.
 *
 * When a future phase injects a handler AND ai is enabled with an
 * endpoint, the handler is invoked and its result is passed through
 * (observations[]/themes[]/questions[] only — no trading writes).
 * Any handler failure maps to { success:false, status:ERROR, error }.
 */
export async function requestAiObservations(payload) {
  if (!isAiEnabled() || providerHandler == null) {
    return unavailableResult(
      providerConfig.enabled === true ? AI_STATUS.UNAVAILABLE : AI_STATUS.NOT_CONFIGURED,
    );
  }
  try {
    let snapshot = null;
    try {
      snapshot = payload === undefined ? null : JSON.parse(JSON.stringify(payload));
    } catch {
      snapshot = null;
    }
    const res = await providerHandler(snapshot);
    if (!isPlainObject(res)) {
      return Object.freeze({ success: false, status: AI_STATUS.ERROR, error: AI_UNAVAILABLE_ERROR });
    }
    const observations = Array.isArray(res.observations) ? res.observations.filter((s) => typeof s === 'string') : [];
    const themes = Array.isArray(res.themes) ? res.themes.filter((s) => typeof s === 'string') : [];
    const questions = Array.isArray(res.questions) ? res.questions.filter((s) => typeof s === 'string') : [];
    return Object.freeze({
      success: true,
      status: AI_STATUS.OK,
      provider: providerConfig.provider,
      model: providerConfig.model,
      observations: Object.freeze([...observations]),
      themes: Object.freeze([...themes]),
      questions: Object.freeze([...questions]),
    });
  } catch {
    return Object.freeze({ success: false, status: AI_STATUS.ERROR, error: AI_UNAVAILABLE_ERROR });
  }
}

/**
 * resetAiProvider — test/utility escape hatch. Disables AI and drops
 * the injected handler. Touches no trading data.
 */
export function resetAiProvider() {
  providerConfig = { enabled: false, provider: '', model: '', endpoint: '' };
  providerHandler = null;
  return Object.freeze({ success: true, status: AI_STATUS.NOT_CONFIGURED, config: sanitizedConfig() });
}

export default Object.freeze({
  AI_STATUS,
  AI_LABEL,
  AI_DISCLAIMER,
  AI_UNAVAILABLE_ERROR,
  AI_FORBIDDEN_ACTIONS,
  isAiEnabled,
  setAiProvider,
  getAiProviderConfig,
  getAiStatus,
  requestAiObservations,
  resetAiProvider,
});
