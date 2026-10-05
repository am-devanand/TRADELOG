// CONTRACT TEST SUITE — locks public utility return shapes.
// Vanilla ESM, offline, no dependencies. Run via `node test/run-all.js`
// or directly via `node test/contracts.test.js`.
// NOTE (discrepancy vs spec intent): the implementation's
// getOutcomeProcessMatrix(dataset, thresholds) takes a DATASET array —
// not (accountId, filters). These tests pin the ACTUAL shape.
import {
  test, skip, run, ok, equal, deepEqual, typeOf,
  assertThrows, assertNoMutation, assertExactKeys,
  seedDeterministic, buildPerfectReview, buildEmptyReview,
  SEED_USER, SEED_ACC1, SEED_ACC2,
} from './helpers.js';
import { getTradeDataset, getCoreMetrics, getOutcomeProcessMatrix } from '../src/js/utils/tradingAnalytics.js';
import * as riskAnalytics from '../src/js/utils/riskAnalytics.js';
import { getIntegrityReport } from '../src/js/utils/dataIntegrity.js';
import {
  validateBackupSchema, validateEntities, validateReferences, previewBackup, exportBackup,
} from '../src/js/utils/backup.js';
import { calculateProcessScore } from '../src/js/utils/processScore.js';
import { evaluateChecklist } from '../src/js/utils/decisionEngine.js';
import { getAttribution } from '../src/js/utils/performanceAttribution.js';
import { getMigrationVersion, migrateUser } from '../src/js/utils/migration.js';
import { appendAudit, getAuditLog, countAudit } from '../src/js/utils/auditLog.js';
import { getAccountPropState } from '../src/js/utils/propEngine.js';
import { createRuleVersion, getRuleHistory, getRuleVersion } from '../src/js/utils/ruleHistory.js';

const U = SEED_USER;
const ACC = SEED_ACC1;

// ---------- riskAnalytics.getDrawdownSeries ----------
test('drawdownSeries: exact keys {series,startingBalance,sampleSize}', () => {
  seedDeterministic(U);
  const r = riskAnalytics.getDrawdownSeries(ACC, { user: U });
  assertExactKeys(r, ['series', 'startingBalance', 'sampleSize'], 'drawdownSeries keys');
  typeOf(r.series, 'array', 'series is array');
  typeOf(r.startingBalance, 'number', 'startingBalance number');
  typeOf(r.sampleSize, 'number', 'sampleSize number');
  equal(r.sampleSize, 3, 'sampleSize matches 3 seeded trades');
});

test('drawdownSeries: element keys {timestamp,balance,peak,drawdown,drawdownPercent}', () => {
  seedDeterministic(U);
  const r = riskAnalytics.getDrawdownSeries(ACC, { user: U });
  ok(r.series.length === 3, 'series has 3 points');
  for (const p of r.series) {
    assertExactKeys(p, ['timestamp', 'balance', 'peak', 'drawdown', 'drawdownPercent'], 'point keys');
    typeOf(p.balance, 'number', 'balance number');
    typeOf(p.peak, 'number', 'peak number');
    typeOf(p.drawdown, 'number', 'drawdown number');
    ok(p.drawdownPercent === null || typeof p.drawdownPercent === 'number', 'drawdownPercent number|null');
  }
});

test('drawdownSeries: empty dataset → series [] and sampleSize 0 (not null)', () => {
  seedDeterministic(U);
  const r = riskAnalytics.getDrawdownSeries(SEED_ACC2, { user: U });
  assertExactKeys(r, ['series', 'startingBalance', 'sampleSize'], 'empty keys');
  deepEqual(r.series, [], 'empty series');
  equal(r.sampleSize, 0, 'sampleSize 0');
  ok(r.series !== null, 'series is not null');
});

// ---------- getTradeDataset ----------
test('tradeDataset: deterministic array, row count matches seeded closed trades', () => {
  seedDeterministic(U);
  const rows = getTradeDataset(ACC, { user: U });
  typeOf(rows, 'array', 'dataset is array');
  equal(rows.length, 3, '3 closed trades for acc-1');
  for (const row of rows) {
    assertExactKeys(row, ['trade', 'review', 'outcome', 'pnl', 'r', 'processScore', 'reviewed'], 'row keys');
    ok(row.trade && typeof row.trade === 'object', 'row.trade object');
    typeOf(row.pnl, 'number', 'row pnl number');
    typeOf(row.r, 'number', 'row r number');
    ok(['WIN', 'LOSS', 'BREAKEVEN'].includes(row.outcome), 'row outcome label');
    typeOf(row.reviewed, 'boolean', 'row reviewed boolean');
  }
});

test('tradeDataset: rows expose documented trade fields', () => {
  seedDeterministic(U);
  const rows = getTradeDataset(ACC, { user: U });
  for (const row of rows) {
    for (const f of ['id', 'accountId', 'status', 'pnl', 'openedAt', 'closedAt']) {
      ok(row.trade[f] !== undefined, `trade exposes ${f}`);
    }
    equal(row.trade.status, 'CLOSED', 'seeded trades are CLOSED');
    equal(row.trade.accountId, ACC, 'trade account matches');
  }
});

test('tradeDataset: ordering stable across two calls (deep-equal)', () => {
  seedDeterministic(U);
  const a = getTradeDataset(ACC, { user: U });
  const b = getTradeDataset(ACC, { user: U });
  deepEqual(a, b, 'two calls deep-equal');
});

// ---------- getOutcomeProcessMatrix ----------
// ACTUAL signature is (dataset, thresholds); spec intent said (accountId, filters).
test('outcomeProcessMatrix: exact keys, numeric counts', () => {
  seedDeterministic(U);
  const dataset = getTradeDataset(ACC, { user: U });
  const m = getOutcomeProcessMatrix(dataset);
  assertExactKeys(
    m,
    ['highProcessProfitable', 'highProcessLosing', 'lowProcessProfitable', 'lowProcessLosing', 'sampleSize'],
    'matrix keys',
  );
  for (const k of ['highProcessProfitable', 'highProcessLosing', 'lowProcessProfitable', 'lowProcessLosing']) {
    typeOf(m[k], 'number', `${k} numeric`);
  }
  typeOf(m.sampleSize, 'number', 'sampleSize numeric');
  equal(m.sampleSize, 2, '2 reviewed trades in matrix');
  equal(m.highProcessProfitable, 1, 't-1 high+win');
  equal(m.lowProcessLosing, 1, 't-2 low+loss');
});

test('outcomeProcessMatrix: no reviewed data → all-null + sampleSize 0', () => {
  seedDeterministic(U);
  const m = getOutcomeProcessMatrix([]);
  assertExactKeys(
    m,
    ['highProcessProfitable', 'highProcessLosing', 'lowProcessProfitable', 'lowProcessLosing', 'sampleSize'],
    'empty matrix keys',
  );
  equal(m.highProcessProfitable, null, 'null when empty');
  equal(m.highProcessLosing, null, 'null when empty');
  equal(m.lowProcessProfitable, null, 'null when empty');
  equal(m.lowProcessLosing, null, 'null when empty');
  equal(m.sampleSize, 0, 'sampleSize 0');
});

// ---------- getIntegrityReport ----------
test('integrityReport: exact top-level keys', () => {
  seedDeterministic(U);
  const r = getIntegrityReport(U);
  assertExactKeys(r, ['valid', 'errors', 'warnings', 'checkedAt', 'summary', 'reconciliations'], 'report keys');
  typeOf(r.valid, 'boolean', 'valid boolean');
  typeOf(r.errors, 'array', 'errors array');
  typeOf(r.warnings, 'array', 'warnings array');
  typeOf(r.checkedAt, 'string', 'checkedAt string');
  ok(!Number.isNaN(Date.parse(r.checkedAt)), 'checkedAt parses as date');
});

test('integrityReport: deterministic ordering across two calls', () => {
  seedDeterministic(U);
  const a = getIntegrityReport(U);
  const b = getIntegrityReport(U);
  deepEqual(a.errors, b.errors, 'errors deterministic');
  deepEqual(a.warnings, b.warnings, 'warnings deterministic');
});

test('integrityReport: each issue has {code,level,entityType,entityId,message}', () => {
  seedDeterministic(U);
  const r = getIntegrityReport(U);
  for (const issue of [...r.errors, ...r.warnings]) {
    assertExactKeys(issue, ['code', 'level', 'entityType', 'entityId', 'message'], 'issue keys');
  }
});

// ---------- backup validators ----------
function validBackupPayload() {
  seedDeterministic(U);
  return exportBackup(U);
}

test('backup.validateBackupSchema: {valid,errors} on valid payload', () => {
  const data = validBackupPayload();
  const r = validateBackupSchema(data);
  assertExactKeys(r, ['valid', 'errors'], 'schema keys');
  equal(r.valid, true, 'valid backup passes schema');
  deepEqual(r.errors, [], 'no errors');
});

test('backup.validateBackupSchema: invalid payload → valid false', () => {
  const r = validateBackupSchema({ bogus: 1 });
  assertExactKeys(r, ['valid', 'errors'], 'invalid schema keys');
  equal(r.valid, false, 'bogus fails');
  ok(r.errors.length > 0, 'errors reported');
});

test('backup.validateEntities: {valid,errors} style', () => {
  const data = validBackupPayload();
  const r = validateEntities(data);
  assertExactKeys(r, ['valid', 'errors'], 'entities keys');
  equal(r.valid, true, 'seeded backup entities valid');
});

test('backup.validateReferences: {valid,errors,warnings} style', () => {
  const data = validBackupPayload();
  const r = validateReferences(data);
  typeOf(r.valid, 'boolean', 'refs valid boolean');
  typeOf(r.errors, 'array', 'refs errors array');
  typeOf(r.warnings, 'array', 'refs warnings array');
  equal(r.valid, true, 'seeded refs valid');
});

test('backup.previewBackup: includes counts + exportedAt', () => {
  const data = validBackupPayload();
  const p = previewBackup(data);
  equal(p.success, true, 'preview success');
  ok(typeof p.exportedAt === 'string' && p.exportedAt !== '', 'exportedAt present');
  ok(p.counts && typeof p.counts === 'object', 'counts present');
  equal(p.counts.trades, 3, 'counts.trades matches seed');
  equal(p.counts.accounts, 2, 'counts.accounts matches seed');
  equal(p.counts.reviews, 2, 'counts.reviews matches seed');
});

// ---------- getCoreMetrics ----------
test('coreMetrics: documented numeric/null fields exist', () => {
  seedDeterministic(U);
  const dataset = getTradeDataset(ACC, { user: U });
  const m = getCoreMetrics(dataset);
  for (const k of [
    'totalTrades', 'wins', 'losses', 'breakeven', 'winRate', 'totalPnl', 'avgPnl',
    'avgWin', 'avgLoss', 'largestWin', 'largestLoss', 'totalR', 'avgR', 'medianR',
    'bestR', 'worstR', 'profitFactor', 'avgProcessScore', 'ruleAdherence', 'sampleSize',
  ]) {
    ok(k in m, `coreMetrics has ${k}`);
  }
  equal(m.totalTrades, 3, 'totalTrades 3');
  equal(m.sampleSize, 3, 'sampleSize 3');
});

test('coreMetrics: winRate/profitFactor NULL (never Infinity/NaN) when undefined', () => {
  const empty = getCoreMetrics([]);
  equal(empty.winRate, null, 'empty winRate null');
  equal(empty.profitFactor, null, 'empty profitFactor null');
  equal(empty.avgPnl, null, 'empty avgPnl null');
  ok(empty.winRate !== Infinity && !Number.isNaN(empty.winRate ?? 0), 'no Infinity/NaN');
  // all-wins → grossLoss 0 → profitFactor null (not Infinity)
  const allWins = getCoreMetrics([
    { trade: { pnl: 100, rMultiple: 1 }, review: null },
    { trade: { pnl: 50, rMultiple: 0.5 }, review: null },
  ]);
  equal(allWins.profitFactor, null, 'all-wins profitFactor null, not Infinity');
  ok(allWins.profitFactor !== Infinity, 'never Infinity');
});

// ---------- calculateProcessScore ----------
test('processScore: exact keys {preTradeScore,executionScore,managementScore,disciplineScore,total,grade}', () => {
  const s = calculateProcessScore(buildPerfectReview());
  assertExactKeys(
    s,
    ['preTradeScore', 'executionScore', 'managementScore', 'disciplineScore', 'total', 'grade'],
    'processScore keys',
  );
  for (const k of ['preTradeScore', 'executionScore', 'managementScore', 'disciplineScore', 'total']) {
    typeOf(s[k], 'number', `${k} number`);
  }
  typeOf(s.grade, 'string', 'grade string');
  ok(['A', 'B', 'C', 'D', 'F'].includes(s.grade), 'grade in A/B/C/D/F');
});

test('processScore: perfect answers → 100/A; empty review → 0/F', () => {
  const perfect = calculateProcessScore(buildPerfectReview());
  equal(perfect.total, 100, 'perfect total 100');
  equal(perfect.grade, 'A', 'perfect grade A');
  const empty = calculateProcessScore(buildEmptyReview());
  equal(empty.total, 0, 'empty total 0');
  equal(empty.grade, 'F', 'empty grade F');
});

test('processScore: independent of any pnl field on the review', () => {
  const base = buildPerfectReview();
  const a = calculateProcessScore({ ...base });
  const b = calculateProcessScore({ ...base, pnl: 9999, trade: { pnl: -5000 } });
  deepEqual(a, b, 'pnl does not affect score');
});

// ---------- evaluateChecklist ----------
test('checklist: exact keys {score,state,passedRules,failedRules,missingRules,warnings,blockers}', () => {
  const rules = [
    { id: 'a', name: 'Rule A', weight: 1 },
    { id: 'b', name: 'Rule B', weight: 1, required: true },
  ];
  const r = evaluateChecklist({ rules, checks: { a: { pass: true }, b: { pass: true } } });
  assertExactKeys(r, ['score', 'state', 'passedRules', 'failedRules', 'missingRules', 'warnings', 'blockers'], 'checklist keys');
  typeOf(r.score, 'number', 'score number');
  ok(['READY', 'WAITING', 'NO_TRADE'].includes(r.state), 'state enum');
  equal(r.state, 'READY', 'all pass → READY');
});

test('checklist: failed required rule → NO_TRADE + blockers', () => {
  const rules = [{ id: 'a', name: 'Must', weight: 1, required: true }];
  const r = evaluateChecklist({ rules, checks: { a: { pass: false, reason: 'nope', source: 'Risk' } } });
  equal(r.state, 'NO_TRADE', 'blocker forces NO_TRADE');
  equal(r.blockers.length, 1, 'one blocker');
  equal(r.failedRules.length, 1, 'one failed');
});

test('checklist: missing check → missingRules entry', () => {
  const rules = [{ id: 'a', name: 'Rule A', weight: 1 }];
  const r = evaluateChecklist({ rules, checks: {} });
  equal(r.missingRules.length, 1, 'one missing');
});

// ---------- riskAnalytics key sets ----------
test('risk.getConsecutiveWins/getConsecutiveLosses: exact keys', () => {
  seedDeterministic(U);
  const w = riskAnalytics.getConsecutiveWins(ACC, { user: U });
  assertExactKeys(w, ['longestWinStreak', 'currentWinStreak', 'sampleSize'], 'wins keys');
  const l = riskAnalytics.getConsecutiveLosses(ACC, { user: U });
  assertExactKeys(l, ['longestLossStreak', 'currentLossStreak', 'sampleSize'], 'losses keys');
  equal(w.sampleSize, 3, 'wins sampleSize');
  equal(l.sampleSize, 3, 'losses sampleSize');
  typeOf(w.longestWinStreak, 'number', 'longestWinStreak number');
  typeOf(l.longestLossStreak, 'number', 'longestLossStreak number');
});

test('risk.getDailyRiskStats: exact keys {days,sampleSize}', () => {
  seedDeterministic(U);
  const r = riskAnalytics.getDailyRiskStats(ACC, { user: U });
  assertExactKeys(r, ['days', 'sampleSize'], 'daily keys');
  typeOf(r.days, 'array', 'days array');
  equal(r.sampleSize, 3, 'daily sampleSize');
  ok(r.days.length >= 3, 'one bucket per trade day');
});

test('risk.getRiskDistribution: exact keys {bins,sampleSize,configuredMaxRiskPercent}', () => {
  seedDeterministic(U);
  const r = riskAnalytics.getRiskDistribution(ACC, { user: U });
  assertExactKeys(r, ['bins', 'sampleSize', 'configuredMaxRiskPercent'], 'distribution keys');
  equal(r.sampleSize, 3, 'distribution sampleSize');
});

test('risk.getAverageRisk/getMaxRisk: exact keys', () => {
  seedDeterministic(U);
  const a = riskAnalytics.getAverageRisk(ACC, { user: U });
  assertExactKeys(a, ['averageRiskPercent', 'sampleSize'], 'avg keys');
  typeOf(a.averageRiskPercent, 'number', 'average number');
  const m = riskAnalytics.getMaxRisk(ACC, { user: U });
  assertExactKeys(m, ['maxRiskPercent', 'tradeId', 'sampleSize'], 'max keys');
  typeOf(m.maxRiskPercent, 'number', 'max number');
});

test('risk.getRiskViolations: {violations,count,sampleSize,configuredMax} (+note when unconfigured)', () => {
  seedDeterministic(U);
  const r = riskAnalytics.getRiskViolations(ACC, { user: U });
  for (const k of ['violations', 'count', 'sampleSize', 'configuredMax']) {
    ok(k in r, `violations has ${k}`);
  }
  const extra = Object.keys(r).filter((k) => !['violations', 'count', 'sampleSize', 'configuredMax', 'note'].includes(k));
  deepEqual(extra, [], 'no unexpected keys beyond note');
  typeOf(r.violations, 'array', 'violations array');
  typeOf(r.count, 'number', 'count number');
});

// ---------- performanceAttribution ----------
test('attribution: rows have exact keys, no ranking/winner key', () => {
  seedDeterministic(U);
  const rows = getAttribution(ACC, 'strategy', { user: U });
  typeOf(rows, 'array', 'attribution array');
  ok(rows.length >= 2, 'two strategies present');
  for (const row of rows) {
    assertExactKeys(
      row,
      ['dimensionValue', 'trades', 'pnl', 'totalR', 'averageR', 'winRate', 'processScore', 'sampleSize'],
      'attribution row keys',
    );
    ok(!('rank' in row) && !('ranking' in row) && !('winner' in row), 'no ranking/winner key');
  }
});

// ---------- migration ----------
test('migration.getMigrationVersion: integer; migrateUser idempotency', () => {
  seedDeterministic('miguser1');
  const before = getMigrationVersion('miguser1');
  typeOf(before, 'number', 'version number');
  ok(Number.isInteger(before), 'version integer');
  const first = migrateUser('miguser1');
  assertExactKeys(first, ['migrated', 'version'], 'migrateUser keys');
  typeOf(first.migrated, 'boolean', 'migrated boolean');
  ok(Number.isInteger(first.version), 'version integer after migrate');
  const second = migrateUser('miguser1');
  assertExactKeys(second, ['migrated', 'version'], 'second call keys');
  equal(second.migrated, false, 'second call migrated:false (idempotent)');
  equal(second.version, first.version, 'version stable across calls');
});

// ---------- auditLog ----------
test('audit: entry exact keys {id,entityType,entityId,action,timestamp,metadata}', () => {
  seedDeterministic(U);
  const res = appendAudit(U, { entityType: 'trade', entityId: 't-1', action: 'TRADE_CREATED', metadata: { note: 'hi' } });
  equal(res.success, true, 'append success');
  assertExactKeys(res.entry, ['id', 'entityType', 'entityId', 'action', 'timestamp', 'metadata'], 'entry keys');
  typeOf(res.entry.id, 'string', 'id string');
  typeOf(res.entry.timestamp, 'string', 'timestamp string');
});

test('audit: append-only (prior entries deep-equal after new append); countAudit', () => {
  seedDeterministic(U);
  appendAudit(U, { entityType: 'trade', entityId: 't-1', action: 'TRADE_CREATED' });
  const before = getAuditLog(U);
  const n1 = countAudit(U);
  typeOf(n1, 'number', 'count number');
  equal(n1, before.length, 'count matches log length');
  appendAudit(U, { entityType: 'trade', entityId: 't-2', action: 'TRADE_CLOSED' });
  const after = getAuditLog(U);
  equal(countAudit(U), n1 + 1, 'count increments by 1');
  deepEqual(after.slice(0, before.length), before, 'prior entries unchanged (append-only)');
});

// ---------- propEngine ----------
test('prop.getAccountPropState: top-level keys; status enum', () => {
  seedDeterministic(U);
  const s = getAccountPropState(ACC, U);
  for (const k of [
    'success', 'status', 'accountId', 'balance', 'equity', 'equityAvailable',
    'startingBalance', 'netProfit', 'profitTarget', 'drawdown', 'tradingDays',
    'consistency', 'rules',
  ]) {
    ok(k in s, `propState has ${k}`);
  }
  equal(s.success, true, 'prop success true');
  ok(['SAFE', 'WARNING', 'CRITICAL', 'BREACH'].includes(s.status), `status enum (got ${s.status})`);
  typeOf(s.balance, 'number', 'balance number');
});

// ---------- ruleHistory ----------
test('ruleHistory.createRuleVersion: {version,rule,changes,createdAt}; cosmetic no-bump, material bumps, v1 immutable', () => {
  seedDeterministic('rhuser1');
  const full = {
    id: 'rh-1', name: 'Rule One', type: 'CHECKBOX', category: 'GENERAL',
    weight: 10, required: false, enabled: true, severity: 'MEDIUM',
    description: 'd', validation: { operator: '>=', value: 0, unit: 'count' },
    applicableSessions: [], applicableStrategies: [], applicablePairs: [],
  };
  const v1 = createRuleVersion('rh-1', full, 'rhuser1');
  assertExactKeys(v1, ['version', 'rule', 'changes', 'createdAt'], 'version keys');
  equal(v1.version, 1, 'first version is 1');
  const v1snap = JSON.parse(JSON.stringify(v1));
  // cosmetic-only change (unknown future field) must NOT bump
  const cosmetic = createRuleVersion('rh-1', { ...full, someFutureField: 'x' }, 'rhuser1');
  equal(cosmetic.version, 1, 'cosmetic change does not bump');
  // material change (weight) MUST bump
  const v2 = createRuleVersion('rh-1', { ...full, weight: 20 }, 'rhuser1');
  equal(v2.version, 2, 'material change bumps to 2');
  // v1 remains immutable
  const reread = getRuleVersion('rh-1', 1, 'rhuser1');
  deepEqual(reread.rule, v1snap.rule, 'v1 snapshot immutable');
  deepEqual(getRuleHistory('rh-1', 'rhuser1').map((v) => v.version), [1, 2], 'history versions [1,2]');
});

// ---------- genuinely browser-only modules: SKIP, never silent-pass ----------
skip('storage.js login/register/sync flows', 'firebase + browser sync');
skip('screenshotStore IndexedDB blob flows', 'IndexedDB unavailable in Node');

export { run };
export default { run };

// Direct execution: `node test/contracts.test.js`
if (process.argv[1] && String(process.argv[1]).endsWith('contracts.test.js')) {
  run().then((r) => {
    // Force exit: firebase handles (via ruleManager chain) would hang Node.
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
