// ============================================
// Risk Engine — pure vanilla ESM calculations
// No UI, no storage, no network. Deterministic only.
// Balances/amounts in account currency (absolute values).
// ============================================

// ---- Internal helpers ----

function round2(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function clampRiskPercent(p) {
  const num = Number(p);
  if (!Number.isFinite(num)) return 0;
  if (num <= 0) return 0;
  if (num >= 100) return 100;
  return num;
}

function money(n) {
  return `$${round2(n).toFixed(2)}`;
}

// Accepts LONG/SHORT or BUY/SELL (any case). Returns 'long' | 'short' | null.
function normalizeDirection(direction) {
  if (typeof direction !== 'string') return null;
  const d = direction.trim().toUpperCase();
  if (d === 'LONG' || d === 'BUY') return 'long';
  if (d === 'SHORT' || d === 'SELL') return 'short';
  return null;
}

// ---- Core calculations ----

// Risk amount (currency) for a given balance + risk %.
// Invalid/zero/negative balance → 0. Percent clamped 0–100.
export function calcRiskAmount(balance, riskPercent) {
  const bal = Number(balance);
  if (!Number.isFinite(bal) || bal <= 0) return 0;
  const pct = clampRiskPercent(riskPercent);
  if (pct <= 0) return 0;
  return round2((bal * pct) / 100);
}

// Risk % for a given balance + risk amount.
// Invalid/zero/negative balance or invalid/negative amount → 0.
export function calcRiskPercent(balance, riskAmount) {
  const bal = Number(balance);
  const amt = Number(riskAmount);
  if (!Number.isFinite(bal) || bal <= 0) return 0;
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  return round2((amt / bal) * 100);
}

// Reward:risk ratio = |tp - entry| / |entry - sl|.
// Returns 0 when entry/sl/tp invalid, entry == sl,
// direction unknown, or SL/TP on the wrong side for direction.
export function calcRR(entry, sl, tp, direction) {
  const e = Number(entry);
  const s = Number(sl);
  const t = Number(tp);
  if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(t)) return 0;
  const riskDist = Math.abs(e - s);
  if (riskDist <= 0) return 0;
  const dir = normalizeDirection(direction);
  if (dir === 'long') {
    if (!(s < e)) return 0; // SL must be below entry for LONG
    if (!(t > e)) return 0; // TP must be above entry for LONG
  } else if (dir === 'short') {
    if (!(s > e)) return 0; // SL must be above entry for SHORT
    if (!(t < e)) return 0; // TP must be below entry for SHORT
  } else {
    return 0;
  }
  const rewardDist = Math.abs(t - e);
  return round2(rewardDist / riskDist);
}

// Position size (units) = riskAmount / |entry - sl|.
// Returns 0 when inputs invalid or stop distance <= 0.
export function calcPositionSize(balance, riskPercent, entry, sl) {
  const riskAmount = calcRiskAmount(balance, riskPercent);
  if (riskAmount <= 0) return 0;
  const e = Number(entry);
  const s = Number(sl);
  if (!Number.isFinite(e) || !Number.isFinite(s)) return 0;
  const dist = Math.abs(e - s);
  if (!Number.isFinite(dist) || dist <= 0) return 0;
  return round2(riskAmount / dist);
}

// Sum of today's trades riskAmount (absolute, currency).
// Non-array → 0. Non-finite entries ignored.
export function calcDailyRisk(tradesToday) {
  if (!Array.isArray(tradesToday)) return 0;
  let total = 0;
  for (const t of tradesToday) {
    const amt = t != null && typeof t === 'object' ? t.riskAmount : t;
    const num = Number(amt);
    if (Number.isFinite(num)) total += Math.abs(num);
  }
  return round2(total);
}

// Pre-trade guards. Pure function of inputs — no storage/network.
// Optional entry/sl/tp/direction are validated for side when provided.
// Always returns { safe, warnings[], blockers[] }; safe = no blockers.
// Every reason states current vs limit values for transparency.
export function checkRiskGuards({
  balance,
  riskAmount,
  riskPercent,
  dailyUsed,
  dailyLimit,
  maxRiskPerTrade,
  remainingDrawdown,
  entry,
  sl,
  tp,
  direction,
} = {}) {
  const warnings = [];
  const blockers = [];

  const bal = Number(balance);
  const risk = Number(riskAmount);
  const pct = Number(riskPercent);
  const used = Number(dailyUsed);
  const limit = Number(dailyLimit);
  const maxPerTrade = Number(maxRiskPerTrade);
  const ddLeft = Number(remainingDrawdown);

  const balValid = Number.isFinite(bal) && bal > 0;
  const riskValid = Number.isFinite(risk) && risk > 0;

  if (!balValid) {
    warnings.push(`Invalid balance (${String(balance)}): expected a positive number.`);
  }
  if (!riskValid) {
    warnings.push(`Invalid risk amount (${String(riskAmount)}): expected a positive number.`);
  }
  if (Number.isFinite(pct) && (pct < 0 || pct > 100)) {
    warnings.push(`Risk percent ${pct}% out of range: clamped to 0–100%.`);
  }

  // 1. Per-trade max
  if (riskValid && Number.isFinite(maxPerTrade) && maxPerTrade >= 0 && risk > maxPerTrade) {
    blockers.push(
      `Risk per trade ${money(risk)} exceeds max ${money(maxPerTrade)}. Reduce size or skip trade.`,
    );
  }

  // 2. Daily limit → hard pause
  const usedSafe = Number.isFinite(used) && used >= 0 ? used : 0;
  if (!Number.isFinite(used) || used < 0) {
    warnings.push(`Invalid daily used (${String(dailyUsed)}): treated as ${money(0)}.`);
  }
  const limitValid = Number.isFinite(limit) && limit > 0;
  if (!limitValid && dailyLimit !== undefined) {
    warnings.push(`Invalid daily limit (${String(dailyLimit)}): daily checks skipped.`);
  }
  if (riskValid && limitValid) {
    const projected = round2(usedSafe + risk);
    if (projected > limit) {
      blockers.push(
        `TRADING PAUSED: projected daily risk ${money(projected)} (${money(usedSafe)} used + ${money(risk)} this trade) exceeds daily limit ${money(limit)}.`,
      );
    } else if (projected / limit >= 0.75) {
      const pctUsed = round2((projected / limit) * 100);
      warnings.push(
        `HIGH RISK: projected daily risk ${money(projected)} is ${pctUsed}% of daily limit ${money(limit)}.`,
      );
    }
  }

  // 3. Remaining drawdown (prop guard)
  if (riskValid && Number.isFinite(ddLeft) && ddLeft >= 0 && risk > ddLeft) {
    blockers.push(
      `Risk ${money(risk)} exceeds remaining drawdown ${money(ddLeft)}. Trade would breach the drawdown buffer.`,
    );
  }

  // 4. SL/TP side validation (only when levels + direction supplied)
  const hasLevels = entry !== undefined || sl !== undefined || tp !== undefined || direction !== undefined;
  if (hasLevels) {
    const e = Number(entry);
    const s = Number(sl);
    const t = Number(tp);
    const dir = normalizeDirection(direction);
    if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(t) || dir === null) {
      blockers.push(
        `Invalid SL/TP setup (entry=${String(entry)}, sl=${String(sl)}, tp=${String(tp)}, direction=${String(direction)}): need finite levels and direction LONG/SHORT (BUY/SELL accepted).`,
      );
    } else if (e === s) {
      blockers.push(`Invalid SL: stop equals entry (${e}). Move SL to create risk distance.`);
    } else if (dir === 'long' && !(s < e)) {
      blockers.push(`Invalid SL side for LONG: SL ${s} must be below entry ${e}.`);
    } else if (dir === 'short' && !(s > e)) {
      blockers.push(`Invalid SL side for SHORT: SL ${s} must be above entry ${e}.`);
    } else if (dir === 'long' && !(t > e)) {
      blockers.push(`Invalid TP side for LONG: TP ${t} must be above entry ${e}.`);
    } else if (dir === 'short' && !(t < e)) {
      blockers.push(`Invalid TP side for SHORT: TP ${t} must be below entry ${e}.`);
    }
  }

  return { safe: blockers.length === 0, warnings, blockers };
}

export default {
  calcRiskAmount,
  calcRiskPercent,
  calcRR,
  calcPositionSize,
  calcDailyRisk,
  checkRiskGuards,
};
