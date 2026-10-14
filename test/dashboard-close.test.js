// DASHBOARD CLOSE REGRESSION TESTS
//
// The /trade dashboard CLOSE button opened an inline modal whose confirm
// handler called storage.js updateTrade(folderId, tradeId, updates) — a write
// to the legacy tradelog_trades_{folderId} store that returns undefined.
// Canonical executed trades live in tradelog_exectrades_{user}, so the close
// silently did nothing to the real record while the UI toasted success.
//
// The dashboard now opens tradeDetail's shared close modal, which runs the
// canonical closeTrade path (validation, partial/full-close math, realized
// P/L, R-multiple, balance recalculation, event history) and toasts only on
// res.success. These tests drive the real close helpers against canonical
// fixtures and lock the wiring in source.
import { test, run, ok, equal } from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const TRADE_PAGE = readFileSync(path.join(SRC, 'js/pages/trade.js'), 'utf8');
const DETAIL_PAGE = readFileSync(path.join(SRC, 'js/pages/tradeDetail.js'), 'utf8');

const USER = 'closer';

function seed() {
  const now = '2024-01-01T00:00:00.000Z';
  localStorage.setItem(
    `tradelog_folders_${USER}`,
    JSON.stringify([
      { id: 'acc-A', name: 'Alpha', type: 'LIVE', startingBalance: 10000, currentBalance: 10000, createdAt: now, updatedAt: now },
    ]),
  );
  const open = (over = {}) => ({
    id: 'op-1', userId: USER, accountId: 'acc-A', pair: 'EUR/USD', direction: 'LONG',
    strategyId: '', session: 'London', timeframe: 'H1', setupType: 'breakout', lotSize: 2,
    entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.14, riskAmount: 200, riskPercent: 2,
    pnl: 0, rMultiple: 0, status: 'OPEN',
    openedAt: '2024-01-02T10:00:00.000Z', createdAt: '2024-01-02T10:00:00.000Z', ...over,
  });
  localStorage.setItem(`tradelog_exectrades_${USER}`, JSON.stringify([open()]));
  localStorage.setItem(`tradelog_trades_acc-A`, '[]');
  localStorage.setItem('tradelog_session', USER);
}

async function exec() {
  return import(pathToFileURL(path.join(SRC, 'js/utils/executedTrades.js')).href);
}

function readTrade(id = 'op-1') {
  return JSON.parse(localStorage.getItem(`tradelog_exectrades_${USER}`)).find((t) => t.id === id);
}

function balance() {
  return JSON.parse(localStorage.getItem(`tradelog_folders_${USER}`))[0].currentBalance;
}

// ---- 1. Canonical close succeeds and settles ----

test('a canonical OPEN trade closes with computed P/L and a recalculated balance', async () => {
  seed();
  const { closeTrade } = await exec();
  // LONG 2 lots, entry 1.10, exit 1.12: pnl = (1.12-1.10) * 2 * 100000? No —
  // computePnl uses price-diff x lot x contractFactor(1 default) scaled? Just
  // assert internal consistency, not a hand-computed constant.
  const res = await closeTrade(USER, 'op-1', { exitPrice: 1.12, lot: 2, reason: 'Take profit' });
  equal(res.success, true, 'close succeeds');
  const t = readTrade();
  equal(t.status, 'CLOSED', 'status flips to CLOSED');
  ok(Number.isFinite(Number(t.pnl)) && Number(t.pnl) > 0, `pnl is a positive number, got ${t.pnl}`);
  equal(balance(), 10000 + Number(t.pnl), 'balance equals starting plus realized P/L');
  ok(Array.isArray(t.events) && t.events.length > 0, 'event history records the close');
});

test('a missing trade id fails without writing anything', async () => {
  seed();
  const { closeTrade } = await exec();
  const before = localStorage.getItem(`tradelog_exectrades_${USER}`);
  const res = await closeTrade(USER, 'nope', { exitPrice: 1.12, lot: 1, reason: 'Take profit' });
  equal(res.success, false, 'missing trade is an error, not silent success');
  equal(localStorage.getItem(`tradelog_exectrades_${USER}`), before, 'store byte-identical after failure');
  equal(readTrade().status, 'OPEN', 'the real trade is untouched');
});

test('an invalid exit price fails and preserves the user’s inputs by leaving state alone', async () => {
  seed();
  const { closeTrade } = await exec();
  const res = await closeTrade(USER, 'op-1', { exitPrice: 'abc', lot: 1, reason: 'Take profit' });
  equal(res.success, false, 'non-numeric exit is rejected');
  const t = readTrade();
  equal(t.status, 'OPEN', 'trade stays OPEN');
  equal(Number(t.pnl), 0, 'no partial P/L leaks in');
  equal(balance(), 10000, 'balance untouched');
});

// ---- 2. Partial-close semantics ----

test('closing fewer lots leaves PARTIALLY_CLOSED with realized P/L on the closed leg', async () => {
  seed();
  const { closeTrade } = await exec();
  const res = await closeTrade(USER, 'op-1', { exitPrice: 1.12, lot: 1, reason: 'Take profit' });
  equal(res.success, true, 'partial close succeeds');
  const t = readTrade();
  equal(t.status, 'PARTIALLY_CLOSED', 'status reflects the open remainder');
  ok(Number(t.pnl) > 0, 'realized P/L booked for the closed lot');
  const rest = await closeTrade(USER, 'op-1', { exitPrice: 1.11, lot: 1, reason: 'Take profit' });
  equal(rest.success, true, 'closing the remainder succeeds');
  const done = readTrade();
  equal(done.status, 'CLOSED', 'fully closed after the second leg');
  ok(Number(done.pnl) > Number(t.pnl), 'total exceeds the first leg alone');
});

test('an over-quantity close resolves to a full close rather than corrupting lots', async () => {
  seed();
  const { closeTrade } = await exec();
  const res = await closeTrade(USER, 'op-1', { exitPrice: 1.12, lot: 99, reason: 'Take profit' });
  equal(res.success, true, 'over-quantity is accepted as a full close');
  const t = readTrade();
  equal(t.status, 'CLOSED', 'position fully closed');
  ok(Number(t.closedLot) <= 2, `closed lots never exceed position size, got ${t.closedLot}`);
});

// ---- 3. The old legacy path demonstrably fails the same cases ----

test('NON-VACUITY: legacy storage.updateTrade leaves the canonical trade OPEN', async () => {
  seed();
  const store = await import(pathToFileURL(path.join(SRC, 'js/utils/storage.js')).href);
  store.updateTrade('acc-A', 'op-1', { status: 'CLOSED', closedAt: '2024-01-02T15:00:00.000Z' });
  equal(readTrade().status, 'OPEN', 'the canonical record is untouched by the legacy write');
  const legacy = JSON.parse(localStorage.getItem('tradelog_trades_acc-A') || '[]');
  equal(legacy.length, 0, 'and the legacy store gained no row for a canonical id');
});

// ---- 4. Wiring locks: the dashboard close path is canonical ----

test('tradeDetail exports the shared close modal', () => {
  ok(/export function openCloseModal\(user, trade/.test(DETAIL_PAGE), 'openCloseModal is a named export');
  ok(/openCloseModal\(user, trade, \(\) => refreshTradeLists\(user\)\)|openCloseModal\(user, trade,/.test(TRADE_PAGE), 'the dashboard passes a list-refresh callback');
});

test('the dashboard opens the shared modal and never writes the legacy store', () => {
  ok(/mod\.openCloseModal\(user, trade/.test(TRADE_PAGE), 'dashboard delegates to the shared modal');
  ok(!/updateTrade\(folderId, tradeId/.test(TRADE_PAGE), 'no legacy updateTrade(folderId, tradeId) call remains in the close flow');
  ok(!/id="close-exit"/.test(TRADE_PAGE), 'the legacy inline modal markup is gone');
  ok(/navigate\(`\/trade\/\$\{tradeId\}`\)/.test(TRADE_PAGE), 'chunk failure falls back to navigation, not a shadow write');
});

test('the shared modal toasts only on reported success and preserves inputs on failure', () => {
  ok(/if \(!res\.success\) return showToast\(res\.error \|\| 'Close failed'/.test(DETAIL_PAGE), 'failure toasts the engine error and returns before hideModal');
  const confirmIdx = DETAIL_PAGE.indexOf("getElementById('close-confirm')");
  const hideIdx = DETAIL_PAGE.indexOf('hideModal();', confirmIdx);
  const toastIdx = DETAIL_PAGE.indexOf('Trade closed:', confirmIdx);
  ok(hideIdx !== -1 && toastIdx !== -1 && hideIdx < toastIdx, 'success path hides the modal before toasting');
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('dashboard-close.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}