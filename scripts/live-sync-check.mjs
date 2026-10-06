// Drives the REAL syncManager against REAL production Firestore, with a real
// Firebase Auth session. No mocked adapter - this is the app's actual code path.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

import { createUserWithEmailAndPassword, signInWithEmailAndPassword, deleteUser } from 'firebase/auth';
import { auth } from '../src/js/utils/firebase.js';
import * as sync from '../src/js/utils/syncManager.js';

const stamp = Date.now();
const USER = `synccheck${stamp}`;
const EMAIL = `${USER}@tradelog.app`;
const PASS = 'LiveSyncCheck!2345';
const API_KEY = 'AIzaSyCk5YTf80Tv2RP0prWbj1uhlBoHHEvGdRs';

const step = (m) => console.log(`\n== ${m}`);
const ok = (c, m) => console.log(`   ${c ? 'PASS' : 'FAIL'}  ${m}`);

let created = false;
try {
  step('create throwaway auth account');
  await createUserWithEmailAndPassword(auth, EMAIL, PASS).catch(async () => {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaSyCk5YTf80Tv2RP0prWbj1uhlBoHHEvGdRs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS, returnSecureToken: true }),
    });
    const j = await r.json();
    if (!j.idToken) throw new Error(j.error?.message || 'signUp failed');
    created = true;
  });
  const signIn = await signInWithEmailAndPassword(auth, EMAIL, PASS);
  const uid = signIn.user.uid;
  ok(!!uid, `signed in, uid=${uid}`);

  step('seed local-only data (simulates months of unsynced history)');
  localStorage.setItem('tradelog_session', USER);
  localStorage.setItem(`tradelog_folders_${USER}`, JSON.stringify([
    { id: 'acc1', name: 'Live Check', startingBalance: 10000, currentBalance: 10000, currency: 'USD', createdAt: '2024-01-01T00:00:00.000Z' },
  ]));
  localStorage.setItem('tradelog_trades_acc1', JSON.stringify([
    { id: 'lt1', date: '2024-01-01', pair: 'EUR/USD', type: 'TP', amount: 25, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'lt2', date: '2024-01-02', pair: 'XAU/USD', type: 'SL', amount: 10, createdAt: '2024-01-02T00:00:00.000Z' },
  ]));
  localStorage.setItem(`tradelog_rules_${USER}`, JSON.stringify([
    { id: 'r1', name: 'Risk <= 0.5%', category: 'RISK', type: 'PERCENTAGE_LIMIT', weight: 15, required: true, validation: { operator: '<=', value: 0.5, unit: '%' }, updatedAt: '2024-01-01T00:00:00.000Z' },
  ]));
  for (const k of ['setups', 'reviews', 'exectrades', 'improvements', 'audit']) {
    localStorage.setItem(`tradelog_${k}_${USER}`, '[]');
  }
  ok(localStorage.getItem(`tradelog_folders_${USER}`) !== null, 'local seed present');

  step('initSyncManager + reconcile (remote is empty -> must upload)');
  const init = await sync.initSyncManager(USER);
  ok(init.success === true, `initSyncManager success (uid=${init.uid})`);
  const rec = await sync.reconcile(USER);
  ok(rec.success === true, `reconcile success`);
  const deleted = JSON.stringify(rec.plan || '').match(/"(delete|remove|prune)"/gi);
  ok(!deleted, `plan contains no destructive action ${deleted ? deleted.join(',') : ''}`);

  step('verify documents actually landed in production');
  const base = `https://firestore.googleapis.com/v1/projects/tradelog-8d1f7/databases/(default)/documents`;
  const h = { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` };
  for (const p of [`users/${uid}`, `users/${uid}/accounts/acc1`, `users/${uid}/rules/r1`, `users/${uid}/legacyTrades/acc1/entries/lt1`]) {
    const r = await fetch(`${base}/${p}`, { headers: h });
    ok(r.ok, `exists: ${p}`);
  }

  step('pullAll round-trip');
  const pulled = await sync.pullAll(USER);
  ok(pulled.success === true, 'pullAll success');
  ok(pulled.data.accounts?.length === 1, `accounts pulled: ${pulled.data.accounts?.length}`);
  ok((pulled.data.legacyTrades?.acc1 || []).length === 2, `legacy trades pulled: ${(pulled.data.legacyTrades?.acc1 || []).length}`);
  ok(pulled.data.rules?.length === 1, `rules pulled: ${pulled.data.rules?.length}`);

  step('local data intact after upload');
  ok(JSON.parse(localStorage.getItem(`tradelog_folders_${USER}`)).length === 1, 'local accounts still 1');
  ok(JSON.parse(localStorage.getItem('tradelog_trades_acc1')).length === 2, 'local trades still 2');
} finally {
  step('cleanup: delete the throwaway account and prove it is gone');
  try {
    if (auth.currentUser) {
      await deleteUser(auth.currentUser).catch(async () => {
        const tok = await auth.currentUser.getIdToken();
        await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: tok }),
        });
      });
    }
    // Prove deletion took effect. This must go through the REST API: the
    // Firebase SDK holds an in-memory session, so re-signing in-process
    // succeeds from cache and would report a false "still exists".
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS, returnSecureToken: true }),
    });
    const body = await res.json().catch(() => ({}));
    const stillThere = Boolean(body.idToken);
    console.log(`   ${stillThere ? 'FAIL' : 'PASS'}  throwaway account no longer exists (${body.error?.message || 'sign-in refused'})`);
    if (stillThere) process.exitCode = 1;
  } catch (e) {
    console.log(`   FAIL  cleanup error: ${e.message}`);
    process.exitCode = 1;
  }
  store.clear();
  console.log('   PASS  local seed cleared');
}
