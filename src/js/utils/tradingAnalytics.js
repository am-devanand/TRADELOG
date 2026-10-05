import {
  ANALYTICS_THRESHOLDS,
  ANALYTICS_OUTCOMES,
  REVIEW_FILTERS,
  MISTAKE_TYPES,
  STRENGTH_TYPES,
  PROCESS_QUALITY_THRESHOLD,
  outcomeForPnl,
} from './models.js';
import { getClosedTrades } from './executedTrades.js';
import { getCompletedReviews } from './tradeReviews.js';
import { gradeForTotal } from './processScore.js';
import { toLocalISO } from './dayKey.js';
import { getImprovementPatterns as improvementPatterns } from './improvementEngine.js';

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function toFinite(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function finiteOrNull(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function isDatasetRow(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v) && 'trade' in v;
}

function mean(vals) {
  if (vals.length === 0) return null;
  return round2(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function tradeTimestamp(trade) {
  const t = trade && typeof trade === 'object' ? trade : {};
  return t.closedAt || t.openedAt || t.createdAt || '';
}

function localDayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return toLocalISO(d) || '';
  } catch {
    return '';
  }
}

function reviewTotal(review) {
  if (!review || typeof review !== 'object') return null;
  const nested =
    review.processScore && typeof review.processScore === 'object'
      ? review.processScore.total
      : NaN;
  const n = Number(nested);
  if (Number.isFinite(n)) return n;
  return finiteOrNull(review.total);
}

function reviewSubscores(review) {
  const ps =
    review && typeof review === 'object' && review.processScore && typeof review.processScore === 'object'
      ? review.processScore
      : {};
  return {
    preTrade: finiteOrNull(ps.preTradeScore),
    execution: finiteOrNull(ps.executionScore),
    management: finiteOrNull(ps.managementScore),
    discipline: finiteOrNull(ps.disciplineScore),
  };
}

function asReview(review) {
  return review && typeof review === 'object' && !Array.isArray(review) ? review : null;
}

function makeRow(trade, review, hint) {
  const rev = asReview(review);
  const pnl = toFinite(trade && trade.pnl, 0);
  const r = toFinite(trade && (trade.rMultiple ?? trade.realizedR), 0);
  const ps =
    rev != null
      ? reviewTotal(rev)
      : hint != null && Number.isFinite(hint.processScore)
        ? hint.processScore
        : null;
  const reviewed = rev != null || (hint != null && hint.reviewed === true);
  return { trade, review: rev, outcome: outcomeForPnl(pnl), pnl, r, processScore: ps, reviewed };
}

function normalizeRows(dataset) {
  const list = Array.isArray(dataset) ? dataset : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (isDatasetRow(item)) {
      if (!item.trade || typeof item.trade !== 'object') continue;
      out.push(makeRow(item.trade, item.review ?? null, item));
    } else {
      out.push(makeRow(item, item.review ?? null, null));
    }
  }
  return out;
}

// Snapshots live on the trade in two fields holding the same frozen content,
// so checklistResults wins and rulesSnapshot is only a fallback — reading
// both would double-count every evaluation.
function snapshotEntries(trade) {
  const t = trade && typeof trade === 'object' ? trade : {};
  if (Array.isArray(t.checklistResults) && t.checklistResults.length > 0) return t.checklistResults;
  if (Array.isArray(t.rulesSnapshot) && t.rulesSnapshot.length > 0) return t.rulesSnapshot;
  return [];
}

function boolFromString(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'pass' || s === 'passed' || s === 'true' || s === 'yes' || s === 'y') return true;
  if (s === 'fail' || s === 'failed' || s === 'false' || s === 'no' || s === 'n') return false;
  return undefined;
}

function entryName(e) {
  const cands = [e.name, e.title, e.ruleName, e.label, e.rule, e.id, e.ruleId, e.key];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return '';
}

// A snapshot entry counts as evaluated only with an explicit boolean-ish
// verdict; verdict-less rule metadata is skipped rather than scored as fail.
function parseSnapshotEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  let pass;
  for (const c of [e.pass, e.passed, e.ok, e.success, e.checked]) {
    if (typeof c === 'boolean') {
      pass = c;
      break;
    }
  }
  if (pass === undefined) {
    if (typeof e.value === 'boolean') pass = e.value;
    else {
      for (const c of [e.result, e.verdict, e.status, e.outcome]) {
        const b = boolFromString(c);
        if (b !== undefined) {
          pass = b;
          break;
        }
      }
    }
  }
  if (pass === undefined) return null;
  const name = entryName(e);
  if (name === '') return null;
  return { name, pass, required: e.required === true };
}

// Pooled pass rate over snapshot evaluations (null when no snapshot data,
// so callers never render a fabricated adherence value).
function pooledRuleAdherence(rows) {
  let passed = 0;
  let evaluated = 0;
  for (const r of rows) {
    for (const e of snapshotEntries(r.trade)) {
      const p = parseSnapshotEntry(e);
      if (!p) continue;
      evaluated += 1;
      if (p.pass) passed += 1;
    }
  }
  if (evaluated === 0) return null;
  return round2((passed / evaluated) * 100);
}

function profitFactorFor(rows) {
  if (rows.length === 0) return null;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const r of rows) {
    if (r.pnl > 0) grossProfit += r.pnl;
    else if (r.pnl < 0) grossLoss += Math.abs(r.pnl);
  }
  if (grossLoss === 0) return null;
  return round2(grossProfit / grossLoss);
}

function avgProcessScoreFor(rows) {
  const scores = [];
  for (const r of rows) {
    if (r.reviewed && Number.isFinite(r.processScore)) scores.push(r.processScore);
  }
  return mean(scores);
}

function tagList(review, key) {
  const raw = review && Array.isArray(review[key]) ? review[key] : [];
  const out = [];
  for (const t of raw) {
    if (typeof t === 'string' && t.trim() !== '') out.push(t.trim());
    else if (t && typeof t === 'object') {
      const name = entryName(t);
      if (name !== '') out.push(name);
    }
  }
  return out;
}

function medianOf(vals) {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return round2(s[mid]);
  return round2((s[mid - 1] + s[mid]) / 2);
}

export function filterTrades(trades, filters = {}) {
  const list = Array.isArray(trades) ? trades : [];
  const f = filters && typeof filters === 'object' ? filters : {};
  const toSet = (v, upper = false) => {
    if (v == null) return null;
    const arr = Array.isArray(v) ? v : [v];
    const vals = [];
    for (const x of arr) {
      if (x == null || x === '') continue;
      vals.push(upper ? String(x).toUpperCase() : String(x));
    }
    return vals.length > 0 ? new Set(vals) : null;
  };
  const accountId = f.accountId == null || f.accountId === '' ? null : String(f.accountId);
  const strategies = toSet(f.strategies);
  const pairs = toSet(f.pairs);
  const sessions = toSet(f.sessions);
  const timeframes = toSet(f.timeframes);
  const setupTypes = toSet(f.setupTypes);
  let outcomes = toSet(f.outcomes, true);
  if (outcomes) {
    const valid = new Set(ANALYTICS_OUTCOMES);
    const kept = [...outcomes].filter((o) => valid.has(o));
    outcomes = kept.length > 0 ? new Set(kept) : null;
  }
  let dayFrom = null;
  let dayTo = null;
  if (f.dateFrom != null && f.dateFrom !== '') dayFrom = String(f.dateFrom).slice(0, 10);
  if (f.dateTo != null && f.dateTo !== '') dayTo = String(f.dateTo).slice(0, 10);
  let reviewNorm = String(f.reviewStatus ?? 'ALL').trim().toUpperCase();
  if (!REVIEW_FILTERS.includes(reviewNorm)) reviewNorm = 'ALL';
  let reviewedIds = null;
  if (reviewNorm !== 'ALL') {
    if (f.reviewedTradeIds instanceof Set) reviewedIds = f.reviewedTradeIds;
    else if (Array.isArray(f.reviewedTradeIds)) {
      reviewedIds = new Set(f.reviewedTradeIds.map((x) => String(x)));
    } else if (Array.isArray(f.reviews)) {
      reviewedIds = new Set();
      for (const r of f.reviews) {
        if (r && r.tradeId != null && String(r.tradeId) !== '') reviewedIds.add(String(r.tradeId));
      }
    }
  }
  const reviewedFlag = (item) => {
    if (isDatasetRow(item) && typeof item.reviewed === 'boolean') return item.reviewed;
    const t = isDatasetRow(item) ? item.trade : item;
    if (t && typeof t === 'object') {
      if (typeof t._reviewed === 'boolean') return t._reviewed;
      if (typeof t.hasReview === 'boolean') return t.hasReview;
      if (t.review != null) return true;
      if (t.reviewStatus != null && String(t.reviewStatus).trim() !== '') {
        const s = String(t.reviewStatus).trim().toUpperCase();
        if (s === 'REVIEWED') return true;
        if (s === 'UNREVIEWED') return false;
      }
    }
    if (reviewedIds && t && t.id != null && String(t.id) !== '') return reviewedIds.has(String(t.id));
    return null;
  };
  return list.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const trade = isDatasetRow(item) ? item.trade : item;
    if (!trade || typeof trade !== 'object') return false;
    if (accountId != null && String(trade.accountId ?? '') !== accountId) return false;
    if (strategies) {
      const k = String(trade.strategyId ?? trade.strategy ?? '').trim();
      if (k === '' || !strategies.has(String(trade.strategyId ?? trade.strategy ?? ''))) return false;
    }
    if (pairs && !pairs.has(String(trade.pair ?? ''))) return false;
    if (sessions && !sessions.has(String(trade.session ?? ''))) return false;
    if (timeframes && !timeframes.has(String(trade.timeframe ?? ''))) return false;
    if (setupTypes && !setupTypes.has(String(trade.setupType ?? ''))) return false;
    if (outcomes && !outcomes.has(outcomeForPnl(trade.pnl))) return false;
    if (dayFrom != null || dayTo != null) {
      const day = localDayKey(tradeTimestamp(trade));
      if (day === '') return false;
      if (dayFrom != null && day < dayFrom) return false;
      if (dayTo != null && day > dayTo) return false;
    }
    if (reviewNorm !== 'ALL') {
      const flag = reviewedFlag(item);
      if (flag === null) return true;
      if (reviewNorm === 'REVIEWED' && flag !== true) return false;
      if (reviewNorm === 'UNREVIEWED' && flag !== false) return false;
    }
    return true;
  });
}

export function getTradeDataset(accountId, filters = {}) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const effAccount = accountId != null && accountId !== '' ? accountId : (f.accountId ?? '');
  let sessionUser = '';
  try {
    if (typeof localStorage !== 'undefined') {
      sessionUser = localStorage.getItem('tradelog_session') || '';
    }
  } catch {
    sessionUser = '';
  }
  const user = f.user ?? f.userId ?? sessionUser;
  let trades = Array.isArray(f.trades) ? [...f.trades] : null;
  if (trades === null) {
    try {
      trades = getClosedTrades(user, effAccount || undefined) || [];
    } catch {
      trades = [];
    }
  }
  let reviews = Array.isArray(f.reviews) ? [...f.reviews] : null;
  if (reviews === null) {
    try {
      reviews = getCompletedReviews(user) || [];
    } catch {
      reviews = [];
    }
  }
  const byTrade = new Map();
  for (const r of reviews) {
    if (!r || typeof r !== 'object' || r.tradeId == null || String(r.tradeId) === '') continue;
    if (String(r.status ?? '').trim().toUpperCase() !== 'COMPLETED') continue;
    const k = String(r.tradeId);
    if (!byTrade.has(k)) byTrade.set(k, r);
  }
  const filtered = filterTrades(trades, { ...f, accountId: effAccount });
  const rows = [];
  for (const item of filtered) {
    const trade = isDatasetRow(item) ? item.trade : item;
    if (!trade || typeof trade !== 'object') continue;
    if (String(trade.status ?? '').trim().toUpperCase() !== 'CLOSED') continue;
    rows.push(makeRow(trade, byTrade.get(String(trade.id)) ?? null, null));
  }
  rows.sort((a, b) => {
    const ta = Date.parse(tradeTimestamp(a.trade));
    const tb = Date.parse(tradeTimestamp(b.trade));
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na !== nb) return na ? 1 : -1;
    if (!na && ta !== tb) return ta - tb;
    const ia = String(a.trade?.id ?? '');
    const ib = String(b.trade?.id ?? '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
  return rows;
}

export function getCoreMetrics(dataset) {
  const rows = normalizeRows(dataset);
  const n = rows.length;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalPnl = 0;
  let totalR = 0;
  const winPnls = [];
  const lossPnls = [];
  const rVals = [];
  for (const r of rows) {
    if (r.outcome === 'WIN') {
      wins += 1;
      winPnls.push(r.pnl);
    } else if (r.outcome === 'LOSS') {
      losses += 1;
      lossPnls.push(r.pnl);
    } else {
      breakeven += 1;
    }
    totalPnl += r.pnl;
    totalR += r.r;
    rVals.push(r.r);
  }
  totalPnl = round2(totalPnl);
  totalR = round2(totalR);
  return {
    totalTrades: n,
    wins,
    losses,
    breakeven,
    winRate: n === 0 ? null : round2((wins / n) * 100),
    totalPnl,
    avgPnl: n === 0 ? null : round2(totalPnl / n),
    avgWin: mean(winPnls),
    avgLoss: mean(lossPnls),
    largestWin: winPnls.length === 0 ? null : round2(Math.max(...winPnls)),
    largestLoss: lossPnls.length === 0 ? null : round2(Math.min(...lossPnls)),
    totalR,
    avgR: n === 0 ? null : round2(totalR / n),
    medianR: medianOf(rVals),
    bestR: rVals.length === 0 ? null : round2(Math.max(...rVals)),
    worstR: rVals.length === 0 ? null : round2(Math.min(...rVals)),
    profitFactor: profitFactorFor(rows),
    avgProcessScore: avgProcessScoreFor(rows),
    ruleAdherence: pooledRuleAdherence(rows),
    sampleSize: n,
  };
}

function summarizeGroup(key, rows) {
  const trades = rows.length;
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let totalR = 0;
  for (const r of rows) {
    if (r.outcome === 'WIN') wins += 1;
    else if (r.outcome === 'LOSS') losses += 1;
    totalPnl += r.pnl;
    totalR += r.r;
  }
  totalPnl = round2(totalPnl);
  totalR = round2(totalR);
  return {
    key,
    trades,
    wins,
    losses,
    winRate: trades === 0 ? null : round2((wins / trades) * 100),
    totalPnl,
    avgR: trades === 0 ? null : round2(totalR / trades),
    totalR,
    profitFactor: profitFactorFor(rows),
    avgProcessScore: avgProcessScoreFor(rows),
    ruleAdherence: pooledRuleAdherence(rows),
    sampleSize: trades,
    smallSample: trades < ANALYTICS_THRESHOLDS.minimumSample,
  };
}

function groupKeyFor(trade, field) {
  const t = trade && typeof trade === 'object' ? trade : {};
  let v;
  if (field === 'strategy') v = t.strategyId ?? t.strategy;
  else if (field === 'setupType') v = t.setupType;
  else if (field === 'session') v = t.session;
  else if (field === 'pair') v = t.pair;
  else v = t.timeframe;
  const s = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
  return s === '' ? 'Unspecified' : s;
}

function groupStats(dataset, field) {
  const rows = normalizeRows(dataset);
  const map = new Map();
  for (const r of rows) {
    const k = groupKeyFor(r.trade, field);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return [...map.keys()].sort().map((k) => summarizeGroup(k, map.get(k)));
}

export function getStrategyStats(dataset, strategyId) {
  const all = groupStats(dataset, 'strategy');
  if (strategyId == null || strategyId === '') return all;
  const want = String(strategyId);
  return all.filter((g) => g.key === want);
}

export function getAllStrategyStats(dataset) {
  return groupStats(dataset, 'strategy');
}

export function getSetupStats(dataset) {
  return groupStats(dataset, 'setupType');
}

export function getSessionStats(dataset) {
  return groupStats(dataset, 'session');
}

export function getPairStats(dataset) {
  return groupStats(dataset, 'pair');
}

export function getTimeframeStats(dataset) {
  return groupStats(dataset, 'timeframe');
}

export function getProcessStats(dataset) {
  const rows = normalizeRows(dataset);
  const scored = rows.filter((r) => r.reviewed && Number.isFinite(r.processScore));
  const totals = scored.map((r) => r.processScore);
  const gradeDistribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const t of totals) {
    const g = gradeForTotal(t);
    if (Object.prototype.hasOwnProperty.call(gradeDistribution, g)) gradeDistribution[g] += 1;
  }
  const subs = { preTrade: [], execution: [], management: [], discipline: [] };
  for (const r of scored) {
    const s = reviewSubscores(r.review);
    if (Number.isFinite(s.preTrade)) subs.preTrade.push(s.preTrade);
    if (Number.isFinite(s.execution)) subs.execution.push(s.execution);
    if (Number.isFinite(s.management)) subs.management.push(s.management);
    if (Number.isFinite(s.discipline)) subs.discipline.push(s.discipline);
  }
  return {
    avgProcessScore: mean(totals),
    gradeDistribution,
    ruleAdherence: pooledRuleAdherence(rows),
    preTrade: mean(subs.preTrade),
    execution: mean(subs.execution),
    management: mean(subs.management),
    discipline: mean(subs.discipline),
    sampleSize: scored.length,
  };
}

function tagStats(dataset, canonical, key) {
  const rows = normalizeRows(dataset);
  const reviewed = rows.filter((r) => r.reviewed && r.review != null);
  const observed = new Set(canonical);
  for (const r of reviewed) {
    for (const t of tagList(r.review, key)) observed.add(t);
  }
  return [...observed].sort().map((tag) => {
    const tagged = reviewed.filter((r) => tagList(r.review, key).includes(tag));
    const count = tagged.length;
    const rVals = tagged.map((r) => r.r);
    const scores = [];
    for (const r of tagged) {
      if (Number.isFinite(r.processScore)) scores.push(r.processScore);
    }
    return {
      tag,
      count,
      percentageOfReviewed: reviewed.length === 0 ? null : round2((count / reviewed.length) * 100),
      avgR: count === 0 ? null : round2(rVals.reduce((a, b) => a + b, 0) / count),
      totalR: round2(rVals.reduce((a, b) => a + b, 0)),
      avgProcessScore: mean(scores),
      sampleSize: count,
    };
  });
}

export function getMistakeStats(dataset) {
  return tagStats(dataset, MISTAKE_TYPES, 'mistakes');
}

export function getStrengthStats(dataset) {
  return tagStats(dataset, STRENGTH_TYPES, 'strengths');
}

export function getRuleAdherenceStats(dataset) {
  const rows = normalizeRows(dataset);
  const map = new Map();
  for (const r of rows) {
    for (const e of snapshotEntries(r.trade)) {
      const p = parseSnapshotEntry(e);
      if (!p) continue;
      if (!map.has(p.name)) map.set(p.name, { evaluated: 0, passed: 0, failed: 0, requiredFailures: 0 });
      const agg = map.get(p.name);
      agg.evaluated += 1;
      if (p.pass) agg.passed += 1;
      else {
        agg.failed += 1;
        if (p.required) agg.requiredFailures += 1;
      }
    }
  }
  return [...map.keys()].sort().map((ruleName) => {
    const agg = map.get(ruleName);
    return {
      ruleName,
      evaluated: agg.evaluated,
      passed: agg.passed,
      failed: agg.failed,
      requiredFailures: agg.requiredFailures,
      adherencePct: agg.evaluated === 0 ? null : round2((agg.passed / agg.evaluated) * 100),
      sampleSize: agg.evaluated,
    };
  });
}

export function getOutcomeProcessMatrix(dataset, thresholds = {}) {
  const t = thresholds && typeof thresholds === 'object' ? thresholds : {};
  const highRaw = Number(t.highProcessScore);
  const lowRaw = Number(t.lowProcessScore);
  const high = Number.isFinite(highRaw) ? highRaw : PROCESS_QUALITY_THRESHOLD;
  const low = Number.isFinite(lowRaw) ? lowRaw : ANALYTICS_THRESHOLDS.lowProcessScore;
  const scored = normalizeRows(dataset).filter(
    (r) => r.reviewed && Number.isFinite(r.processScore),
  );
  if (scored.length === 0) {
    return {
      highProcessProfitable: null,
      highProcessLosing: null,
      lowProcessProfitable: null,
      lowProcessLosing: null,
      sampleSize: 0,
    };
  }
  let highProcessProfitable = 0;
  let highProcessLosing = 0;
  let lowProcessProfitable = 0;
  let lowProcessLosing = 0;
  for (const r of scored) {
    const s = r.processScore;
    const isHigh = s >= high;
    const isLow = s <= low;
    if (!isHigh && !isLow) continue;
    if (r.pnl > 0) {
      if (isHigh) highProcessProfitable += 1;
      else lowProcessProfitable += 1;
    } else if (r.pnl < 0) {
      if (isHigh) highProcessLosing += 1;
      else lowProcessLosing += 1;
    }
  }
  return {
    highProcessProfitable,
    highProcessLosing,
    lowProcessProfitable,
    lowProcessLosing,
    sampleSize: scored.length,
  };
}

export function getImprovementPatterns(dataset) {
  return improvementPatterns(dataset);
}

// getDailyAggregates reads storage per month and cannot serve an arbitrary
// dataset, so only the shared local-day semantic (toLocalISO) is reused here
// and grouping is computed from dataset timestamps.
export function getDailyPnlSeries(dataset) {
  const rows = normalizeRows(dataset);
  const byDay = new Map();
  for (const r of rows) {
    const day = localDayKey(tradeTimestamp(r.trade));
    if (day === '') continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  return [...byDay.keys()].sort().map((dateISO) => {
    const rs = byDay.get(dateISO);
    let pnl = 0;
    let r = 0;
    const scores = [];
    for (const x of rs) {
      pnl += x.pnl;
      r += x.r;
      if (Number.isFinite(x.processScore)) scores.push(x.processScore);
    }
    return {
      dateISO,
      pnl: round2(pnl),
      r: round2(r),
      count: rs.length,
      avgScore: mean(scores),
      reviewCount: scores.length,
    };
  });
}
