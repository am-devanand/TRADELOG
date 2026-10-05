import { PROP_STATUSES } from './models.js';
import { getPropConfig } from './propRules.js';

export { PROP_STATUSES };

const STATUS_RANK = { SAFE: 0, WARNING: 1, CRITICAL: 2, BREACH: 3 };

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

function safeParse(raw, fallback) {
  try {
    if (raw == null) return fallback;
    return JSON.parse(raw);
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

function money(n) {
  const v = toFinite(n, 0);
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(round2(v)).toFixed(2)}`;
}

function dateKey(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function readFolders(user) {
  if (typeof localStorage === 'undefined') return [];
  const parsed = safeParse(localStorage.getItem(`tradelog_folders_${normalizeUser(user)}`), []);
  return Array.isArray(parsed) ? parsed : [];
}

function readExecTrades(user) {
  if (typeof localStorage === 'undefined') return [];
  const parsed = safeParse(localStorage.getItem(`tradelog_exectrades_${normalizeUser(user)}`), []);
  return Array.isArray(parsed) ? parsed : [];
}

function tradeStatus(t) {
  return String(t?.status ?? 'OPEN').trim().toUpperCase();
}

function tradeAccount(t) {
  return t?.accountId ?? '';
}

function tradePnl(t) {
  return toFinite(t?.pnl, 0);
}

function tradeRisk(t) {
  return Math.abs(toFinite(t?.riskAmount, 0));
}

function remainingLot(t) {
  const rem = round2(toFinite(t?.lotSize, 0) - toFinite(t?.closedLot ?? t?.closedLots, 0));
  return rem > 0 ? rem : 0;
}

function dirSign(direction) {
  const d = String(direction ?? 'LONG').trim().toUpperCase();
  return d === 'SHORT' || d === 'SELL' ? -1 : 1;
}

function unrealizedFor(t) {
  const px = Number(t?.currentPrice);
  if (!Number.isFinite(px)) return null;
  const entry = Number(t?.entryPrice ?? t?.entry);
  if (!Number.isFinite(entry)) return null;
  const lot = remainingLot(t);
  if (lot <= 0) return null;
  const factorRaw = Number(t?.contractFactor);
  const factor = Number.isFinite(factorRaw) && factorRaw > 0 ? factorRaw : 1;
  return round2((px - entry) * dirSign(t?.direction) * lot * factor);
}

function closedTime(t) {
  return t?.closedAt || t?.exitTime || t?.updatedAt || t?.createdAt || t?.openedAt || '';
}

function openTime(t) {
  return t?.openedAt || t?.executionTime || t?.createdAt || closedTime(t);
}

function snapshot(accountId, user) {
  const clean = resolveUser(user);
  const id = String(accountId ?? '');
  const folder = readFolders(clean).find((f) => f && f.id === id);
  const startingBalance = folder ? toFinite(folder.startingBalance, 0) : 0;
  const all = readExecTrades(clean).filter((t) => t && tradeAccount(t) === id);
  const closed = all
    .filter((t) => tradeStatus(t) === 'CLOSED')
    .map((t) => ({ ...t, _pnl: tradePnl(t), _at: closedTime(t) }))
    .sort((a, b) => new Date(a._at).getTime() - new Date(b._at).getTime());
  const realized = round2(closed.reduce((s, t) => s + t._pnl, 0));
  const partialRealized = round2(
    all.filter((t) => tradeStatus(t) === 'PARTIALLY_CLOSED').reduce((s, t) => s + tradePnl(t), 0),
  );
  const balance = round2(startingBalance + realized + partialRealized);
  const open = all.filter((t) => tradeStatus(t) === 'OPEN' || tradeStatus(t) === 'PARTIALLY_CLOSED');
  let unrealized = 0;
  let priced = 0;
  for (const t of open) {
    const u = unrealizedFor(t);
    if (u !== null) {
      unrealized = round2(unrealized + u);
      priced += 1;
    }
  }
  const equityAvailable = priced > 0;
  const equity = equityAvailable ? round2(balance + unrealized) : balance;
  const config = getPropConfig(id, clean);
  return { clean, id, folder, startingBalance, all, closed, open, balance, equity, equityAvailable, unrealized, config };
}

function ruleByType(rules, type) {
  return (rules || []).find((r) => r && r.type === type && r.enabled !== false) || null;
}

function ruleById(rules, id) {
  return (rules || []).find((r) => r && r.id === id) || null;
}

function severityFor(status) {
  if (status === 'BREACH' || status === 'CRITICAL') return 'CRITICAL';
  if (status === 'WARNING') return 'MEDIUM';
  return 'LOW';
}

function lowerResult(rule, current, label) {
  const limit = toFinite(rule?.limit, 0);
  const warn = toFinite(rule?.warningThreshold, 70);
  const crit = toFinite(rule?.criticalThreshold, 90);
  const cur = round2(current);
  if (rule && rule.enabled === false) {
    return { status: 'SAFE', percentageUsed: 0, remaining: 0, reason: `${label} disabled — skipped.` };
  }
  if (!rule || !(limit > 0)) {
    return { status: 'SAFE', percentageUsed: 0, remaining: 0, reason: `${label} has no limit set — skipped.` };
  }
  const pct = round2((cur / limit) * 100);
  const remaining = round2(Math.max(0, limit - cur));
  if (cur > limit) {
    return { status: 'BREACH', percentageUsed: pct, remaining: 0, reason: `${label} ${money(cur)} exceeds limit ${money(limit)} (${pct}% used) — BREACH.` };
  }
  if (pct >= crit) {
    return { status: 'CRITICAL', percentageUsed: pct, remaining, reason: `${label} ${money(cur)} of ${money(limit)} limit (${pct}% used) — critical.` };
  }
  if (pct >= warn) {
    return { status: 'WARNING', percentageUsed: pct, remaining, reason: `${label} ${money(cur)} of ${money(limit)} limit (${pct}% used) — warning.` };
  }
  return { status: 'SAFE', percentageUsed: Math.max(0, pct), remaining, reason: `${label} ${money(cur)} of ${money(limit)} limit (${Math.max(0, pct)}% used) — OK.` };
}

function higherResult(rule, current, limitLabel, fmt) {
  const limit = toFinite(rule?.limit, 0);
  const cur = current;
  const fmtFn = typeof fmt === 'function' ? fmt : (v) => String(round2(v));
  if (rule && rule.enabled === false) {
    return { status: 'SAFE', percentageUsed: 0, remaining: 0, reason: `${limitLabel} disabled — skipped.` };
  }
  if (!rule || !(limit > 0)) {
    return { status: 'SAFE', percentageUsed: 0, remaining: 0, reason: `${limitLabel} has no target set — skipped.` };
  }
  const pct = round2((toFinite(cur, 0) / limit) * 100);
  if (toFinite(cur, 0) >= limit) {
    return { status: 'SAFE', percentageUsed: pct, remaining: 0, reason: `${limitLabel} ${fmtFn(cur)} reached target ${fmtFn(limit)} (${pct}%) — achieved.` };
  }
  return { status: 'SAFE', percentageUsed: Math.max(0, pct), remaining: round2(limit - toFinite(cur, 0)), reason: `${limitLabel} ${fmtFn(cur)} of ${fmtFn(limit)} target (${Math.max(0, pct)}%) — in progress.` };
}

function dailyBuckets(closed) {
  const byDay = new Map();
  for (const t of closed) {
    const key = dateKey(t._at);
    if (!key) continue;
    byDay.set(key, round2((byDay.get(key) || 0) + t._pnl));
  }
  return byDay;
}

function worstDailyLoss(closed) {
  const byDay = dailyBuckets(closed);
  let worst = 0;
  for (const pnl of byDay.values()) {
    if (pnl < 0 && Math.abs(pnl) > worst) worst = Math.abs(pnl);
  }
  return round2(worst);
}

function drawdownCurve(startingBalance, closed) {
  let running = startingBalance;
  let peak = startingBalance;
  let maxDd = 0;
  for (const t of closed) {
    running = round2(running + t._pnl);
    if (running > peak) peak = running;
    const dd = round2(peak - running);
    if (dd > maxDd) maxDd = dd;
  }
  return { endBalance: running, peak, maxDrawdown: round2(maxDd), currentDrawdown: round2(Math.max(0, peak - running)) };
}

function buildRuleEntries(snap) {
  const { startingBalance, closed, open, all, balance, config } = snap;
  const rules = config?.rules || [];
  const netProfit = round2(balance - startingBalance);
  const dailyWorst = worstDailyLoss(closed);
  const curve = drawdownCurve(startingBalance, closed);
  const daySet = new Set();
  for (const t of all) {
    const key = dateKey(openTime(t)) || dateKey(closedTime(t));
    if (key) daySet.add(key);
  }
  const dayCount = daySet.size;
  const byDay = dailyBuckets(closed);
  const total = round2(closed.reduce((s, t) => s + t._pnl, 0));
  let bestDay = 0;
  let bestDate = '';
  for (const [day, pnl] of byDay.entries()) {
    if (pnl > bestDay) {
      bestDay = pnl;
      bestDate = day;
    }
  }
  const consistencyRule = ruleById(rules, 'consistency');
  const consistencyEnabled = consistencyRule ? consistencyRule.enabled !== false : false;
  const consistencyCurrent = consistencyEnabled && total > 0 ? round2((bestDay / total) * 100) : 0;
  let worstRisk = 0;
  for (const t of all) {
    const r = tradeRisk(t);
    if (r > worstRisk) worstRisk = r;
  }
  worstRisk = round2(worstRisk);
  const openRisk = round2(open.reduce((s, t) => s + tradeRisk(t), 0));
  const out = [];
  for (const rule of rules) {
    if (!rule) continue;
    const base = { ruleId: rule.id, name: rule.name, type: rule.type, direction: rule.direction, limit: rule.limit, enabled: rule.enabled !== false };
    if (rule.type === 'PROFIT_TARGET') {
      const target = toFinite(rule.limit, 0);
      const remaining = round2(Math.max(0, target - netProfit));
      const pct = target > 0 ? round2((netProfit / target) * 100) : 0;
      const achieved = netProfit >= target && target > 0;
      out.push({
        ...base,
        status: 'SAFE',
        current: netProfit,
        remaining,
        percentageUsed: Math.max(0, pct),
        severity: 'LOW',
        reason: achieved
          ? `Profit ${money(netProfit)} reached target ${money(target)} (${pct}%) — achieved.`
          : `Profit ${money(netProfit)} of ${money(target)} target (${Math.max(0, pct)}%) — ${money(remaining)} remaining.`,
      });
    } else if (rule.type === 'DAILY_LOSS') {
      const r = lowerResult(rule, dailyWorst, 'Daily loss');
      out.push({ ...base, status: r.status, current: dailyWorst, remaining: r.remaining, percentageUsed: r.percentageUsed, severity: severityFor(r.status), reason: r.reason });
    } else if (rule.type === 'MAX_DRAWDOWN') {
      const r = lowerResult(rule, curve.maxDrawdown, 'Drawdown');
      out.push({ ...base, status: r.status, current: curve.maxDrawdown, remaining: r.remaining, percentageUsed: r.percentageUsed, severity: severityFor(r.status), reason: `${r.reason} Peak ${money(curve.peak)}.` });
    } else if (rule.type === 'MIN_TRADING_DAYS') {
      const r = higherResult(rule, dayCount, 'Trading days', (v) => `${Math.round(toFinite(v, 0))}`);
      out.push({ ...base, status: r.status, current: dayCount, remaining: Math.round(toFinite(r.remaining, 0)), percentageUsed: r.percentageUsed, severity: 'LOW', reason: r.reason });
    } else if (rule.type === 'CONSISTENCY') {
      if (!consistencyEnabled) {
        out.push({ ...base, status: 'SAFE', current: 0, limit: rule.limit, remaining: 0, percentageUsed: 0, severity: 'LOW', reason: 'Consistency check disabled — skipped.' });
      } else if (!(total > 0)) {
        out.push({ ...base, status: 'SAFE', current: 0, limit: rule.limit, remaining: toFinite(rule.limit, 0), percentageUsed: 0, severity: 'LOW', reason: 'Consistency needs net profit above $0.00 — skipped (no profit yet).' });
      } else {
        const r = lowerResult(rule, consistencyCurrent, 'Consistency');
        out.push({ ...base, status: r.status, current: consistencyCurrent, remaining: r.remaining, percentageUsed: r.percentageUsed, severity: severityFor(r.status), reason: `${r.reason} Best day ${money(bestDay)}${bestDate ? ` (${bestDate})` : ''} of ${money(total)} total.` });
      }
    } else if (rule.type === 'MAX_RISK_PER_TRADE') {
      const r = lowerResult(rule, worstRisk, 'Risk per trade');
      out.push({ ...base, status: r.status, current: worstRisk, remaining: r.remaining, percentageUsed: r.percentageUsed, severity: severityFor(r.status), reason: r.reason });
    } else if (rule.type === 'MAX_OPEN_RISK') {
      const r = lowerResult(rule, openRisk, 'Open risk');
      out.push({ ...base, status: r.status, current: openRisk, remaining: r.remaining, percentageUsed: r.percentageUsed, severity: severityFor(r.status), reason: `${r.reason} Across ${open.length} open trade(s).` });
    } else {
      out.push({ ...base, status: 'SAFE', current: 0, remaining: 0, percentageUsed: 0, severity: 'LOW', reason: `Custom rule "${rule.name}" is tracked manually — no automatic metric.` });
    }
  }
  return { entries: out, netProfit, dailyWorst, curve, dayCount, daySet, bestDay, bestDate, total, consistencyCurrent, consistencyEnabled, worstRisk, openRisk };
}

function worstStatus(statuses) {
  let worst = 'SAFE';
  for (const s of statuses || []) {
    const up = String(s ?? 'SAFE').trim().toUpperCase();
    const rank = STATUS_RANK[up] ?? 0;
    if (rank > (STATUS_RANK[worst] ?? 0)) worst = up;
  }
  return worst;
}

export function getPropStatus(input, user) {
  try {
    if (input === undefined || input === null || input === '') return 'SAFE';
    if (Array.isArray(input)) {
      return worstStatus(input.map((r) => (r && typeof r === 'object' ? r.status : r)));
    }
    if (typeof input === 'object') {
      if (Array.isArray(input.rules)) return worstStatus(input.rules.map((r) => r?.status));
      if (typeof input.status === 'string') return worstStatus([input.status]);
      return 'SAFE';
    }
    if (typeof input === 'string') {
      const up = input.trim().toUpperCase();
      if (STATUS_RANK[up] !== undefined && user === undefined && !/^[a-z0-9._-]{1,64}$/i.test(input)) {
        return up;
      }
      if (STATUS_RANK[up] !== undefined && input.length <= 8) return up;
      const state = getAccountPropState(input, user);
      if (state && !state.error) return state.status;
      if (state && state.status) return state.status;
      return 'SAFE';
    }
    return 'SAFE';
  } catch {
    return 'SAFE';
  }
}

export function evaluatePropRules(accountId, user) {
  try {
    if (!accountId) return { success: false, error: 'Account id is required', rules: [] };
    const snap = snapshot(accountId, user);
    if (!snap.folder) return { success: false, error: `Account not found: "${accountId}"`, rules: [] };
    const built = buildRuleEntries(snap);
    return { success: true, rules: built.entries, status: worstStatus(built.entries.map((r) => r.status)) };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to evaluate prop rules', rules: [] };
  }
}

export function getDailyStats(accountId, date, user) {
  try {
    let day = date;
    let clean = user;
    if (day !== undefined && day !== null && day !== '' && clean === undefined) {
      const probe = String(day);
      if (!/^\d{4}-\d{2}-\d{2}/.test(probe) && Number.isNaN(Date.parse(probe))) {
        clean = day;
        day = undefined;
      }
    }
    if (!accountId) return { success: false, error: 'Account id is required' };
    const snap = snapshot(accountId, clean);
    if (!snap.folder) return { success: false, error: `Account not found: "${accountId}"` };
    const target = day ? dateKey(day) : dateKey(new Date().toISOString());
    if (!target) return { success: false, error: `Invalid date: "${String(day)}"` };
    const before = snap.closed.filter((t) => dateKey(t._at) < target);
    const startBalance = round2(snap.startingBalance + before.reduce((s, t) => s + t._pnl, 0));
    const onDay = snap.closed.filter((t) => dateKey(t._at) === target);
    const pnl = round2(onDay.reduce((s, t) => s + t._pnl, 0));
    const endBalance = round2(startBalance + pnl);
    const loss = pnl < 0 ? round2(Math.abs(pnl)) : 0;
    const lossPercent = startBalance > 0 ? round2((loss / startBalance) * 100) : 0;
    return { success: true, date: target, startBalance, endBalance, pnl, loss, lossPercent, tradeCount: onDay.length };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to compute daily stats' };
  }
}

export function getDrawdown(accountId, user) {
  try {
    if (!accountId) return { success: false, error: 'Account id is required' };
    const snap = snapshot(accountId, user);
    if (!snap.folder) return { success: false, error: `Account not found: "${accountId}"` };
    const curve = drawdownCurve(snap.startingBalance, snap.closed);
    const daily = worstDailyLoss(snap.closed);
    const rule = ruleByType(snap.config?.rules, 'MAX_DRAWDOWN');
    const limit = rule ? toFinite(rule.limit, 0) : 0;
    return {
      success: true,
      daily,
      max: curve.maxDrawdown,
      current: curve.currentDrawdown,
      peak: curve.peak,
      balance: snap.balance,
      startingBalance: snap.startingBalance,
      limit,
      remaining: limit > 0 ? round2(Math.max(0, limit - curve.maxDrawdown)) : 0,
    };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to compute drawdown' };
  }
}

export function getConsistency(accountId, user) {
  try {
    if (!accountId) return { success: false, error: 'Account id is required' };
    const snap = snapshot(accountId, user);
    if (!snap.folder) return { success: false, error: `Account not found: "${accountId}"` };
    const rule = ruleById(snap.config?.rules, 'consistency');
    const enabled = rule ? rule.enabled !== false : false;
    const limit = rule ? toFinite(rule.limit, 30) : 30;
    const byDay = dailyBuckets(snap.closed);
    const total = round2(snap.closed.reduce((s, t) => s + t._pnl, 0));
    let bestDay = 0;
    let bestDate = '';
    for (const [day, pnl] of byDay.entries()) {
      if (pnl > bestDay) {
        bestDay = pnl;
        bestDate = day;
      }
    }
    if (!enabled) {
      return { success: true, enabled: false, current: 0, limit, status: 'SAFE', bestDay: 0, bestDate: '', total, reason: 'Consistency check disabled — skipped.' };
    }
    if (!(total > 0)) {
      return { success: true, enabled: true, current: 0, limit, status: 'SAFE', bestDay, bestDate, total, reason: 'Consistency needs net profit above $0.00 — skipped (no profit yet).' };
    }
    const current = round2((bestDay / total) * 100);
    const r = lowerResult(rule, current, 'Consistency');
    return { success: true, enabled: true, current, limit, status: r.status, bestDay, bestDate, total, percentageUsed: r.percentageUsed, reason: r.reason };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to compute consistency' };
  }
}

export function getTradingDays(accountId, user) {
  try {
    if (!accountId) return { success: false, error: 'Account id is required' };
    const snap = snapshot(accountId, user);
    if (!snap.folder) return { success: false, error: `Account not found: "${accountId}"` };
    const daySet = new Set();
    for (const t of snap.all) {
      const key = dateKey(openTime(t)) || dateKey(closedTime(t));
      if (key) daySet.add(key);
    }
    const dates = [...daySet].sort();
    const count = dates.length;
    const rule = ruleByType(snap.config?.rules, 'MIN_TRADING_DAYS');
    const required = rule ? Math.round(toFinite(rule.limit, 10)) : 10;
    return { success: true, count, current: count, dates, required, remaining: Math.max(0, required - count) };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to compute trading days' };
  }
}

export function getAccountPropState(accountId, user) {
  try {
    if (!accountId) {
      return { success: false, error: 'Account id is required', status: 'SAFE', rules: [] };
    }
    const snap = snapshot(accountId, user);
    if (!snap.folder) {
      return { success: false, error: `Account not found: "${accountId}"`, status: 'SAFE', rules: [] };
    }
    const built = buildRuleEntries(snap);
    const status = worstStatus(built.entries.map((r) => r.status));
    const profitRule = ruleByType(snap.config?.rules, 'PROFIT_TARGET');
    const target = profitRule ? toFinite(profitRule.limit, 0) : 0;
    const current = built.netProfit;
    const drawdownRule = ruleByType(snap.config?.rules, 'MAX_DRAWDOWN');
    const ddLimit = drawdownRule ? toFinite(drawdownRule.limit, 0) : 0;
    const daysRule = ruleByType(snap.config?.rules, 'MIN_TRADING_DAYS');
    const required = daysRule ? Math.round(toFinite(daysRule.limit, 10)) : 10;
    const consistencyRule = ruleById(snap.config?.rules, 'consistency');
    const consistencyLimit = consistencyRule ? toFinite(consistencyRule.limit, 30) : 30;
    const consistencyStatus = (built.entries.find((r) => r.type === 'CONSISTENCY') || {}).status || 'SAFE';
    return {
      success: true,
      status,
      accountId: snap.id,
      balance: snap.balance,
      equity: snap.equity,
      equityAvailable: snap.equityAvailable,
      startingBalance: snap.startingBalance,
      netProfit: current,
      profitTarget: {
        target,
        current,
        remaining: round2(Math.max(0, target - current)),
        progress: target > 0 ? round2((current / target) * 100) : 0,
      },
      drawdown: {
        daily: built.dailyWorst,
        max: built.curve.maxDrawdown,
        current: built.curve.currentDrawdown,
        peak: built.curve.peak,
        remaining: ddLimit > 0 ? round2(Math.max(0, ddLimit - built.curve.maxDrawdown)) : 0,
      },
      tradingDays: {
        current: built.dayCount,
        required,
        remaining: Math.max(0, required - built.dayCount),
      },
      consistency: {
        enabled: built.consistencyEnabled,
        current: built.consistencyCurrent,
        limit: consistencyLimit,
        status: consistencyStatus,
      },
      rules: built.entries,
    };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Failed to evaluate prop state', status: 'SAFE', rules: [] };
  }
}

export default {
  PROP_STATUSES,
  getAccountPropState,
  evaluatePropRules,
  getDailyStats,
  getDrawdown,
  getConsistency,
  getTradingDays,
  getPropStatus,
};
