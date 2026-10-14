// SETUP SAVE IDEMPOTENCE + TRUTHFULNESS REGRESSION TESTS
//
// persistSetup/openEnterTradeModal used a blind-append saveSetup (two calls
// with the same id produced two rows), ignored updateSetup's null return, let
// storage-quota throws escape with no toast at all, and had no re-entrancy
// guard. Both paths now go through upsertSetup — idempotent per stable id,
// result-checked, quota-safe — behind a persistInFlight guard reset in a
// finally block, so success UI and execution only follow a verified write.
//
// These tests run the real extracted functions against recording stubs. The
// quota-failure cases would fail against the old code by throwing instead of
// returning false, and the idempotence cases fail against blind-append.
import { test, run, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(ROOT, 'src/js/pages/trade.js'), 'utf8');

function extractFunction(name) {
  const match = SOURCE.match(new RegExp(`(?:async\\s+)?function ${name}\\(`));
  if (!match) throw new Error(`could not find ${name} in trade.js`);
  let depth = 0;
  let opened = false;
  for (let i = match.index; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === '{') { depth += 1; opened = true; }
    else if (ch === '}') {
      depth -= 1;
      if (opened && depth === 0) return SOURCE.slice(match.index, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const READY_RESULT = {
  applicable: [], checks: {},
  decision: { score: 85, state: 'READY', failedRules: [], warnings: [], blockers: [], missingRules: [], passedRules: ['rule-1'] },
  risk: { rr: 2, riskAmount: 100, positionSize: 20000 }, priceError: null,
};

const FIELDS = {
  'ta-account': 'acc-A', 'ta-pair': 'EUR/USD', 'ta-strategy': 'Scalp',
  'ta-setupType': 'Breakout retest', 'ta-session': 'London', 'ta-timeframe': '1h',
  'ta-entry': '1.1000', 'ta-sl': '1.0950', 'ta-tp': '1.1100',
  'ta-risk': '1', 'ta-lotsize': '1', 'ta-notes': 'plan',
};

function makeDoc(values = FIELDS) {
  return {
    getElementById: (id) => {
      if (!(id in values)) return null;
      const v = values[id];
      return { value: v, tagName: 'INPUT', checked: v === true, selectedOptions: [] };
    },
  };
}

/**
 * Evaluates the real save path with every side effect observable. document,
 * recalc, audit, toasts, navigation and the execution modal are stubs; the
 * store itself is the real localStorage stub, so row counts are genuine.
 */
function makeSaver() {
  const calls = { recalcs: [], audits: [], toasts: [], navigations: [], modals: [] };
  const factory = new Function(
    'document', 'recalc', 'auditSetupWrite', 'showToast', 'navigate', 'openExecutionModal', 'generateId',
    `function safeParse(raw, fallback) { try { const p = JSON.parse(raw); return p == null ? fallback : p; } catch { return fallback; } }
function setupsKey(user) { return 'tradelog_setups_' + String(user || '').trim().toLowerCase(); }
const pendingShotIds = {};
let analysis = null;
let lastResult = null;
let persistInFlight = false;
${extractFunction('getSetups')}
${extractFunction('writeSetups')}
${extractFunction('upsertSetup')}
${extractFunction('stagedShotIds')}
${extractFunction('blankAnalysis')}
${extractFunction('readFormIntoState')}
${extractFunction('buildSetupRecord')}
${extractFunction('persistSetup')}
${extractFunction('openEnterTradeModal')}
analysis = blankAnalysis();
analysis.id = 'setup-1';
return {
  setLastResult: (r) => { lastResult = r; },
  getAnalysis: () => analysis,
  persistSetup: (status) => persistSetup('u', status),
  openEnterTradeModal: () => openEnterTradeModal('u'),
  rows: () => JSON.parse(localStorage.getItem('tradelog_setups_u') || '[]'),
};`,
  );
  const api = factory(
    makeDoc(),
    (u) => { calls.recalcs.push(u); },
    (...a) => { calls.audits.push(a); },
    (msg, kind) => { calls.toasts.push({ msg, kind: kind || 'success' }); },
    (path) => { calls.navigations.push(path); },
    (saved, opts) => { calls.modals.push({ saved, opts }); },
    () => 'gen-id',
  );
  return { api, calls };
}

// Runs fn with localStorage.setItem rigged to throw, restoring it after.
async function withQuotaFailure(fn) {
  const storage = globalThis.localStorage;
  const original = storage.setItem.bind(storage);
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  try {
    await fn();
  } finally {
    storage.setItem = original;
  }
}

// ---- 1. Idempotence at the store primitive ----

test('upserting twice under one id keeps exactly one row and updates it', () => {
  const { api } = makeSaver();
  api.setLastResult(READY_RESULT);
  equal(api.persistSetup('DRAFT'), true, 'first save succeeds');
  equal(api.rows().length, 1, 'one row after first save');
  equal(api.persistSetup('DRAFT'), true, 'repeat save succeeds');
  equal(api.rows().length, 1, 'still one row — no duplicate');
  equal(api.rows()[0].status, 'DRAFT', 'content reflects the latest save');
});

test('two distinct ids still produce two rows — no accidental merging', () => {
  const { api } = makeSaver();
  api.setLastResult(READY_RESULT);
  api.persistSetup('DRAFT');
  api.getAnalysis().id = 'setup-2';
  api.persistSetup('DRAFT');
  const rows = api.rows();
  equal(rows.length, 2, 'distinct setups are never merged');
  deepEqual(rows.map((r) => r.id).sort(), ['setup-1', 'setup-2'], 'both stable ids survive');
});

test('a repeat save records update semantics in the audit trail', () => {
  const { api, calls } = makeSaver();
  api.setLastResult(READY_RESULT);
  api.persistSetup('WAITING');
  api.persistSetup('WAITING');
  equal(calls.audits.length, 2, 'both saves audited');
  equal(calls.audits[0][2], true, 'first is a creation');
  equal(calls.audits[1][2], false, 'second is an update, not a second creation');
});

// ---- 2. Truthful toasts and navigation ----

test('DRAFT success toasts once and never navigates', () => {
  const { api, calls } = makeSaver();
  api.setLastResult(READY_RESULT);
  api.persistSetup('DRAFT');
  const okToasts = calls.toasts.filter((t) => t.kind !== 'error');
  equal(okToasts.length, 1, 'exactly one success toast');
  ok(/saved/i.test(okToasts[0].msg), `toast confirms the save, got: ${okToasts[0].msg}`);
  deepEqual(calls.navigations, [], 'DRAFT stays on the form');
});

test('WAITING success navigates exactly once', () => {
  const { api, calls } = makeSaver();
  api.setLastResult(READY_RESULT);
  api.persistSetup('WAITING');
  deepEqual(calls.navigations, ['/trade'], 'single navigation after a verified write');
});

// ---- 3. Failure paths: quota, and the guard reset that follows ----

test('a quota failure reports an error, shows no success, and preserves the analysis', async () => {
  const { api, calls } = makeSaver();
  api.setLastResult(READY_RESULT);
  await withQuotaFailure(async () => {
    equal(api.persistSetup('DRAFT'), false, 'failure is returned, not thrown');
  });
  ok(calls.toasts.some((t) => t.kind === 'error'), 'an error toast names the failure');
  ok(!calls.toasts.some((t) => t.kind !== 'error' && /saved/i.test(t.msg)), 'no success toast may appear');
  deepEqual(calls.navigations, [], 'no navigation on failure');
  const a = api.getAnalysis();
  equal(a.accountId, 'acc-A', 'captured form inputs survive the failure instead of being blanked');
  equal(a.pair, 'EUR/USD', 'pair survives for the retry');
  equal(a.entry, '1.1000', 'entry survives for the retry');
  equal(api.rows().length, 0, 'no half-written row');
});

test('the in-flight guard resets after failure: a retry succeeds', async () => {
  const { api, calls } = makeSaver();
  api.setLastResult(READY_RESULT);
  await withQuotaFailure(async () => { api.persistSetup('DRAFT'); });
  equal(api.persistSetup('DRAFT'), true, 'retry works — the guard did not stick');
  equal(api.rows().length, 1, 'exactly one row after retry');
  equal(calls.navigations.length, 0, 'DRAFT never navigates');
});

// ---- 4. READY path gates execution on persistence ----

test('READY failure never opens the execution modal', async () => {
  const { api, calls } = makeSaver();
  api.setLastResult(READY_RESULT);
  await withQuotaFailure(async () => {
    api.openEnterTradeModal();
  });
  equal(calls.modals.length, 0, 'no execution modal without a verified write');
  ok(calls.toasts.some((t) => t.kind === 'error'), 'the failure is reported');
});

test('READY success opens the modal once with the persisted record', () => {
  const { api, calls } = makeSaver();
  api.setLastResult(READY_RESULT);
  api.openEnterTradeModal();
  api.openEnterTradeModal();
  equal(calls.modals.length, 2, 'each explicit invocation opens once (no hidden double-fire)');
  equal(api.rows().length, 1, 'still a single setup row');
  deepEqual(calls.modals[0].saved.screenshotIds, [], 'record carries the evidence list shape');
  equal(calls.modals[0].saved.status, 'READY', 'record persisted as READY before the modal');
});

test('non-READY analysis never reaches persistence or the modal', () => {
  const { api, calls } = makeSaver();
  api.setLastResult({ ...READY_RESULT, decision: { ...READY_RESULT.decision, state: 'NO_TRADE' } });
  api.openEnterTradeModal();
  equal(calls.modals.length, 0, 'no modal for NO_TRADE');
  equal(api.rows().length, 0, 'no row written for a rejected analysis');
  ok(calls.toasts.some((t) => t.kind === 'error' && /READY/.test(t.msg)), 'rejection names the READY requirement');
});

// ---- 5. Non-vacuity: the old blind append is gone ----

test('NON-VACUITY: no blind-append save helper remains on the save path', () => {
  ok(!/function saveSetup\(user, setup\)/.test(SOURCE), 'the unconditional push helper is removed');
  ok(/upsertSetup\(user, record\)/.test(SOURCE), 'both save paths go through the idempotent helper');
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('setup-save-idempotent.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}