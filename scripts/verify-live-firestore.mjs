// Live Firestore authorization matrix for TradeLog.
//
// Static checks cannot prove owner access works, so this exercises the deployed
// rules over the real API with two throwaway users. It creates both accounts,
// runs every row, then deletes both accounts so no residue is left behind.
//
//   node scripts/verify-live-firestore.mjs
//
// Before `firebase deploy --only firestore:rules`, every row should read
// DENIED because the rules deny everything. After deploying, owner rows flip
// to ALLOWED and the cross-user rows must stay DENIED.

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'tradelog-8d1f7';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCk5YTf80Tv2RP0prWbj1uhlBoHHEvGdRs';
const DOC_ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';

const stamp = Date.now();
const ALICE = `tl-verify-a-${stamp}@tradelog.app`;
const BOB = `tl-verify-b-${stamp}@tradelog.app`;
const CREDS = { A: null, B: null };

const results = [];

async function signUp(email) {
  const r = await fetch(`${IDENTITY}/accounts:signUp?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'VerifyOnly!2345', returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error(`signUp failed for ${email}: ${j.error?.message || r.status}`);
  return { uid: j.localId, token: j.idToken };
}

async function cleanup() {
  for (const cred of Object.values(CREDS)) {
    if (!cred) continue;
    await fetch(`${IDENTITY}/accounts:delete?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: cred.token }),
    }).catch(() => {});
  }
}

async function probe({ who, method, docPath, expect, note }) {
  const headers = {};
  const token = who === 'none' ? null : CREDS[who]?.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  let url = `${DOC_ROOT}/${docPath}`;
  const init = { method, headers };
  if (method === 'PATCH' || method === 'POST') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify({ fields: { probe: { stringValue: 'verify' } } });
    url += '?updateMask.fieldPaths=probe';
  }

  const res = await fetch(url, init);

  // Distinguish three outcomes, because conflating them hides whether the
  // rules actually permitted the request:
  //   2xx            -> ALLOWED, document exists
  //   404 NOT_FOUND  -> PERMITTED, rules allowed but no such document.
  //                     Firestore only reports absence once rules have passed.
  //   403 DENIED     -> rules refused (and it refuses before checking
  //                     existence, so a 403 never leaks whether a doc exists).
  let outcome;
  if (res.ok) {
    outcome = 'ALLOWED';
  } else if (res.status === 404) {
    outcome = 'PERMITTED';
  } else {
    outcome = 'DENIED';
  }
  const detail = outcome === 'ALLOWED'
    ? 'ALLOWED'
    : `${outcome} (${res.status}${outcome === 'DENIED' ? ' PERMISSION_DENIED' : ' NOT_FOUND'})`;

  const permitted = outcome !== 'DENIED';
  const pass = permitted === (expect === 'ALLOWED');
  results.push({ row: `${who} ${method} ${docPath}`, expect, got: detail, pass });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  [${who}] ${method} ${docPath} -> ${detail} (expected ${expect})`);
  return pass;
}

async function main() {
  console.log(`project: ${PROJECT}\n`);
  console.log('creating two throwaway users...');
  CREDS.A = await signUp(ALICE);
  CREDS.B = await signUp(BOB);
  console.log(`  A uid ${CREDS.A.uid}\n  B uid ${CREDS.B.uid}\n`);

  const A = CREDS.A.uid;
  const B = CREDS.B.uid;

  console.log('--- unauthenticated ---');
  await probe({ who: 'none', method: 'GET', docPath: `users/${A}`, expect: 'DENIED' });
  await probe({ who: 'none', method: 'PATCH', docPath: `users/${A}`, expect: 'DENIED' });

  console.log('\n--- owner access (write first, then read back the same document) ---');
  await probe({ who: 'A', method: 'PATCH', docPath: `users/${A}`, expect: 'ALLOWED' });
  await probe({ who: 'A', method: 'GET', docPath: `users/${A}`, expect: 'ALLOWED', note: 'profile read back' });
  await probe({ who: 'A', method: 'PATCH', docPath: `users/${A}/accounts/acc1`, expect: 'ALLOWED', note: 'no id field -> partial merge allowed' });
  await probe({ who: 'A', method: 'GET', docPath: `users/${A}/accounts/acc1`, expect: 'ALLOWED' });
  await probe({ who: 'A', method: 'PATCH', docPath: `users/${A}/accounts/acc1/journal/e1`, expect: 'ALLOWED' });
  await probe({ who: 'A', method: 'GET', docPath: `users/${A}/accounts/acc1/journal/e1`, expect: 'ALLOWED', note: 'nested journal' });
  await probe({ who: 'A', method: 'PATCH', docPath: `users/${A}/legacyTrades/acc1/entries/t1`, expect: 'ALLOWED', note: 'legacy trades' });
  await probe({ who: 'A', method: 'GET', docPath: `users/${A}/legacyTrades/acc1/entries/t1`, expect: 'ALLOWED' });
  await probe({ who: 'A', method: 'PATCH', docPath: `users/${A}/rules/r1`, expect: 'ALLOWED' });
  await probe({ who: 'A', method: 'GET', docPath: `users/${A}/rules/r1`, expect: 'ALLOWED' });

  console.log('\n--- cross-user (must always be denied) ---');
  await probe({ who: 'A', method: 'GET', docPath: `users/${B}`, expect: 'DENIED' });
  await probe({ who: 'A', method: 'PATCH', docPath: `users/${B}`, expect: 'DENIED' });
  await probe({ who: 'A', method: 'GET', docPath: `users/${B}/accounts/acc1`, expect: 'DENIED' });
  await probe({ who: 'A', method: 'PATCH', docPath: `users/${B}/rules/r1`, expect: 'DENIED' });
  await probe({ who: 'A', method: 'GET', docPath: `users/${B}/accounts/acc1/journal/e1`, expect: 'DENIED' });
  await probe({ who: 'B', method: 'GET', docPath: `users/${A}`, expect: 'DENIED' });
  await probe({ who: 'B', method: 'PATCH', docPath: `users/${A}`, expect: 'DENIED' });
  await probe({ who: 'B', method: 'GET', docPath: `users/${A}/accounts/acc1`, expect: 'DENIED' });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} rows as expected`);

  const allDenied = results.every((r) => r.got.startsWith('DENIED'));
  if (allDenied) {
    console.log('\nEvery row was DENIED, including owner rows.');
    console.log('That is expected BEFORE deploying. Run:');
    console.log('  firebase deploy --only firestore:rules');
    console.log('then re-run this script and confirm owner rows flip to ALLOWED');
    console.log('while every cross-user row stays DENIED.');
  } else if (failed.length) {
    console.log('\nUNEXPECTED. Rows that did not match expectation:');
    for (const f of failed) console.log(`  - [${f.row}] expected ${f.expect}, got ${f.got}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll rows as expected: owner access works, cross-user access is denied.');
  }
}

main()
  .catch((e) => {
    console.error(`\nverification aborted: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
