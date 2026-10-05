// ============================================
// Data Integrity — read-only integrity engine
// Vanilla ESM, offline-first. No side effects on import. No network.
// STRICTLY READ-ONLY: never writes, repairs, or normalizes user records.
// Reads raw localStorage snapshots (never the normalizing getters, so
// stored invalid values stay visible) plus the read-only engine readers
// getAccountPropState / getTradeDataset / getCoreMetrics. An unavailable
// reader yields a SKIPPED warning — never a faked agreement.
// ============================================
import {
  TRADE_STATUSES,
  SETUP_STATUSES,
  INTEGRITY_LEVELS,
  INTEGRITY_CODES,
  RECONCILIATION_TOLERANCE,
} from './models.js';
import { getAccountPropState } from './propEngine.js';
import { getTradeDataset, getCoreMetrics } from './tradingAnalytics.js';

const TRADE_STATUS_SET = new Set(TRADE_STATUSES);
const SETUP_STATUS_SET = new Set(SETUP_STATUSES);

const ERROR = INTEGRITY_LEVELS.ERROR;
const WARNING = INTEGRITY_LEVELS.WARNING;
const C = INTEGRITY_CODES;
const TOL = RECONCILIATION_TOLERANCE;

function normalizeUser(user) {
  return String(user ?? '').trim().toLowerCase();
}

function resolveUser(user) {
  const direct = normalizeUser(user);
  if (direct) return direct;
  try {
    if (typeof localStorage !== 'undefined') {
      const session = normalizeUser(localStorage.getItem('tradelog_session'));
      if (session) return session;
    }
  } catch {
    // Offline-safe: fall through to empty user.
  }
  return direct;
}

function safeParse(raw, fallback) {
  try {
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readArray(key) {
  try {
    if (typeof localStorage === 'undefined') return [];
    const parsed = safeParse(localStorage.getItem(key), []);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readObject(key) {
  try {
    if (typeof localStorage === 'undefined') return {};
    const parsed = safeParse(localStorage.getItem(key), {});
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function foldersKey(user) {
  return `tradelog_folders_${user}`;
}

function exectradesKey(user) {
  return `tradelog_exectrades_${user}`;
}

function setupsKey(user) {
  return `tradelog_setups_${user}`;
}

function reviewsKey(user) {
  return `tradelog_reviews_${user}`;
}

function rulesKey(user) {
  return `tradelog_rules_${user}`;
}

function propConfigKey(user) {
  return `tradelog_propconfig_${user}`;
}

function improvementsKey(user) {
  return `tradelog_improvements_${user}`;
}

function legacyTradesKey(folderId) {
  return `tradelog_trades_${folderId}`;
}

function asRecords(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
}

function isPresent(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return true;
}

function isFiniteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v));
  return false;
}

function round2(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function finiteOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function tradeDirection(raw) {
  const d = String(raw ?? 'LONG').trim().toUpperCase();
  if (d === 'SHORT' || d === 'SELL') return 'SHORT';
  return 'LONG';
}

function makeIssue(code, level, entityType, entityId, message) {
  return {
    code,
    level,
    entityType,
    entityId: String(entityId ?? ''),
    message: String(message ?? ''),
  };
}

function finalize(errors, warnings) {
  const deduped = (list) => {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const key = `${String(item.code ?? '')}::${String(item.entityId ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };
  const compare = (a, b) => {
    const byType = String(a.entityType ?? '').localeCompare(String(b.entityType ?? ''));
    if (byType !== 0) return byType;
    const byId = String(a.entityId ?? '').localeCompare(String(b.entityId ?? ''));
    if (byId !== 0) return byId;
    return String(a.code ?? '').localeCompare(String(b.code ?? ''));
  };
  const cleanErrors = deduped(errors).sort(compare);
  const cleanWarnings = deduped(warnings).sort(compare);
  return {
    valid: cleanErrors.length === 0,
    errors: cleanErrors,
    warnings: cleanWarnings,
    checkedAt: new Date().toISOString(),
  };
}

function checkTrade(t, folderIds) {
  const errors = [];
  const warnings = [];
  const id = t?.id ?? '';
  if (!isPresent(t?.status) || !TRADE_STATUS_SET.has(t.status)) {
    errors.push(
      makeIssue(
        C.TRADE_STATUS_INVALID,
        ERROR,
        'trade',
        id,
        `Trade "${id || '?'}" has invalid status ${JSON.stringify(t?.status ?? null)}; expected one of ${TRADE_STATUSES.join('/')}.`,
      ),
    );
  }
  const isClosed = String(t?.status ?? '') === 'CLOSED';
  const accountId = t?.accountId;
  if (!isPresent(accountId)) {
    warnings.push(
      makeIssue(
        C.TRADE_ACCOUNT_ID_MISSING,
        WARNING,
        'trade',
        id,
        `Trade "${id || '?'}" has no accountId; it cannot be attributed to an account.`,
      ),
    );
  } else if (!folderIds.has(String(accountId))) {
    errors.push(
      makeIssue(
        C.TRADE_ACCOUNT_MISSING,
        ERROR,
        'trade',
        id,
        `Trade "${id || '?'}" references missing account "${String(accountId)}".`,
      ),
    );
  }
  if (isClosed && !isFiniteNumber(t?.pnl)) {
    errors.push(
      makeIssue(
        C.TRADE_PNL_INVALID,
        ERROR,
        'trade',
        id,
        `CLOSED trade "${id || '?'}" has non-finite pnl ${JSON.stringify(t?.pnl ?? null)}.`,
      ),
    );
  }
  const rMultiple = isPresent(t?.rMultiple) ? t.rMultiple : t?.realizedR;
  if (isPresent(rMultiple) && !isFiniteNumber(rMultiple)) {
    errors.push(
      makeIssue(
        C.TRADE_R_MULTIPLE_INVALID,
        ERROR,
        'trade',
        id,
        `Trade "${id || '?'}" has non-finite rMultiple ${JSON.stringify(rMultiple ?? null)}.`,
      ),
    );
  }
  const openedAt = t?.openedAt;
  const closedAt = t?.closedAt;
  if (isPresent(openedAt) && isPresent(closedAt)) {
    const openedMs = Date.parse(openedAt);
    const closedMs = Date.parse(closedAt);
    if (Number.isNaN(openedMs) || Number.isNaN(closedMs)) {
      errors.push(
        makeIssue(
          C.TRADE_DATES_UNPARSEABLE,
          ERROR,
          'trade',
          id,
          `Trade "${id || '?'}" has unparseable dates (openedAt=${JSON.stringify(openedAt ?? null)}, closedAt=${JSON.stringify(closedAt ?? null)}).`,
        ),
      );
    } else if (openedMs > closedMs) {
      errors.push(
        makeIssue(
          C.TRADE_DATES_INVALID,
          ERROR,
          'trade',
          id,
          `Trade "${id || '?'}" openedAt is after closedAt.`,
        ),
      );
    }
  }
  const entry = t?.entryPrice ?? t?.entry;
  const stopLoss = t?.stopLoss ?? t?.currentSL ?? t?.sl;
  const takeProfit = t?.takeProfit ?? t?.currentTP ?? t?.tp;
  if (
    isFiniteNumber(entry) &&
    isFiniteNumber(stopLoss) &&
    isFiniteNumber(takeProfit) &&
    Number(entry) > 0 &&
    Number(stopLoss) > 0 &&
    Number(takeProfit) > 0
  ) {
    const direction = tradeDirection(t?.direction);
    const entryNum = Number(entry);
    const slNum = Number(stopLoss);
    const tpNum = Number(takeProfit);
    const ok = direction === 'LONG' ? slNum < entryNum && tpNum > entryNum : slNum > entryNum && tpNum < entryNum;
    if (!ok) {
      errors.push(
        makeIssue(
          C.TRADE_LEVELS_INVALID,
          ERROR,
          'trade',
          id,
          `Trade "${id || '?'}" has invalid ${direction} levels (entry=${entryNum}, SL=${slNum}, TP=${tpNum}).`,
        ),
      );
    }
  }
  const lot = t?.lotSize ?? t?.lot;
  if (isPresent(lot) && (!isFiniteNumber(lot) || Number(lot) <= 0)) {
    warnings.push(
      makeIssue(
        C.TRADE_LOT_SIZE_INVALID,
        WARNING,
        'trade',
        id,
        `Trade "${id || '?'}" has suspicious lot size ${JSON.stringify(lot ?? null)}.`,
      ),
    );
  }
  return { errors, warnings };
}

function checkSetup(s, folderIds, tradeIds) {
  const errors = [];
  const warnings = [];
  const id = s?.id ?? '';
  if (!isPresent(s?.status) || !SETUP_STATUS_SET.has(s.status)) {
    errors.push(
      makeIssue(
        C.SETUP_STATUS_INVALID,
        ERROR,
        'setup',
        id,
        `Setup "${id || '?'}" has invalid status ${JSON.stringify(s?.status ?? null)}; expected one of ${SETUP_STATUSES.join('/')}.`,
      ),
    );
  }
  if (String(s?.status ?? '') === 'ENTERED') {
    const ref = s?.executedTradeId;
    if (!isPresent(ref) || !tradeIds.has(String(ref))) {
      errors.push(
        makeIssue(
          C.SETUP_ENTERED_MISSING_TRADE,
          ERROR,
          'setup',
          id,
          `ENTERED setup "${id || '?'}" references missing executed trade ${JSON.stringify(ref ?? null)}.`,
        ),
      );
    }
  }
  const accountId = s?.accountId;
  if (isPresent(accountId) && !folderIds.has(String(accountId))) {
    warnings.push(
      makeIssue(
        C.SETUP_ACCOUNT_MISSING,
        WARNING,
        'setup',
        id,
        `Setup "${id || '?'}" references missing account "${String(accountId)}".`,
      ),
    );
  }
  return { errors, warnings };
}

function isReviewCompleted(review) {
  return String(review?.status ?? '').trim().toUpperCase() === 'COMPLETED';
}

function checkReview(r, tradeById, completedCounts) {
  const errors = [];
  const warnings = [];
  const id = r?.id ?? '';
  const tradeId = r?.tradeId;
  const completed = isReviewCompleted(r);
  if (!isPresent(tradeId) || !tradeById.has(String(tradeId))) {
    errors.push(
      makeIssue(
        C.REVIEW_TRADE_MISSING,
        ERROR,
        'review',
        id,
        `Review "${id || '?'}" references missing trade ${JSON.stringify(tradeId ?? null)}.`,
      ),
    );
  } else {
    const trade = tradeById.get(String(tradeId));
    if (String(trade?.status ?? '') !== 'CLOSED') {
      if (completed) {
        errors.push(
          makeIssue(
            C.REVIEW_TRADE_NOT_CLOSED,
            ERROR,
            'review',
            id,
            `Review "${id || '?'}" references trade "${String(tradeId)}" with status "${String(trade?.status ?? '')}"; completed reviews require a CLOSED trade.`,
          ),
        );
      } else {
        warnings.push(
          makeIssue(
            C.REVIEW_NON_CLOSED_TRADE,
            WARNING,
            'review',
            id,
            `Review "${id || '?'}" exists for non-CLOSED trade "${String(tradeId)}" (status "${String(trade?.status ?? '')}").`,
          ),
        );
      }
    }
  }
  if (completed && isPresent(tradeId) && (completedCounts.get(String(tradeId)) ?? 0) > 1) {
    errors.push(
      makeIssue(
        C.REVIEW_DUPLICATE,
        ERROR,
        'review',
        id,
        `Duplicate completed review "${id || '?'}" for trade "${String(tradeId)}"; at most one completed review per trade is allowed.`,
      ),
    );
  }
  return { errors, warnings };
}

function checkRuleWeight(r) {
  const warnings = [];
  const id = r?.id ?? '';
  const weight = r?.weight;
  if (isPresent(weight) && (!isFiniteNumber(weight) || Number(weight) <= 0 || Number(weight) > 100)) {
    warnings.push(
      makeIssue(
        C.RULE_WEIGHT_INVALID,
        WARNING,
        'rule',
        id,
        `Rule "${id || '?'}" has suspicious weight ${JSON.stringify(weight ?? null)}; expected a number in (0, 100].`,
      ),
    );
  }
  return { errors: [], warnings };
}

function checkLegacyBalance(folder, legacyTrades) {
  const warnings = [];
  const folderId = folder?.id ?? '';
  const starting = Number(folder?.startingBalance);
  if (!Number.isFinite(starting)) return warnings;
  const rows = asRecords(legacyTrades).slice();
  rows.sort((a, b) => {
    const byDate = new Date(a?.date).getTime() - new Date(b?.date).getTime();
    if (Number.isFinite(byDate) && byDate !== 0) return byDate;
    const byCreated = new Date(a?.createdAt).getTime() - new Date(b?.createdAt).getTime();
    if (Number.isFinite(byCreated) && byCreated !== 0) return byCreated;
    return 0;
  });
  let running = starting;
  rows.forEach((t, index) => {
    const amount = Number(t?.amount);
    if (Number.isFinite(amount)) {
      running = round2(running + (String(t?.type ?? '').trim().toUpperCase() === 'TP' ? amount : -amount));
    }
    if (isPresent(t?.balanceAfter) && isFiniteNumber(t?.balanceAfter)) {
      if (Math.abs(Number(t.balanceAfter) - running) > TOL) {
        warnings.push(
          makeIssue(
            C.TRADE_BALANCE_INCONSISTENT,
            WARNING,
            'trade',
            t?.id ?? `${folderId}:legacy-${index}`,
            `Legacy trade "${t?.id ?? `legacy-${index}`}" balanceAfter ${Number(t.balanceAfter)} disagrees with running balance ${running}.`,
          ),
        );
      }
    }
  });
  return warnings;
}

function collectDataset(user) {
  const clean = resolveUser(user);
  const folderList = asRecords(readArray(foldersKey(clean)));
  const tradeList = asRecords(readArray(exectradesKey(clean)));
  const setupList = asRecords(readArray(setupsKey(clean)));
  const reviewList = asRecords(readArray(reviewsKey(clean)));
  const ruleList = asRecords(readArray(rulesKey(clean)));
  const propConfigs = readObject(propConfigKey(clean));
  const improvementList = asRecords(readArray(improvementsKey(clean)));
  const folderIds = new Set(folderList.filter((f) => isPresent(f?.id)).map((f) => String(f.id)));
  const tradeIds = new Set(tradeList.filter((t) => isPresent(t?.id)).map((t) => String(t.id)));
  const tradeById = new Map();
  for (const t of tradeList) {
    if (isPresent(t?.id) && !tradeById.has(String(t.id))) tradeById.set(String(t.id), t);
  }
  const completedCounts = new Map();
  for (const r of reviewList) {
    if (isReviewCompleted(r) && isPresent(r?.tradeId)) {
      const key = String(r.tradeId);
      completedCounts.set(key, (completedCounts.get(key) ?? 0) + 1);
    }
  }
  const errors = [];
  const warnings = [];
  for (const t of tradeList) {
    const res = checkTrade(t, folderIds);
    errors.push(...res.errors);
    warnings.push(...res.warnings);
  }
  for (const s of setupList) {
    const res = checkSetup(s, folderIds, tradeIds);
    errors.push(...res.errors);
    warnings.push(...res.warnings);
  }
  for (const r of reviewList) {
    const res = checkReview(r, tradeById, completedCounts);
    errors.push(...res.errors);
    warnings.push(...res.warnings);
  }
  const ruleIdCounts = new Map();
  for (const r of ruleList) {
    if (!isPresent(r?.id)) continue;
    const key = String(r.id);
    ruleIdCounts.set(key, (ruleIdCounts.get(key) ?? 0) + 1);
  }
  for (const [dupId, count] of ruleIdCounts.entries()) {
    if (count > 1) {
      warnings.push(
        makeIssue(
          C.RULE_DUPLICATE_ID,
          WARNING,
          'rule',
          dupId,
          `Duplicate rule id "${dupId}" appears ${count} times.`,
        ),
      );
    }
  }
  for (const r of ruleList) {
    const res = checkRuleWeight(r);
    warnings.push(...res.warnings);
  }
  for (const folder of folderList) {
    if (!isPresent(folder?.id)) continue;
    warnings.push(...checkLegacyBalance(folder, readArray(legacyTradesKey(String(folder.id)))));
  }
  return {
    clean,
    folders: folderList,
    trades: tradeList,
    setups: setupList,
    reviews: reviewList,
    rules: ruleList,
    propConfigs,
    improvements: improvementList,
    errors,
    warnings,
  };
}

function findTradeAnywhere(clean, tradeId) {
  const canonical = asRecords(readArray(exectradesKey(clean)));
  const inCanonical = canonical.find((t) => isPresent(t?.id) && String(t.id) === String(tradeId));
  if (inCanonical) return inCanonical;
  const folderList = asRecords(readArray(foldersKey(clean)));
  for (const folder of folderList) {
    if (!isPresent(folder?.id)) continue;
    const legacy = asRecords(readArray(legacyTradesKey(String(folder.id))));
    const hit = legacy.find((t) => isPresent(t?.id) && String(t.id) === String(tradeId));
    if (hit) return hit;
  }
  return undefined;
}

function closedPnlSum(trades, accountId) {
  let sum = 0;
  for (const t of trades) {
    if (!t || String(t?.accountId ?? '') !== String(accountId)) continue;
    if (String(t?.status ?? '') !== 'CLOSED') continue;
    sum = round2(sum + finiteOrZero(t?.pnl));
  }
  return sum;
}

function accountCalculatedBalance(folder, trades) {
  const starting = Number(folder?.startingBalance);
  if (!Number.isFinite(starting)) return null;
  let sum = 0;
  for (const t of trades) {
    if (!t || String(t?.accountId ?? '') !== String(folder?.id ?? '')) continue;
    const status = String(t?.status ?? '');
    if (status !== 'CLOSED' && status !== 'PARTIALLY_CLOSED') continue;
    sum = round2(sum + finiteOrZero(t?.pnl));
  }
  return round2(starting + sum);
}

export function validateAccount(accountId, user) {
  const clean = resolveUser(user);
  const errors = [];
  const warnings = [];
  if (!isPresent(accountId)) {
    errors.push(makeIssue(C.ACCOUNT_NOT_FOUND, ERROR, 'account', '', 'Account id is required.'));
    return { ...finalize(errors, warnings), checkedAt: new Date().toISOString() };
  }
  const folderList = asRecords(readArray(foldersKey(clean)));
  const folder = folderList.find((f) => isPresent(f?.id) && String(f.id) === String(accountId));
  if (!folder) {
    errors.push(
      makeIssue(C.ACCOUNT_NOT_FOUND, ERROR, 'account', String(accountId), `Account "${String(accountId)}" not found.`)
    );
    return { ...finalize(errors, warnings), checkedAt: new Date().toISOString() };
  }
  const folderIds = new Set(folderList.filter((f) => isPresent(f?.id)).map((f) => String(f.id)));
  const tradeList = asRecords(readArray(exectradesKey(clean)));
  for (const t of tradeList) {
    if (String(t?.accountId ?? '') !== String(folder.id)) continue;
    const res = checkTrade(t, folderIds);
    errors.push(...res.errors);
    warnings.push(...res.warnings);
  }
  warnings.push(...checkLegacyBalance(folder, readArray(legacyTradesKey(String(folder.id)))));
  for (const recon of [
    reconcileAccountBalance(folder.id, clean),
    reconcilePropVsAccount(folder.id, clean),
    reconcileAnalyticsVsTrades(folder.id, clean),
  ]) {
    errors.push(...(recon.errors ?? []));
    warnings.push(...(recon.warnings ?? []));
  }
  return finalize(errors, warnings);
}

export function validateTrade(tradeId, user) {
  const clean = resolveUser(user);
  const errors = [];
  const warnings = [];
  if (!isPresent(tradeId)) {
    errors.push(makeIssue(C.TRADE_NOT_FOUND, ERROR, 'trade', '', 'Trade id is required.'));
    return finalize(errors, warnings);
  }
  const trade = findTradeAnywhere(clean, tradeId);
  if (!trade) {
    errors.push(
      makeIssue(C.TRADE_NOT_FOUND, ERROR, 'trade', String(tradeId), `Trade "${String(tradeId)}" not found.`)
    );
    return finalize(errors, warnings);
  }
  const folderList = asRecords(readArray(foldersKey(clean)));
  const folderIds = new Set(folderList.filter((f) => isPresent(f?.id)).map((f) => String(f.id)));
  const res = checkTrade(trade, folderIds);
  errors.push(...res.errors);
  warnings.push(...res.warnings);
  return finalize(errors, warnings);
}

export function validateSetup(setupId, user) {
  const clean = resolveUser(user);
  const errors = [];
  const warnings = [];
  if (!isPresent(setupId)) {
    errors.push(makeIssue(C.SETUP_NOT_FOUND, ERROR, 'setup', '', 'Setup id is required.'));
    return finalize(errors, warnings);
  }
  const setupList = asRecords(readArray(setupsKey(clean)));
  const setup = setupList.find((s) => isPresent(s?.id) && String(s.id) === String(setupId));
  if (!setup) {
    errors.push(
      makeIssue(C.SETUP_NOT_FOUND, ERROR, 'setup', String(setupId), `Setup "${String(setupId)}" not found.`)
    );
    return finalize(errors, warnings);
  }
  const folderList = asRecords(readArray(foldersKey(clean)));
  const folderIds = new Set(folderList.filter((f) => isPresent(f?.id)).map((f) => String(f.id)));
  const tradeList = asRecords(readArray(exectradesKey(clean)));
  const tradeIds = new Set(tradeList.filter((t) => isPresent(t?.id)).map((t) => String(t.id)));
  const res = checkSetup(setup, folderIds, tradeIds);
  errors.push(...res.errors);
  warnings.push(...res.warnings);
  return finalize(errors, warnings);
}

export function validateReview(reviewId, user) {
  const clean = resolveUser(user);
  const errors = [];
  const warnings = [];
  if (!isPresent(reviewId)) {
    errors.push(makeIssue(C.REVIEW_NOT_FOUND, ERROR, 'review', '', 'Review id is required.'));
    return finalize(errors, warnings);
  }
  const reviewList = asRecords(readArray(reviewsKey(clean)));
  const review = reviewList.find((r) => isPresent(r?.id) && String(r.id) === String(reviewId));
  if (!review) {
    errors.push(
      makeIssue(C.REVIEW_NOT_FOUND, ERROR, 'review', String(reviewId), `Review "${String(reviewId)}" not found.`)
    );
    return finalize(errors, warnings);
  }
  const tradeList = asRecords(readArray(exectradesKey(clean)));
  const tradeById = new Map();
  for (const t of tradeList) {
    if (isPresent(t?.id) && !tradeById.has(String(t.id))) tradeById.set(String(t.id), t);
  }
  const completedCounts = new Map();
  for (const r of reviewList) {
    if (isReviewCompleted(r) && isPresent(r?.tradeId)) {
      const key = String(r.tradeId);
      completedCounts.set(key, (completedCounts.get(key) ?? 0) + 1);
    }
  }
  const res = checkReview(review, tradeById, completedCounts);
  errors.push(...res.errors);
  warnings.push(...res.warnings);
  return finalize(errors, warnings);
}

export function validateUserDataset(user) {
  const dataset = collectDataset(user);
  return finalize(dataset.errors, dataset.warnings);
}

export function getIntegrityReport(user) {
  const dataset = collectDataset(user);
  const errors = [...dataset.errors];
  const warnings = [...dataset.warnings];
  const accountBalance = [];
  const propVsAccount = [];
  const analyticsVsTrades = [];
  for (const folder of dataset.folders) {
    if (!isPresent(folder?.id)) continue;
    const accountId = String(folder.id);
    const balanceRecon = reconcileAccountBalance(accountId, dataset.clean);
    const propRecon = reconcilePropVsAccount(accountId, dataset.clean);
    const analyticsRecon = reconcileAnalyticsVsTrades(accountId, dataset.clean);
    accountBalance.push(balanceRecon);
    propVsAccount.push(propRecon);
    analyticsVsTrades.push(analyticsRecon);
    errors.push(...(balanceRecon.errors ?? []), ...(propRecon.errors ?? []), ...(analyticsRecon.errors ?? []));
    warnings.push(...(balanceRecon.warnings ?? []), ...(propRecon.warnings ?? []), ...(analyticsRecon.warnings ?? []));
  }
  const finalized = finalize(errors, warnings);
  const counts = {};
  for (const item of [...finalized.errors, ...finalized.warnings]) {
    const key = String(item?.code ?? 'UNKNOWN');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const reconValid = [...accountBalance, ...propVsAccount, ...analyticsVsTrades].every((r) => r?.valid === true);
  return {
    valid: finalized.errors.length === 0 && reconValid,
    errors: finalized.errors,
    warnings: finalized.warnings,
    checkedAt: finalized.checkedAt,
    summary: {
      accounts: dataset.folders.length,
      trades: dataset.trades.length,
      setups: dataset.setups.length,
      reviews: dataset.reviews.length,
      rules: dataset.rules.length,
      propConfigs: Object.keys(dataset.propConfigs ?? {}).length,
      improvements: dataset.improvements.length,
      errors: finalized.errors.length,
      warnings: finalized.warnings.length,
      counts,
    },
    reconciliations: {
      accountBalance,
      propVsAccount,
      analyticsVsTrades,
    },
  };
}

export function reconcileAccountBalance(accountId, user) {
  const clean = resolveUser(user);
  const checkedAt = new Date().toISOString();
  const fail = (code, message, extra = {}) => ({
    valid: false,
    errors: [],
    warnings: [makeIssue(code, WARNING, 'reconciliation', String(accountId ?? ''), message)],
    checkedAt,
    accountId: isPresent(accountId) ? String(accountId) : '',
    skipped: true,
    ...extra,
  });
  if (!isPresent(accountId)) {
    return fail(C.RECON_BALANCE_SKIPPED, 'Account id is required; balance check was skipped.');
  }
  const folderList = asRecords(readArray(foldersKey(clean)));
  const folder = folderList.find((f) => isPresent(f?.id) && String(f.id) === String(accountId));
  if (!folder) {
    return fail(C.RECON_BALANCE_SKIPPED, `Account "${String(accountId)}" not found; balance check was skipped.`);
  }
  const starting = Number(folder?.startingBalance);
  if (!Number.isFinite(starting)) {
    return fail(
      C.RECON_BALANCE_SKIPPED,
      `Account "${String(accountId)}" has no finite startingBalance; balance check was skipped.`
    );
  }
  const tradeList = asRecords(readArray(exectradesKey(clean)));
  const expected = round2(starting + closedPnlSum(tradeList, String(accountId)));
  const actual = Number(folder?.currentBalance);
  if (!Number.isFinite(actual)) {
    return fail(
      C.RECON_BALANCE_SKIPPED,
      `Account "${String(accountId)}" has no finite stored currentBalance; balance check was skipped.`,
      { expected, skipped: true }
    );
  }
  const difference = round2(expected - actual);
  if (Math.abs(difference) > TOL) {
    return {
      valid: false,
      errors: [],
      warnings: [
        makeIssue(
          C.RECON_BALANCE_MISMATCH,
          WARNING,
          'reconciliation',
          String(accountId),
          `Account "${String(accountId)}" stored balance ${actual} disagrees with startingBalance + closed pnl ${expected} (diff ${difference}); flagged only, never auto-fixed.`
        ),
      ],
      checkedAt,
      accountId: String(accountId),
      expected,
      actual,
      difference,
      tolerance: TOL,
      skipped: false,
    };
  }
  return {
    valid: true,
    errors: [],
    warnings: [],
    checkedAt,
    accountId: String(accountId),
    expected,
    actual,
    difference,
    tolerance: TOL,
    skipped: false,
  };
}

export function reconcilePropVsAccount(accountId, user) {
  const clean = resolveUser(user);
  const checkedAt = new Date().toISOString();
  const fail = (code, message, extra = {}) => ({
    valid: false,
    errors: [],
    warnings: [makeIssue(code, WARNING, 'reconciliation', String(accountId ?? ''), message)],
    checkedAt,
    accountId: isPresent(accountId) ? String(accountId) : '',
    skipped: true,
    ...extra,
  });
  if (!isPresent(accountId)) {
    return fail(C.RECON_PROP_SKIPPED, 'Account id is required; prop comparison was skipped.');
  }
  let state = null;
  try {
    if (typeof getAccountPropState !== 'function') {
      return fail(C.RECON_PROP_SKIPPED, 'Prop reader is unavailable; prop comparison was skipped.');
    }
    state = getAccountPropState(String(accountId), clean);
  } catch (e) {
    return fail(
      C.RECON_PROP_SKIPPED,
      `Prop reader failed (${String(e?.message ?? e)}); prop comparison was skipped, not treated as agreement.`
    );
  }
  if (!state || state.success === false || !Number.isFinite(Number(state?.balance))) {
    return fail(
      C.RECON_PROP_SKIPPED,
      `Prop state unavailable for account "${String(accountId)}" (${String(state?.error ?? 'no balance')}); prop comparison was skipped, not treated as agreement.`
    );
  }
  const folderList = asRecords(readArray(foldersKey(clean)));
  const folder = folderList.find((f) => isPresent(f?.id) && String(f.id) === String(accountId));
  if (!folder) {
    return fail(C.RECON_PROP_SKIPPED, `Account "${String(accountId)}" not found; prop comparison was skipped.`);
  }
  const tradeList = asRecords(readArray(exectradesKey(clean)));
  const accountBalance = accountCalculatedBalance(folder, tradeList);
  if (accountBalance === null) {
    return fail(
      C.RECON_PROP_SKIPPED,
      `Account "${String(accountId)}" has no finite startingBalance; prop comparison was skipped.`
    );
  }
  const propBalance = round2(Number(state.balance));
  const difference = round2(propBalance - accountBalance);
  if (Math.abs(difference) > TOL) {
    return {
      valid: false,
      errors: [],
      warnings: [
        makeIssue(
          C.RECON_PROP_MISMATCH,
          WARNING,
          'reconciliation',
          String(accountId),
          `Prop engine balance ${propBalance} disagrees with account-calculated balance ${accountBalance} for account "${String(accountId)}" (diff ${difference}); flagged only, never auto-fixed.`
        ),
      ],
      checkedAt,
      accountId: String(accountId),
      accountBalance,
      propBalance,
      difference,
      tolerance: TOL,
      skipped: false,
    };
  }
  return {
    valid: true,
    errors: [],
    warnings: [],
    checkedAt,
    accountId: String(accountId),
    accountBalance,
    propBalance,
    difference,
    tolerance: TOL,
    skipped: false,
  };
}

export function reconcileAnalyticsVsTrades(accountId, user) {
  const clean = resolveUser(user);
  const checkedAt = new Date().toISOString();
  const fail = (code, entityId, message, extra = {}) => ({
    valid: false,
    errors: [],
    warnings: [makeIssue(code, WARNING, 'reconciliation', entityId, message)],
    checkedAt,
    accountId: isPresent(accountId) ? String(accountId) : '',
    skipped: true,
    ...extra,
  });
  if (!isPresent(accountId)) {
    return fail(
      C.RECON_ANALYTICS_SKIPPED,
      String(accountId ?? ''),
      'Account id is required; analytics comparison was skipped.'
    );
  }
  let dataset = null;
  let metrics = null;
  try {
    if (typeof getTradeDataset !== 'function' || typeof getCoreMetrics !== 'function') {
      return fail(
        C.RECON_ANALYTICS_SKIPPED,
        String(accountId),
        'Analytics readers are unavailable; analytics comparison was skipped.'
      );
    }
    dataset = getTradeDataset(String(accountId), { user: clean });
    metrics = getCoreMetrics(dataset);
  } catch (e) {
    return fail(
      C.RECON_ANALYTICS_SKIPPED,
      String(accountId),
      `Analytics readers failed (${String(e?.message ?? e)}); analytics comparison was skipped, not treated as agreement.`
    );
  }
  if (!Array.isArray(dataset) || !metrics || typeof metrics !== 'object') {
    return fail(
      C.RECON_ANALYTICS_SKIPPED,
      String(accountId),
      'Analytics readers returned no usable dataset; analytics comparison was skipped, not treated as agreement.'
    );
  }
  const tradeList = asRecords(readArray(exectradesKey(clean)));
  let tradePnl = 0;
  let tradeR = 0;
  for (const t of tradeList) {
    if (String(t?.accountId ?? '') !== String(accountId)) continue;
    if (String(t?.status ?? '') !== 'CLOSED') continue;
    tradePnl = round2(tradePnl + finiteOrZero(t?.pnl));
    const rRaw = isPresent(t?.rMultiple) ? t.rMultiple : t?.realizedR;
    tradeR = round2(tradeR + finiteOrZero(rRaw));
  }
  const analyticsPnl = round2(finiteOrZero(metrics?.totalPnl));
  const analyticsR = round2(finiteOrZero(metrics?.totalR));
  const warnings = [];
  const pnlDiff = round2(analyticsPnl - tradePnl);
  if (Math.abs(pnlDiff) > TOL) {
    warnings.push(
      makeIssue(
        C.RECON_ANALYTICS_MISMATCH,
        WARNING,
        'reconciliation',
        `${String(accountId)}:pnl`,
        `Analytics totalPnl ${analyticsPnl} disagrees with closed-trade sum ${tradePnl} for account "${String(accountId)}" (diff ${pnlDiff}); flagged only, never auto-fixed.`
      )
    );
  }
  const rDiff = round2(analyticsR - tradeR);
  if (Math.abs(rDiff) > TOL) {
    warnings.push(
      makeIssue(
        C.RECON_ANALYTICS_MISMATCH,
        WARNING,
        'reconciliation',
        `${String(accountId)}:totalR`,
        `Analytics totalR ${analyticsR} disagrees with closed-trade sum ${tradeR} for account "${String(accountId)}" (diff ${rDiff}); flagged only, never auto-fixed.`
      )
    );
  }
  return {
    valid: warnings.length === 0,
    errors: [],
    warnings,
    checkedAt,
    accountId: String(accountId),
    tradePnl,
    analyticsPnl,
    pnlDifference: pnlDiff,
    tradeR,
    analyticsR,
    rDifference: rDiff,
    tolerance: TOL,
    skipped: false,
  };
}
