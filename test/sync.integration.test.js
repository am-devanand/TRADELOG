// Integration tests for the sync layer, the critical path after the 8.5 repair.
//
// The contract suite cannot reach syncManager.js without Firebase, so these
// drive it through the injectable adapter seam (__setSyncAdapter) with an
// in-memory Firestore double. The behaviour that matters most is data safety:
// an empty remote must never be read as "delete my local history", and a
// failed push must never damage a local write.

import { test, ok, equal } from './helpers.js';

const mod = await import('../src/js/utils/syncManager.js');
const {
  initSyncManager,
  pushAll,
  pullAll,
  reconcile,
  getSyncState,
  retryNow,
  formatSyncStatus,
  SYNC_STATES,
  __setSyncAdapter,
  __clearSyncAdapter,
  __setUidProvider,
  __clearUidProvider,
} = mod;

const USER = 'alice';
const UID = 'uid-A';
const ACC = 'acc1';

function memoryFirestore({ failWrites = false } = {}) {
  const docs = new Map();
  const key = (p) => p.join('/');
  return {
    docs,
    async getDocData(path) {
      const hit = docs.get(key(path));
      return hit ? hit.data : null;
    },
    async listCollection(colPath) {
      const prefix = `${key(colPath)}/`;
      const out = [];
      for (const [k, v] of docs) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest.includes('/')) continue;
        out.push({ id: v.data.id ?? rest, data: v.data });
      }
      return out;
    },
    async setDocData(path, data) {
      if (failWrites) throw new Error('PERMISSION_DENIED: simulated outage');
      docs.set(key(path), { data });
    },
    async batchSet(entries) {
      if (failWrites) throw new Error('PERMISSION_DENIED: simulated outage');
      for (const e of entries) docs.set(key(e.path), { data: e.data });
    },
  };
}

function seedLocal({ accounts = 1, trades = 3 } = {}) {
  const s = globalThis.localStorage;
  s.setItem('tradelog_session', USER);
  s.setItem(`tradelog_folders_${USER}`, JSON.stringify(
    Array.from({ length: accounts }, (_, i) => ({
      id: i === 0 ? ACC : `acc${i + 1}`,
      name: `Account ${i + 1}`,
      startingBalance: 10000,
      currentBalance: 10000,
      currency: 'USD',
      createdAt: '2024-01-01T00:00:00.000Z',
    })),
  ));
  s.setItem(`tradelog_trades_${ACC}`, JSON.stringify(
    Array.from({ length: trades }, (_, i) => ({
      id: `lt${i + 1}`,
      date: `2024-01-0${i + 1}`,
      pair: 'EUR/USD',
      type: 'TP',
      amount: 10 * (i + 1),
      createdAt: `2024-01-0${i + 1}T00:00:00.000Z`,
    })),
  ));
  s.setItem(`tradelog_rules_${USER}`, JSON.stringify([
    { id: 'r1', name: 'Risk <= 0.5%', category: 'RISK', type: 'PERCENTAGE_LIMIT', weight: 15, required: true, updatedAt: '2024-01-01T00:00:00.000Z' },
  ]));
  s.setItem(`tradelog_setups_${USER}`, '[]');
  s.setItem(`tradelog_reviews_${USER}`, '[]');
  s.setItem(`tradelog_exectrades_${USER}`, '[]');
  s.setItem(`tradelog_improvements_${USER}`, '[]');
  s.setItem(`tradelog_audit_${USER}`, '[]');
}

test('sync: init resolves a uid', async () => {
  seedLocal();
  __setUidProvider(() => UID);
  __setSyncAdapter(memoryFirestore());
  const r = await initSyncManager(USER);
  equal(r.success, true, 'init succeeds');
  ok(typeof r.uid === 'string' && r.uid.length > 0, 'returns a non-empty uid');
});

test('sync: empty remote + nonempty local uploads and never deletes local', async () => {
  seedLocal();
  __setUidProvider(() => UID);
  const before = globalThis.localStorage.getItem(`tradelog_folders_${USER}`);
  const fe = memoryFirestore();
  __setSyncAdapter(fe);
  await initSyncManager(USER);

  const res = await reconcile(USER);
  equal(res.success, true, 'reconcile succeeds');

  const paths = [...fe.docs.keys()];
  ok(paths.some((p) => p.includes('/accounts/')), 'accounts uploaded');
  ok(paths.some((p) => p.includes('/legacyTrades/')), 'legacy trades uploaded');
  ok(paths.some((p) => p.includes('/rules/')), 'rules uploaded');
  ok(!paths.some((p) => /users\/alice(\/|$)/.test(p)), 'nothing written under a username-keyed path');

  equal(globalThis.localStorage.getItem(`tradelog_folders_${USER}`), before,
    'local folders byte-identical after upload');
  ok(globalThis.localStorage.getItem(`tradelog_trades_${ACC}`), 'local trades still present');
});

test('sync: push then pull round-trips the dataset', async () => {
  seedLocal({ accounts: 2, trades: 3 });
  __setUidProvider(() => UID);
  __setSyncAdapter(memoryFirestore());
  await initSyncManager(USER);

  const pushed = await pushAll(USER);
  equal(pushed.success, true, 'pushAll succeeds');

  const pulled = await pullAll(USER);
  equal(pulled.success, true, 'pullAll succeeds');
  equal(pulled.data.accounts.length, 2, 'both accounts came back');
  equal(pulled.data.rules.length, 1, 'rule came back');
  equal((pulled.data.legacyTrades[ACC] || []).length, 3, 'all legacy trades came back');
});

test('sync: newer remote wins and remote-only records are downloaded', async () => {
  seedLocal();
  __setUidProvider(() => UID);
  const fe = memoryFirestore();
  __setSyncAdapter(fe);
  await initSyncManager(USER);
  const uid = UID;

  fe.docs.set(`users/${uid}/accounts/${ACC}`, {
    data: { id: ACC, name: 'Renamed Remotely', updatedAt: '2099-01-01T00:00:00.000Z' },
  });
  fe.docs.set(`users/${uid}/accounts/accRemote`, {
    data: { id: 'accRemote', name: 'Remote Only', updatedAt: '2099-01-01T00:00:00.000Z' },
  });

  const res = await reconcile(USER);
  equal(res.success, true, 'reconcile succeeds');

  const pulled = await pullAll(USER);
  const names = pulled.data.accounts.map((a) => a.name);
  ok(names.includes('Renamed Remotely'), 'newer remote record applied');
  ok(names.includes('Remote Only'), 'remote-only record downloaded, not dropped');
});

test('sync: failed push keeps local data intact and reports a safe state', async () => {
  seedLocal();
  __setUidProvider(() => UID);
  const before = globalThis.localStorage.getItem(`tradelog_folders_${USER}`);
  __setSyncAdapter(memoryFirestore({ failWrites: true }));
  await initSyncManager(USER);

  const res = await pushAll(USER);
  equal(res.success, false, 'push reports failure instead of throwing');
  equal(globalThis.localStorage.getItem(`tradelog_folders_${USER}`), before,
    'local data byte-identical after failure');

  const st = getSyncState();
  ok([SYNC_STATES.OFFLINE, SYNC_STATES.ERROR, SYNC_STATES.RETRYING].includes(st.status),
    `state signals a problem (got ${st.status})`);
  ok(typeof st.message === 'string' && st.message.length > 0, 'has a user-safe message');
  ok(!/PERMISSION_DENIED|firebase|auth\//i.test(st.message), 'message hides internal error detail');
});

test('sync: retryNow resolves rather than throwing while offline', async () => {
  seedLocal();
  __setSyncAdapter(memoryFirestore({ failWrites: true }));
  await initSyncManager(USER);
  let threw = false;
  try {
    await retryNow();
  } catch {
    threw = true;
  }
  equal(threw, false, 'retryNow does not throw');
});

test('sync: every state formats with a symbol and truthful text', () => {
  const cases = [
    ['IDLE', 'Not synced yet'],
    ['SYNCING', 'Syncing…'],
    ['SYNCED', 'Synced'],
    ['OFFLINE', 'Offline — changes saved on this device'],
    ['RETRYING', 'Retrying…'],
    ['ERROR', 'Sync unavailable'],
  ];
  for (const [status, text] of cases) {
    const f = formatSyncStatus({ status });
    equal(f.text, text, `${status} text`);
    ok(typeof f.symbol === 'string' && f.symbol.length > 0, `${status} has a symbol`);
  }
  const bogus = formatSyncStatus({ status: 'NOT_A_STATE' }).text;
  ok(bogus !== 'Synced' || getSyncState().status === SYNC_STATES.SYNCED,
    'an unrecognised status never fabricates a Synced claim');
});

export async function run() {
  const helpers = await import('./helpers.js');
  const result = await helpers.run();
  __clearSyncAdapter();
  __clearUidProvider();
  return result;
}
