# TradeLog — Firebase security model

> Rules were authored offline. The owner must review and deploy them.
> Never commit secrets/API keys alongside these files (none are included).

## 1. Security model

* **Single authorization primitive:** `request.auth.uid` — the Firebase Auth
  UID minted server-side. Email, username, and every client-supplied field are
  treated as attacker-controlled and confer **zero** access.
* **Ownership:** a signed-in user may read/write **only** under
  `users/{their own uid}`. Unauthenticated access is denied everywhere.
* **Default deny:** any path not explicitly listed below has no `allow` rule
  and is denied. There is no catch-all.
* **No legacy-username access:** old `users/{username}` documents are NOT
  reachable (their `{uid}` segment never equals a real UID). Migrate the data
  to UID paths — do not weaken the rules.
* **Anti id-spoofing:** where the app stores an `id` field inside a document,
  create/update requires it to equal the document ID in the path (when the
  field is present). The check is presence-guarded so legitimate partial
  merges via `setDoc(..., {merge:true})` keep working. Deletes are
  ownership-only (`request.resource` is null on delete).

Protected paths (all under `users/{uid}`, owner-only):

| Path | Notes |
| --- | --- |
| `users/{uid}` | profile / merged aggregate doc, no id check |
| `users/{uid}/accounts/{accountId}` | `id` must match `accountId` |
| `users/{uid}/accounts/{accountId}/journal/{entryId}` | own explicit rule — parent rule does NOT cascade; `id` must match `entryId` |
| `users/{uid}/trades/{tradeId}` | `id` must match `tradeId` |
| `users/{uid}/legacyTrades/{accountId}` | discovery marker doc; binds `accountId` field |
| `users/{uid}/legacyTrades/{accountId}/entries/{tradeId}` | legacy TP/SL trades; needs its own match because a document cannot sit under a document |
| `users/{uid}/rules/{ruleId}` | `id` must match `ruleId` |
| `users/{uid}/setups/{setupId}` | `id` must match `setupId` |
| `users/{uid}/reviews/{reviewId}` | `id` must match `reviewId` |
| `users/{uid}/propConfigs/{accountId}` | binds `accountId` field (no `id` field on this doc) |
| `users/{uid}/improvements/{improvementId}` | `id` must match `improvementId` |
| `users/{uid}/audit/{entryId}` | `id` must match `entryId` |

Why the nested `journal` rule matters: in Firestore, an `allow` on
`accounts/{accountId}` covers ONLY that document, not its `journal`
subcollection; and a recursive `match /users/{uid}/{doc=**}` with a bare
signed-in check would leak every user's data to every other user. Each rule
re-checks `request.auth.uid == {uid}` from the path, so cross-user read and
cross-user write are both impossible.

## 2. Deploy (owner only — requires `firebase login` first)

```bash
cd /home/darkdevil/TRADELOG
firebase use default          # selects tradelog-8d1f7 via .firebaserc
firebase deploy --only firestore:rules     # deploy the rules
firebase deploy --only firestore:indexes   # no-op while index list is empty
firebase deploy --only hosting             # serve dist/ (hash-router SPA)
```

Config notes (`firebase.json`): Firestore deploys `firestore.rules` +
`firestore.indexes.json`; hosting serves `dist` with a `** → /index.html`
rewrite (required for the hash-router SPA so deep links resolve);
emulators use auth **9099** (default), hosting **5000** (default), Firestore
**4400** (moved off the 8080 default to avoid local clashes).

## 3. Verify with the Firebase Emulator (before deploying)

```bash
cd /home/darkdevil/TRADELOG
firebase emulators:start --only auth,firestore
```

Seed two users via the Auth emulator (create `UID_A` and `UID_B`), then mint
**emulator-only** unsigned test JWTs (the emulator decodes the payload
without verifying a signature — these tokens are worthless in production):

```bash
# Token asserting UID_A:
node -e "const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');console.log([b({alg:'none',typ:'JWT'}),b({sub:'UID_A',user_id:'UID_A'}),''].join('.'))"
# Repeat with UID_B for a second token. Save as $TOKEN_A / $TOKEN_B.
export FS=http://localhost:4400/v1/projects/tradelog-8d1f7/databases/'(default)'/documents
```

REST shapes used below (Firestore v1 REST over the emulator):

```bash
# READ own profile:
curl -s -o /dev/null -w '%{http_code}\n' "$FS/users/UID_A" -H "Authorization: Bearer $TOKEN_A"
# WRITE own trade doc:
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$FS/users/UID_A/trades/t1" \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"fields":{"id":{"stringValue":"t1"}}}'
```

Console alternative (no curl): Firebase console → Firestore → **Rules
playground** → load `firestore.rules` → simulate `get`/`set` on each matrix
row with Authentication ON (UID_A / UID_B) and OFF.

## 4. Post-deploy verification matrix (owner runs AFTER deploying)

Expect HTTP **200** = ALLOWED, **403** (`PERMISSION_DENIED`, any non-200) =
DENIED. Replace `$TOKEN_A`/`$TOKEN_B` with real ID tokens
(`await auth.currentUser.getIdToken()` in the app console) and `$FS` with
`https://firestore.googleapis.com/v1/projects/tradelog-8d1f7/databases/(default)/documents`.

| # | Case | curl shape | Expect |
| --- | --- | --- | --- |
| 1 | Unauth read own path | `curl $FS/users/UID_A` (no header) | DENIED |
| 2 | Unauth write own path | `curl -X PATCH $FS/users/UID_A/trades/t1 -H 'Content-Type: application/json' -d '{"fields":{"id":{"stringValue":"t1"}}}'` (no header) | DENIED |
| 3 | A reads A | `curl $FS/users/UID_A -H "Authorization: Bearer $TOKEN_A"` | ALLOWED |
| 4 | A writes A | `PATCH $FS/users/UID_A/trades/t1` + Bearer A, body `id=t1` | ALLOWED |
| 5 | A reads B | `curl $FS/users/UID_B -H "Authorization: Bearer $TOKEN_A"` | DENIED |
| 6 | A writes B | `PATCH $FS/users/UID_B/trades/t1` + Bearer A, body `id=t1` | DENIED |
| 7 | B reads A (incl. nested journal) | `curl $FS/users/UID_A/accounts/acc1/journal/e1 -H "Authorization: Bearer $TOKEN_B"` | DENIED |
| 8 | B writes A (incl. nested journal) | `PATCH $FS/users/UID_A/accounts/acc1/journal/e1` + Bearer B | DENIED |
| 9 | A writes A with spoofed id | `PATCH $FS/users/UID_A/trades/t1` + Bearer A, body `id=someone-else` | DENIED |
| 10 | A partial merge w/o id field | `PATCH $FS/users/UID_A/trades/t1?updateMask.fieldPaths=notes` + Bearer A, body `notes=hi` | ALLOWED |

If any DENIED row returns 200, do NOT ship — re-open `firestore.rules`.
