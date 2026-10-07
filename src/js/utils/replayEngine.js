// ============================================
// Replay Engine — deterministic historical replay (Phase 9B)
// Pure vanilla ESM: no storage, no Firebase, no DOM, no network.
//
// ISOLATION BOUNDARY (do not cross): this module must NEVER import, directly
// or transitively, any of: executedTrades.js, propEngine.js, propRules.js,
// calendar.js, tradingAnalytics.js, riskAnalytics.js,
// performanceAttribution.js, storage.js, firebase.js, or any page/component.
// A replay has zero write path into real trades, balance, prop state,
// calendar, reviews, or real analytics. Every emitted trade carries
// status 'SIMULATED' only. All decision scoring comes from decisionEngine.js
// (evaluateChecklist) and all risk maths from riskEngine.js (calcRR,
// calcRiskAmount, calcPositionSize, checkRiskGuards) — nothing is
// reimplemented here.
// ============================================

import { evaluateChecklist } from './decisionEngine.js';
import {
  calcRR,
  calcRiskAmount,
  calcPositionSize,
  checkRiskGuards,
} from './riskEngine.js';

export const REPLAY_EXIT_REASONS = Object.freeze({
  TP_HIT: 'TP_HIT',
  SL_HIT: 'SL_HIT',
  END_OF_DATA: 'END_OF_DATA',
  TIME_EXIT: 'TIME_EXIT',
});

const SIMULATED_STATUS = 'SIMULATED';

// ---- Deterministic primitives (no Date/Math.random/generateId anywhere) ----

function round2(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function round5(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100000) / 100000;
}

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeDirection(raw) {
  const d = String(raw ?? '').trim().toUpperCase();
  if (d === 'LONG' || d === 'BUY') return 'LONG';
  if (d === 'SHORT' || d === 'SELL') return 'SHORT';
  return null;
}

function resolveStrategyDirection(raw) {
  const d = String(raw ?? 'AUTO').trim().toUpperCase();
  if (d === 'LONG' || d === 'BUY') return 'LONG';
  if (d === 'SHORT' || d === 'SELL') return 'SHORT';
  return 'AUTO';
}

// Stable stringify: object keys emitted in sorted order, arrays in order.
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

// FNV-1a 32-bit hash → 8 lowercase hex chars. Deterministic across runs.
function fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function cmpStr(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---- Candle helpers (read-only) ----

function isCandle(c) {
  return (
    c !== null &&
    typeof c === 'object' &&
    Number.isFinite(Number(c.t)) &&
    Number.isFinite(Number(c.o)) &&
    Number.isFinite(Number(c.h)) &&
    Number.isFinite(Number(c.l)) &&
    Number.isFinite(Number(c.c))
  );
}

function smaCloses(candles, cursor, period) {
  const p = Math.floor(Number(period));
  if (!Number.isFinite(p) || p <= 0) return null;
  const start = cursor - p + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= cursor; i += 1) {
    const c = candles[i];
    if (!isCandle(c)) return null;
    sum += Number(c.c);
  }
  return sum / p;
}

function avgRange(candles, from, toInclusive) {
  if (toInclusive < from) return null;
  let sum = 0;
  let n = 0;
  for (let i = from; i <= toInclusive; i += 1) {
    const c = candles[i];
    if (!isCandle(c)) return null;
    sum += Math.abs(Number(c.h) - Number(c.l));
    n += 1;
  }
  if (n <= 0) return null;
  return sum / n;
}

function maxHigh(candles, from, toInclusive) {
  let m = -Infinity;
  for (let i = from; i <= toInclusive; i += 1) {
    const c = candles[i];
    if (!isCandle(c)) return null;
    if (Number(c.h) > m) m = Number(c.h);
  }
  return m === -Infinity ? null : m;
}

function minLow(candles, from, toInclusive) {
  let m = Infinity;
  for (let i = from; i <= toInclusive; i += 1) {
    const c = candles[i];
    if (!isCandle(c)) return null;
    if (Number(c.l) < m) m = Number(c.l);
  }
  return m === Infinity ? null : m;
}

function fmt(n) {
  return String(round5(n));
}

// Defensive candle normalisation: ascending by timestamp (stable), with
// duplicate timestamps de-duplicated last-wins. The engine forward-walks
// bars, so unordered input would read future bars as past (look-ahead bias).
// Duplicate policy is last-wins: a later row is treated as a correction of
// the earlier row at the same timestamp. Determinism matters more than the
// choice — the comparator is a total order (timestamp, then input position),
// so equal inputs always normalise identically. Rows without a finite
// timestamp can never evaluate; they are parked at the end, stably, instead
// of being silently dropped (dropping would renumber every later bar).
// Already-ascending input with unique finite timestamps passes through with
// identical order and identical row references.
export function normalizeCandles(candles) {
  const input = Array.isArray(candles) ? candles : [];
  const lastByTime = new Map();
  const timeless = [];
  for (let i = 0; i < input.length; i += 1) {
    const row = input[i];
    const t = Number(row && row.t);
    if (Number.isFinite(t)) lastByTime.set(t, { row, i });
    else timeless.push({ row, i });
  }
  const ordered = [...lastByTime.entries()].map(([t, kept]) => ({ t, row: kept.row, i: kept.i }));
  for (const kept of timeless) ordered.push({ t: Infinity, row: kept.row, i: kept.i });
  ordered.sort((a, b) => (a.t - b.t) || (a.i - b.i));
  return ordered.map((entry) => entry.row);
}

// ---- Strategy condition evaluation (pure readout of candle window) ----

// Canonical Phase 9A contract (models.js STRATEGY_CONDITION_TYPES) carries
// parameters in `condition.params`; legacy snake_case conditions carry them
// flat on the condition object. Both shapes are accepted: `params` first,
// then flat fields, in a fixed lookup order.
function condParams(cond) {
  const c = cond && typeof cond === 'object' ? cond : {};
  const p = c.params && typeof c.params === 'object' && !Array.isArray(c.params) ? c.params : {};
  return { c, p };
}

function paramValue(cond, names) {
  const { c, p } = condParams(cond);
  for (const n of names) {
    if (p[n] !== undefined) return p[n];
  }
  for (const n of names) {
    if (n !== 'params' && c[n] !== undefined) return c[n];
  }
  return undefined;
}

function numParam(cond, names, dflt) {
  const v = paramValue(cond, names);
  if (v === undefined || v === null || v === '') return dflt;
  return numberOrNull(v);
}

// Tolerant side word: UP-family vs DOWN-family. Returns 'UP' | 'DOWN' | null.
function parseSideWord(raw) {
  const d = String(raw ?? '').trim().toUpperCase();
  if (d === 'UP' || d === 'LONG' || d === 'BUY' || d === 'BULLISH' || d === 'BULL') return 'UP';
  if (d === 'DOWN' || d === 'SHORT' || d === 'SELL' || d === 'BEARISH' || d === 'BEAR') return 'DOWN';
  return null;
}

// Match types case-insensitively; tolerate kebab/snake/space variants.
function typeKey(raw) {
  return String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function conditionListFor(strategy, direction) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const out = [];
  if (direction === 'LONG' && Array.isArray(s.longConditions)) out.push(...s.longConditions);
  if (direction === 'SHORT' && Array.isArray(s.shortConditions)) out.push(...s.shortConditions);
  if (Array.isArray(s.conditions)) out.push(...s.conditions);
  // Canonical Phase 9A shape: entryConditions (+ confirmationConditions).
  if (Array.isArray(s.entryConditions)) out.push(...s.entryConditions);
  if (Array.isArray(s.confirmationConditions)) out.push(...s.confirmationConditions);
  return out;
}

function evalSingleCondition(candles, cursor, cond, direction = 'LONG') {
  const c = candles[cursor];
  const o = Number(c.o);
  const h = Number(c.h);
  const l = Number(c.l);
  const close = Number(c.c);
  const range = Math.abs(h - l);
  const rawType = String(cond?.type ?? cond?.kind ?? cond?.name ?? '').trim();
  const key = typeKey(rawType);
  const id = String(cond?.id ?? cond?.key ?? '');
  const label = id || rawType || 'condition';
  const echo = rawType.toLowerCase() || 'unknown';
  const setupDir = direction === 'SHORT' ? 'SHORT' : 'LONG';

  const fail = (reason) => ({ id: label, type: echo, pass: false, reason });
  const ok = (reason) => ({ id: label, type: echo, pass: true, reason });

  switch (key) {
    // ---- Canonical Phase 9A vocabulary (models.js STRATEGY_CONDITION_TYPES) ----
    case 'PRICE_ABOVE': {
      const level = numParam(cond, ['level', 'price', 'threshold', 'value'], null);
      if (level === null) {
        return fail(`PRICE_ABOVE "${label}" missing finite level at index ${cursor}: recorded as not passed`);
      }
      return close > level
        ? ok(`close ${fmt(close)} > level ${fmt(level)} at index ${cursor}`)
        : fail(`close ${fmt(close)} <= level ${fmt(level)} at index ${cursor}`);
    }
    case 'PRICE_BELOW': {
      const level = numParam(cond, ['level', 'price', 'threshold', 'value'], null);
      if (level === null) {
        return fail(`PRICE_BELOW "${label}" missing finite level at index ${cursor}: recorded as not passed`);
      }
      return close < level
        ? ok(`close ${fmt(close)} < level ${fmt(level)} at index ${cursor}`)
        : fail(`close ${fmt(close)} >= level ${fmt(level)} at index ${cursor}`);
    }
    case 'CROSS_UP': {
      const level = numParam(cond, ['level', 'price', 'threshold', 'value'], null);
      if (level === null) {
        return fail(`CROSS_UP "${label}" missing finite level at index ${cursor}: recorded as not passed`);
      }
      if (cursor < 1 || !isCandle(candles[cursor - 1])) {
        return fail(`CROSS_UP level ${fmt(level)} unevaluable at index ${cursor}: no prior candle to compare`);
      }
      const prev = Number(candles[cursor - 1].c);
      return prev <= level && close > level
        ? ok(`close crossed up: prior close ${fmt(prev)} <= level ${fmt(level)} and close ${fmt(close)} > level ${fmt(level)} at index ${cursor}`)
        : fail(`no cross up: prior close ${fmt(prev)} and close ${fmt(close)} against level ${fmt(level)} at index ${cursor}`);
    }
    case 'CROSS_DOWN': {
      const level = numParam(cond, ['level', 'price', 'threshold', 'value'], null);
      if (level === null) {
        return fail(`CROSS_DOWN "${label}" missing finite level at index ${cursor}: recorded as not passed`);
      }
      if (cursor < 1 || !isCandle(candles[cursor - 1])) {
        return fail(`CROSS_DOWN level ${fmt(level)} unevaluable at index ${cursor}: no prior candle to compare`);
      }
      const prev = Number(candles[cursor - 1].c);
      return prev >= level && close < level
        ? ok(`close crossed down: prior close ${fmt(prev)} >= level ${fmt(level)} and close ${fmt(close)} < level ${fmt(level)} at index ${cursor}`)
        : fail(`no cross down: prior close ${fmt(prev)} and close ${fmt(close)} against level ${fmt(level)} at index ${cursor}`);
    }
    case 'TOUCHES_LEVEL': {
      const level = numParam(cond, ['level', 'price', 'threshold', 'value'], null);
      if (level === null) {
        return fail(`TOUCHES_LEVEL "${label}" missing finite level at index ${cursor}: recorded as not passed`);
      }
      const tolRaw = paramValue(cond, ['tolerance', 'tol']);
      const tol = tolRaw === undefined || tolRaw === null || tolRaw === '' ? 0 : numberOrNull(tolRaw);
      if (tol === null || tol < 0) {
        return fail(`TOUCHES_LEVEL "${label}" has nonsensical tolerance ${String(tolRaw)} at index ${cursor}: recorded as not passed`);
      }
      const touched = l <= level + tol && h >= level - tol;
      return touched
        ? ok(`candle range ${fmt(l)}..${fmt(h)} touches level ${fmt(level)} (tolerance ${fmt(tol)}) at index ${cursor}`)
        : fail(`candle range ${fmt(l)}..${fmt(h)} does not touch level ${fmt(level)} (tolerance ${fmt(tol)}) at index ${cursor}`);
    }
    case 'BREAKS_STRUCTURE': {
      const lbRaw = paramValue(cond, ['lookback', 'period', 'window']);
      const lookback = lbRaw === undefined || lbRaw === null || lbRaw === '' ? 20 : Math.floor(Number(lbRaw));
      if (!Number.isInteger(lookback) || lookback <= 0) {
        return fail(`BREAKS_STRUCTURE "${label}" has nonsensical lookback ${String(lbRaw)} at index ${cursor}: recorded as not passed`);
      }
      if (cursor - lookback < 0) {
        return fail(`BREAKS_STRUCTURE(${lookback}) unevaluable at index ${cursor}: available bars ${cursor + 1} below required ${lookback + 1}`);
      }
      const dirRaw = paramValue(cond, ['direction', 'side', 'bias']);
      const dirWord = dirRaw === undefined || dirRaw === null || dirRaw === '' ? null : parseSideWord(dirRaw);
      if (dirWord === null && dirRaw !== undefined && dirRaw !== null && dirRaw !== '') {
        return fail(`BREAKS_STRUCTURE "${label}" has unrecognised direction ${String(dirRaw)} at index ${cursor}: recorded as not passed`);
      }
      const wantUp = dirWord === null || dirWord === 'UP';
      const wantDown = dirWord === null || dirWord === 'DOWN';
      const prevHigh = wantUp ? maxHigh(candles, cursor - lookback, cursor - 1) : null;
      const prevLow = wantDown ? minLow(candles, cursor - lookback, cursor - 1) : null;
      if ((wantUp && prevHigh === null) || (wantDown && prevLow === null)) {
        return fail(`BREAKS_STRUCTURE(${lookback}) unevaluable at index ${cursor}: invalid candle in window`);
      }
      const breaksUp = wantUp && close > prevHigh;
      const breaksDown = wantDown && close < prevLow;
      if (breaksUp && !breaksDown) {
        return ok(`close ${fmt(close)} > prior ${lookback}-bar high ${fmt(prevHigh)} (structure break up) at index ${cursor}`);
      }
      if (breaksDown && !breaksUp) {
        return ok(`close ${fmt(close)} < prior ${lookback}-bar low ${fmt(prevLow)} (structure break down) at index ${cursor}`);
      }
      if (breaksUp && breaksDown) {
        return ok(`close ${fmt(close)} outside prior ${lookback}-bar range ${fmt(prevLow)}..${fmt(prevHigh)} (structure break both sides) at index ${cursor}`);
      }
      if (wantUp && wantDown) {
        return fail(`close ${fmt(close)} inside prior ${lookback}-bar range ${fmt(prevLow)}..${fmt(prevHigh)} (no structure break) at index ${cursor}`);
      }
      return wantUp
        ? fail(`close ${fmt(close)} <= prior ${lookback}-bar high ${fmt(prevHigh)} (no structure break up) at index ${cursor}`)
        : fail(`close ${fmt(close)} >= prior ${lookback}-bar low ${fmt(prevLow)} (no structure break down) at index ${cursor}`);
    }
    case 'HTF_BIAS': {
      const perRaw = paramValue(cond, ['period', 'lookback']);
      const period = perRaw === undefined || perRaw === null || perRaw === '' ? 20 : Math.floor(Number(perRaw));
      if (!Number.isInteger(period) || period <= 0) {
        return fail(`HTF_BIAS "${label}" has nonsensical period ${String(perRaw)} at index ${cursor}: recorded as not passed`);
      }
      const dirRaw = paramValue(cond, ['direction', 'side', 'bias']);
      const dirWord = dirRaw === undefined || dirRaw === null || dirRaw === '' ? null : parseSideWord(dirRaw);
      if (dirWord === null && dirRaw !== undefined && dirRaw !== null && dirRaw !== '') {
        return fail(`HTF_BIAS "${label}" has unrecognised direction ${String(dirRaw)} at index ${cursor}: recorded as not passed`);
      }
      const smaNow = smaCloses(candles, cursor, period);
      const smaPrev = cursor >= 1 ? smaCloses(candles, cursor - 1, period) : null;
      if (smaNow === null || smaPrev === null) {
        return fail(`HTF_BIAS SMA(${period}) unevaluable at index ${cursor}: available bars ${cursor + 1} below required ${period + 1}`);
      }
      let want = dirWord;
      if (want === null) {
        if (close > o) want = 'UP';
        else if (close < o) want = 'DOWN';
        else return fail(`HTF_BIAS "${label}" has no direction and candle at index ${cursor} has no body polarity (open equals close ${fmt(o)})`);
      }
      if (want === 'UP') {
        return smaNow > smaPrev
          ? ok(`SMA(${period}) rising ${fmt(smaPrev)} to ${fmt(smaNow)} (htf bias up) at index ${cursor}`)
          : fail(`SMA(${period}) not rising ${fmt(smaPrev)} to ${fmt(smaNow)} (htf bias up unmet) at index ${cursor}`);
      }
      return smaNow < smaPrev
        ? ok(`SMA(${period}) falling ${fmt(smaPrev)} to ${fmt(smaNow)} (htf bias down) at index ${cursor}`)
        : fail(`SMA(${period}) not falling ${fmt(smaPrev)} to ${fmt(smaNow)} (htf bias down unmet) at index ${cursor}`);
    }
    case 'CANDLE_CLOSE': {
      const dirRaw = paramValue(cond, ['direction', 'side']);
      const dirWord = dirRaw === undefined || dirRaw === null || dirRaw === '' ? null : parseSideWord(dirRaw);
      if (dirWord === null && dirRaw !== undefined && dirRaw !== null && dirRaw !== '') {
        return fail(`CANDLE_CLOSE "${label}" has unrecognised direction ${String(dirRaw)} at index ${cursor}: recorded as not passed`);
      }
      if (dirWord === 'UP') {
        return close > o
          ? ok(`close ${fmt(close)} > open ${fmt(o)} (bullish close) at index ${cursor}`)
          : fail(`close ${fmt(close)} <= open ${fmt(o)} (bullish close unmet) at index ${cursor}`);
      }
      if (dirWord === 'DOWN') {
        return close < o
          ? ok(`close ${fmt(close)} < open ${fmt(o)} (bearish close) at index ${cursor}`)
          : fail(`close ${fmt(close)} >= open ${fmt(o)} (bearish close unmet) at index ${cursor}`);
      }
      return close !== o
        ? ok(`close ${fmt(close)} != open ${fmt(o)} (decisive close) at index ${cursor}`)
        : fail(`close ${fmt(close)} equals open ${fmt(o)} (no decisive close) at index ${cursor}`);
    }
    case 'INSIDE_RANGE': {
      const hi = numParam(cond, ['high', 'top', 'upper', 'resistance'], null);
      const lo = numParam(cond, ['low', 'bottom', 'lower', 'support'], null);
      if (hi === null || lo === null) {
        return fail(`INSIDE_RANGE "${label}" missing finite high/low at index ${cursor}: recorded as not passed`);
      }
      if (hi < lo) {
        return fail(`INSIDE_RANGE "${label}" has inverted range high ${fmt(hi)} < low ${fmt(lo)} at index ${cursor}: recorded as not passed`);
      }
      return close >= lo && close <= hi
        ? ok(`close ${fmt(close)} inside range ${fmt(lo)}..${fmt(hi)} at index ${cursor}`)
        : fail(`close ${fmt(close)} outside range ${fmt(lo)}..${fmt(hi)} at index ${cursor}`);
    }
    case 'CUSTOM': {
      const supplied = paramValue(cond, ['result', 'pass', 'value']);
      if (typeof supplied === 'boolean') {
        return supplied
          ? ok(`CUSTOM "${label}" satisfied by caller-supplied result at index ${cursor} (supplied by caller)`)
          : fail(`CUSTOM "${label}" not satisfied by caller-supplied result at index ${cursor} (supplied by caller)`);
      }
      return fail(`CUSTOM condition "${label}" is not auto-evaluated from candles at index ${cursor}: recorded as not passed`);
    }
    // ---- Legacy snake_case vocabulary (backward compatible) ----
    case 'PASS':
    case 'LITERAL':
    case 'ALWAYS': {
      const v = paramValue(cond, ['value', 'pass']);
      const p = v === true;
      return p
        ? ok(`literal condition "${label}" recorded as satisfied at index ${cursor}`)
        : fail(`literal condition "${label}" recorded as not satisfied at index ${cursor}`);
    }
    case 'CLOSE_ABOVE_SMA':
    case 'SMA_BULLISH':
    case 'CLOSE_ABOVE_MA': {
      const period = numParam(cond, ['period', 'lookback'], 20);
      const ma = smaCloses(candles, cursor, period);
      if (ma === null) {
        return fail(
          `SMA(${period}) unavailable at index ${cursor}: available bars ${cursor + 1} below required ${period}`,
        );
      }
      return close > ma
        ? ok(`close ${fmt(close)} above SMA(${period}) ${fmt(ma)} at index ${cursor}`)
        : fail(`close ${fmt(close)} not above SMA(${period}) ${fmt(ma)} at index ${cursor}`);
    }
    case 'CLOSE_BELOW_SMA':
    case 'SMA_BEARISH':
    case 'CLOSE_BELOW_MA': {
      const period = numParam(cond, ['period', 'lookback'], 20);
      const ma = smaCloses(candles, cursor, period);
      if (ma === null) {
        return fail(
          `SMA(${period}) unavailable at index ${cursor}: available bars ${cursor + 1} below required ${period}`,
        );
      }
      return close < ma
        ? ok(`close ${fmt(close)} below SMA(${period}) ${fmt(ma)} at index ${cursor}`)
        : fail(`close ${fmt(close)} not below SMA(${period}) ${fmt(ma)} at index ${cursor}`);
    }
    case 'BREAKOUT_HIGH':
    case 'BREAK_HIGH': {
      const lookback = Math.floor(numParam(cond, ['lookback', 'period'], 20));
      if (!(lookback > 0) || cursor - lookback < 0) {
        return fail(
          `breakout_high(${lookback}) unevaluable at index ${cursor}: available bars ${cursor + 1} below required ${lookback + 1}`,
        );
      }
      const prev = maxHigh(candles, cursor - lookback, cursor - 1);
      if (prev === null) return fail(`breakout_high(${lookback}) unevaluable at index ${cursor}: invalid candle in window`);
      return close > prev
        ? ok(`close ${fmt(close)} above prior ${lookback}-bar high ${fmt(prev)} at index ${cursor}`)
        : fail(`close ${fmt(close)} not above prior ${lookback}-bar high ${fmt(prev)} at index ${cursor}`);
    }
    case 'BREAKOUT_LOW':
    case 'BREAK_LOW': {
      const lookback = Math.floor(numParam(cond, ['lookback', 'period'], 20));
      if (!(lookback > 0) || cursor - lookback < 0) {
        return fail(
          `breakout_low(${lookback}) unevaluable at index ${cursor}: available bars ${cursor + 1} below required ${lookback + 1}`,
        );
      }
      const prev = minLow(candles, cursor - lookback, cursor - 1);
      if (prev === null) return fail(`breakout_low(${lookback}) unevaluable at index ${cursor}: invalid candle in window`);
      return close < prev
        ? ok(`close ${fmt(close)} below prior ${lookback}-bar low ${fmt(prev)} at index ${cursor}`)
        : fail(`close ${fmt(close)} not below prior ${lookback}-bar low ${fmt(prev)} at index ${cursor}`);
    }
    case 'BULLISH_BODY':
    case 'BODY_BULLISH':
    case 'BULLISH_CANDLE': {
      const minPct = numParam(cond, ['minBodyPct', 'minBodyPercent'], 0) ?? NaN;
      const bodyPct = range > 0 ? ((close - o) / range) * 100 : 0;
      const p = close > o && bodyPct >= minPct;
      return p
        ? ok(`bullish body ${round2(bodyPct)}% meets minimum ${round2(minPct)}% at index ${cursor}`)
        : fail(`bullish body ${round2(bodyPct)}% below minimum ${round2(minPct)}% at index ${cursor}`);
    }
    case 'BEARISH_BODY':
    case 'BODY_BEARISH':
    case 'BEARISH_CANDLE': {
      const minPct = numParam(cond, ['minBodyPct', 'minBodyPercent'], 0) ?? NaN;
      const bodyPct = range > 0 ? ((o - close) / range) * 100 : 0;
      const p = close < o && bodyPct >= minPct;
      return p
        ? ok(`bearish body ${round2(bodyPct)}% meets minimum ${round2(minPct)}% at index ${cursor}`)
        : fail(`bearish body ${round2(bodyPct)}% below minimum ${round2(minPct)}% at index ${cursor}`);
    }
    case 'RANGE_EXPANSION': {
      const lookback = Math.floor(numParam(cond, ['lookback', 'period'], 14));
      const multRaw = paramValue(cond, ['multiplier']);
      const mult = multRaw === undefined || multRaw === null || multRaw === '' ? 1.5 : Number(multRaw);
      if (!(lookback > 0) || cursor - lookback < 0) {
        return fail(
          `range_expansion(${lookback}, x${mult}) unevaluable at index ${cursor}: available bars ${cursor + 1} below required ${lookback + 1}`,
        );
      }
      const avg = avgRange(candles, cursor - lookback, cursor - 1);
      if (avg === null || avg <= 0) {
        return fail(`range_expansion(${lookback}, x${mult}) unevaluable at index ${cursor}: invalid range in window`);
      }
      return range >= mult * avg
        ? ok(`range ${fmt(range)} at least ${mult}x average range ${fmt(avg)} at index ${cursor}`)
        : fail(`range ${fmt(range)} below ${mult}x average range ${fmt(avg)} at index ${cursor}`);
    }
    case 'HIGHER_CLOSE':
    case 'RISING_CLOSE': {
      const streakRaw = paramValue(cond, ['streak', 'count']);
      const streak = Math.floor(streakRaw === undefined || streakRaw === null || streakRaw === '' ? 2 : Number(streakRaw));
      if (!(streak > 0) || cursor - streak < 0) {
        return fail(
          `higher_close streak ${streak} unevaluable at index ${cursor}: available bars ${cursor + 1} below required ${streak + 1}`,
        );
      }
      for (let i = cursor - streak + 1; i <= cursor; i += 1) {
        if (!isCandle(candles[i]) || !isCandle(candles[i - 1])) {
          return fail(`higher_close streak ${streak} unevaluable at index ${cursor}: invalid candle in window`);
        }
        if (!(Number(candles[i].c) > Number(candles[i - 1].c))) {
          return fail(`close series not rising for ${streak} bars ending at index ${cursor}`);
        }
      }
      return ok(`close series rising for ${streak} bars ending at index ${cursor}`);
    }
    case 'LOWER_CLOSE':
    case 'FALLING_CLOSE': {
      const streakRaw = paramValue(cond, ['streak', 'count']);
      const streak = Math.floor(streakRaw === undefined || streakRaw === null || streakRaw === '' ? 2 : Number(streakRaw));
      if (!(streak > 0) || cursor - streak < 0) {
        return fail(
          `lower_close streak ${streak} unevaluable at index ${cursor}: available bars ${cursor + 1} below required ${streak + 1}`,
        );
      }
      for (let i = cursor - streak + 1; i <= cursor; i += 1) {
        if (!isCandle(candles[i]) || !isCandle(candles[i - 1])) {
          return fail(`lower_close streak ${streak} unevaluable at index ${cursor}: invalid candle in window`);
        }
        if (!(Number(candles[i].c) < Number(candles[i - 1].c))) {
          return fail(`close series not falling for ${streak} bars ending at index ${cursor}`);
        }
      }
      return ok(`close series falling for ${streak} bars ending at index ${cursor}`);
    }
    case 'THRESHOLD':
    case 'FIELD_COMPARE':
    case 'COMPARE': {
      const field = String(paramValue(cond, ['field']) ?? 'c').trim().toLowerCase();
      const op = String(paramValue(cond, ['operator', 'op']) ?? '>').trim();
      const targetRaw = paramValue(cond, ['value', 'target']);
      const target = targetRaw === undefined ? NaN : Number(targetRaw);
      const fields = { o, h, l, c: close, v: toFinite(c?.v, 0), body: close - o, range };
      if (!(field in fields) || !Number.isFinite(target)) {
        return fail(`threshold condition "${label}" has unevaluable field/value at index ${cursor}`);
      }
      const actual = fields[field];
      let p = false;
      if (op === '>') p = actual > target;
      else if (op === '>=') p = actual >= target;
      else if (op === '<') p = actual < target;
      else if (op === '<=') p = actual <= target;
      else if (op === '==' || op === '=') p = actual === target;
      else if (op === '!=') p = actual !== target;
      else return fail(`threshold condition "${label}" has unsupported operator "${op}" at index ${cursor}`);
      return p
        ? ok(`${field} ${fmt(actual)} ${op} ${fmt(target)} holds at index ${cursor}`)
        : fail(`${field} ${fmt(actual)} ${op} ${fmt(target)} does not hold at index ${cursor}`);
    }
    default: {
      return fail(`unsupported condition type "${type || 'missing'}" for "${label}" at index ${cursor}: recorded as not passed`);
    }
  }
}

function resolveAutoDirection(candles, cursor, strategy) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const hasSides = Array.isArray(s.longConditions) || Array.isArray(s.shortConditions);
  if (hasSides) {
    const longs = Array.isArray(s.longConditions) ? s.longConditions : [];
    const shorts = Array.isArray(s.shortConditions) ? s.shortConditions : [];
    const longPass = longs.length > 0 && longs.every((cond, i) => {
      const r = evalSingleCondition(candles, cursor, { ...cond, id: cond?.id ?? cond?.key ?? `long_cond_${i}` }, 'LONG');
      return r.pass;
    });
    const shortPass = shorts.length > 0 && shorts.every((cond, i) => {
      const r = evalSingleCondition(candles, cursor, { ...cond, id: cond?.id ?? cond?.key ?? `short_cond_${i}` }, 'SHORT');
      return r.pass;
    });
    if (longPass && !shortPass) return 'LONG';
    if (shortPass && !longPass) return 'SHORT';
    if (longPass && shortPass) return 'LONG';
    return null;
  }
  const c = candles[cursor];
  if (!isCandle(c)) return null;
  return Number(c.c) >= Number(c.o) ? 'LONG' : 'SHORT';
}

/**
 * Evaluate the strategy setup at a cursor. Pure readout of the candle window.
 * @returns {{ pass: boolean, direction: 'LONG'|'SHORT'|null, checks: Array<{id,type,pass,reason}> }}
 */
export function evaluateSetup({ candles, cursor, strategy } = {}) {
  const list = Array.isArray(candles) ? candles : [];
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const idx = Math.floor(Number(cursor));
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length || !isCandle(list[idx])) {
    return { pass: false, direction: null, checks: [] };
  }
  const configured = resolveStrategyDirection(s.direction ?? s.side ?? 'AUTO');
  let direction = configured;
  if (direction === 'AUTO') {
    direction = resolveAutoDirection(list, idx, s);
    if (direction === null) return { pass: false, direction: null, checks: [] };
  }
  const conds = conditionListFor(s, direction);
  const checks = conds.map((cond, i) => evalSingleCondition(
    list,
    idx,
    { ...(cond && typeof cond === 'object' ? cond : {}), id: cond?.id ?? cond?.key ?? `cond_${i}` },
    direction,
  ));
  // Total-order sort: by id, then type — equal elements can never reorder.
  checks.sort((a, b) => cmpStr(String(a.id), String(b.id)) || cmpStr(String(a.type), String(b.type)));
  const pass = checks.length > 0 && checks.every((c) => c.pass === true);
  return { pass, direction, checks };
}

// ---- Checklist bridge (strategy conditions + referenced personal rules) ----

function referencedRuleIds(strategy, ruleRefs) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const raw = Array.isArray(ruleRefs)
    ? ruleRefs
    : Array.isArray(s.requiredRuleIds)
      ? s.requiredRuleIds
      : Array.isArray(s.ruleRefs)
        ? s.ruleRefs
        : Array.isArray(s.ruleIds)
          ? s.ruleIds
          : [];
  const ids = [];
  for (const r of raw) {
    const id = typeof r === 'string' ? r : r?.id ?? r?.ruleId;
    if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
  }
  ids.sort(cmpStr);
  return ids;
}

function ruleById(rules, id) {
  if (!Array.isArray(rules)) return undefined;
  return rules.find((r) => r && (r.id === id || r.ruleId === id || r.key === id));
}

function compareOp(actual, op, target) {
  if (op === '>') return actual > target;
  if (op === '>=') return actual >= target;
  if (op === '<') return actual < target;
  if (op === '<=') return actual <= target;
  if (op === '==' || op === '=') return actual === target;
  if (op === '!=') return actual !== target;
  return null;
}

/**
 * Build the `checks` map for evaluateChecklist: every strategy condition plus
 * every referenced personal rule maps to { pass, reason, source }.
 * Personal rules with candle-evaluable validation (RR_LIMIT against the
 * replay RR) are evaluated; all other referenced rules are recorded as
 * satisfied in the replay context with an explicit reason.
 */
export function buildChecks({ strategy, ruleRefs, rules, context } = {}) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const ctx = context && typeof context === 'object' ? context : {};
  const checks = {};
  const candles = Array.isArray(ctx.candles) ? ctx.candles : [];
  const cursor = Math.floor(Number(ctx.cursor));
  const direction = normalizeDirection(ctx.direction) === 'SHORT' ? 'SHORT' : 'LONG';

  const conds = conditionListFor(s, direction);
  const condIds = conds.map((cond, i) => String(cond?.id ?? cond?.key ?? `cond_${i}`));
  const sortedCondIdx = conds.map((_, i) => i).sort((a, b) => cmpStr(condIds[a], condIds[b]) || a - b);
  for (const i of sortedCondIdx) {
    const cond = conds[i] && typeof conds[i] === 'object' ? conds[i] : {};
    const cid = condIds[i];
    let entry;
    if (Number.isInteger(cursor) && cursor >= 0 && cursor < candles.length && isCandle(candles[cursor])) {
      const r = evalSingleCondition(candles, cursor, { ...cond, id: cid }, direction);
      entry = { pass: r.pass, reason: r.reason, source: 'Strategy' };
    } else {
      entry = { pass: false, reason: `strategy condition "${cid}" unevaluable at index ${Number.isInteger(cursor) ? cursor : 'NaN'}: cursor outside candle range`, source: 'Strategy' };
    }
    checks[cid] = entry;
  }

  for (const rid of referencedRuleIds(s, ruleRefs)) {
    const rule = ruleById(rules, rid);
    if (!rule) {
      checks[rid] = {
        pass: false,
        missing: true,
        reason: `referenced rule "${rid}" absent from rules input at index ${Number.isInteger(cursor) ? cursor : 'NaN'}`,
        source: 'Rules',
      };
      continue;
    }
    const type = String(rule.type ?? 'CHECKBOX').trim().toUpperCase();
    const source = String(rule.category ?? 'Rules');
    if (type === 'RR_LIMIT') {
      const v = rule.validation && typeof rule.validation === 'object' ? rule.validation : {};
      const op = String(v.operator ?? '>=');
      const limit = Number(v.value);
      const rr = Number(ctx.riskReward);
      if (!Number.isFinite(limit) || !Number.isFinite(rr)) {
        checks[rid] = {
          pass: false,
          reason: `RR rule "${rid}" unevaluable: replay RR ${Number.isFinite(rr) ? fmt(rr) : 'unknown'} against limit ${Number.isFinite(limit) ? fmt(limit) : 'unknown'}`,
          source,
        };
        continue;
      }
      const p = compareOp(rr, op, limit);
      if (p === null) {
        checks[rid] = { pass: false, reason: `RR rule "${rid}" has unsupported operator "${op}"`, source };
        continue;
      }
      checks[rid] = {
        pass: p,
        reason: `replay RR ${fmt(rr)} ${op} required ${fmt(limit)} (${String(rule.name ?? rid)})`,
        source,
      };
      continue;
    }
    checks[rid] = {
      pass: true,
      reason: `rule "${String(rule.name ?? rid)}" recorded as satisfied in replay context (no candle-evaluable validation for type ${type})`,
      source,
    };
  }
  return checks;
}

/**
 * Build the rules array for evaluateChecklist: strategy conditions become
 * required pseudo-rules; referenced personal rules keep their own
 * weight/required/enabled flags. Sorted by id for deterministic scoring.
 */
export function buildChecklistRules({ strategy, ruleRefs, rules, direction } = {}) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const dir = normalizeDirection(direction) === 'SHORT' ? 'SHORT' : 'LONG';
  const conds = conditionListFor(s, dir);
  const out = conds.map((cond, i) => {
    const cid = String(cond?.id ?? cond?.key ?? `cond_${i}`);
    return {
      id: cid,
      name: `Strategy: ${String(cond?.label ?? cond?.name ?? cond?.type ?? cid)}`,
      weight: 1,
      required: true,
      enabled: true,
      category: 'STRATEGY',
    };
  });
  for (const rid of referencedRuleIds(s, ruleRefs)) {
    const rule = ruleById(rules, rid);
    if (!rule) {
      out.push({ id: rid, name: `Missing rule ${rid}`, weight: 1, required: true, enabled: true, category: 'GENERAL' });
      continue;
    }
    out.push({
      id: String(rule.id ?? rule.ruleId ?? rid),
      name: String(rule.name ?? rid),
      weight: rule.weight,
      required: rule.required,
      enabled: rule.enabled,
      category: rule.category,
    });
  }
  out.sort((a, b) => cmpStr(String(a.id), String(b.id)));
  return out;
}

// ---- Entry / stops / exit resolution ----

function entryConfig(strategy) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const e = s.entry && typeof s.entry === 'object' ? s.entry : {};
  const mode = String(e.mode ?? s.entryMode ?? 'next_open').trim().toLowerCase();
  return { mode: mode === 'signal_close' ? 'signal_close' : 'next_open' };
}

/**
 * Resolve the fill for a setup at cursor. Default `next_open` enters at the
 * next candle open (no lookahead); `signal_close` enters at the signal close.
 * @returns {{ index: number, price: number } | null}
 */
export function resolveEntry({ candles, cursor, strategy, direction } = {}) {
  void direction;
  const list = Array.isArray(candles) ? candles : [];
  const idx = Math.floor(Number(cursor));
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return null;
  const { mode } = entryConfig(strategy);
  const entryIndex = mode === 'signal_close' ? idx : idx + 1;
  if (entryIndex < 0 || entryIndex >= list.length) return null;
  const bar = list[entryIndex];
  if (!isCandle(bar)) return null;
  const price = mode === 'signal_close' ? Number(bar.c) : Number(bar.o);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { index: entryIndex, price: round5(price) };
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function distanceFromConfig(s, keys) {
  for (const k of keys) {
    const n = numberOrNull(s?.[k]);
    if (n !== null && n > 0) return n;
  }
  return null;
}

// Accepts: number (distance) | { type:'distance'|'percent'|'price', value } |
// { distance } | { pips/points } — plus legacy flat aliases on the strategy.
function parseLevelConfig(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' || typeof raw === 'string') {
    const n = numberOrNull(raw);
    return n !== null && n > 0 ? { type: 'distance', value: n } : null;
  }
  if (typeof raw !== 'object') return null;
  const type = String(raw.type ?? raw.mode ?? 'distance').trim().toLowerCase();
  const value = numberOrNull(raw.value ?? raw.distance ?? raw.pips ?? raw.points ?? raw.percent ?? raw.price ?? raw.level);
  if (value === null) return null;
  if (type === 'price' || type === 'level') return { type: 'price', value };
  if (type === 'percent' || type === 'percentage' || type === 'pct') return { type: 'percent', value };
  return { type: 'distance', value };
}

/**
 * Resolve stop-loss / take-profit prices for an entry. Sides are enforced by
 * direction; invalid configs fall back to a deterministic default derived
 * from the signal candle range with a 2R target.
 */
export function resolveStops({ candle, entry, direction, strategy } = {}) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const dir = normalizeDirection(direction) === 'SHORT' ? 'SHORT' : 'LONG';
  const entryPrice = Number(entry);
  const fallbackRange = candle && Number.isFinite(Number(candle.h)) && Number.isFinite(Number(candle.l))
    ? Math.abs(Number(candle.h) - Number(candle.l))
    : 0;
  const safeRange = fallbackRange > 0 ? fallbackRange : Math.abs(entryPrice) * 0.001 || 1;

  const slRaw = s.stopLoss ?? s.sl ?? s.stop ?? { distance: distanceFromConfig(s, ['slDistance', 'stopDistance', 'stopLossDistance', 'riskDistance']) };
  const tpRaw = s.takeProfit ?? s.tp ?? s.target ?? { distance: distanceFromConfig(s, ['tpDistance', 'takeProfitDistance']) };
  const slCfg = parseLevelConfig(slRaw);
  const tpCfg = parseLevelConfig(tpRaw);
  const targetRR = numberOrNull(s.targetRR ?? s.riskReward ?? s.minRR ?? s.rr);

  let slDist = null;
  if (slCfg) {
    if (slCfg.type === 'distance') slDist = slCfg.value > 0 ? slCfg.value : null;
    else if (slCfg.type === 'percent') slDist = slCfg.value > 0 ? (Math.abs(entryPrice) * slCfg.value) / 100 : null;
    else if (slCfg.type === 'price') {
      const d = dir === 'LONG' ? entryPrice - slCfg.value : slCfg.value - entryPrice;
      slDist = d > 0 ? d : null;
    }
  }
  if ((slDist === null || !(slDist > 0)) && Number.isFinite(entryPrice) && entryPrice > 0) {
    slDist = safeRange;
  }

  let stopLoss;
  let takeProfit;
  if (Number.isFinite(entryPrice) && slDist !== null && slDist > 0) {
    stopLoss = dir === 'LONG' ? entryPrice - slDist : entryPrice + slDist;
    let tpDist = null;
    if (tpCfg) {
      if (tpCfg.type === 'distance') tpDist = tpCfg.value > 0 ? tpCfg.value : null;
      else if (tpCfg.type === 'percent') tpDist = tpCfg.value > 0 ? (Math.abs(entryPrice) * tpCfg.value) / 100 : null;
      else if (tpCfg.type === 'price') {
        const d = dir === 'LONG' ? tpCfg.value - entryPrice : entryPrice - tpCfg.value;
        tpDist = d > 0 ? d : null;
      }
    }
    if ((tpDist === null || !(tpDist > 0)) && targetRR !== null && targetRR > 0) {
      tpDist = slDist * targetRR;
    }
    if (tpDist === null || !(tpDist > 0)) tpDist = slDist * 2;
    takeProfit = dir === 'LONG' ? entryPrice + tpDist : entryPrice - tpDist;
  } else {
    stopLoss = NaN;
    takeProfit = NaN;
  }
  return { stopLoss: round5(stopLoss), takeProfit: round5(takeProfit) };
}

/**
 * Walk ONLY candles after entry. A same-bar SL+TP hit resolves to SL_HIT
 * (conservative, deterministic). Unreached levels → END_OF_DATA at the last
 * close. Optional strategy.maxHoldCandles forces TIME_EXIT at close.
 */
export function resolveExit({ candles, entryIndex, direction, stopLoss, takeProfit, strategy } = {}) {
  const list = Array.isArray(candles) ? candles : [];
  const eIdx = Math.floor(Number(entryIndex));
  const dir = normalizeDirection(direction) === 'SHORT' ? 'SHORT' : 'LONG';
  const sl = Number(stopLoss);
  const tp = Number(takeProfit);
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const maxHoldRaw = s.maxHoldCandles ?? s.maxHold ?? s.exit?.maxHoldCandles;
  const maxHold = maxHoldRaw === undefined || maxHoldRaw === null ? null : Math.floor(Number(maxHoldRaw));
  const holdCap = Number.isInteger(maxHold) && maxHold > 0 ? maxHold : null;

  const noData = (idx) => ({
    exitIndex: idx,
    exitPrice: round5(Number(list[idx]?.c) || 0),
    reason: REPLAY_EXIT_REASONS.END_OF_DATA,
    holdCandles: Math.max(0, idx - eIdx),
  });

  if (!Number.isInteger(eIdx) || eIdx < 0 || eIdx >= list.length) {
    return { exitIndex: eIdx, exitPrice: 0, reason: REPLAY_EXIT_REASONS.END_OF_DATA, holdCandles: 0 };
  }
  if (!Number.isFinite(sl) || !Number.isFinite(tp)) {
    return noData(list.length - 1 < eIdx ? eIdx : list.length - 1);
  }
  for (let i = eIdx + 1; i < list.length; i += 1) {
    const bar = list[i];
    if (!isCandle(bar)) continue;
    const h = Number(bar.h);
    const l = Number(bar.l);
    const slHit = dir === 'LONG' ? l <= sl : h >= sl;
    const tpHit = dir === 'LONG' ? h >= tp : l <= tp;
    if (slHit && tpHit) {
      return { exitIndex: i, exitPrice: round5(sl), reason: REPLAY_EXIT_REASONS.SL_HIT, holdCandles: i - eIdx };
    }
    if (slHit) {
      return { exitIndex: i, exitPrice: round5(sl), reason: REPLAY_EXIT_REASONS.SL_HIT, holdCandles: i - eIdx };
    }
    if (tpHit) {
      return { exitIndex: i, exitPrice: round5(tp), reason: REPLAY_EXIT_REASONS.TP_HIT, holdCandles: i - eIdx };
    }
    if (holdCap !== null && i - eIdx >= holdCap) {
      return { exitIndex: i, exitPrice: round5(Number(bar.c)), reason: REPLAY_EXIT_REASONS.TIME_EXIT, holdCandles: i - eIdx };
    }
  }
  if (holdCap !== null && list.length - 1 - eIdx >= holdCap) {
    const bi = Math.min(eIdx + holdCap, list.length - 1);
    return {
      exitIndex: bi,
      exitPrice: round5(Number(list[bi]?.c) || 0),
      reason: REPLAY_EXIT_REASONS.TIME_EXIT,
      holdCandles: bi - eIdx,
    };
  }
  return noData(list.length - 1);
}

// ---- Trade simulation (SIMULATED only) ----

/**
 * Build a SIMULATED trade. Deterministic id = `${runId}::t${entryIndex}`.
 * Risk maths via riskEngine only: calcRiskAmount, calcPositionSize, calcRR.
 */
export function simulateTrade({
  runId,
  symbol,
  timeframe,
  entryIndex,
  direction,
  entryPrice,
  stopLoss,
  takeProfit,
  exit,
  strategy,
  verdict,
  account,
  riskPercent,
  rules,
} = {}) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const acct = account && typeof account === 'object' ? account : {};
  const dir = normalizeDirection(direction) === 'SHORT' ? 'SHORT' : 'LONG';
  const eIdx = Math.floor(Number(entryIndex));
  const ex = exit && typeof exit === 'object' ? exit : {};
  const exitIndex = Number.isInteger(Math.floor(Number(ex.exitIndex))) ? Math.floor(Number(ex.exitIndex)) : eIdx;
  const exitPrice = round5(Number(ex.exitPrice));
  const reason = Object.values(REPLAY_EXIT_REASONS).includes(ex.reason) ? ex.reason : REPLAY_EXIT_REASONS.END_OF_DATA;
  const holdCandles = Math.max(0, Math.floor(Number(ex.holdCandles)) || exitIndex - eIdx);

  const balance = toFinite(acct.balance ?? acct.startingBalance, 0);
  const rp = Number(riskPercent);
  const riskPct = Number.isFinite(rp) && rp >= 0 ? rp : 0;
  const riskAmount = calcRiskAmount(balance, riskPct);
  const positionSize = calcPositionSize(balance, riskPct, Number(entryPrice), Number(stopLoss));
  const rr = calcRR(Number(entryPrice), Number(stopLoss), Number(takeProfit), dir);

  const riskDist = Math.abs(Number(entryPrice) - Number(stopLoss));
  let rMultiple = 0;
  if (reason === REPLAY_EXIT_REASONS.SL_HIT) rMultiple = -1;
  else if (reason === REPLAY_EXIT_REASONS.TP_HIT) rMultiple = round2(rr);
  else if (riskDist > 0) {
    const signed = dir === 'LONG' ? exitPrice - Number(entryPrice) : Number(entryPrice) - exitPrice;
    rMultiple = round2(signed / riskDist);
  }
  const pnl = round2(rMultiple * riskAmount);
  const pnlPercent = balance > 0 ? round2((pnl / balance) * 100) : 0;

  const v = verdict && typeof verdict === 'object' ? verdict : {};
  const score = toFinite(v.score, 0);
  const passedIds = Array.isArray(v.passedRules)
    ? v.passedRules.map((r) => String(r?.id ?? '')).filter(Boolean).sort(cmpStr)
    : [];
  const requiredPassed = Array.isArray(v.passedRules)
    ? v.passedRules.filter((r) => r && r.required === true).map((r) => String(r.id ?? '')).filter(Boolean).sort(cmpStr)
    : [];
  void rules;

  const strategyId = String(s.id ?? s.strategyId ?? 'unknown');

  return {
    id: `${String(runId)}::t${eIdx}`,
    runId: String(runId),
    status: SIMULATED_STATUS,
    symbol: String(symbol ?? s.symbol ?? s.pair ?? acct.symbol ?? 'UNKNOWN'),
    timeframe: String(timeframe ?? s.timeframe ?? 'UNKNOWN'),
    direction: dir,
    strategyId,
    strategyVersion: s.version ?? s.strategyVersion ?? 1,
    entryIndex: eIdx,
    entryTime: 0,
    entryPrice: round5(Number(entryPrice)),
    exitIndex,
    exitTime: 0,
    exitPrice,
    holdCandles,
    closeReason: reason,
    stopLoss: round5(Number(stopLoss)),
    takeProfit: round5(Number(takeProfit)),
    riskPercent: round2(riskPct),
    riskAmount,
    positionSize,
    rr,
    rMultiple,
    pnl,
    pnlPercent,
    checklistScore: score,
    decisionState: String(v.state ?? 'READY'),
    requiredRulesPassed: requiredPassed,
    passedRules: passedIds,
    entryReason: `decision ${String(v.state ?? 'READY')} at index ${eIdx} with score ${score} (${passedIds.length} checks passed; required rules passed: ${requiredPassed.length > 0 ? requiredPassed.join(', ') : 'none'})`,
  };
}

// ---- Run identity ----

function ruleVersionTag(rule) {
  const id = String(rule?.id ?? rule?.ruleId ?? rule?.key ?? 'unknown');
  const ver = rule?.version ?? rule?.ruleVersion ?? 1;
  return `${id}@${String(ver)}`;
}

export function describeRuleVersions(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((r) => r && typeof r === 'object')
    .map(ruleVersionTag)
    .sort(cmpStr);
}

function deriveRunId({ strategy, ruleVersions, firstT, lastT, count, startIndex, endIndex, riskPercent, maxTrades, allowLong, allowShort }) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const payload = {
    allowLong: allowLong === true,
    allowShort: allowShort === true,
    conditions: s.conditions ?? s.longConditions ?? null,
    count,
    endIndex,
    entry: s.entry ?? null,
    firstT,
    lastT,
    maxHold: s.maxHoldCandles ?? s.maxHold ?? null,
    maxTrades,
    riskPercent,
    ruleVersions,
    sid: String(s.id ?? s.strategyId ?? 'unknown'),
    sl: s.stopLoss ?? s.sl ?? null,
    startIndex,
    sver: s.version ?? s.strategyVersion ?? 1,
    tp: s.takeProfit ?? s.tp ?? null,
  };
  // Canonical Phase 9A identity fields join the hash only when present, so
  // legacy strategies hash byte-identically to before.
  if (s.entryConditions !== undefined) payload.entryConditions = s.entryConditions;
  if (s.confirmationConditions !== undefined) payload.confirmationConditions = s.confirmationConditions;
  if (s.ruleRefs !== undefined) payload.ruleRefs = s.ruleRefs;
  if (s.entryConditions !== undefined || s.confirmationConditions !== undefined) {
    payload.strategyDirection = String(s.direction ?? s.side ?? 'AUTO');
  }
  return `replay_${fnv1aHex(stableStringify(payload))}`;
}

// ---- Single-bar gate (single source of truth) ----
// Canonical per-bar decision order: setup -> entry -> stops -> risk guards ->
// checklist verdict. runReplay calls this for every bar; the replay cursor
// panel calls it for display. One implementation, no parallel interpretation.
export function evaluateBar({ candles, cursor, strategy, rules, account, riskPercent } = {}) {
  const list = normalizeCandles(candles);
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const ruleList = Array.isArray(rules) ? rules : [];
  const acct = account && typeof account === 'object' ? account : {};
  const rawCursor = cursor;
  const idx = Math.floor(Number(cursor));
  const base = {
    cursor: Number.isInteger(idx) ? idx : rawCursor,
    setup: null,
    direction: null,
    entry: null,
    stops: null,
    guards: null,
    checks: null,
    verdict: null,
    riskReward: null,
    riskAmount: null,
    canSimulate: false,
    blockedReason: '',
  };
  const block = (reason) => ({ ...base, blockedReason: reason });
  if (list.length === 0) return block('no candles to evaluate');
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length || !isCandle(list[idx])) {
    return block(`cursor ${String(rawCursor)} is outside evaluable candle range 0..${list.length - 1}`);
  }
  const setup = evaluateSetup({ candles: list, cursor: idx, strategy: s });
  const dir = setup.direction;
  if (!setup.pass) {
    const firstFail = setup.checks.find((chk) => chk.pass !== true);
    if (!firstFail) {
      return { ...base, setup, direction: dir, blockedReason: `strategy defines no conditions to evaluate at index ${idx}` };
    }
    return { ...base, setup, direction: dir, blockedReason: `setup failed: ${firstFail.reason}` };
  }
  const entry = resolveEntry({ candles: list, cursor: idx, strategy: s, direction: dir });
  if (!entry) {
    return { ...base, setup, direction: dir, blockedReason: `no fill after setup at index ${idx}: insufficient candles after entry` };
  }
  const stops = resolveStops({ candle: list[idx], entry: entry.price, direction: dir, strategy: s });
  if (!Number.isFinite(stops.stopLoss) || !Number.isFinite(stops.takeProfit)) {
    return { ...base, setup, direction: dir, entry, blockedReason: `levels not resolvable for ${dir} entry ${entry.price} at index ${idx}` };
  }
  const balance = toFinite(acct.balance ?? acct.startingBalance, 0);
  const rpRaw = Number(riskPercent);
  const rp = Number.isFinite(rpRaw) && rpRaw >= 0 ? rpRaw : 0;
  const riskAmount = calcRiskAmount(balance, rp);
  const guards = checkRiskGuards({
    balance, riskAmount, riskPercent: rp,
    entry: entry.price, sl: stops.stopLoss, tp: stops.takeProfit, direction: dir,
  });
  if (!guards.safe) {
    return { ...base, setup, direction: dir, entry, stops, guards, riskAmount, blockedReason: `risk guard: ${guards.blockers[0] ?? 'blocked'}` };
  }
  const riskReward = calcRR(entry.price, stops.stopLoss, stops.takeProfit, dir);
  const context = {
    candles: list, cursor: idx, direction: dir,
    entryPrice: entry.price, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit, riskReward,
  };
  const checks = buildChecks({ strategy: s, ruleRefs: undefined, rules: ruleList, context });
  const checklistRules = buildChecklistRules({ strategy: s, ruleRefs: undefined, rules: ruleList, direction: dir });
  const thresholds = s.thresholds && typeof s.thresholds === 'object' ? s.thresholds : undefined;
  let verdict = null;
  try {
    verdict = evaluateChecklist(
      thresholds === undefined
        ? { rules: checklistRules, checks }
        : { rules: checklistRules, checks, thresholds },
    );
  } catch (err) {
    return { ...base, setup, direction: dir, entry, stops, guards, checks, riskReward, riskAmount, blockedReason: `checklist error: ${(err && err.message) || err}` };
  }
  if (verdict.state !== 'READY') {
    return { ...base, setup, direction: dir, entry, stops, guards, checks, verdict, riskReward, riskAmount, blockedReason: `decision ${verdict.state} with score ${verdict.score} (READY required)` };
  }
  return { ...base, setup, direction: dir, entry, stops, guards, checks, verdict, riskReward, riskAmount, canSimulate: true, blockedReason: '' };
}

// ---- Main replay loop ----

/**
 * Deterministic historical replay over candles. Never writes anywhere;
 * every emitted entry has status 'SIMULATED' and required a READY verdict
 * from evaluateChecklist. Identical inputs yield byte-identical output.
 * Input bars are normalised (ascending timestamp, last-wins dedupe) so
 * unordered input can never introduce look-ahead bias.
 */
export function runReplay({ candles, strategy, rules, account, options } = {}) {
  if (strategy !== undefined && (strategy === null || typeof strategy !== 'object' || Array.isArray(strategy))) {
    throw new TypeError('strategy must be an object');
  }
  if (account !== undefined && (account === null || typeof account !== 'object' || Array.isArray(account))) {
    throw new TypeError('account must be an object');
  }
  const list = normalizeCandles(candles);
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const ruleList = Array.isArray(rules) ? rules : [];
  const acct = account && typeof account === 'object' ? account : {};
  const opts = options && typeof options === 'object' ? options : {};

  const strategyId = String(s.id ?? s.strategyId ?? 'unknown');
  const strategyVersion = s.version ?? s.strategyVersion ?? 1;
  const ruleVersions = describeRuleVersions(ruleList);
  const symbol = String(s.symbol ?? s.pair ?? opts.symbol ?? acct.symbol ?? 'UNKNOWN');
  const timeframe = String(s.timeframe ?? opts.timeframe ?? 'UNKNOWN');

  const riskPercent = Number.isFinite(Number(opts.riskPercent))
    ? Number(opts.riskPercent)
    : Number.isFinite(Number(s.riskPercent))
      ? Number(s.riskPercent)
      : 1;
  const maxTradesRaw = opts.maxTrades ?? s.maxTrades;
  const maxTrades = maxTradesRaw === undefined || maxTradesRaw === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(Number(maxTradesRaw)));
  const allowLong = opts.allowLong ?? s.allowLong ?? true;
  const allowShort = opts.allowShort ?? s.allowShort ?? true;

  const startRaw = opts.startIndex ?? opts.initialCursor ?? 0;
  const endRaw = opts.endIndex ?? list.length - 1;
  const startIndex = list.length === 0 ? 0 : Math.min(Math.max(0, Math.floor(Number(startRaw)) || 0), list.length - 1);
  const endIndex = list.length === 0 ? -1 : Math.min(Math.max(0, Math.floor(Number(endRaw)) || 0), list.length - 1);
  const barsProcessed = list.length === 0 || endIndex < startIndex ? 0 : endIndex - startIndex + 1;

  const firstT = list.length > 0 && isCandle(list[Math.max(0, startIndex)]) ? Number(list[Math.max(0, startIndex)].t) : 0;
  const lastT = list.length > 0 && isCandle(list[Math.max(0, endIndex)]) ? Number(list[Math.max(0, endIndex)].t) : 0;

  const runId = typeof opts.runId === 'string' && opts.runId !== ''
    ? opts.runId
    : deriveRunId({
      strategy: s,
      ruleVersions,
      firstT,
      lastT,
      count: list.length,
      startIndex,
      endIndex,
      riskPercent,
      maxTrades: maxTrades === Number.POSITIVE_INFINITY ? -1 : maxTrades,
      allowLong: allowLong === true || (allowLong !== false && allowLong !== 'false'),
      allowShort: allowShort === true || (allowShort !== false && allowShort !== 'false'),
    });

  const entries = [];
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalPnl = 0;
  let totalR = 0;
  let setupsPassed = 0;
  let guardSkips = 0;
  let insufficientSkips = 0;
  let nonReadySkips = 0;

  const allowLongOn = allowLong === true || (allowLong !== false && allowLong !== 'false');
  const allowShortOn = allowShort === true || (allowShort !== false && allowShort !== 'false');

  if (list.length > 0 && barsProcessed > 0) {
    for (let cursor = startIndex; cursor <= endIndex && entries.length < maxTrades; cursor += 1) {
      const gate = evaluateBar({ candles: list, cursor, strategy: s, rules: ruleList, account: acct, riskPercent });
      if (!gate.setup || !gate.setup.pass) continue;
      setupsPassed += 1;
      const dir = gate.direction;
      if (dir === 'LONG' && !allowLongOn) continue;
      if (dir === 'SHORT' && !allowShortOn) continue;

      const entry = gate.entry;
      if (!entry) {
        insufficientSkips += 1;
        continue;
      }
      const stops = gate.stops;
      if (!stops || !Number.isFinite(stops.stopLoss) || !Number.isFinite(stops.takeProfit)) {
        insufficientSkips += 1;
        continue;
      }

      const guards = gate.guards;
      if (!guards || !guards.safe) {
        guardSkips += 1;
        continue;
      }

      const verdict = gate.verdict;
      if (!gate.canSimulate || !verdict) {
        nonReadySkips += 1;
        continue;
      }

      const exit = resolveExit({
        candles: list,
        entryIndex: entry.index,
        direction: dir,
        stopLoss: stops.stopLoss,
        takeProfit: stops.takeProfit,
        strategy: s,
      });
      const trade = simulateTrade({
        runId,
        symbol,
        timeframe,
        entryIndex: entry.index,
        direction: dir,
        entryPrice: entry.price,
        stopLoss: stops.stopLoss,
        takeProfit: stops.takeProfit,
        exit: { ...exit, cursor },
        strategy: s,
        verdict,
        account: acct,
        riskPercent,
        rules: ruleList,
      });
      // Attach true candle timestamps (deterministic: derived from input only).
      trade.entryTime = Number(list[entry.index]?.t) || 0;
      trade.exitTime = Number(list[exit.exitIndex]?.t) || 0;
      entries.push(trade);

      totalPnl = round2(totalPnl + trade.pnl);
      totalR = round2(totalR + trade.rMultiple);
      if (trade.pnl > 0) wins += 1;
      else if (trade.pnl < 0) losses += 1;
      else breakeven += 1;

      if (exit.exitIndex > cursor) cursor = exit.exitIndex;
    }
  }

  // Total-order entry sort: entryIndex, then id. Loop already emits in order;
  // the sort guarantees byte-identical output regardless of emission path.
  entries.sort((a, b) => (a.entryIndex - b.entryIndex) || cmpStr(String(a.id), String(b.id)));

  const totalTrades = entries.length;
  let noTradeReason = null;
  if (totalTrades === 0) {
    if (list.length === 0) noTradeReason = 'empty candle input: no bars to evaluate';
    else if (setupsPassed === 0) noTradeReason = 'no setup passed strategy conditions in range';
    else if (guardSkips > 0 && nonReadySkips === 0 && insufficientSkips === 0) noTradeReason = 'setups passed but all blocked by risk guards';
    else if (insufficientSkips > 0 && nonReadySkips === 0 && guardSkips === 0) noTradeReason = 'setups passed but insufficient candles before/after entry to resolve fills';
    else noTradeReason = 'setups passed but decision verdict never reached READY';
  }

  return {
    runId,
    strategyId,
    strategyVersion,
    ruleVersions,
    symbol,
    timeframe,
    barsProcessed,
    entries,
    summary: {
      totalTrades,
      wins,
      losses,
      breakeven,
      totalPnl: round2(totalPnl),
      avgR: totalTrades > 0 ? round2(totalR / totalTrades) : 0,
      winRate: totalTrades > 0 ? round2((wins / totalTrades) * 100) : 0,
      guardSkips,
      insufficientSkips,
      nonReadySkips,
      noTradeReason,
    },
  };
}

export default {
  runReplay,
  evaluateBar,
  normalizeCandles,
  evaluateSetup,
  buildChecks,
  buildChecklistRules,
  resolveEntry,
  resolveStops,
  resolveExit,
  simulateTrade,
  describeRuleVersions,
  REPLAY_EXIT_REASONS,
};

/**
 * Navigation bounds for the replay cursor over a candle series.
 * Pure so the boundary rule is unit-testable and cannot drift from the UI.
 */
export function cursorNavState(cursorIndex, total) {
  const n = Number.isFinite(Number(total)) ? Math.max(0, Math.floor(Number(total))) : 0;
  const i = Number.isFinite(Number(cursorIndex)) ? Math.floor(Number(cursorIndex)) : 0;
  if (n === 0) return { canPrev: false, canNext: false };
  return { canPrev: i > 0, canNext: i < n - 1 };
}
