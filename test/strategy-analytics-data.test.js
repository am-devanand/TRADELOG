// STRATEGY ANALYTICS DATA-CORRECTNESS REGRESSION TESTS
//
// /analytics/strategies showed N = 0 for valid closed trades and its account
// dropdown listed only ALL. Two independent causes, both in the page layer:
//
//   1. The page called getTradeDataset(user, {...}) — passing the USERNAME into
//      the positional accountId slot. The engine therefore demanded
//      trade.accountId === <username>, which no canonical trade satisfies.
//   2. Neither the filter component nor the page ever enumerated folders, so
//      the account dropdown was structurally capped at ALL plus the current
//      selection.
//
// The seeded fixtures here were deliberately checked against normalizeTrade:
// every field a real buildNewTrade record carries that these lack is backfilled
// by the loader and tested by no rejection predicate, so the fixture is valid
// and the loader's scoping was wrong — not the data.
//
// N, as documented on the page, counts closed, eligible real trades in the
// currently filtered strategy dataset. Open and simulated trades are never
// included.
import { test, run, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const PAGE_SOURCE = readFileSync(path.join(SRC, 'js/pages/strategyAnalytics.js'), 'utf8');

const USER = 'analyst';

function seed() {
  const u = USER;
  const folders = (id, name, start) => ({
    id, name, type: 'LIVE', startingBalance: start, currentBalance: start,
    createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
  });
  const trade = (over = {}) => ({
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    userId: u,
    accountId: 'acc-A',
    pair: 'EUR/USD',
    direction: 'LONG',
    strategyId: 'strat_x',
    session: 'London',
    timeframe: 'H1',
    setupType: 'breakout',
    lotSize: 1,
    entryPrice: 1.1,
    exitPrice: 1.12,
    stopLoss: 1.09,
    takeProfit: 1.14,
    riskAmount: 100,
    riskPercent: 1,
    pnl: 200,
    rMultiple: 2,
    status: 'CLOSED',
    openedAt: '2024-01-02T10:00:00.000Z',
    closedAt: '2024-01-02T15:00:00.000Z',
    createdAt: '2024-01-02T10:00:00.000Z',
    ...over,
  });
  localStorage.setItem(
    `tradelog_folders_${u}`,
    JSON.stringify([folders('acc-A', 'Alpha', 10000), folders('acc-B', 'Beta', 5000)]),
  );
  localStorage.setItem(
    `tradelog_exectrades_${u}`,
    JSON.stringify([
      trade({ id: 't-a1', strategyId: 'strat_x', pnl: 200 }),
      trade({ id: 't-a2', accountId: 'acc-B', strategyId: 'strat_x', pnl: -100 }),
      trade({ id: 't-a3', strategyId: 'Legacy Name', pnl: 50 }),
      trade({ id: 't-a4', strategyId: '', strategy: '', pnl: 10 }),
      trade({ id: 't-a5', strategyId: 'strat_x', status: 'OPEN', pnl: 0 }),
    ]),
  );
  localStorage.setItem('tradelog_session', u);
}

// ---- helpers extracted from the real modules under test ----

async function engine() {
  return import(pathToFileURL(path.join(SRC, 'js/utils/tradingAnalytics.js')).href);
}

async function executed() {
  return import(pathToFileURL(path.join(SRC, 'js/utils/executedTrades.js')).href);
}

// The page's account helpers are module-private, so they are evaluated out of
// the real source with the store injected — the mapping logic under test is
// verbatim, not a reimplementation.
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

function makePageAccountHelpers({ folders, initialAccount = 'ALL' } = {}) {
  const factory = new Function(
    'getFolders',
    'box',
    `const filters = {
      get account() { return box.filters.account; },
      set account(v) { box.filters.account = v; },
    };
${extractFunction(PAGE_SOURCE, 'accountOptions')}
${extractFunction(PAGE_SOURCE, 'resolvedAccountId')}
return {
  accountOptions: (user) => accountOptions(user),
  resolvedAccountId: (user) => resolvedAccountId(user),
  getFilters: () => box.filters,
};`,
  );
  const box = { filters: { account: initialAccount } };
  return factory(
    () => folders,
    box,
  );
}

// ---- 1. Canonical records reach the strategies page ----

test('closed canonical trades with strategy ids appear with no account selected', async () => {
  seed();
  const { getTradeDataset, getAllStrategyStats } = await engine();
  const dataset = getTradeDataset('', { user: USER });
  equal(dataset.length, 4, 'N counts the four CLOSED rows; the OPEN one is excluded');
  const keys = getAllStrategyStats(dataset).map((g) => g.key).sort();
  deepEqual(keys, ['Legacy Name', 'Unspecified', 'strat_x'], 'ids group by id, legacy by name, blank as Unspecified');
});

test('legacy string-only records keep their own group and never merge into a linked one', async () => {
  seed();
  const { getTradeDataset, getAllStrategyStats } = await engine();
  const dataset = getTradeDataset('', { user: USER });
  const byKey = Object.fromEntries(getAllStrategyStats(dataset).map((g) => [g.key, g.trades]));
  equal(byKey.strat_x, 2, 'the two linked trades group together');
  equal(byKey['Legacy Name'], 1, 'the legacy record is its own group');
});

// ---- 2. Non-vacuity: the username-as-account bug yields N = 0 ----

test('NON-VACUITY: passing the username positionally excludes every real trade', async () => {
  seed();
  const { getTradeDataset } = await engine();
  const dataset = getTradeDataset(USER, { accountId: '', user: USER });
  equal(dataset.length, 0, 'the old call shape must produce the reported N = 0');
});

test('the strategies page no longer calls the dataset that way', () => {
  const calls = [...PAGE_SOURCE.matchAll(/getTradeDataset\(\s*([A-Za-z_][\w.]*)/g)].map((m) => m[1]);
  equal(calls.length, 2, 'exactly two dataset call sites, list and detail');
  ok(calls.every((c) => c === 'accountId'), `both must pass the resolved account, got: ${calls.join(', ')}`);
  ok(!/getTradeDataset\(\s*user\s*,/.test(PAGE_SOURCE), 'the username must never sit in the account slot');
});

// ---- 3. Account enumeration and filtering ----

test('account options enumerate every folder with stable ids and readable names', () => {
  seed();
  const page = makePageAccountHelpers({
    folders: JSON.parse(localStorage.getItem(`tradelog_folders_${USER}`)),
  });
  deepEqual(
    page.accountOptions(USER),
    [
      { value: 'acc-A', label: 'Alpha' },
      { value: 'acc-B', label: 'Beta' },
    ],
    'every folder is offered exactly once',
  );
});

test('per-account filtering returns only that account, ALL aggregates both', async () => {
  seed();
  const { getTradeDataset } = await engine();
  const a = getTradeDataset('acc-A', { user: USER });
  const b = getTradeDataset('acc-B', { user: USER });
  const all = getTradeDataset('', { user: USER });
  equal(a.length, 3, 'acc-A holds three closed rows');
  ok(a.every((r) => r.trade.accountId === 'acc-A'), 'no cross-account leakage');
  equal(b.length, 1, 'acc-B holds one closed row');
  equal(all.length, 4, 'ALL aggregates across applicable accounts');
});

test('a deleted or unknown selection falls back to ALL instead of zeroing the page', () => {
  seed();
  const page = makePageAccountHelpers({
    folders: JSON.parse(localStorage.getItem(`tradelog_folders_${USER}`)),
    initialAccount: 'acc-gone',
  });
  equal(page.resolvedAccountId(USER), '', 'stale selection resolves to the empty all-accounts value');
  equal(page.getFilters().account, 'ALL', 'and the filter aligns so the dropdown agrees');
});

test('the shared filter bar renders enumerated accounts and keeps unknown current values', async () => {
  const { renderAnalyticsFilters, clearFilters } = await import(
    pathToFileURL(path.join(SRC, 'js/components/analyticsFilters.js')).href
  );
  const html = renderAnalyticsFilters(
    { ...clearFilters(), account: 'ALL' },
    { accounts: [{ value: 'acc-A', label: 'Alpha' }, { value: 'acc-B', label: 'Beta' }] },
  );
  ok(html.includes('value="acc-A"') && html.includes('>Alpha<'), 'Alpha is offered');
  ok(html.includes('value="acc-B"') && html.includes('>Beta<'), 'Beta is offered');
  ok(html.includes('value="ALL"'), 'the ALL option is preserved');
  const stale = renderAnalyticsFilters(
    { ...clearFilters(), account: 'acc-gone' },
    { accounts: [{ value: 'acc-A', label: 'Alpha' }] },
  );
  ok(stale.includes('value="acc-gone"'), 'a stale selection is kept visible, not silently swapped');
  const untouched = renderAnalyticsFilters({ ...clearFilters(), account: 'ALL' }, {});
  ok(!untouched.includes('value="acc-A"'), 'pages that do not enumerate keep the old behaviour exactly');
});

// ---- 4. Filter composition ----

test('strategy and account filters compose', async () => {
  seed();
  const { getTradeDataset, getAllStrategyStats } = await engine();
  const dataset = getTradeDataset('acc-A', { user: USER, strategies: ['strat_x'] });
  equal(dataset.length, 1, 'only the acc-A strat_x row survives both filters');
  deepEqual(getAllStrategyStats(dataset).map((g) => g.key), ['strat_x'], 'grouping follows the filtered rows');
});

test('a date range keeps only trades whose close day falls inside it', async () => {
  seed();
  const { getTradeDataset } = await engine();
  const inside = getTradeDataset('', { user: USER, dateFrom: '2024-01-02', dateTo: '2024-01-02' });
  equal(inside.length, 4, 'all seeded closes fall on the same day');
  const outside = getTradeDataset('', { user: USER, dateFrom: '2024-02-01', dateTo: '2024-02-28' });
  equal(outside.length, 0, 'nothing closes in February');
});

// ---- 5. Empty, insufficient, and excluded data ----

test('an empty store yields an empty dataset and empty statistics, honestly', async () => {
  localStorage.setItem(`tradelog_exectrades_${USER}`, '[]');
  localStorage.setItem('tradelog_session', USER);
  const { getTradeDataset, getAllStrategyStats } = await engine();
  equal(getTradeDataset('', { user: USER }).length, 0, 'N is zero, not fabricated');
  deepEqual(getAllStrategyStats([]), [], 'no phantom groups appear');
});

test('insufficient samples are flagged but still counted', async () => {
  seed();
  const { getTradeDataset, getAllStrategyStats } = await engine();
  const dataset = getTradeDataset('acc-B', { user: USER });
  const [only] = getAllStrategyStats(dataset);
  equal(only.trades, 1, 'N stays 1 — the sample-size flag must not zero it');
  equal(only.smallSample, true, 'and it is flagged as a small sample');
});

test('simulated and open trades are never counted', async () => {
  seed();
  const { getTradeDataset } = await engine();
  const dataset = getTradeDataset('', {
    user: USER,
    trades: [
      { id: 'sim-1', accountId: 'acc-A', strategyId: 'strat_x', status: 'SIMULATED', pnl: 999, closedAt: '2024-01-02T15:00:00.000Z' },
      { id: 't-open', accountId: 'acc-A', strategyId: 'strat_x', status: 'OPEN', pnl: 0, openedAt: '2024-01-02T10:00:00.000Z' },
    ],
  });
  equal(dataset.length, 0, 'neither a sim row nor an open row survives, even when injected directly');
});

// ---- 6. N meaning ----

test('N equals the number of eligible CLOSED real rows after all filters', async () => {
  seed();
  const { getTradeDataset, getCoreMetrics } = await engine();
  const dataset = getTradeDataset('acc-A', { user: USER });
  const core = getCoreMetrics(dataset);
  equal(dataset.length, core.totalTrades, 'the rendered N and the metrics agree');
  equal(core.totalTrades, 3, 'three closed acc-A rows');
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('strategy-analytics-data.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}