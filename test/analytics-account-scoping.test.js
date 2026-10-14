// ANALYTICS ACCOUNT-SCOPING REGRESSION TESTS (process + improvements)
//
// strategyAnalytics.js shipped with getTradeDataset(user, {...}) — the username
// in the positional accountId slot — so the engine demanded
// trade.accountId === <username> and every page showed an empty dataset.
// processAnalytics.js and improvements.js carried the identical call shape.
// Each page is verified INDEPENDENTLY here because their dataset semantics
// differ: process metrics count reviewed+scored rows, while improvements needs
// at least five completed reviews before any pattern emerges.
//
// Fixtures reuse the shared deterministic seed (2 accounts, 3 closed acc-1
// trades, 2 completed reviews) extended in-test to reach the 5-review gate.
import { test, run, ok, equal, deepEqual, seedDeterministic, SEED_USER } from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const PROCESS_SOURCE = readFileSync(path.join(SRC, 'js/pages/processAnalytics.js'), 'utf8');
const IMPROVE_SOURCE = readFileSync(path.join(SRC, 'js/pages/improvements.js'), 'utf8');

function extractFunction(source, name) {
  const match = source.match(new RegExp(`(?:async\\s+)?function ${name}\\(`));
  if (!match) throw new Error(`could not find ${name}`);
  let depth = 0;
  let opened = false;
  for (let i = match.index; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') { depth += 1; opened = true; }
    else if (ch === '}') {
      depth -= 1;
      if (opened && depth === 0) return source.slice(match.index, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// The page helpers are module-private; they are evaluated out of the real
// page source with the real folder store, so the mapping under test is
// verbatim, not a reimplementation.
function makePageAccountHelpers(source, { initialAccount = 'ALL' } = {}) {
  const factory = new Function(
    'getFolders',
    'box',
    `const filters = {
      get account() { return box.filters.account; },
      set account(v) { box.filters.account = v; },
    };
${extractFunction(source, 'accountOptions')}
${extractFunction(source, 'resolvedAccountId')}
return {
  accountOptions: (user) => accountOptions(user),
  resolvedAccountId: (user) => resolvedAccountId(user),
  getFilters: () => box.filters,
};`,
  );
  const box = { filters: { account: initialAccount } };
  return factory(
    (user) => JSON.parse(localStorage.getItem(`tradelog_folders_${String(user).toLowerCase()}`) || '[]'),
    box,
  );
}

// Extends the shared seed to five closed trades each carrying a completed
// review with a repeated mistake, which is what the improvements gate
// requires. Reviews join first-wins per trade, so extra reviews on the same
// trade would never reach the gate.
function seedWithFiveReviews() {
  const { user } = seedDeterministic(SEED_USER);
  const tkey = `tradelog_exectrades_${user}`;
  const trades = JSON.parse(localStorage.getItem(tkey));
  const mkTrade = (id, pnl) => ({
    id, userId: user, accountId: 'acc-1', pair: 'EUR/USD', direction: 'LONG',
    strategyId: 'strat-a', session: 'London', timeframe: 'H1', setupType: 'breakout',
    lotSize: 1, entryPrice: 1.1, exitPrice: 1.12, stopLoss: 1.09, takeProfit: 1.1,
    riskAmount: 100, riskPercent: 1, pnl, rMultiple: pnl / 100, status: 'CLOSED',
    openedAt: '2024-01-04T10:00:00.000Z', closedAt: '2024-01-04T15:00:00.000Z',
    createdAt: '2024-01-04T10:00:00.000Z', updatedAt: '2024-01-04T15:00:00.000Z',
  });
  trades.push(mkTrade('t-4', 120), mkTrade('t-5', -60));
  localStorage.setItem(tkey, JSON.stringify(trades));
  const key = `tradelog_reviews_${user}`;
  const reviews = JSON.parse(localStorage.getItem(key));
  const mk = (i, tradeId, total) => ({
    id: `r-x${i}`, userId: user, tradeId, accountId: 'acc-1', status: 'COMPLETED',
    answers: { preTrade: {}, execution: {}, management: {} },
    ruleViolations: ['rule-1'], mistakes: ['late-entry'], strengths: ['patience'],
    followedPlan: false, confidence: 2,
    processScore: {
      preTradeScore: 10, executionScore: 10, managementScore: 10,
      disciplineScore: 10, total, grade: 'F',
    },
    total, createdAt: '2024-01-05T12:00:00.000Z', updatedAt: '2024-01-05T12:00:00.000Z',
  });
  reviews.push(mk(3, 't-3', 45), mk(4, 't-4', 50), mk(5, 't-5', 55));
  localStorage.setItem(key, JSON.stringify(reviews));
  return user;
}

async function engine() {
  return import(pathToFileURL(path.join(SRC, 'js/utils/tradingAnalytics.js')).href);
}

// ---- 1. The defect, reproduced per page ----

test('processAnalytics: the old username-first call yields an empty dataset', async () => {
  seedDeterministic(SEED_USER);
  const { getTradeDataset, getProcessStats } = await engine();
  const dataset = getTradeDataset(SEED_USER, { accountId: '', user: SEED_USER });
  equal(dataset.length, 0, 'username in the account slot excludes every canonical trade');
  equal(getProcessStats(dataset).sampleSize, 0, 'so the page would show N/A everywhere');
});

test('improvements: the old username-first call starves the pattern gate', async () => {
  seedWithFiveReviews();
  const { getTradeDataset } = await engine();
  const mod = await import(pathToFileURL(path.join(SRC, 'js/utils/improvementEngine.js')).href);
  const dataset = getTradeDataset(SEED_USER, { user: SEED_USER });
  const reviews = dataset.map((r) => r.review).filter(Boolean);
  deepEqual(mod.getImprovementPatterns({ reviews }), [], 'fewer than five reviews can never produce a pattern');
});

test('neither page still calls the dataset that way', () => {
  for (const [name, src] of [['processAnalytics.js', PROCESS_SOURCE], ['improvements.js', IMPROVE_SOURCE]]) {
    const calls = [...src.matchAll(/getTradeDataset\(\s*([A-Za-z_][\w.]*)/g)].map((m) => m[1]);
    equal(calls.length, 1, `${name} has exactly one dataset call site`);
    equal(calls[0], 'accountId', `${name} must pass the resolved account, got: ${calls[0]}`);
    ok(!/getTradeDataset\(\s*user\s*,/.test(src), `${name} must never pass the username positionally`);
  }
});

// ---- 2. Account enumeration per page ----

test('both pages enumerate folders as stable-id options', () => {
  seedDeterministic(SEED_USER);
  for (const [name, src] of [['processAnalytics.js', PROCESS_SOURCE], ['improvements.js', IMPROVE_SOURCE]]) {
    const page = makePageAccountHelpers(src);
    deepEqual(
      page.accountOptions(SEED_USER),
      [
        { value: 'acc-1', label: 'Contract Acc One' },
        { value: 'acc-2', label: 'Contract Acc Two' },
      ],
      `${name} offers every folder exactly once`,
    );
    ok(/getFolders/.test(src), `${name} imports the canonical folder store`);
    ok(/accounts: accountOptions\(user\)/.test(src), `${name} passes the enumeration to the filter bar`);
  }
});

test('both pages fall back to ALL on a deleted selection instead of zeroing', () => {
  seedDeterministic(SEED_USER);
  for (const [name, src] of [['processAnalytics.js', PROCESS_SOURCE], ['improvements.js', IMPROVE_SOURCE]]) {
    const page = makePageAccountHelpers(src, { initialAccount: 'acc-gone' });
    equal(page.resolvedAccountId(SEED_USER), '', `${name}: stale selection resolves to all-accounts`);
    equal(page.getFilters().account, 'ALL', `${name}: the filter aligns so dropdown and dataset agree`);
  }
});

// ---- 3. Corrected dataset semantics per page ----

test('process page: reviewed subset is counted once scoping is correct', async () => {
  seedDeterministic(SEED_USER);
  const { getTradeDataset, getProcessStats } = await engine();
  const dataset = getTradeDataset('', { user: SEED_USER });
  equal(dataset.length, 3, 'all three closed trades load');
  equal(getProcessStats(dataset).sampleSize, 2, 'the two completed reviews are the scored sample');
  const scoped = getTradeDataset('acc-2', { user: SEED_USER });
  equal(scoped.length, 0, 'acc-2 holds no trades — an honest zero, not a scoping failure');
});

test('improvements page: five completed reviews clear the pattern gate', async () => {
  const user = seedWithFiveReviews();
  const { getTradeDataset } = await engine();
  const mod = await import(pathToFileURL(path.join(SRC, 'js/utils/improvementEngine.js')).href);
  const dataset = getTradeDataset('', { user });
  const reviews = dataset.map((r) => r.review).filter(Boolean);
  equal(reviews.length, 5, 'five completed reviews join the dataset');
  ok(mod.getImprovementPatterns({ reviews }).length > 0, 'the repeated mistake now surfaces as a pattern');
});

test('per-account scoping holds for the improvements chain too', async () => {
  const user = seedWithFiveReviews();
  const { getTradeDataset } = await engine();
  const scoped = getTradeDataset('acc-2', { user });
  equal(scoped.length, 0, 'an account with no trades yields an empty slice, not other accounts’ rows');
});

// ---- 4. Empty data and simulated exclusion ----

test('empty stores stay empty and honest on both dataset shapes', async () => {
  seedDeterministic(SEED_USER);
  localStorage.setItem(`tradelog_exectrades_${SEED_USER}`, '[]');
  const { getTradeDataset, getProcessStats } = await engine();
  equal(getTradeDataset('', { user: SEED_USER }).length, 0, 'N is zero, not fabricated');
  equal(getProcessStats([]).sampleSize, 0, 'no phantom scored sample');
});

test('simulated and open rows never enter either page’s dataset', async () => {
  seedDeterministic(SEED_USER);
  const { getTradeDataset } = await engine();
  const dataset = getTradeDataset('', {
    user: SEED_USER,
    trades: [
      { id: 'sim-1', accountId: 'acc-1', strategyId: 's', status: 'SIMULATED', pnl: 999, closedAt: '2024-01-02T15:00:00.000Z' },
      { id: 't-open', accountId: 'acc-1', strategyId: 's', status: 'OPEN', pnl: 0, openedAt: '2024-01-02T10:00:00.000Z' },
    ],
  });
  equal(dataset.length, 0, 'injected sim/open rows are rejected by the real predicates');
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('analytics-account-scoping.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}