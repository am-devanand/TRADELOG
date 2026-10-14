// CALENDAR AGGREGATION TESTS — pins the exported date/aggregation contract of
// src/js/pages/calendar.js (read-only view, no trade creation).
//
// Pages normally import CSS, which Node cannot parse, so this file registers a
// resolve/load hook that turns `*.css` into an empty module before importing
// the page. That keeps the tests pointed at the REAL production module instead
// of a re-implementation copied out of it.
//
// All assertions are timezone-independent: dates are built with the local
// Date constructor and every produced day key is checked against the
// round-trip invariant `toLocalISO(new Date(y, m-1, d)) === key`.
import { registerHooks } from 'node:module';
import {
  test, run, ok, equal, deepEqual, assertExactKeys,
  resetStorage, SEED_USER, SEED_ACC1,
} from './helpers.js';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\.css(?:$|\?)/.test(specifier)) {
      return { url: specifier, format: 'module', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (/\.css(?:$|\?)/.test(url)) {
      return { format: 'module', shortCircuit: true, source: 'export default {};' };
    }
    return nextLoad(url, context);
  },
});

const { getDailyAggregates, dayKeyForTrade, toLocalISO } = await import(
  '../src/js/pages/calendar.js'
);

const USER = SEED_USER;
const ACCOUNT = SEED_ACC1;
const USER_KEY = `tradelog_exectrades_${USER}`;

function readTrades() {
  const raw = globalThis.localStorage.getItem(USER_KEY);
  const parsed = raw ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? parsed : [];
}

function writeTrades(list) {
  globalThis.localStorage.setItem(USER_KEY, JSON.stringify(list));
}

function setReviews(list) {
  globalThis.localStorage.setItem(`tradelog_reviews_${USER}`, JSON.stringify(list));
}

/** Canonical check: a day key must denote a real local calendar day. */
function assertCanonicalDayKey(key, label) {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(key), `${label}: key "${key}" is YYYY-MM-DD`);
  const [y, m, d] = key.split('-').map(Number);
  const rebuilt = new Date(y, m - 1, d);
  equal(
    toLocalISO(rebuilt),
    key,
    `${label}: key round-trips through a local Date constructor`,
  );
  equal(rebuilt.getMonth(), m - 1, `${label}: month component is in range`);
  ok(d >= 1 && d <= 31, `${label}: day component is in range`);
}

function trade(overrides) {
  return {
    id: 'x', userId: USER, accountId: ACCOUNT, setupId: '', pair: 'EUR/USD',
    direction: 'LONG', strategyId: 'strat-a', session: 'London', timeframe: 'H1',
    setupType: 'breakout', lotSize: 1, entryPrice: 1.1, exitPrice: 1.1,
    stopLoss: 1.09, takeProfit: 1.14, riskAmount: 100, riskPercent: 1,
    pnl: 0, rMultiple: 0, status: 'OPEN',
    openedAt: '2024-01-10T10:00:00.000Z', closedAt: null,
    createdAt: '2024-01-10T10:00:00.000Z', updatedAt: '2024-01-10T10:00:00.000Z',
    checklistResults: [], rulesSnapshot: [], events: [], screenshotIds: [],
    ...overrides,
  };
}

function dayByISO(aggregates) {
  return new Map(aggregates.map((a) => [a.dateISO, a]));
}

function findTrade(aggregates, id) {
  for (const a of aggregates) {
    if (a.trades.some((t) => String(t.id) === String(id))) return a;
  }
  return null;
}

// ---- toLocalISO ----

test('toLocalISO: local midnight and end-of-day resolve to the same day key', () => {
  const start = toLocalISO(new Date(2024, 0, 15, 0, 0, 0, 0));
  const end = toLocalISO(new Date(2024, 0, 15, 23, 59, 59, 999));
  equal(start, '2024-01-15', 'midnight');
  equal(end, '2024-01-15', 'end of day');
  assertCanonicalDayKey(start, 'midnight');
  assertCanonicalDayKey(end, 'end of day');
});

test('toLocalISO: zero-pads single-digit month and day', () => {
  equal(toLocalISO(new Date(2024, 0, 5)), '2024-01-05', 'Jan 5');
  equal(toLocalISO(new Date(2024, 8, 9)), '2024-09-09', 'Sep 9');
  equal(toLocalISO(new Date(2024, 11, 31)), '2024-12-31', 'Dec 31');
});

test('toLocalISO: invalid and non-Date input yields empty string, never throws', () => {
  equal(toLocalISO(new Date('not-a-date')), '', 'Invalid Date');
  equal(toLocalISO('2024-01-15'), '', 'string is not a Date instance');
  equal(toLocalISO(null), '', 'null');
  equal(toLocalISO(undefined), '', 'undefined');
  equal(toLocalISO(1700000000000), '', 'number');
});

// ---- dayKeyForTrade ----

test('dayKeyForTrade: CLOSED trades key off closedAt, not openedAt', () => {
  const opened = new Date(2024, 0, 10, 10, 0, 0);
  const closed = new Date(2024, 0, 12, 15, 30, 0);
  equal(
    dayKeyForTrade(trade({ status: 'CLOSED', openedAt: opened.toISOString(), closedAt: closed.toISOString() })),
    toLocalISO(closed),
    'CLOSED uses the close day even when it opened on an earlier day',
  );
});

test('dayKeyForTrade: OPEN and PARTIALLY_CLOSED trades key off openedAt', () => {
  const opened = new Date(2024, 0, 10, 9, 15, 0);
  for (const status of ['OPEN', 'PARTIALLY_CLOSED']) {
    equal(
      dayKeyForTrade(trade({ status, openedAt: opened.toISOString(), closedAt: null })),
      toLocalISO(opened),
      `${status} uses the open day`,
    );
  }
});

test('dayKeyForTrade: status match is case- and whitespace-insensitive', () => {
  const closed = new Date(2024, 0, 12, 15, 30, 0);
  const opened = new Date(2024, 0, 10, 9, 15, 0);
  for (const status of ['closed', '  CLOSED  ', 'Closed']) {
    equal(
      dayKeyForTrade(trade({ status, openedAt: opened.toISOString(), closedAt: closed.toISOString() })),
      toLocalISO(closed),
      `"${status}" still resolves to the close day`,
    );
  }
});

test('dayKeyForTrade: CLOSED with unparseable closedAt falls back to openedAt', () => {
  const opened = new Date(2024, 0, 10, 9, 15, 0);
  equal(
    dayKeyForTrade(trade({ status: 'CLOSED', openedAt: opened.toISOString(), closedAt: 'garbage' })),
    toLocalISO(opened),
    'falls back rather than dropping the trade',
  );
  equal(
    dayKeyForTrade(trade({ status: 'CLOSED', openedAt: opened.toISOString(), closedAt: '' })),
    toLocalISO(opened),
    'empty closedAt falls back',
  );
});

test('dayKeyForTrade: missing or invalid dates yield empty string', () => {
  equal(dayKeyForTrade(trade({ status: 'CLOSED', closedAt: null, openedAt: null })), '', 'no dates at all');
  equal(dayKeyForTrade(trade({ status: 'CLOSED', closedAt: 'nope', openedAt: 'nope' })), '', 'both unparseable');
  equal(dayKeyForTrade(trade({ status: 'OPEN', openedAt: undefined })), '', 'openedAt undefined');
  equal(dayKeyForTrade({}), '', 'no status, no dates');
});

test('dayKeyForTrade: non-object input yields empty string, never throws', () => {
  for (const bad of [null, undefined, 'trade', 42, true]) {
    equal(dayKeyForTrade(bad), '', `${String(bad)} is ignored`);
  }
});

test('dayKeyForTrade: a Date instance is accepted directly', () => {
  const d = new Date(2024, 4, 7, 13, 45, 0);
  equal(dayKeyForTrade(trade({ status: 'CLOSED', closedAt: d, openedAt: new Date(2024, 4, 1) })), toLocalISO(d), 'Date closedAt');
  equal(dayKeyForTrade(trade({ status: 'OPEN', openedAt: d, closedAt: null })), toLocalISO(d), 'Date openedAt');
});

// ---- getDailyAggregates: shape and empty data ----

test('getDailyAggregates: returns exactly one entry per day of the requested month', () => {
  const aggregates = getDailyAggregates(USER, ACCOUNT, 2024, 0);
  equal(aggregates.length, 31, 'January has 31 days');
  equal(aggregates[0].dateISO, '2024-01-01', 'starts on the 1st');
  equal(aggregates[30].dateISO, '2024-01-31', 'ends on the 31st');
  assertExactKeys(aggregates[0], ['dateISO', 'trades', 'pnl', 'r', 'grade', 'count', 'avgScore', 'reviewCount'], 'day entry');
});

test('getDailyAggregates: month length is correct across leap and non-leap years', () => {
  equal(getDailyAggregates(USER, ACCOUNT, 2024, 1).length, 29, 'Feb 2024 (leap)');
  equal(getDailyAggregates(USER, ACCOUNT, 2023, 1).length, 28, 'Feb 2023');
  equal(getDailyAggregates(USER, ACCOUNT, 2024, 3).length, 30, 'April 2024');
  equal(getDailyAggregates(USER, ACCOUNT, 2024, 0).length, 31, 'January 2024');
});

test('getDailyAggregates: empty dataset yields all-zero days and no fabricated grade', () => {
  writeTrades([]);
  setReviews([]);
  const aggregates = getDailyAggregates(USER, ACCOUNT, 2024, 0);
  equal(aggregates.length, 31, 'every day still present');
  for (const day of aggregates) {
    equal(day.count, 0, `${day.dateISO} has no trades`);
    deepEqual(day.trades, [], `${day.dateISO} trades array is empty`);
    equal(day.pnl, 0, `${day.dateISO} pnl is 0, not null`);
    equal(day.r, 0, `${day.dateISO} r is 0, not null`);
    equal(day.grade, '', `${day.dateISO} has no grade`);
    equal(day.avgScore, null, `${day.dateISO} has no score`);
    equal(day.reviewCount, 0, `${day.dateISO} reviewed no trades`);
  }
});

test('getDailyAggregates: invalid month or year returns an empty array instead of throwing', () => {
  for (const [y, m] of [[2024, -1], [2024, 12], [2024, 1.5], [2024, 'x'], [null, 0], [2024, NaN]]) {
    deepEqual(getDailyAggregates(USER, ACCOUNT, y, m), [], `year=${y} month=${m}`);
  }
});

// ---- getDailyAggregates: date placement ----

test('getDailyAggregates: CLOSED trades land on the close day inside the month', () => {
  writeTrades([
    trade({
      id: 'c-1', status: 'CLOSED',
      openedAt: new Date(2024, 0, 8, 10, 0, 0).toISOString(),
      closedAt: new Date(2024, 0, 11, 15, 0, 0).toISOString(),
      pnl: 200, rMultiple: 2,
    }),
  ]);
  setReviews([]);
  const aggregates = getDailyAggregates(USER, ACCOUNT, 2024, 0);
  equal(findTrade(aggregates, 'c-1')?.dateISO, toLocalISO(new Date(2024, 0, 11)), 'bucketed on close day');
  equal(dayByISO(aggregates).get('2024-01-08')?.count, 0, 'open day is not counted for a closed trade');
  const closeDay = dayByISO(aggregates).get('2024-01-11');
  equal(closeDay.pnl, 200, 'pnl on close day');
  equal(closeDay.r, 2, 'r on close day');
});

test('getDailyAggregates: OPEN trades land on the open day', () => {
  writeTrades([
    trade({
      id: 'o-1', status: 'OPEN',
      openedAt: new Date(2024, 0, 9, 9, 30, 0).toISOString(),
      closedAt: null, pnl: 0, rMultiple: 0,
    }),
  ]);
  setReviews([]);
  const aggregates = getDailyAggregates(USER, ACCOUNT, 2024, 0);
  equal(findTrade(aggregates, 'o-1')?.dateISO, toLocalISO(new Date(2024, 0, 9)), 'bucketed on open day');
});

test('getDailyAggregates: trades outside the requested month are excluded', () => {
  writeTrades([
    trade({ id: 'prev', status: 'CLOSED', openedAt: new Date(2023, 11, 30, 10).toISOString(), closedAt: new Date(2023, 11, 30, 12).toISOString() }),
    trade({ id: 'in', status: 'CLOSED', openedAt: new Date(2024, 0, 15, 10).toISOString(), closedAt: new Date(2024, 0, 15, 12).toISOString() }),
    trade({ id: 'next', status: 'CLOSED', openedAt: new Date(2024, 1, 1, 10).toISOString(), closedAt: new Date(2024, 1, 1, 12).toISOString() }),
  ]);
  setReviews([]);
  const aggregates = getDailyAggregates(USER, ACCOUNT, 2024, 0);
  equal(aggregates.reduce((a, d) => a + d.count, 0), 1, 'only the in-month trade is counted');
  equal(findTrade(aggregates, 'in')?.dateISO, '2024-01-15', 'in-month trade present');
  equal(findTrade(aggregates, 'prev'), null, 'previous-month trade excluded');
  equal(findTrade(aggregates, 'next'), null, 'next-month trade excluded');
});

test('getDailyAggregates: a trade opening Jan 31 and closing Feb 1 shows on the Feb side', () => {
  writeTrades([
    trade({
      id: 'roll', status: 'CLOSED',
      openedAt: new Date(2024, 0, 31, 22, 0, 0).toISOString(),
      closedAt: new Date(2024, 1, 1, 3, 0, 0).toISOString(),
    }),
  ]);
  setReviews([]);
  equal(findTrade(getDailyAggregates(USER, ACCOUNT, 2024, 0), 'roll'), null, 'absent from January');
  equal(findTrade(getDailyAggregates(USER, ACCOUNT, 2024, 1), 'roll')?.dateISO, '2024-02-01', 'present in February');
});

test('getDailyAggregates: trade with no resolvable date is skipped, never crashes the month', () => {
  writeTrades([
    trade({ id: 'bad', status: 'CLOSED', openedAt: 'garbage', closedAt: null }),
    trade({ id: 'good', status: 'CLOSED', openedAt: new Date(2024, 0, 5, 10).toISOString(), closedAt: new Date(2024, 0, 5, 11).toISOString(), pnl: 50, rMultiple: 0.5 }),
  ]);
  setReviews([]);
  const aggregates = getDailyAggregates(USER, ACCOUNT, 2024, 0);
  equal(aggregates.length, 31, 'month still renders');
  equal(findTrade(aggregates, 'bad'), null, 'undated trade is not bucketed anywhere');
  equal(dayByISO(aggregates).get('2024-01-05')?.count, 1, 'valid trade still counted');
});

test('getDailyAggregates: every emitted day key is a canonical local calendar day', () => {
  writeTrades([
    trade({ id: 'a', status: 'CLOSED', openedAt: new Date(2024, 1, 1, 10).toISOString(), closedAt: new Date(2024, 1, 29, 23, 59, 59, 999).toISOString() }),
    trade({ id: 'b', status: 'OPEN', openedAt: new Date(2024, 1, 29, 0, 0, 0, 0).toISOString(), closedAt: null }),
  ]);
  setReviews([]);
  for (const day of getDailyAggregates(USER, ACCOUNT, 2024, 1)) {
    assertCanonicalDayKey(day.dateISO, 'february');
    ok(day.dateISO.startsWith('2024-02-'), `${day.dateISO} stays inside the requested month`);
  }
});

// ---- getDailyAggregates: aggregation math and review linkage ----

test('getDailyAggregates: same-day trades sum P/L and R', () => {
  writeTrades([
    trade({ id: 'a', status: 'CLOSED', openedAt: new Date(2024, 0, 4, 10).toISOString(), closedAt: new Date(2024, 0, 4, 12).toISOString(), pnl: 200, rMultiple: 2 }),
    trade({ id: 'b', status: 'CLOSED', openedAt: new Date(2024, 0, 4, 13).toISOString(), closedAt: new Date(2024, 0, 4, 15).toISOString(), pnl: -100, rMultiple: -1 }),
    trade({ id: 'c', status: 'OPEN', openedAt: new Date(2024, 0, 4, 16).toISOString(), closedAt: null, pnl: 0, rMultiple: 0 }),
  ]);
  setReviews([]);
  const day = dayByISO(getDailyAggregates(USER, ACCOUNT, 2024, 0)).get('2024-01-04');
  equal(day.count, 3, 'all three trades on one day');
  equal(day.pnl, 100, 'net P/L');
  equal(day.r, 1, 'net R');
});

test('getDailyAggregates: P/L is rounded to 2 decimals and non-numeric values do not poison the sum', () => {
  writeTrades([
    trade({ id: 'a', status: 'CLOSED', openedAt: new Date(2024, 0, 4, 10).toISOString(), closedAt: new Date(2024, 0, 4, 12).toISOString(), pnl: 10.005, rMultiple: 0.333 }),
    trade({ id: 'b', status: 'CLOSED', openedAt: new Date(2024, 0, 4, 13).toISOString(), closedAt: new Date(2024, 0, 4, 15).toISOString(), pnl: 'nonsense', rMultiple: null }),
  ]);
  setReviews([]);
  const day = dayByISO(getDailyAggregates(USER, ACCOUNT, 2024, 0)).get('2024-01-04');
  equal(day.pnl, 10.01, 'rounded to cents, garbage treated as 0');
  equal(day.r, 0.33, 'rounded to 2dp');
});

test('getDailyAggregates: a trade is counted once even if both readers return it', () => {
  writeTrades([
    trade({ id: 'dup', status: 'CLOSED', openedAt: new Date(2024, 0, 6, 10).toISOString(), closedAt: new Date(2024, 0, 6, 12).toISOString(), pnl: 75, rMultiple: 0.75 }),
  ]);
  setReviews([]);
  const day = dayByISO(getDailyAggregates(USER, ACCOUNT, 2024, 0)).get('2024-01-06');
  equal(day.count, 1, 'no duplicate day entry');
  equal(day.pnl, 75, 'P/L counted once');
});

test('getDailyAggregates: completed reviews produce an avg score and a grade; unreviewed trades leave both null', () => {
  writeTrades([
    trade({ id: 'rev-1', status: 'CLOSED', openedAt: new Date(2024, 0, 7, 10).toISOString(), closedAt: new Date(2024, 0, 7, 12).toISOString() }),
    trade({ id: 'rev-2', status: 'CLOSED', openedAt: new Date(2024, 0, 7, 13).toISOString(), closedAt: new Date(2024, 0, 7, 15).toISOString() }),
  ]);
  setReviews([
    { id: 'r1', userId: USER, tradeId: 'rev-1', accountId: ACCOUNT, status: 'COMPLETED', processScore: { total: 90 }, total: 90 },
    { id: 'r2', userId: USER, tradeId: 'rev-2', accountId: ACCOUNT, status: 'COMPLETED', total: 50 },
    { id: 'r3', userId: USER, tradeId: 'rev-1', accountId: ACCOUNT, status: 'DRAFT', total: 10 },
  ]);
  const day = dayByISO(getDailyAggregates(USER, ACCOUNT, 2024, 0)).get('2024-01-07');
  equal(day.reviewCount, 2, 'both COMPLETED reviews counted');
  equal(day.avgScore, 70, 'nested total preferred, flat total accepted');
  ok(typeof day.grade === 'string' && day.grade.length > 0, 'grade derived from avg score');

  setReviews([]);
  const unreviewed = dayByISO(getDailyAggregates(USER, ACCOUNT, 2024, 0)).get('2024-01-07');
  equal(unreviewed.avgScore, null, 'no reviews leaves score null, not 0');
  equal(unreviewed.grade, '', 'no reviews leaves grade empty');
});

test('getDailyAggregates: accountId scopes the month; empty accountId means every account', () => {
  writeTrades([
    trade({ id: 'a1', accountId: ACCOUNT, status: 'CLOSED', openedAt: new Date(2024, 0, 8, 10).toISOString(), closedAt: new Date(2024, 0, 8, 12).toISOString(), pnl: 100, rMultiple: 1 }),
    trade({ id: 'a2', accountId: 'acc-2', status: 'CLOSED', openedAt: new Date(2024, 0, 8, 10).toISOString(), closedAt: new Date(2024, 0, 8, 12).toISOString(), pnl: 400, rMultiple: 4 }),
  ]);
  setReviews([]);
  equal(dayByISO(getDailyAggregates(USER, ACCOUNT, 2024, 0)).get('2024-01-08')?.count, 1, 'scoped to one account');
  equal(dayByISO(getDailyAggregates(USER, ACCOUNT, 2024, 0)).get('2024-01-08')?.pnl, 100, 'only this account P/L');
  equal(dayByISO(getDailyAggregates(USER, '', 2024, 0)).get('2024-01-08')?.count, 2, 'all accounts');
  equal(dayByISO(getDailyAggregates(USER, '', 2024, 0)).get('2024-01-08')?.pnl, 500, 'combined P/L');
});

test('getDailyAggregates: corrupt trade payload degrades to an empty month rather than throwing', () => {
  globalThis.localStorage.setItem(USER_KEY, '{ not json');
  ok(Array.isArray(getDailyAggregates(USER, ACCOUNT, 2024, 0)), 'still returns an array');
  globalThis.localStorage.setItem(`tradelog_reviews_${USER}`, ']]]');
  ok(Array.isArray(getDailyAggregates(USER, ACCOUNT, 2024, 0)), 'corrupt reviews degrade too');
});

test('getDailyAggregates: unknown user reads nothing and returns a zeroed month', () => {
  resetStorage();
  const aggregates = getDailyAggregates('nobody-here', ACCOUNT, 2024, 0);
  equal(aggregates.length, 31, 'month still renders for an empty user');
  equal(aggregates.reduce((a, d) => a + d.count, 0), 0, 'no trades leak across users');
});

test('getDailyAggregates: repeated calls for the same inputs are identical', () => {
  writeTrades([
    trade({ id: 'a', status: 'CLOSED', openedAt: new Date(2024, 0, 4, 10).toISOString(), closedAt: new Date(2024, 0, 4, 12).toISOString(), pnl: 200, rMultiple: 2 }),
  ]);
  setReviews([{ id: 'r1', userId: USER, tradeId: 'a', accountId: ACCOUNT, status: 'COMPLETED', total: 80 }]);
  const first = getDailyAggregates(USER, ACCOUNT, 2024, 0);
  const second = getDailyAggregates(USER, ACCOUNT, 2024, 0);
  deepEqual(
    second.map(({ trades, ...rest }) => rest),
    first.map(({ trades, ...rest }) => rest),
    'aggregation output is deterministic',
  );
  equal(readTrades().length, 1, 'the reader did not mutate storage');
});

test('calendar stays read-only: aggregation creates no trades, reviews, or audit entries', () => {
  writeTrades([
    trade({ id: 'a', status: 'CLOSED', openedAt: new Date(2024, 0, 4, 10).toISOString(), closedAt: new Date(2024, 0, 4, 12).toISOString() }),
  ]);
  setReviews([]);
  const before = JSON.stringify({
    trades: globalThis.localStorage.getItem(USER_KEY),
    reviews: globalThis.localStorage.getItem(`tradelog_reviews_${USER}`),
    audit: globalThis.localStorage.getItem(`tradelog_audit_${USER}`),
  });
  getDailyAggregates(USER, ACCOUNT, 2024, 0);
  getDailyAggregates(USER, '', 2023, 11);
  const after = JSON.stringify({
    trades: globalThis.localStorage.getItem(USER_KEY),
    reviews: globalThis.localStorage.getItem(`tradelog_reviews_${USER}`),
    audit: globalThis.localStorage.getItem(`tradelog_audit_${USER}`),
  });
  equal(after, before, 'no storage writes from the read-only aggregation');
});

test('getDailyAggregates: regression — a review without an explicit processScore uses its own total, not 0', () => {
  writeTrades([
    trade({ id: 'r-a', status: 'CLOSED', openedAt: new Date(2024, 0, 7, 10).toISOString(), closedAt: new Date(2024, 0, 7, 12).toISOString() }),
    trade({ id: 'r-b', status: 'CLOSED', openedAt: new Date(2024, 0, 7, 13).toISOString(), closedAt: new Date(2024, 0, 7, 15).toISOString() }),
  ]);
  setReviews([
    { id: 'x1', userId: USER, tradeId: 'r-a', accountId: ACCOUNT, status: 'COMPLETED', processScore: { total: 90 }, total: 90 },
    { id: 'x2', userId: USER, tradeId: 'r-b', accountId: ACCOUNT, status: 'COMPLETED', total: 50 },
  ]);
  const day = dayByISO(getDailyAggregates(USER, ACCOUNT, 2024, 0)).get('2024-01-07');
  equal(day.avgScore, 70, 'the 50-scored review is not dragged to 0 by the factory default processScore');
  equal(day.reviewCount, 2, 'both reviews still counted');
});

test('getDailyAggregates: regression — a null or empty-string year yields no phantom month', () => {
  for (const y of [null, '', undefined, NaN, 0, -5, 10000]) {
    deepEqual(getDailyAggregates(USER, ACCOUNT, y, 0), [], `year=${String(y)}`);
  }
  equal(getDailyAggregates(USER, ACCOUNT, '2024', '0').length, 31, 'numeric strings are still accepted');
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('calendar.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
