// ============================================
// Trade Reviews — post-trade review data layer
// Vanilla ESM, offline-first (localStorage-first).
// No side effects on import. No network.
//
// Canonical store: tradelog_reviews_{user} (one review
// per CLOSED trade). Reviews never mutate trades: trade
// status stays CLOSED, the review carries its own status,
// and trade/setup/checklist snapshots are frozen at
// creation (historical snapshots are immutable).
//
// Automatic findings derive ONLY from the trade's own
// snapshots + events (never current rules). Exit labels
// are structural (EARLY_EXIT) — never psychological.
// Outcome (WIN/LOSS/BREAKEVEN) derives from trade.pnl.
// ============================================
import {
  DEFAULT_REVIEW,
  REVIEW_STATUSES,
  REVIEW_OUTCOMES,
  MISTAKE_TYPES,
  STRENGTH_TYPES,
  REVIEW_QUESTIONS,
  outcomeForPnl,
  makeTradeReview,
} from './models.js';
import { getTradeById } from './executedTrades.js';
import { getSetup } from './setups.js';
import { calculateProcessScore } from './processScore.js';
import { appendAudit } from './auditLog.js';

function safeAudit(user, entry) {
  try {
    appendAudit(user, entry);
  } catch {
    /* audit must never break review operations */
  }
}

export {
  DEFAULT_REVIEW,
  REVIEW_STATUSES,
  REVIEW_OUTCOMES,
  MISTAKE_TYPES,
  STRENGTH_TYPES,
  REVIEW_QUESTIONS,
};

export function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function reviewsKey(user) {
  return `tradelog_reviews_${normalizeUser(user)}`;
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

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function fail(error) {
  return { success: false, error: String(error || 'Unknown error') };
}

function normalizeStatus(raw) {
  const s = String(raw ?? 'PENDING').trim().toUpperCase();
  return REVIEW_STATUSES.includes(s) ? s : 'PENDING';
}

function normalizeOutcome(raw) {
  const o = String(raw ?? '').trim().toUpperCase();
  return REVIEW_OUTCOMES.includes(o) ? o : '';
}

function readRaw(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(reviewsKey(user)), []);
}

function writeAll(user, reviews) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(reviewsKey(user), JSON.stringify(reviews));
}

function normalizeReview(raw, user) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const now = new Date().toISOString();
  const base = makeTradeReview({}, normalizeUser(src.userId ?? user));
  const answers = src.answers && typeof src.answers === 'object' ? src.answers : {};
  return {
    ...base,
    ...src,
    id: src.id || base.id,
    userId: normalizeUser(src.userId ?? user),
    tradeId: src.tradeId ?? '',
    accountId: src.accountId ?? '',
    setupId: src.setupId ?? '',
    pair: src.pair ?? '',
    direction: src.direction ?? base.direction,
    outcome: normalizeOutcome(src.outcome),
    status: normalizeStatus(src.status),
    answers: {
      preTrade: { ...(answers.preTrade ?? {}) },
      execution: { ...(answers.execution ?? {}) },
      management: { ...(answers.management ?? {}) },
    },
    ruleViolations: Array.isArray(src.ruleViolations) ? [...src.ruleViolations] : [],
    mistakes: Array.isArray(src.mistakes) ? [...src.mistakes] : [],
    strengths: Array.isArray(src.strengths) ? [...src.strengths] : [],
    emotions: Array.isArray(src.emotions) ? [...src.emotions] : [],
    confidence: toFinite(src.confidence, base.confidence) || base.confidence,
    followedPlan: src.followedPlan ?? false,
    wouldTakeAgain: src.wouldTakeAgain ?? false,
    whatWentWell: src.whatWentWell ?? '',
    whatWentWrong: src.whatWentWrong ?? '',
    lesson: src.lesson ?? '',
    improvementAction: src.improvementAction ?? '',
    screenshotIds: Array.isArray(src.screenshotIds) ? [...src.screenshotIds] : [],
    tradeSnapshot: src.tradeSnapshot ?? null,
    setupSnapshot: src.setupSnapshot ?? null,
    checklistSnapshot: Array.isArray(src.checklistSnapshot) ? [...src.checklistSnapshot] : [],
    automaticFindings: {
      ...base.automaticFindings,
      ...(src.automaticFindings && typeof src.automaticFindings === 'object'
        ? src.automaticFindings
        : {}),
    },
    processScore: {
      ...base.processScore,
      ...(src.processScore && typeof src.processScore === 'object' ? src.processScore : {}),
    },
    total: Number.isFinite(Number(src.total))
      ? Number(src.total)
      : Number.isFinite(Number(src.processScore?.total))
        ? Number(src.processScore.total)
        : 0,
    ruleAdherence: Number.isFinite(Number(src.ruleAdherence))
      ? Number(src.ruleAdherence)
      : adherenceFor(src),
    createdAt: src.createdAt || now,
    updatedAt: src.updatedAt || now,
  };
}

function sortNewest(list) {
  return list.sort((a, b) => {
    const da = new Date(a?.createdAt).getTime();
    const db = new Date(b?.createdAt).getTime();
    if (Number.isFinite(db) && Number.isFinite(da) && db !== da) return db - da;
    return 0;
  });
}

function userOf(data) {
  const d = data && typeof data === 'object' ? data : {};
  return normalizeUser(d.user ?? d.userId ?? d.username ?? '');
}

/**
 * Rule adherence 0-100 derived from the review's own ruleViolations only
 * (never trade outcome): 0 violations → 100, each violation −25, floor 0.
 */
function adherenceFor(review) {
  const r = review && typeof review === 'object' ? review : {};
  if (!Array.isArray(r.ruleViolations)) return 100;
  return Math.max(0, 100 - 25 * r.ruleViolations.length);
}

/** Stamp denormalized UI mirrors (flat total + adherence) onto a review. */
function stampMirrors(review) {
  const r = review && typeof review === 'object' ? review : {};
  const total = Number(r.processScore?.total);
  r.total = Number.isFinite(total) ? total : 0;
  const stored = Number(r.ruleAdherence);
  r.ruleAdherence = Number.isFinite(stored) ? stored : adherenceFor(r);
  return r;
}

// ---- Snapshot helpers (frozen at review creation; never re-derived) ----

function resolveSetupSnapshot(user, trade) {
  if (!trade) return null;
  try {
    if (trade.setupId) {
      const live = getSetup(user, trade.setupId);
      if (live) return deepCopy(live);
    }
  } catch {
    // Fall through to the trade's own frozen snapshot
  }
  return deepCopy(trade.setupSnapshot ?? trade.originalSetup ?? null) ?? null;
}

function resolveChecklistSnapshot(trade) {
  if (!trade) return [];
  const src = Array.isArray(trade.checklistResults)
    ? trade.checklistResults
    : Array.isArray(trade.rulesSnapshot)
      ? trade.rulesSnapshot
      : [];
  return deepCopy(src) ?? [];
}

// ---- Findings (snapshots + events only; never current rules) ----

function eventTypes(events) {
  if (!Array.isArray(events)) return new Set();
  const out = new Set();
  for (const e of events) {
    const t = String(e?.type || '').trim().toUpperCase();
    if (t) out.add(t);
  }
  return out;
}

/** Collect numeric snapshot limits from frozen checklist/rules entries. */
function snapshotLimits(entries, match) {
  const limits = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    if (!match(e)) continue;
    const v = e.validation && typeof e.validation === 'object' ? e.validation : null;
    const candidates = [
      v?.value,
      e?.value,
      e?.limit,
      e?.maxRisk,
      e?.maxRiskPercent,
      e?.minRR,
      e?.min,
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) limits.push(n);
    }
  }
  return limits;
}

function isRiskEntry(e) {
  const cat = String(e?.category || '').toUpperCase();
  const type = String(e?.type || '').toUpperCase();
  const name = String(e?.name || '').toLowerCase();
  return (
    cat === 'RISK' ||
    type === 'NUMERIC_LIMIT' ||
    type === 'PERCENTAGE_LIMIT' ||
    name.includes('risk')
  );
}

function isRREntry(e) {
  const type = String(e?.type || '').toUpperCase();
  const name = String(e?.name || '').toLowerCase();
  return type === 'RR_LIMIT' || name.includes('rr') || name.includes('risk-reward') || name.includes('risk reward');
}

function sessionAllowlist(entries) {
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    const lists = [
      e?.applicableSessions,
      e?.allowedSessions,
      e?.sessions,
      e?.validation?.allowedSessions,
      e?.validation?.sessions,
    ];
    for (const l of lists) {
      if (Array.isArray(l) && l.length > 0) return l.map((s) => String(s));
    }
  }
  return null;
}

/**
 * Structural exit label from close fields only.
 * TP_HIT / SL_HIT exited per plan → null. Anything else is a
 * deviation described structurally (EARLY_EXIT, LATE_EXIT,
 * BREAKEVEN_EXIT, MANUAL_EXIT) — never a psychological label.
 */
function exitDeviationFor(trade) {
  if (!trade || trade.status !== 'CLOSED') return null;
  const reason = String(trade.closeReason || '').toUpperCase();
  if (reason === 'TP_HIT' || reason === 'SL_HIT') return null;
  if (reason === 'BREAKEVEN') return 'BREAKEVEN_EXIT';
  const entry = Number(trade.entryPrice);
  const exit = Number(trade.exitPrice);
  const tp = Number(trade.initialTP || trade.takeProfit);
  if (Number.isFinite(entry) && Number.isFinite(exit) && Number.isFinite(tp) && tp !== 0) {
    const long = String(trade.direction || 'LONG').toUpperCase() !== 'SHORT';
    const targetDist = long ? tp - entry : entry - tp;
    const exitDist = long ? exit - entry : entry - exit;
    if (targetDist > 0 && exitDist >= 0 && exitDist < targetDist) return 'EARLY_EXIT';
    if (targetDist > 0 && exitDist > targetDist) return 'LATE_EXIT';
  }
  return reason ? 'MANUAL_EXIT' : null;
}

function buildFindings(trade, setupSnap, checklist) {
  const events = Array.isArray(trade?.events) ? trade.events : [];
  const types = eventTypes(events);
  const history = Array.isArray(trade?.slTpHistory) ? trade.slTpHistory : [];

  const sl = Number(trade?.stopLoss);
  const isl = Number(trade?.initialSL);
  const tp = Number(trade?.takeProfit);
  const itp = Number(trade?.initialTP);
  const slMoved =
    types.has('SL_UPDATE') ||
    history.length > 0 ||
    (Number.isFinite(sl) && Number.isFinite(isl) && isl !== 0 && sl !== isl);
  const tpMoved =
    types.has('TP_UPDATE') ||
    (Number.isFinite(tp) && Number.isFinite(itp) && itp !== 0 && tp !== itp);

  let riskViolation = false;
  const risk = Number(trade?.riskPercent);
  if (Number.isFinite(risk)) {
    const limits = snapshotLimits(checklist, isRiskEntry);
    if (limits.some((lim) => risk > lim)) riskViolation = true;
    const planRisk = Number(setupSnap?.riskPercent);
    if (!riskViolation && Number.isFinite(planRisk) && planRisk > 0 && risk > planRisk) {
      riskViolation = true;
    }
  }

  let rrViolation = false;
  const rr = Number(trade?.rr);
  if (Number.isFinite(rr)) {
    const mins = snapshotLimits(checklist, isRREntry);
    if (mins.some((m) => rr < m)) rrViolation = true;
  }

  let sessionViolation = false;
  const session = String(trade?.session || '');
  if (session) {
    const allow = sessionAllowlist(checklist);
    if (allow && !allow.includes(session)) sessionViolation = true;
    else if (!allow && setupSnap?.session && String(setupSnap.session) !== session) {
      sessionViolation = true;
    }
  }

  return {
    riskViolation,
    rrViolation,
    sessionViolation,
    slMoved: !!slMoved,
    tpMoved: !!tpMoved,
    exitDeviation: exitDeviationFor(trade),
  };
}

// ---- Reads ----

export function getReviews(user) {
  return sortNewest(readRaw(user).map((r) => normalizeReview(r, user)));
}

/** getReview(user, reviewId). Tolerates swapped args: getReview(reviewId, user). */
export function getReview(a, b) {
  if (b === undefined) return undefined;
  const direct = getReviews(a).find((r) => r && r.id === b);
  if (direct) return direct;
  return getReviews(b).find((r) => r && r.id === a);
}

/** getReviewByTradeId(user, tradeId). Tolerates swapped args. */
export function getReviewByTradeId(a, b) {
  if (b === undefined) return undefined;
  const direct = getReviews(a).find((r) => r && r.tradeId === b);
  if (direct) return direct;
  return getReviews(b).find((r) => r && r.tradeId === a);
}

/** All COMPLETED reviews for a user (newest first). */
export function getCompletedReviews(user) {
  return getReviews(user).filter((r) => r && r.status === 'COMPLETED');
}

/**
 * The COMPLETED review for a trade, or null (pending/absent reviews
 * return null so detail pages can show REVIEW PENDING).
 * getCompletedReview(user, tradeId). Tolerates swapped args.
 */
export function getCompletedReview(a, b) {
  if (b === undefined) return null;
  const direct = getReviews(a).find((r) => r && r.tradeId === b && r.status === 'COMPLETED');
  if (direct) return direct;
  return getReviews(b).find((r) => r && r.tradeId === a && r.status === 'COMPLETED') ?? null;
}

/** True when a COMPLETED review exists for the trade. Tolerates swapped args. */
export function hasCompletedReview(a, b) {
  return getCompletedReview(a, b) != null;
}

export function isReviewCompleted(review) {
  if (!review || typeof review !== 'object') return false;
  return String(review.status || '').trim().toUpperCase() === 'COMPLETED';
}

// ---- Pure compute (no persistence) ----

/**
 * Gather trade + frozen setup/checklist snapshots + events and return
 * automaticFindings. Pure: never reads current rules, never writes.
 * calculateReview(tradeId, user). Tolerates swapped args.
 */
export function calculateReview(tradeId, user) {
  try {
    let trade = tradeId ? getTradeById(tradeId, user) : undefined;
    if (!trade && user !== undefined) trade = getTradeById(user, tradeId);
    if (!trade) return fail(`Trade not found: "${tradeId}"`);
    const clean = normalizeUser(userOf(trade) || user || tradeId);
    const owner = normalizeUser(trade.userId || user || clean);
    const setupSnap = resolveSetupSnapshot(owner, trade);
    const checklist = resolveChecklistSnapshot(trade);
    return {
      success: true,
      tradeId: trade.id,
      outcome: outcomeForPnl(trade.pnl),
      automaticFindings: buildFindings(trade, setupSnap, checklist),
      snapshots: {
        trade: deepCopy(trade),
        setup: setupSnap,
        checklist,
      },
      events: Array.isArray(trade.events) ? deepCopy(trade.events) : [],
    };
  } catch (e) {
    return fail(e?.message || 'Failed to calculate review');
  }
}

// ---- Writes (reviews only; trades are never touched) ----

/**
 * Create the single review for a CLOSED trade.
 * createReview(tradeId, data) where data carries user/userId plus any
 * review fields (answers, mistakes, notes...). Snapshots, outcome, and
 * automaticFindings are computed — caller values are ignored.
 */
export function createReview(tradeId, data = {}) {
  try {
    const d = data && typeof data === 'object' ? data : {};
    const clean = userOf(d);
    if (!tradeId) return fail('Trade id is required');
    if (!clean) return fail('User is required (pass user or userId in data)');
    const trade = getTradeById(tradeId, clean);
    if (!trade) return fail(`Trade not found: "${tradeId}"`);
    if (trade.status !== 'CLOSED') {
      return fail(
        `Only CLOSED trades can be reviewed (trade "${tradeId}" is ${trade.status}).`,
      );
    }
    if (getReviewByTradeId(clean, tradeId)) {
      return fail(`Review already exists for trade "${tradeId}" (one review per trade).`);
    }
    const setupSnap = resolveSetupSnapshot(clean, trade);
    const checklist = resolveChecklistSnapshot(trade);
    const review = makeTradeReview(
      {
        ...d,
        id: undefined,
        userId: clean,
        tradeId: trade.id,
        accountId: trade.accountId ?? '',
        setupId: trade.setupId ?? '',
        pair: trade.pair ?? '',
        direction: trade.direction ?? 'LONG',
        outcome: outcomeForPnl(trade.pnl),
        tradeSnapshot: deepCopy(trade),
        setupSnapshot: setupSnap,
        checklistSnapshot: checklist,
        automaticFindings: buildFindings(trade, setupSnap, checklist),
        createdAt: undefined,
        updatedAt: undefined,
      },
      clean,
    );
    review.processScore = calculateProcessScore(review);
    stampMirrors(review);
    const all = readRaw(clean);
    if (all.some((r) => r && r.id === review.id)) {
      return fail(`Duplicate review id: "${review.id}"`);
    }
    all.push(review);
    writeAll(clean, all);
    safeAudit(clean, {
      entityType: 'review',
      entityId: String(review.id),
      action: 'REVIEW_CREATED',
      metadata: { tradeId: String(trade.id), outcome: String(review.outcome ?? '') },
    });
    return { success: true, review: normalizeReview(review, clean) };
  } catch (e) {
    return fail(e?.message || 'Failed to create review');
  }
}

const IMMUTABLE_REVIEW_FIELDS = new Set([
  'id',
  'userId',
  'tradeId',
  'tradeSnapshot',
  'setupSnapshot',
  'checklistSnapshot',
  'outcome',
  'createdAt',
]);

/**
 * Update a review's own fields (status, answers, notes, tags...).
 * Historical snapshots and trade linkage are immutable and silently kept.
 * updateReview(user, reviewId, updates). Tolerates updateReview(reviewId, updates).
 */
export function updateReview(a, b, c) {
  try {
    let clean;
    let reviewId;
    let updates;
    if (c !== undefined) {
      clean = normalizeUser(a);
      reviewId = b;
      updates = c;
    } else {
      const d = b && typeof b === 'object' ? b : {};
      reviewId = a;
      updates = d;
      clean = userOf(d);
    }
    if (!reviewId) return fail('Review id is required');
    if (!clean) return fail('User is required');
    const src = updates && typeof updates === 'object' && !Array.isArray(updates) ? updates : {};
    const cleanUpdates = {};
    for (const k of Object.keys(src)) {
      if (!IMMUTABLE_REVIEW_FIELDS.has(k)) cleanUpdates[k] = src[k];
    }
    const all = readRaw(clean);
    const idx = all.findIndex((r) => r && r.id === reviewId);
    if (idx === -1) return fail(`Review not found: "${reviewId}"`);
    const stored = normalizeReview(all[idx], clean);
    const merged = normalizeReview(
      { ...stored, ...cleanUpdates, updatedAt: new Date().toISOString() },
      clean,
    );
    merged.processScore = calculateProcessScore(merged);
    merged.ruleAdherence = adherenceFor(merged);
    stampMirrors(merged);
    all[idx] = merged;
    writeAll(clean, all);
    const wasCompleted = String(stored.status ?? '').trim().toUpperCase() === 'COMPLETED';
    const nowCompleted = String(merged.status ?? '').trim().toUpperCase() === 'COMPLETED';
    safeAudit(clean, {
      entityType: 'review',
      entityId: String(reviewId),
      action: !wasCompleted && nowCompleted ? 'REVIEW_COMPLETED' : 'REVIEW_UPDATED',
      metadata: { tradeId: String(merged.tradeId ?? ''), status: String(merged.status ?? '') },
    });
    return { success: true, review: merged };
  } catch (e) {
    return fail(e?.message || 'Failed to update review');
  }
}

/**
 * Full upsert of a review record. Insert when id is new, replace when it
 * exists. Trade linkage + frozen snapshots of a stored review are preserved
 * on replace. saveReview(user, review).
 */
export function saveReview(user, review) {
  try {
    const clean = normalizeUser(user);
    if (!clean) return fail('User is required');
    if (!review || typeof review !== 'object' || Array.isArray(review)) {
      return fail('Review must be an object');
    }
    const all = readRaw(clean);
    const idx = review.id ? all.findIndex((r) => r && r.id === review.id) : -1;
    if (idx === -1) {
      if (review.tradeId && getReviewByTradeId(clean, review.tradeId)) {
        return fail(`Review already exists for trade "${review.tradeId}" (one review per trade).`);
      }
      const normalized = normalizeReview(
        { ...review, userId: clean, updatedAt: new Date().toISOString() },
        clean,
      );
      normalized.processScore = calculateProcessScore(normalized);
      stampMirrors(normalized);
      all.push(normalized);
      writeAll(clean, all);
      return { success: true, review: normalized };
    }
    const stored = normalizeReview(all[idx], clean);
    const merged = normalizeReview(
      {
        ...stored,
        ...review,
        id: stored.id,
        userId: stored.userId,
        tradeId: stored.tradeId,
        tradeSnapshot: stored.tradeSnapshot,
        setupSnapshot: stored.setupSnapshot,
        checklistSnapshot: stored.checklistSnapshot,
        outcome: stored.outcome,
        createdAt: stored.createdAt,
        updatedAt: new Date().toISOString(),
      },
      clean,
    );
    merged.processScore = calculateProcessScore(merged);
    merged.ruleAdherence = adherenceFor(merged);
    stampMirrors(merged);
    all[idx] = merged;
    writeAll(clean, all);
    return { success: true, review: merged };
  } catch (e) {
    return fail(e?.message || 'Failed to save review');
  }
}

/** Delete a review. The linked trade is never touched. deleteReview(user, reviewId). */
export function deleteReview(a, b) {
  try {
    if (b === undefined) return fail('User and review id are required');
    let all = readRaw(a);
    let idx = all.findIndex((r) => r && r.id === b);
    let clean = normalizeUser(a);
    if (idx === -1) {
      all = readRaw(b);
      idx = all.findIndex((r) => r && r.id === a);
      clean = normalizeUser(b);
    }
    if (idx === -1) return fail(`Review not found: "${b}"`);
    all.splice(idx, 1);
    writeAll(clean, all);
    return { success: true };
  } catch (e) {
    return fail(e?.message || 'Failed to delete review');
  }
}

export default {
  DEFAULT_REVIEW,
  REVIEW_STATUSES,
  REVIEW_OUTCOMES,
  MISTAKE_TYPES,
  STRENGTH_TYPES,
  REVIEW_QUESTIONS,
  getReviews,
  getReview,
  getReviewByTradeId,
  getCompletedReviews,
  getCompletedReview,
  hasCompletedReview,
  createReview,
  updateReview,
  calculateReview,
  saveReview,
  deleteReview,
};
