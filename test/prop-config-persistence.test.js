// PROP CONFIG PERSISTENCE REGRESSION TESTS
//
// The /prop editor's controls were dead for two independent reasons.
//
// 1. Event wiring: Save/Cancel/Close/Reset live in #modal-overlay, a sibling of
//    #app, so a listener on #app never saw their clicks. Covered by
//    prop-event-wiring.test.js.
//
// 2. API contract: prop.js probed propRules with WRONG ARGUMENT ORDER. The real
//    signatures are (accountId, ruleId, updates, user) for updatePropRule and
//    (accountId, user) for resetPropConfig/getPropConfig. Passing user first
//    neither threw nor failed loudly:
//      - updatePropRule('e2euser', 'acc-A', ...) looked for a rule literally
//        named "acc-A", returned { success: false }, and prop.js set
//        saved = true regardless, then showed "Prop rules saved".
//      - resetPropConfig('e2euser', 'acc-A') reset an account named after the
//        username and left the real account untouched.
//      - getPropConfig always returns an object, so the multi-signature probe
//        could never fall through to the correct order, making saved values
//        unreadable.
//
// These tests extract the real functions from src/js/pages/prop.js and run
// them against a recording stub of propRules, asserting on the exact arguments
// and on the returned success contract. Non-vacuity: each test states the
// user-first call that the fix replaced.
import { test, run, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(ROOT, 'src/js/pages/prop.js'), 'utf8');

function extractFunction(name) {
  const match = SOURCE.match(new RegExp(`(?:async\\s+)?function ${name}\\(`));
  if (!match) throw new Error(`could not find ${name} in prop.js`);
  const start = match.index;
  let depth = 0;
  let opened = false;
  for (let i = start; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === '{') { depth += 1; opened = true; }
    else if (ch === '}') {
      depth -= 1;
      if (opened && depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function extractConst(name) {
  const m = SOURCE.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`));
  if (!m) throw new Error(`could not find const ${name} in prop.js`);
  return m[1];
}

// Builds the adapter with injectable dependencies. rulesMod is a recording
// stub so every assertion is about the real call, not about a reimplementation.
function makeAdapter({ updateResult, resetResult, configResult } = {}) {
  const calls = { updates: [], resets: [], toasts: [], audits: 0, hidden: 0, refreshed: 0 };
  const form = {};
  const folders = [{ id: 'acc-A', name: 'Alpha', startingBalance: 10000 }];

  const rulesMod = {
    updatePropRule: (...args) => {
      calls.updates.push(args);
      return updateResult === undefined ? { success: true } : updateResult;
    },
    resetPropConfig: (...args) => {
      calls.resets.push(args);
      return resetResult === undefined ? { success: true } : resetResult;
    },
    getPropConfig: (...args) => {
      calls.gets = calls.gets || [];
      calls.gets.push(args);
      return configResult;
    },
  };

  // readEditForm resolves inputs through the `document` captured in this
  // factory's scope, so it has to be a swappable holder rather than the global.
  const doc = { getElementById: () => null };

  const factory = new Function(
    'rulesMod', 'getCurrentUser', 'getFolders', 'getSelectedAccountId', 'showToast',
    'auditPropConfigUpdated', 'hideModal', 'refreshProp', 'propCfgKey', 'readLocalConfig',
    'defaultLocalConfig', 'cleanUpdates', 'localStorage', 'document',
    `const PROP_RULE_BINDINGS = ${extractConst('PROP_RULE_BINDINGS')};
${extractFunction('canonicalRuleUpdate')}
${extractFunction('numOrUndef')}
${extractFunction('normalizeEngineConfig')}
${extractFunction('resolveConfig')}
${extractFunction('readEditForm')}
${extractFunction('saveConfig')}
${extractFunction('resetConfig')}
return { PROP_RULE_BINDINGS, canonicalRuleUpdate, normalizeEngineConfig, resolveConfig, saveConfig, resetConfig };`,
  );

  const api = factory(
    rulesMod,
    () => 'e2euser',
    () => folders,
    () => 'acc-A',
    (msg, kind) => calls.toasts.push({ msg, kind }),
    () => { calls.audits += 1; },
    () => { calls.hidden += 1; },
    () => { calls.refreshed += 1; },
    () => 'tradelog_propconfig_e2euser_acc-A',
    () => ({ config: {} }),
    () => ({}),
    (o) => o,
    { getItem: () => null, setItem() {}, removeItem() {} },
    doc,
  );

  return {
    api,
    calls,
    form,
    withInputs: (getElementById, fn) => {
      doc.getElementById = getElementById;
      return fn();
    },
  };
}

// Builds a document stub whose inputs match what the real modal always renders:
// one numeric field per rule plus an enabled checkbox per rule.
function domWith(values = {}, { allEnabled = true } = {}) {
  const nums = {
    'prop-profitTarget-target': values.profitTarget,
    'prop-dailyLoss-limit': values.dailyLoss,
    'prop-maxDrawdown-limit': values.maxDrawdown,
    'prop-tradingDays-required': values.tradingDays,
    'prop-consistency-limitPct': values.consistency,
  };
  const checks = [
    'prop-profitTarget-enabled', 'prop-dailyLoss-enabled', 'prop-maxDrawdown-enabled',
    'prop-tradingDays-enabled', 'prop-consistency-enabled',
  ];
  return {
    getElementById: (id) => {
      if (id in nums) {
        const v = nums[id];
        return v === undefined ? { value: '' } : { value: String(v) };
      }
      if (checks.includes(id)) {
        const v = values[id];
        return { checked: v === undefined ? allEnabled : v === true };
      }
      return null;
    },
  };
}

// ---- 1. Canonical id + field mapping ----

test('the UI rule keys map to canonical propRules ids', () => {
  const { api } = makeAdapter();
  deepEqual(
    api.PROP_RULE_BINDINGS.map((b) => [b.uiKey, b.ruleId]),
    [
      ['profitTarget', 'profit_target'],
      ['dailyLoss', 'daily_loss'],
      ['maxDrawdown', 'max_drawdown'],
      ['tradingDays', 'min_trading_days'],
      ['consistency', 'consistency'],
    ],
    'display names must resolve to the canonical ids propRules actually stores',
  );
});

test('canonicalRuleUpdate emits only canonical field names', () => {
  const { api } = makeAdapter();
  const binding = api.PROP_RULE_BINDINGS.find((b) => b.uiKey === 'profitTarget');
  deepEqual(
    api.canonicalRuleUpdate(binding, { target: 2500, warningPct: 60, criticalPct: 80, enabled: true }),
    { limit: 2500, warningThreshold: 60, criticalThreshold: 80, enabled: true },
    'UI field names must be translated to limit/warningThreshold/criticalThreshold',
  );
  const days = api.PROP_RULE_BINDINGS.find((b) => b.uiKey === 'tradingDays');
  deepEqual(
    api.canonicalRuleUpdate(days, { required: 12, enabled: true }),
    { limit: 12, enabled: true },
    'tradingDays.required maps to the canonical limit field',
  );
});

test('canonicalRuleUpdate drops blank fields so a partial edit cannot wipe a rule', () => {
  const { api } = makeAdapter();
  const binding = api.PROP_RULE_BINDINGS.find((b) => b.uiKey === 'dailyLoss');
  deepEqual(
    api.canonicalRuleUpdate(binding, { limit: undefined, warningPct: undefined, enabled: false }),
    { enabled: false },
    'blank numeric fields must be omitted rather than written as NaN',
  );
});

// ---- 2. Save: argument order and success handling ----

test('saveConfig calls updatePropRule(accountId, ruleId, updates, user)', async () => {
  const adapter = makeAdapter();
  const { api, calls } = adapter;
  await adapter.withInputs(domWith({ profitTarget: 2500 }).getElementById, () => api.saveConfig());
  const profit = calls.updates.find((c) => c[1] === 'profit_target');
  ok(profit, 'the profit_target rule was written');
  equal(profit[0], 'acc-A', 'first argument is the accountId, not the user');
  equal(profit[1], 'profit_target', 'second argument is the canonical rule id');
  deepEqual(profit[2], { limit: 2500, enabled: true }, 'third argument is the canonical payload');
  equal(profit[3], 'e2euser', 'fourth argument is the user');
  for (const call of calls.updates) {
    ok(call[0] === 'acc-A', `no call may pass user in the accountId slot, got ${call[0]}`);
    ok(call[3] === 'e2euser', `every call must pass the user last, got ${call[3]}`);
  }
});

test('saveConfig surfaces an engine failure instead of reporting success', async () => {
  const adapter = makeAdapter({
    updateResult: { success: false, error: 'Rule not found: "acc-A"' },
  });
  const { api, calls } = adapter;
  await adapter.withInputs(domWith({ profitTarget: 2500 }).getElementById, () => api.saveConfig());
  equal(calls.hidden, 0, 'modal must stay open when persistence failed');
  equal(calls.toasts.length, 1, 'the failure is reported');
  ok(calls.toasts[0].kind === 'error', 'the toast is an error, not a success');
  ok(!/saved/i.test(calls.toasts[0].msg), `must not claim success, got: ${calls.toasts[0].msg}`);
});

test('saveConfig writes every rule the form owns, then dismisses and audits once', async () => {
  const adapter = makeAdapter();
  const { api, calls } = adapter;
  await adapter.withInputs(domWith({ profitTarget: 2500, maxDrawdown: 3333 }).getElementById, () => api.saveConfig());
  const byRule = Object.fromEntries(calls.updates.map((c) => [c[1], c[2]]));
  equal(byRule.profit_target.limit, 2500, 'profit target persisted');
  equal(byRule.max_drawdown.limit, 3333, 'max drawdown persisted');
  equal(byRule.daily_loss.limit, undefined, 'an untouched rule keeps its stored limit');
  equal(calls.hidden, 1, 'modal dismissed once');
  equal(calls.audits, 1, 'audit entry written once');
  equal(calls.toasts.length, 1, 'a single success toast');
  ok(/saved/i.test(calls.toasts[0].msg), `expected a saved toast, got: ${calls.toasts[0].msg}`);
});

// ---- 3. Reset: argument order ----

test('resetConfig calls resetPropConfig(accountId, user)', async () => {
  const { api, calls } = makeAdapter();
  await api.resetConfig();
  equal(calls.resets.length, 1, 'reset ran once');
  deepEqual(calls.resets[0], ['acc-A', 'e2euser'], 'accountId first, user second');
  ok(!calls.resets[0].includes('e2euser') || calls.resets[0][0] === 'acc-A',
    'the username must never be passed in the accountId slot');
});

test('resetConfig surfaces an engine failure instead of reporting success', async () => {
  const { api, calls } = makeAdapter({ resetResult: { success: false, error: 'nope' } });
  await api.resetConfig();
  equal(calls.toasts.length, 1, 'the failure is reported');
  ok(calls.toasts[0].kind === 'error', 'error toast');
  equal(calls.audits, 0, 'no audit for a failed reset');
});

// ---- 4. Read path ----

test('resolveConfig calls getPropConfig(accountId, user)', () => {
  const { api, calls } = makeAdapter({
    configResult: { accountId: 'acc-A', startingBalance: 10000, rules: [{ id: 'profit_target', limit: 2500 }] },
  });
  const res = api.resolveConfig('e2euser', { id: 'acc-A', startingBalance: 10000 });
  deepEqual(calls.gets[0], ['acc-A', 'e2euser'], 'accountId first, user second');
  equal(res.config.profitTarget.target, 2500, 'the stored value is read back');
});

test('normalizeEngineConfig indexes the canonical rules array', () => {
  const { api } = makeAdapter();
  const cfg = api.normalizeEngineConfig({
    accountId: 'acc-A',
    startingBalance: 20000,
    rules: [
      { id: 'profit_target', limit: 2500, warningThreshold: 55, criticalThreshold: 85, enabled: true },
      { id: 'min_trading_days', limit: 12, enabled: false },
      { id: 'consistency', limit: 42, enabled: true },
    ],
  });
  equal(cfg.profitTarget.target, 2500, 'profit_target limit read as target');
  equal(cfg.profitTarget.warningPct, 55, 'warningThreshold read as warningPct');
  equal(cfg.profitTarget.criticalPct, 85, 'criticalThreshold read as criticalPct');
  equal(cfg.tradingDays.required, 12, 'min_trading_days limit read as required');
  equal(cfg.consistency.limitPct, 42, 'consistency limit read as limitPct');
});

// ---- 5. Non-vacuity ----

test('NON-VACUITY: the old user-first probes are gone from prop.js', () => {
  ok(
    !/updateFn\(user,/.test(SOURCE) && !/resetFn\(user,/.test(SOURCE) && !/getFn\(user,/.test(SOURCE),
    'no propRules call may pass user in the accountId position',
  );
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('prop-config-persistence.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}