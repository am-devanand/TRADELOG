// STRATEGY LINKING REGRESSION TESTS
//
// /trade/new used a free-text strategy field backed by a hardcoded datalist, so
// nothing tied a trade to a Strategy Builder entry. Two consequences:
//
//   - executed trades stored the display string in the strategyId slot
//     (executedTrades.js read market.strategy before setup.strategyId), so
//     per-strategy stats keyed off unvalidated text and a typo silently split
//     one strategy's history into two groups;
//   - the Strategy Builder could not see trades that used it.
//
// These tests extract the real functions from src/js/pages/trade.js and assert
// the linking contract: a select bound to the store when strategies exist, a
// stable id persisted alongside the display name, and a free-text fallback only
// when the store is empty. Non-vacuity: the id assertions fail if strategyId
// stops being persisted.
import { test, run, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRADE_JS = path.join(ROOT, 'src/js/pages/trade.js');
const EXECUTED = path.join(ROOT, 'src/js/utils/executedTrades.js');
const SOURCE = readFileSync(TRADE_JS, 'utf8');

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

function extractConst(name) {
  const m = SOURCE.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`));
  if (!m) throw new Error(`could not find const ${name}`);
  return m[1];
}

function makeTradeModule({ strategies = [] } = {}) {
  // readFormIntoState resolves inputs through the `document` captured in this
  // factory's scope, so it must be a swappable holder rather than the global.
  const doc = { getElementById: () => null };

  const factory = new Function(
    'getStrategies', 'getStrategy', 'escapeHtml', 'generateId', 'document',
    `const STRATEGY_SUGGESTIONS = ${extractConst('STRATEGY_SUGGESTIONS')};
let lastResult = null;
${extractFunction('strategyFieldHtml')}
${extractFunction('blankAnalysis')}
${extractFunction('readFormIntoState')}
${extractFunction('buildSetupRecord')}
analysis = blankAnalysis();
return {
  strategyFieldHtml,
  resetAnalysis: () => { analysis = blankAnalysis(); },
  setAnalysis: (v) => { analysis = v; },
  readFormIntoState: () => readFormIntoState(),
  buildSetupRecord: (status) => buildSetupRecord(status),
  getAnalysis: () => analysis,
  setLastResult: (r) => { lastResult = r; },
};`,
  );

  let analysis = null;
  const mod = factory(
    () => strategies,
    (user, id) => strategies.find((s) => s.id === id),
    (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    () => 'gen-id',
    doc,
  );
  mod.setDocument = (getElementById) => { doc.getElementById = getElementById; };
  return mod;
}

const STRATEGIES = [
  { id: 'strat_a1', name: 'London Breakout', version: 2, status: 'ACTIVE' },
  { id: 'strat_b2', name: 'Trend Pullback', version: 1, status: 'DRAFT' },
];

// Minimal select stub: readFormIntoState only touches tagName, value and
// selectedOptions[0].dataset.name.
function selectStub(value) {
  const match = STRATEGIES.find((s) => s.id === value);
  return {
    tagName: 'SELECT',
    value,
    selectedOptions: value ? [{ dataset: { name: match ? match.name : '' } }] : [],
  };
}

// ---- 1. The control renders from the store ----

test('with strategies the field is a select whose option values are strategy ids', () => {
  const m = makeTradeModule({ strategies: STRATEGIES });
  const html = m.strategyFieldHtml('u', '', '');
  ok(/<select id="ta-strategy">/.test(html), 'renders a select, not a text input');
  ok(!/<input[^>]*id="ta-strategy"/.test(html), 'no free-text input when strategies exist');
  ok(html.includes('value="strat_a1"'), 'option value is the stable strategy id');
  ok(html.includes('value="strat_b2"'), 'every strategy is offered, including DRAFT');
});

test('option labels carry the name, version and status', () => {
  const m = makeTradeModule({ strategies: STRATEGIES });
  const html = m.strategyFieldHtml('u', '', '');
  ok(/London Breakout \(v2 · ACTIVE\)/.test(html), 'active strategy is labelled with version and status');
  ok(/Trend Pullback \(v1 · DRAFT\)/.test(html), 'draft strategies are labelled too');
});

test('option values are escaped so a quote in a name cannot break out of the attribute', () => {
  const m = makeTradeModule({
    strategies: [{ id: 'x', name: 'A "quoted" <name>', version: 1, status: 'ACTIVE' }],
  });
  const html = m.strategyFieldHtml('u', '', '');
  ok(!/value="[^"]*"[^>]*"quoted"/.test(html), 'no unescaped attribute break-out');
  ok(html.includes('&quot;quoted&quot;'), 'quotes are entity-escaped');
});

test('with no strategies the free-text input is preserved', () => {
  const m = makeTradeModule({ strategies: [] });
  const html = m.strategyFieldHtml('u', '', 'Breakout');
  ok(/<input list="ta-strategy-list" id="ta-strategy"/.test(html), 'falls back to free text');
  ok(html.includes('value="Breakout"'), 'keeps the previously typed value');
  ok(!/<select/.test(html), 'no empty select is rendered');
});

test('the current selection is preselected, and no selection is the default', () => {
  const m = makeTradeModule({ strategies: STRATEGIES });
  const pre = m.strategyFieldHtml('u', 'strat_b2', 'Trend Pullback');
  ok(/value="strat_b2"[^>]*selected/.test(pre), 'existing link is restored');
  const none = m.strategyFieldHtml('u', '', '');
  ok(/<option value="" selected>— No strategy —<\/option>/.test(none), 'empty by default');
});

// ---- 2. The state reader links id + name ----

test('selecting an option records both the id and the display name', () => {
  const m = makeTradeModule({ strategies: STRATEGIES });
  m.setAnalysis({ ...m.getAnalysis(), accountId: 'acc-1', pair: 'EUR/USD' });
  m.setDocument((id) => (id === 'ta-strategy' ? selectStub('strat_a1') : null));
  m.readFormIntoState();
  const a = m.getAnalysis();
  equal(a.strategyId, 'strat_a1', 'the stable id is captured');
  equal(a.strategy, 'London Breakout', 'the name comes from the option, not a store re-read');
});

test('clearing the selection clears both id and name', () => {
  const m = makeTradeModule({ strategies: STRATEGIES });
  m.setAnalysis({ ...m.getAnalysis(), strategyId: 'strat_a1', strategy: 'London Breakout' });
  m.setDocument((id) => (id === 'ta-strategy' ? selectStub('') : null));
  m.readFormIntoState();
  const a = m.getAnalysis();
  equal(a.strategyId, '', 'id cleared');
  equal(a.strategy, '', 'name cleared, so an empty choice cannot leave a stale group');
});

test('the free-text fallback records a name and no id', () => {
  const m = makeTradeModule({ strategies: [] });
  m.setDocument((id) => (id === 'ta-strategy' ? { tagName: 'INPUT', value: '  London Breakout  ' } : null));
  m.readFormIntoState();
  equal(m.getAnalysis().strategy, 'London Breakout', 'free text is trimmed');
  equal(m.getAnalysis().strategyId, '', 'no id is invented for unlinked strategies');
});

// ---- 3. Persistence ----

test('the saved setup carries the strategyId at the top level and in market', () => {
  const m = makeTradeModule({ strategies: STRATEGIES });
  m.setAnalysis({
    ...m.getAnalysis(),
    strategyId: 'strat_a1',
    strategy: 'London Breakout',
    accountId: 'acc-1',
    pair: 'EUR/USD',
  });
  const rec = m.buildSetupRecord('WAITING');
  equal(rec.strategyId, 'strat_a1', 'top-level strategyId persisted');
  equal(rec.market.strategyId, 'strat_a1', 'market.strategyId persisted for the legacy reader');
  equal(rec.market.strategy, 'London Breakout', 'the display name is kept for rendering');
});

test('an unlinked setup persists an empty strategyId rather than the name', () => {
  const m = makeTradeModule({ strategies: [] });
  m.setAnalysis({ ...m.getAnalysis(), strategyId: '', strategy: 'Scalp' });
  const rec = m.buildSetupRecord('DRAFT');
  equal(rec.strategyId, '', 'no id is fabricated');
  equal(rec.market.strategy, 'Scalp', 'the free-text name is still stored');
});

// ---- 4. Propagation into the executed trade ----

test('executedTrades prefers a real strategyId over the free-text name', () => {
  const src = readFileSync(EXECUTED, 'utf8');
  ok(
    /strategyId: market\.strategyId \?\? setup\.strategyId \?\? market\.strategy \?\? setup\.strategy \?\? ''/.test(src),
    'the legacy propagation must read a real id before falling back to the display name',
  );
});

test('NON-VACUITY: the old precedence that overwrote strategyId with the name is gone', () => {
  const src = readFileSync(EXECUTED, 'utf8');
  ok(
    !/strategyId: market\.strategy \?\? setup\.strategy \?\? setup\.strategyId/.test(src),
    'market.strategy must no longer win the strategyId slot',
  );
});

// ---- 5. Backward compatibility with records that predate linking ----

test('linked trades group by id and legacy string-only trades keep their own group', async () => {
  const { getAllStrategyStats } = await import(
    pathToFileURL(path.join(ROOT, 'src/js/utils/tradingAnalytics.js')).href
  );
  const stats = getAllStrategyStats([
    { strategyId: 'strat_a1', status: 'CLOSED', pnl: 90, rMultiple: 0.9 },
    { strategyId: 'strat_a1', status: 'CLOSED', pnl: 30, rMultiple: 0.3 },
    { strategyId: 'London Breakout', status: 'CLOSED', pnl: -60, rMultiple: -0.6 },
  ]);
  const keys = stats.map((s) => s.key).sort();
  deepEqual(keys, ['London Breakout', 'strat_a1'], 'a pre-link record must not merge into the linked group');
});

test('a trade with neither an id nor a name falls into Unspecified, not a phantom group', async () => {
  const { getAllStrategyStats } = await import(
    pathToFileURL(path.join(ROOT, 'src/js/utils/tradingAnalytics.js')).href
  );
  const stats = getAllStrategyStats([
    { strategyId: '', strategy: '', status: 'CLOSED', pnl: 10, rMultiple: 0.1 },
  ]);
  deepEqual(stats.map((s) => s.key), ['Unspecified'], 'unlinked trades stay bucketable');
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('strategy-linking.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}