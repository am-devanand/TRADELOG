// ============================================
// AI Review — context builder + observers
// Vanilla ESM. Zero side effects on import. No network.
// No SDKs, no storage, no persistence, no external deps
// (only the sibling aiProvider.js seam).
//
// OPTIONAL, non-authoritative observational layer only.
// Phase 7 invariant: "analytics observes, it does not
// become the trading system."
//
// ---- FORBIDDEN ACTIONS (AI must NEVER) ----
// - create/modify trades, SL, TP, risk, balance
// - modify prop rules or user rules
// - approve/reject READY setups
// - execute orders
// - provide trading signals, entry/exit suggestions,
//   or directional opinions
// - store AI output in trading records (output is
//   returned to the caller only, kept separate from
//   authoritative data)
// See AI_FORBIDDEN_ACTIONS in aiProvider.js.
//
// Privacy: buildReviewContext WHITELISTS safe analytics
// fields and EXCLUDES credentials, auth tokens, firebase
// config, uid/username, account identifiers, and any
// unrelated user data. Field names follow utils/models.js
// (DEFAULT_TRADE / DEFAULT_REVIEW), utils/executedTrades.js
// (events, slTpHistory) and utils/tradeReviews.js
// (answers, mistakes, strengths, processScore).
// ============================================
import {
  AI_STATUS,
  AI_LABEL,
  AI_DISCLAIMER,
  AI_UNAVAILABLE_ERROR,
  getAiProviderConfig,
  requestAiObservations,
} from './aiProvider.js';

export { AI_LABEL, AI_DISCLAIMER };

const MAX_STR = 2000;
const MAX_ARR = 50;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cleanStr(v) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, MAX_STR);
}

function cleanNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanStrArray(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim().slice(0, MAX_STR));
    if (out.length >= MAX_ARR) break;
  }
  return out;
}

function deepCopy(v) {
  try {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  } catch {
    return undefined;
  }
}

// Keys that must NEVER enter a review context, even if present on
// trade/review/setup/event objects (credentials, identity, linkage).
const EXCLUDED_KEYS = new Set([
  'userid',
  'uid',
  'username',
  'email',
  'accountid',
  'setupid',
  'tradeid',
  'id',
  'apikey',
  'token',
  'authtoken',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'password',
  'secret',
  'firebase',
  'firebaseconfig',
]);

function stripExcluded(obj) {
  if (!isPlainObject(obj)) return {};
  const out = {};
  for (const k of Object.keys(obj)) {
    if (EXCLUDED_KEYS.has(String(k).toLowerCase())) continue;
    out[k] = obj[k];
  }
  return out;
}

function pickTrade(trade) {
  const t = isPlainObject(trade) ? stripExcluded(trade) : {};
  return {
    pair: cleanStr(t.pair),
    direction: cleanStr(t.direction),
    entryPrice: cleanNum(t.entryPrice ?? t.entry),
    exitPrice: cleanNum(t.exitPrice ?? t.exit),
    stopLoss: cleanNum(t.stopLoss ?? t.sl),
    takeProfit: cleanNum(t.takeProfit ?? t.tp),
    riskAmount: cleanNum(t.riskAmount),
    riskPercent: cleanNum(t.riskPercent),
    rr: cleanNum(t.rr),
    pnl: cleanNum(t.pnl),
    rMultiple: cleanNum(t.rMultiple),
    status: cleanStr(t.status),
    session: cleanStr(t.session),
    strategyId: cleanStr(t.strategyId ?? t.strategy),
    timeframe: cleanStr(t.timeframe),
    setupType: cleanStr(t.setupType),
    checklistScore: cleanNum(t.checklistScore),
  };
}

function pickSetupSnapshot(snap) {
  const s = isPlainObject(snap) ? stripExcluded(snap) : null;
  if (!s) return null;
  return {
    pair: cleanStr(s.pair),
    direction: cleanStr(s.direction),
    strategyId: cleanStr(s.strategyId ?? s.strategy),
    session: cleanStr(s.session),
    timeframe: cleanStr(s.timeframe),
    setupType: cleanStr(s.setupType),
    riskPercent: cleanNum(s.riskPercent),
    riskAmount: cleanNum(s.riskAmount),
    rr: cleanNum(s.rr),
    checklistScore: cleanNum(s.checklistScore),
  };
}

function pickChecklistEntry(e) {
  if (!isPlainObject(e)) return null;
  const s = stripExcluded(e);
  const out = {};
  if (s.name !== undefined) out.name = cleanStr(s.name);
  if (s.label !== undefined) out.label = cleanStr(s.label);
  if (s.title !== undefined) out.title = cleanStr(s.title);
  if (s.score !== undefined) out.score = cleanNum(s.score);
  if (s.passed !== undefined) out.passed = s.passed === true;
  if (s.checked !== undefined) out.checked = s.checked === true;
  if (s.value !== undefined && (typeof s.value === 'string' || typeof s.value === 'number' || typeof s.value === 'boolean')) {
    out.value = typeof s.value === 'string' ? cleanStr(s.value) : s.value;
  }
  return out;
}

function pickChecklistSnapshot(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    const p = pickChecklistEntry(e);
    if (p && Object.keys(p).length > 0) out.push(p);
    if (out.length >= MAX_ARR) break;
  }
  return out;
}

function pickAnswers(answers) {
  const a = isPlainObject(answers) ? answers : {};
  const pickSection = (sec) => {
    const s = isPlainObject(sec) ? stripExcluded(sec) : {};
    const out = {};
    for (const k of Object.keys(s).slice(0, MAX_ARR)) {
      const v = s[k];
      if (typeof v === 'string') out[k] = cleanStr(v);
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  };
  return {
    preTrade: pickSection(a.preTrade),
    execution: pickSection(a.execution),
    management: pickSection(a.management),
  };
}

function pickProcessScore(score) {
  const s = isPlainObject(score) ? stripExcluded(score) : {};
  return {
    preTradeScore: cleanNum(s.preTradeScore),
    executionScore: cleanNum(s.executionScore),
    managementScore: cleanNum(s.managementScore),
    disciplineScore: cleanNum(s.disciplineScore),
    total: cleanNum(s.total),
    grade: cleanStr(s.grade),
  };
}

function pickEvents(events) {
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const e of events) {
    if (!isPlainObject(e)) continue;
    // Type + timestamp ONLY. Messages/payloads may carry notes or
    // identifiers, so they are deliberately dropped.
    const type = cleanStr(e.type);
    const at = cleanStr(e.at ?? e.timestamp ?? e.createdAt);
    if (!type && !at) continue;
    out.push({ type, at });
    if (out.length >= MAX_ARR) break;
  }
  return out;
}

/**
 * buildReviewContext — whitelist-only snapshot for AI observers.
 * Input: { trade, review, setupSnapshot, checklistSnapshot, events, processScore }
 *   (callers may pass tradeReviews.js review objects and
 *   executedTrades.js trade/event objects directly).
 * Output: frozen plain object with ONLY whitelisted fields:
 *   trade{pair,direction,entryPrice,exitPrice,stopLoss,takeProfit,
 *     riskAmount,riskPercent,rr,pnl,rMultiple,status,session,
 *     strategyId,timeframe,setupType,checklistScore},
 *   setup{pair,direction,strategyId,session,timeframe,setupType,
 *     riskPercent,riskAmount,rr,checklistScore},
 *   checklist[{name,label,title,score,passed,checked,value}],
 *   answers{preTrade,execution,management},
 *   mistakes[], strengths[], lessons{lesson,whatWentWell,
 *     whatWentWrong,improvementAction},
 *   processScore{preTradeScore,executionScore,managementScore,
 *     disciplineScore,total,grade},
 *   events[{type,at}].
 * NEVER includes credentials, auth tokens, firebase config,
 * uid/username, account identifiers (userId/accountId/setupId/
 * tradeId/id), or unrelated user data. NEVER mutates inputs.
 */
export function buildReviewContext(input) {
  const src = isPlainObject(input) ? input : {};
  // Deep-copy first so downstream picks can never mutate caller data.
  const trade = deepCopy(src.trade) ?? src.trade;
  const review = deepCopy(src.review) ?? src.review;
  const r = isPlainObject(review) ? stripExcluded(review) : {};

  const setupRaw = deepCopy(src.setupSnapshot ?? r.setupSnapshot ?? null);
  const checklistRaw =
    deepCopy(src.checklistSnapshot ?? r.checklistSnapshot ?? (isPlainObject(trade) ? trade.checklistResults : null)) ??
    [];
  const eventsRaw = deepCopy(src.events ?? (isPlainObject(trade) ? trade.events : null) ?? r.events ?? []);
  const scoreRaw = deepCopy(src.processScore ?? r.processScore ?? null);

  const ctx = {
    trade: pickTrade(trade),
    setup: pickSetupSnapshot(setupRaw),
    checklist: pickChecklistSnapshot(checklistRaw),
    answers: pickAnswers(isPlainObject(review) ? r.answers : undefined),
    mistakes: cleanStrArray(r.mistakes),
    strengths: cleanStrArray(r.strengths),
    lessons: {
      lesson: cleanStr(r.lesson),
      whatWentWell: cleanStr(r.whatWentWell),
      whatWentWrong: cleanStr(r.whatWentWrong),
      improvementAction: cleanStr(r.improvementAction),
    },
    processScore: pickProcessScore(scoreRaw),
    events: pickEvents(eventsRaw),
  };
  return Object.freeze(JSON.parse(JSON.stringify(ctx)));
}

function emptyObserverResult(status) {
  const cfg = getAiProviderConfig();
  return Object.freeze({
    success: false,
    status,
    error: AI_UNAVAILABLE_ERROR,
    provider: cfg.provider,
    model: cfg.model,
    generatedAt: new Date().toISOString(),
    observations: Object.freeze([]),
    themes: Object.freeze([]),
    questions: Object.freeze([]),
    disclaimer: AI_DISCLAIMER,
  });
}

function okObserverResult(providerRes) {
  const cfg = getAiProviderConfig();
  return Object.freeze({
    success: true,
    provider: providerRes?.provider ?? cfg.provider,
    model: providerRes?.model ?? cfg.model,
    generatedAt: new Date().toISOString(),
    observations: Object.freeze([...(providerRes?.observations ?? [])]),
    themes: Object.freeze([...(providerRes?.themes ?? [])]),
    questions: Object.freeze([...(providerRes?.questions ?? [])]),
    disclaimer: AI_DISCLAIMER,
  });
}

async function observe(kind, contextSnapshot) {
  let snapshot = null;
  try {
    snapshot = contextSnapshot === undefined ? null : JSON.parse(JSON.stringify(contextSnapshot));
  } catch {
    snapshot = null;
  }
  const res = await requestAiObservations({ kind, context: snapshot });
  if (!res || res.success !== true) {
    return emptyObserverResult(res?.status ?? AI_STATUS.UNAVAILABLE);
  }
  return okObserverResult(res);
}

/**
 * analyzeTradeReview(reviewContext) — observations for ONE sanitized
 * review context (as returned by buildReviewContext).
 * NEVER mutates the context or any trading record. Output is
 * returned to the caller only. Default (AI unconfigured):
 * { success:false, status, error, provider, model, generatedAt,
 *   observations:[], themes:[], questions:[], disclaimer }.
 * NEVER fabricates observations or canned fallback text.
 */
export async function analyzeTradeReview(reviewContext) {
  return observe('trade-review', reviewContext ?? null);
}

/**
 * summarizeTradingPeriod(periodContext) — observations for ONE
 * sanitized period context (e.g. { startDate, endDate, contexts[] }
 * where contexts are buildReviewContext outputs).
 * Same no-mutation, no-storage, no-fabrication contract as above.
 */
export async function summarizeTradingPeriod(periodContext) {
  return observe('period-summary', periodContext ?? null);
}

/**
 * identifyReviewThemes(reviewContexts) — observations across MANY
 * sanitized review contexts (array of buildReviewContext outputs).
 * Same no-mutation, no-storage, no-fabrication contract as above.
 */
export async function identifyReviewThemes(reviewContexts) {
  const list = Array.isArray(reviewContexts) ? reviewContexts : [];
  return observe('review-themes', list);
}

export default Object.freeze({
  buildReviewContext,
  analyzeTradeReview,
  summarizeTradingPeriod,
  identifyReviewThemes,
});
