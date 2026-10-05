// Shared offline test harness: DOM/localStorage stubs, deterministic seed,
// minimal assertions, tiny test runner. No dependencies. No network.
// This module installs minimal browser stubs ON IMPORT so that later static
// imports of src/utils modules (which transitively reach firebase via
// ruleManager) evaluate safely in Node.
function makeNoopEl() {
  return {
    style: {},
    classList: { add() {}, remove() {} },
    appendChild() {},
    remove() {},
    setAttribute() {},
    addEventListener() {},
    click() {},
  };
}

function installDomStubs() {
  try {
    if (typeof globalThis.document === 'undefined') {
      globalThis.document = {
        getElementById: () => null,
        createElement: makeNoopEl,
        createElementNS: makeNoopEl,
        getElementsByTagName: () => [],
        querySelector: () => null,
        cookie: '',
        documentElement: { setAttribute() {} },
        body: { appendChild() {} },
        head: { appendChild() {} },
      };
    } else {
      const d = globalThis.document;
      if (!d.getElementById) d.getElementById = () => null;
      if (!d.getElementsByTagName) d.getElementsByTagName = () => [];
      if (!d.head) d.head = { appendChild() {} };
      if (!d.body) d.body = { appendChild() {} };
      if (!d.createElement) d.createElement = makeNoopEl;
    }
  } catch { /* never throw from stubs */ }
  try {
    if (typeof globalThis.window === 'undefined') {
      globalThis.window = {
        location: { hash: '' },
        addEventListener() {},
        document: globalThis.document,
      };
    } else if (!globalThis.window.document) {
      globalThis.window.document = globalThis.document;
    }
  } catch { /* ignore */ }
}

installDomStubs();

// ---- localStorage stub ----
function createLocalStorageStub() {
  const store = Object.create(null);
  return {
    _store: store,
    getItem(k) {
      const v = store[String(k)];
      return v === undefined ? null : v;
    },
    setItem(k, v) { store[String(k)] = String(v); },
    removeItem(k) { delete store[String(k)]; },
    clear() { for (const k of Object.keys(store)) delete store[k]; },
    key(i) { return Object.keys(store)[i] ?? null; },
    get length() { return Object.keys(store).length; },
  };
}

export function installLocalStorage() {
  const stub = createLocalStorageStub();
  globalThis.localStorage = stub;
  return stub;
}

if (typeof globalThis.localStorage === 'undefined') installLocalStorage();

export function resetStorage() {
  installLocalStorage();
}

export { createLocalStorageStub };

// ---- Deterministic seed ----
export const SEED_USER = 'contracttester';
export const SEED_ACC1 = 'acc-1';
export const SEED_ACC2 = 'acc-2';

const FIXED = {
  acc1Created: '2024-01-01T00:00:00.000Z',
  t1open: '2024-01-02T10:00:00.000Z',
  t1close: '2024-01-02T15:00:00.000Z',
  t2open: '2024-01-03T10:00:00.000Z',
  t2close: '2024-01-03T15:00:00.000Z',
  t3open: '2024-01-04T10:00:00.000Z',
  t3close: '2024-01-04T15:00:00.000Z',
  rev1: '2024-01-05T10:00:00.000Z',
  rev2: '2024-01-05T11:00:00.000Z',
};

function lsSet(key, value) {
  globalThis.localStorage.setItem(key, JSON.stringify(value));
}

// Creates a deterministic dataset for `user`:
// - 2 accounts (acc-1 with startingBalance 10000, acc-2 with 5000, no trades)
// - 3 CLOSED trades on acc-1 with known pnl/rMultiple/dates
//   (+200/2.0, -100/-1.0, +150/1.5 on 2024-01-02..04)
// - 2 COMPLETED reviews (t-1 total 85 high, t-2 total 40 low), t-3 unreviewed
// - 1 rule, 1 WAITING setup, empty prop config object.
// All timestamps are fixed; never uses the current clock.
export function seedDeterministic(user = SEED_USER) {
  const u = String(user);
  resetStorage();
  lsSet(`tradelog_folders_${u}`, [
    {
      id: SEED_ACC1, name: 'Contract Acc One', type: 'LIVE',
      startingBalance: 10000, currentBalance: 10250,
      createdAt: FIXED.acc1Created, updatedAt: FIXED.acc1Created,
    },
    {
      id: SEED_ACC2, name: 'Contract Acc Two', type: 'LIVE',
      startingBalance: 5000, currentBalance: 5000,
      createdAt: FIXED.acc1Created, updatedAt: FIXED.acc1Created,
    },
  ]);
  lsSet(`tradelog_exectrades_${u}`, [
    {
      id: 't-1', userId: u, accountId: SEED_ACC1, setupId: '', pair: 'EUR/USD',
      direction: 'LONG', strategyId: 'strat-a', session: 'London', timeframe: 'H1',
      setupType: 'breakout', lotSize: 1, entryPrice: 1.1, exitPrice: 1.12,
      stopLoss: 1.09, takeProfit: 1.14, riskAmount: 100, riskPercent: 1,
      pnl: 200, rMultiple: 2, status: 'CLOSED',
      openedAt: FIXED.t1open, closedAt: FIXED.t1close,
      createdAt: FIXED.t1open, updatedAt: FIXED.t1close,
      checklistResults: [], rulesSnapshot: [], events: [], screenshotIds: [],
    },
    {
      id: 't-2', userId: u, accountId: SEED_ACC1, setupId: '', pair: 'EUR/USD',
      direction: 'SHORT', strategyId: 'strat-a', session: 'London', timeframe: 'H1',
      setupType: 'breakout', lotSize: 1, entryPrice: 1.12, exitPrice: 1.11,
      stopLoss: 1.13, takeProfit: 1.1, riskAmount: 100, riskPercent: 1,
      pnl: -100, rMultiple: -1, status: 'CLOSED',
      openedAt: FIXED.t2open, closedAt: FIXED.t2close,
      createdAt: FIXED.t2open, updatedAt: FIXED.t2close,
      checklistResults: [], rulesSnapshot: [], events: [], screenshotIds: [],
    },
    {
      id: 't-3', userId: u, accountId: SEED_ACC1, setupId: '', pair: 'GBP/USD',
      direction: 'SHORT', strategyId: 'strat-b', session: 'New York', timeframe: 'H1',
      setupType: 'pullback', lotSize: 1, entryPrice: 1.27, exitPrice: 1.25,
      stopLoss: 1.28, takeProfit: 1.24, riskAmount: 100, riskPercent: 0.5,
      pnl: 150, rMultiple: 1.5, status: 'CLOSED',
      openedAt: FIXED.t3open, closedAt: FIXED.t3close,
      createdAt: FIXED.t3open, updatedAt: FIXED.t3close,
      checklistResults: [], rulesSnapshot: [], events: [], screenshotIds: [],
    },
  ]);
  lsSet(`tradelog_reviews_${u}`, [
    {
      id: 'r-1', userId: u, tradeId: 't-1', accountId: SEED_ACC1, status: 'COMPLETED',
      answers: { preTrade: {}, execution: {}, management: {} },
      ruleViolations: [], mistakes: [], strengths: [],
      followedPlan: true, confidence: 4,
      processScore: {
        preTradeScore: 22, executionScore: 21, managementScore: 22,
        disciplineScore: 20, total: 85, grade: 'B',
      },
      total: 85, createdAt: FIXED.rev1, updatedAt: FIXED.rev1,
    },
    {
      id: 'r-2', userId: u, tradeId: 't-2', accountId: SEED_ACC1, status: 'COMPLETED',
      answers: { preTrade: {}, execution: {}, management: {} },
      ruleViolations: ['rule-1'], mistakes: [], strengths: [],
      followedPlan: false, confidence: 2,
      processScore: {
        preTradeScore: 10, executionScore: 10, managementScore: 10,
        disciplineScore: 10, total: 40, grade: 'F',
      },
      total: 40, createdAt: FIXED.rev2, updatedAt: FIXED.rev2,
    },
  ]);
  lsSet(`tradelog_rules_${u}`, [
    {
      id: 'rule-1', userId: u, name: 'Seed rule', description: 'seed',
      category: 'GENERAL', type: 'CHECKBOX', enabled: true, weight: 10,
      required: false, severity: 'MEDIUM',
      applicableSessions: [], applicableStrategies: [], applicablePairs: [],
      validation: { operator: '>=', value: 0, unit: 'count' },
      createdAt: FIXED.acc1Created, updatedAt: FIXED.acc1Created,
    },
  ]);
  lsSet(`tradelog_setups_${u}`, [
    {
      id: 'setup-1', userId: u, accountId: SEED_ACC1, pair: 'EUR/USD',
      direction: 'LONG', status: 'WAITING',
      createdAt: FIXED.acc1Created, updatedAt: FIXED.acc1Created,
    },
  ]);
  lsSet(`tradelog_propconfig_${u}`, {});
  return { user: u, accountId: SEED_ACC1 };
}

// ---- Review fixtures for processScore ----
export function buildPerfectReview() {
  return {
    answers: {
      preTrade: { pt_plan: 'fully', pt_setup_quality: 'a_plus', pt_context: 'yes', pt_risk: 'correct' },
      execution: { ex_timing: 'perfect', ex_levels: 'yes', ex_state: 'calm' },
      management: { mg_plan: 'yes', mg_exit: 'per_plan', mg_levels: 'no' },
    },
    followedPlan: 'yes',
    ruleViolations: [],
  };
}

export function buildEmptyReview() {
  return {};
}

// ---- Assertions ----
function fmt(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(`ok failed: ${msg}`);
}

export function equal(actual, expected, msg = '') {
  if (!Object.is(actual, expected)) {
    throw new Error(`equal failed${msg ? ` (${msg})` : ''}: expected ${fmt(expected)}, got ${fmt(actual)}`);
  }
}

export function deepEqual(actual, expected, msg = '') {
  if (!deepEq(actual, expected)) {
    throw new Error(`deepEqual failed${msg ? ` (${msg})` : ''}:\nexpected: ${fmt(expected)}\nactual:   ${fmt(actual)}`);
  }
}

function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEq(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return false;
  for (const k of ka) if (!deepEq(a[k], b[k])) return false;
  return true;
}

export function typeOf(value, type, msg = '') {
  if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`typeOf failed${msg ? ` (${msg})` : ''}: expected array, got ${fmt(value)}`);
    return;
  }
  if (type === 'null') {
    if (value !== null) throw new Error(`typeOf failed${msg ? ` (${msg})` : ''}: expected null, got ${fmt(value)}`);
    return;
  }
  if (typeof value !== type) {
    throw new Error(`typeOf failed${msg ? ` (${msg})` : ''}: expected ${type}, got ${typeof value} (${fmt(value)})`);
  }
}

export function assertThrows(fn, msg = 'expected function to throw') {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(`assertThrows failed: ${msg}`);
}

export function assertNoMutation(fn, getState, msg = 'state was mutated') {
  const before = JSON.stringify(getState());
  fn();
  const after = JSON.stringify(getState());
  if (before !== after) throw new Error(`assertNoMutation failed: ${msg}\nbefore: ${before}\nafter:  ${after}`);
}

// Exact sorted-key comparison: no missing AND no unexpected keys.
export function assertExactKeys(obj, expectedKeys, msg = '') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`assertExactKeys failed${msg ? ` (${msg})` : ''}: not an object: ${fmt(obj)}`);
  }
  const actual = Object.keys(obj).sort();
  const expected = [...expectedKeys].sort();
  if (fmt(actual) !== fmt(expected)) {
    throw new Error(
      `assertExactKeys failed${msg ? ` (${msg})` : ''}:\nexpected keys: ${fmt(expected)}\nactual keys:   ${fmt(actual)}`,
    );
  }
}

// ---- Tiny runner ----
const _tests = [];
const _skips = [];

export function test(name, fn) {
  _tests.push({ name, fn });
}

export function skip(name, reason = '') {
  _skips.push({ name, reason });
}

export function __getTests() { return _tests; }
export function __getSkips() { return _skips; }
export function __clearTests() { _tests.length = 0; _skips.length = 0; }

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const { name, fn } of _tests) {
    resetStorage(); // fresh localStorage stub per test (independence)
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (e) {
      failed += 1;
      failures.push({ name, error: e });
      console.log(`  FAIL - ${name}\n    ${String(e && e.message || e).split('\n').join('\n    ')}`);
    }
  }
  for (const { name, reason } of _skips) {
    console.log(`  skipped: ${name}${reason ? ` (${reason})` : ''} — needs DOM`);
  }
  const skipped = _skips.length;
  console.log(`suite: ${passed} passed, ${failed} failed, ${skipped} skipped, ${_tests.length} total`);
  return { passed, failed, skipped, total: _tests.length, failures };
}
