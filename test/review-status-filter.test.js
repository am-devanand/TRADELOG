// REVIEW-STATUS FILTER REGRESSION TESTS
//
// filterTrades resolved review status per trade, but getTradeDataset called it
// on raw trades BEFORE joining reviews, so every canonical trade resolved flag
// null and `if (flag === null) return true` passed everything through:
// REVIEWED and UNREVIEWED behaved exactly like ALL on all three analytics
// pages. The dataset builder now passes the ids from its COMPLETED-review
// join as reviewedTradeIds, so the three states are distinct and correct.
//
// Qualifying review = status COMPLETED attached to the trade id. Draft,
// incomplete, or otherwise non-qualifying reviews never count, and multiple
// reviews for one trade never duplicate its row (first-wins join).
import { test, run, ok, equal, deepEqual, seedDeterministic, SEED_USER } from './helpers.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

async function engine() {
  return import(pathToFileURL(path.join(SRC, 'js/utils/tradingAnalytics.js')).href);
}

// seedDeterministic gives 3 closed acc-1 trades (t-1, t-2, t-3) with COMPLETED
// reviews on t-1 and t-2 only; t-3 is closed but unreviewed.
function ids(rows) {
  return rows.map((r) => (r.trade || r).id).sort();
}

// ---- 1. The three states are distinct and correct ----

test('ALL includes reviewed and unreviewed trades', async () => {
  seedDeterministic(SEED_USER);
  const { getTradeDataset } = await engine();
  deepEqual(ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'ALL' })), ['t-1', 't-2', 't-3'], 'all three closed rows');
});

test('REVIEWED includes only trades with qualifying completed reviews', async () => {
  seedDeterministic(SEED_USER);
  const { getTradeDataset } = await engine();
  deepEqual(ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'REVIEWED' })), ['t-1', 't-2'], 't-3 has no review and is excluded');
});

test('UNREVIEWED excludes reviewed trades', async () => {
  seedDeterministic(SEED_USER);
  const { getTradeDataset } = await engine();
  deepEqual(ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'UNREVIEWED' })), ['t-3'], 'only the review-less row survives');
});

// ---- 2. Lifecycle: only qualifying reviews count ----

test('a draft review does not qualify its trade as reviewed', async () => {
  seedDeterministic(SEED_USER);
  const key = `tradelog_reviews_${SEED_USER}`;
  const reviews = JSON.parse(localStorage.getItem(key));
  reviews.push({
    id: 'r-draft', userId: SEED_USER, tradeId: 't-3', accountId: 'acc-1', status: 'DRAFT',
    answers: {}, ruleViolations: [], mistakes: [], strengths: [], followedPlan: true, confidence: 3,
    processScore: { preTradeScore: 10, executionScore: 10, managementScore: 10, disciplineScore: 10, total: 40, grade: 'F' },
    total: 40, createdAt: '2024-01-05T12:00:00.000Z', updatedAt: '2024-01-05T12:00:00.000Z',
  });
  localStorage.setItem(key, JSON.stringify(reviews));
  const { getTradeDataset } = await engine();
  deepEqual(ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'REVIEWED' })), ['t-1', 't-2'], 'draft review changes nothing');
  deepEqual(ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'UNREVIEWED' })), ['t-3'], 't-3 still counts as unreviewed');
});

test('multiple reviews for one trade join once and never duplicate its row', async () => {
  seedDeterministic(SEED_USER);
  const key = `tradelog_reviews_${SEED_USER}`;
  const reviews = JSON.parse(localStorage.getItem(key));
  reviews.push({ ...reviews[0], id: 'r-1b' });
  localStorage.setItem(key, JSON.stringify(reviews));
  const { getTradeDataset } = await engine();
  const rows = getTradeDataset('', { user: SEED_USER, reviewStatus: 'REVIEWED' });
  deepEqual(ids(rows), ['t-1', 't-2'], 't-1 appears once despite two reviews');
  equal(rows.filter((r) => (r.trade || r).id === 't-1').length, 1, 'no duplication');
});

// ---- 3. Composition with the other filters ----

test('account scoping stays correct with reviewed and unreviewed rows in play', async () => {
  seedDeterministic(SEED_USER);
  const { getTradeDataset } = await engine();
  deepEqual(ids(getTradeDataset('acc-1', { user: SEED_USER, reviewStatus: 'REVIEWED' })), ['t-1', 't-2'], 'acc-1 reviewed slice');
  deepEqual(ids(getTradeDataset('acc-2', { user: SEED_USER, reviewStatus: 'REVIEWED' })), [], 'acc-2 holds no trades — honest zero');
  deepEqual(ids(getTradeDataset('acc-1', { user: SEED_USER, reviewStatus: 'UNREVIEWED' })), ['t-3'], 'acc-1 unreviewed slice');
});

test('date and strategy filters compose with review status', async () => {
  seedDeterministic(SEED_USER);
  const { getTradeDataset } = await engine();
  deepEqual(
    ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'REVIEWED', dateFrom: '2024-01-02', dateTo: '2024-01-03' })),
    ['t-1', 't-2'],
    'date window keeps both reviewed rows',
  );
  deepEqual(
    ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'REVIEWED', dateFrom: '2024-02-01', dateTo: '2024-02-28' })),
    [],
    'date window outside all closes empties even REVIEWED',
  );
  deepEqual(
    ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'ALL', strategies: ['strat-a'] })),
    ['t-1', 't-2'],
    'strategy filter still composes (t-3 carries strat-b)',
  );
});

// ---- 4. Empty and failure states ----

test('empty review data behaves honestly per state', async () => {
  seedDeterministic(SEED_USER);
  localStorage.setItem(`tradelog_reviews_${SEED_USER}`, '[]');
  const { getTradeDataset } = await engine();
  deepEqual(ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'ALL' })), ['t-1', 't-2', 't-3'], 'ALL unaffected by absent reviews');
  deepEqual(ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'REVIEWED' })), [], 'REVIEWED is empty, matching the pages’ empty states');
  deepEqual(ids(getTradeDataset('', { user: SEED_USER, reviewStatus: 'UNREVIEWED' })), ['t-1', 't-2', 't-3'], 'UNREVIEWED holds every row');
});

test('a complete review join never invents reviewed flags for other users’ trades', async () => {
  seedDeterministic(SEED_USER);
  const { getTradeDataset } = await engine();
  const rows = getTradeDataset('', { user: SEED_USER, reviewStatus: 'REVIEWED' });
  ok(rows.every((r) => (r.trade || r).userId === SEED_USER), 'no cross-user leakage through the join');
});

// ---- 5. Non-vacuity ----

test('NON-VACUITY: without the joined ids the states collapse back to ALL', async () => {
  seedDeterministic(SEED_USER);
  const { filterTrades } = await engine();
  const { getClosedTrades } = await import(
    pathToFileURL(path.join(SRC, 'js/utils/executedTrades.js')).href
  );
  const trades = getClosedTrades(SEED_USER);
  const reviewed = filterTrades(trades, { reviewStatus: 'REVIEWED' });
  const unreviewed = filterTrades(trades, { reviewStatus: 'UNREVIEWED' });
  equal(reviewed.length, trades.length, 'raw trades without joined ids all pass REVIEWED');
  equal(unreviewed.length, trades.length, '...and all pass UNREVIEWED — the reported bug, reproduced');
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('review-status-filter.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}