// ============================================
// Sync Manager — UID-keyed Firestore sync layer
// Vanilla ESM, offline-first. No import-time side effects.
// ============================================
// Every remote path lives under users/{authUid}/... so it satisfies rules
// keyed on request.auth.uid. Local data is authoritative: a failed push
// never blocks or rolls back a local write, and reconciliation is
// additive-only — an empty/missing remote collection is treated as a
// legitimate first-run migration (upload local), never as a delete-local
// signal. Per-record merge keeps the newer timestamp; records without any
// timestamp keep local and note the remote side as a duplicate candidate.
// Device-local keys (session, theme, migration flags, trading lock,
// screenshot blobs/mirror, analytics prefs, transient UI filters) are never
// uploaded.
import { auth, db, SIGNED_OUT_ERROR } from './firebase.js';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import { mergeAuditEntries } from './auditLog.js';
import { generateId } from './helpers.js';

export const SYNC_STATES = Object.freeze({
  IDLE: 'IDLE',
  SYNCING: 'SYNCING',
  SYNCED: 'SYNCED',
  OFFLINE: 'OFFLINE',
  RETRYING: 'RETRYING',
  ERROR: 'ERROR',
});

const SCHEMA_VERSION = 1;
const SESSION_KEY = 'tradelog_session';
const PUSH_DEBOUNCE_MS = 1000;
const BATCH_CHUNK_SIZE = 400;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30000;
const RETRY_MAX_ATTEMPTS = 5;

// User-safe strings only — raw Firebase codes/messages never leave this module.
const SAFE_MESSAGE = Object.freeze({
  idle: 'Not synced yet. Your data is saved on this device.',
  syncing: 'Syncing your data…',
  synced: 'All changes synced.',
  offline: 'You are offline. Changes are saved on this device and will sync later.',
  retrying: 'Connection lost. Retrying sync…',
  error: 'Sync is unavailable right now. Changes are saved on this device.',
  signedOut: 'Not signed in. Your data is saved on this device.',
});

function normalizeUser(user) {
  if (user && typeof user === 'object') {
    return String(user.username ?? user.userId ?? user.user ?? '').trim().toLowerCase();
  }
  return String(user || '').trim().toLowerCase();
}

function resolveUsername(hint) {
  const explicit = normalizeUser(hint);
  if (explicit) return explicit;
  try {
    if (typeof localStorage !== 'undefined') {
      return normalizeUser(localStorage.getItem(SESSION_KEY));
    }
  } catch {
    // storage unavailable — fall through to empty
  }
  return '';
}

// Test seam, mirroring __setSyncAdapter. Production always resolves the uid
// from the live Firebase Auth session; tests cannot provide one, so without
// this the data-safety guarantees (additive reconcile, no destructive
// overwrite, local preservation on failure) would be untestable.
let _uidProvider = null;

export function __setUidProvider(fn) {
  _uidProvider = typeof fn === 'function' ? fn : null;
}

export function __clearUidProvider() {
  _uidProvider = null;
}

function resolveUid() {
  try {
    if (_uidProvider) {
      const u = _uidProvider();
      return u ? String(u) : null;
    }
    const u = auth && auth.currentUser && auth.currentUser.uid;
    return u ? String(u) : null;
  } catch {
    return null;
  }
}

function safeParse(raw, fallback) {
  try {
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readLocal(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return safeParse(raw, fallback);
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function plainCopy(v) {
  try {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  } catch {
    return Array.isArray(v) ? [...v] : v;
  }
}

// ---- Observable state ----

const _state = {
  status: SYNC_STATES.IDLE,
  lastSyncedAt: null,
  lastError: null,
  pendingWrites: 0,
  message: SAFE_MESSAGE.idle,
};

const _listeners = new Set();

function setState(patch) {
  try {
    Object.assign(_state, patch);
    const snap = { ..._state };
    for (const fn of [..._listeners]) {
      try {
        fn(snap);
      } catch {
        // a subscriber must never break sync
      }
    }
  } catch {
    // state bookkeeping never throws
  }
}

export function getSyncState() {
  return { ..._state };
}

export function subscribeSyncState(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

const SYNC_SYMBOLS = Object.freeze({
  [SYNC_STATES.IDLE]: '○',
  [SYNC_STATES.SYNCING]: '◌',
  [SYNC_STATES.SYNCED]: '●',
  [SYNC_STATES.OFFLINE]: '◍',
  [SYNC_STATES.RETRYING]: '◌',
  [SYNC_STATES.ERROR]: '✕',
});

const SYNC_TEXTS = Object.freeze({
  [SYNC_STATES.IDLE]: 'Not synced yet',
  [SYNC_STATES.SYNCING]: 'Syncing…',
  [SYNC_STATES.SYNCED]: 'Synced',
  [SYNC_STATES.OFFLINE]: 'Offline — changes saved on this device',
  [SYNC_STATES.RETRYING]: 'Retrying…',
  [SYNC_STATES.ERROR]: 'Sync unavailable',
});

export function formatSyncStatus(state) {
  try {
    const s = state && typeof state === 'object' ? state.status : state;
    const status = SYNC_STATES[s] ? s : _state.status;
    return { symbol: SYNC_SYMBOLS[status], text: SYNC_TEXTS[status] };
  } catch {
    return { symbol: SYNC_SYMBOLS.IDLE, text: SYNC_TEXTS.IDLE };
  }
}

// ---- Firestore backend seam (swappable for offline tests) ----

let _adapter = null;

const realBackend = {
  async getDocData(path) {
    const snap = await getDoc(doc(db, ...path));
    return snap.exists() ? snap.data() : null;
  },
  async listCollection(colPath) {
    const snap = await getDocs(collection(db, ...colPath));
    const out = [];
    snap.forEach((d) => out.push({ id: d.id, data: d.data() }));
    return out;
  },
  async setDocData(path, data) {
    await setDoc(doc(db, ...path), data, { merge: true });
  },
  async batchSet(entries) {
    for (let i = 0; i < entries.length; i += BATCH_CHUNK_SIZE) {
      const chunk = entries.slice(i, i + BATCH_CHUNK_SIZE);
      const batch = writeBatch(db);
      for (const e of chunk) batch.set(doc(db, ...e.path), e.data, { merge: true });
      await batch.commit();
    }
  },
};

function backend() {
  return _adapter || realBackend;
}

// Test-only seam: inject an in-memory Firestore stand-in. Not used by the app.
export function __setSyncAdapter(a) {
  _adapter = a || null;
}

export function __clearSyncAdapter() {
  _adapter = null;
}

// ---- Remote paths (all keyed by Auth UID) ----

const pProfile = (uid) => ['users', uid];
const pAccount = (uid, accountId) => ['users', uid, 'accounts', String(accountId)];
const pJournal = (uid, accountId, entryId) => ['users', uid, 'accounts', String(accountId), 'journal', String(entryId)];
const pTrade = (uid, tradeId) => ['users', uid, 'trades', String(tradeId)];
// Spec path users/{uid}/legacyTrades/{accountId}/{tradeId} has an odd segment
// count so it cannot address a document; the trailing entries collection
// below preserves every ID from the spec while staying a valid doc path.
const pLegacy = (uid, accountId, tradeId) => ['users', uid, 'legacyTrades', String(accountId), 'entries', String(tradeId)];
const cLegacyAccounts = (uid) => ['users', uid, 'legacyTrades'];
const cLegacyEntries = (uid, accountId) => ['users', uid, 'legacyTrades', String(accountId), 'entries'];
const pRule = (uid, id) => ['users', uid, 'rules', String(id)];
const pSetup = (uid, id) => ['users', uid, 'setups', String(id)];
const pReview = (uid, id) => ['users', uid, 'reviews', String(id)];
const pPropConfig = (uid, accountId) => ['users', uid, 'propConfigs', String(accountId)];
const pImprovement = (uid, id) => ['users', uid, 'improvements', String(id)];
const pAudit = (uid, id) => ['users', uid, 'audit', String(id)];

const cAccounts = (uid) => ['users', uid, 'accounts'];
const cJournal = (uid, accountId) => ['users', uid, 'accounts', String(accountId), 'journal'];
const cTrades = (uid) => ['users', uid, 'trades'];
const cRules = (uid) => ['users', uid, 'rules'];
const cSetups = (uid) => ['users', uid, 'setups'];
const cReviews = (uid) => ['users', uid, 'reviews'];
const cPropConfigs = (uid) => ['users', uid, 'propConfigs'];
const cImprovements = (uid) => ['users', uid, 'improvements'];
const cAudit = (uid) => ['users', uid, 'audit'];

// ---- Local snapshot ----

function readLocalSnapshot(username) {
  const accountsRaw = readLocal(`tradelog_folders_${username}`, []);
  const accounts = Array.isArray(accountsRaw) ? accountsRaw : [];
  const journal = {};
  const legacyTrades = {};
  for (const f of accounts) {
    const fid = f && f.id != null ? String(f.id) : '';
    if (!fid) continue;
    const j = readLocal(`tradelog_journal_${fid}`, []);
    journal[fid] = Array.isArray(j) ? j : [];
    const t = readLocal(`tradelog_trades_${fid}`, []);
    legacyTrades[fid] = Array.isArray(t) ? t : [];
  }
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    accounts,
    journal,
    executedTrades: asArray(readLocal(`tradelog_exectrades_${username}`, [])),
    legacyTrades,
    rules: asArray(readLocal(`tradelog_rules_${username}`, [])),
    setups: asArray(readLocal(`tradelog_setups_${username}`, [])),
    reviews: asArray(readLocal(`tradelog_reviews_${username}`, [])),
    propConfigs: asObject(readLocal(`tradelog_propconfig_${username}`, {})),
    improvements: asArray(readLocal(`tradelog_improvements_${username}`, [])),
    audit: asArray(readLocal(`tradelog_audit_${username}`, [])),
  };
}

// Ensure every record that will become a document has a stable id. Assigning
// a fresh id to an id-less local record is additive (it only makes the record
// addressable) and the id is written back so push→pull round-trips exactly.
function ensureIds(records) {
  let dirty = false;
  const list = Array.isArray(records) ? records : [];
  for (const r of list) {
    if (r && typeof r === 'object' && !Array.isArray(r) && (r.id == null || r.id === '')) {
      try {
        r.id = generateId();
        dirty = true;
      } catch {
        // leave id-less; caller skips it
      }
    }
  }
  return dirty;
}

function recordId(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return '';
  const id = rec.id ?? rec.entryId ?? rec.tradeId;
  return id == null ? '' : String(id);
}

function timeOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  for (const k of ['updatedAt', 'timestamp', 'createdAt', 'date', 'openedAt']) {
    const v = rec[k];
    if (v == null || v === '') continue;
    const t = new Date(v).getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// Newer timestamp wins. Ties and timestamp-less records keep local (never
// destructive); timestamp-less pairs flag the remote side as a duplicate
// candidate for the caller to surface, never to delete.
function pickWinner(localRec, remoteRec) {
  const lt = timeOf(localRec);
  const rt = timeOf(remoteRec);
  if (lt != null && rt != null) {
    if (rt > lt) return { rec: remoteRec, source: 'remote' };
    return { rec: localRec, source: 'local', conflict: rt < lt };
  }
  return { rec: localRec, source: 'local', duplicateCandidate: true };
}

function mergeById(localArr, remoteArr) {
  const local = Array.isArray(localArr) ? localArr : [];
  const remote = Array.isArray(remoteArr) ? remoteArr : [];
  const byLocal = new Map();
  for (const r of local) {
    const id = recordId(r);
    if (id && !byLocal.has(id)) byLocal.set(id, r);
  }
  const merged = [];
  const remoteOnly = [];
  const uploaded = [];
  const downloaded = [];
  const keptLocal = [];
  const duplicates = [];
  const seen = new Set();
  for (const r of local) {
    const id = recordId(r);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(r);
  }
  for (const r of remote) {
    const id = recordId(r);
    if (!id) continue;
    if (seen.has(id)) {
      if (byLocal.has(id)) {
        const w = pickWinner(byLocal.get(id), r);
        if (w.source === 'remote') {
          const idx = merged.findIndex((m) => recordId(m) === id);
          if (idx !== -1) merged[idx] = w.rec;
          downloaded.push(id);
        } else {
          keptLocal.push(id);
          uploaded.push(id);
          if (w.duplicateCandidate) duplicates.push(id);
        }
      }
      continue;
    }
    seen.add(id);
    if (byLocal.has(id)) {
      const w = pickWinner(byLocal.get(id), r);
      const idx = merged.findIndex((m) => recordId(m) === id);
      if (w.source === 'remote') {
        if (idx !== -1) merged[idx] = w.rec;
        downloaded.push(id);
      } else {
        keptLocal.push(id);
        uploaded.push(id);
        if (w.duplicateCandidate) duplicates.push(id);
      }
    } else {
      merged.push(r);
      remoteOnly.push(id);
      downloaded.push(id);
    }
  }
  const localIds = new Set([...byLocal.keys()]);
  const remoteIds = new Set(remote.map(recordId).filter(Boolean));
  const localOnly = [...localIds].filter((id) => !remoteIds.has(id));
  return { merged, localOnly, remoteOnly, uploaded, downloaded, keptLocal, duplicates };
}

function stripId(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return plainCopy(rec);
  const body = { ...rec };
  delete body.id;
  return plainCopy(body);
}

function withId(id, body) {
  // id first: mirrors the canonical local shape so push→pull round-trips
  // with stable field order for the common case.
  const rec = { id: String(id) };
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const k of Object.keys(body)) {
      if (k !== 'id') rec[k] = body[k];
    }
  }
  return rec;
}

// ---- Remote fetch (read-only) ----

async function fetchRemote(uid) {
  const be = backend();
  const [profile, accountDocs, tradeDocs, ruleDocs, setupDocs, reviewDocs, propDocs, improvementDocs, auditDocs, legacyAccountDocs] = await Promise.all([
    be.getDocData(pProfile(uid)).catch(() => null),
    be.listCollection(cAccounts(uid)).catch(() => []),
    be.listCollection(cTrades(uid)).catch(() => []),
    be.listCollection(cRules(uid)).catch(() => []),
    be.listCollection(cSetups(uid)).catch(() => []),
    be.listCollection(cReviews(uid)).catch(() => []),
    be.listCollection(cPropConfigs(uid)).catch(() => []),
    be.listCollection(cImprovements(uid)).catch(() => []),
    be.listCollection(cAudit(uid)).catch(() => []),
    be.listCollection(cLegacyAccounts(uid)).catch(() => []),
  ]);
  const accounts = (Array.isArray(accountDocs) ? accountDocs : []).map((d) => withId(d.id, d.data));
  const journal = {};
  const legacyTrades = {};
  await Promise.all(
    accounts.map(async (a) => {
      const aid = a && a.id ? String(a.id) : '';
      if (!aid) return;
      const entries = await be.listCollection(cJournal(uid, aid)).catch(() => []);
      journal[aid] = (Array.isArray(entries) ? entries : []).map((d) => withId(d.id, d.data));
    }),
  );
  const legacyIds = new Set([
    ...accounts.map((a) => String(a.id)),
    ...(Array.isArray(legacyAccountDocs) ? legacyAccountDocs : []).map((d) => String(d.id)),
  ]);
  await Promise.all(
    [...legacyIds].map(async (aid) => {
      if (!aid) return;
      const entries = await be.listCollection(cLegacyEntries(uid, aid)).catch(() => []);
      const list = (Array.isArray(entries) ? entries : []).map((d) => withId(d.id, d.data));
      if (list.length > 0 || legacyTrades[aid] == null) legacyTrades[aid] = list;
    }),
  );
  return {
    profile: profile && typeof profile === 'object' ? profile : null,
    accounts,
    journal,
    executedTrades: (Array.isArray(tradeDocs) ? tradeDocs : []).map((d) => withId(d.id, d.data)),
    legacyTrades,
    rules: (Array.isArray(ruleDocs) ? ruleDocs : []).map((d) => withId(d.id, d.data)),
    setups: (Array.isArray(setupDocs) ? setupDocs : []).map((d) => withId(d.id, d.data)),
    reviews: (Array.isArray(reviewDocs) ? reviewDocs : []).map((d) => withId(d.id, d.data)),
    propConfigs: Object.fromEntries(
      (Array.isArray(propDocs) ? propDocs : []).map((d) => [String(d.id), d.data]),
    ),
    improvements: (Array.isArray(improvementDocs) ? improvementDocs : []).map((d) => withId(d.id, d.data)),
    audit: (Array.isArray(auditDocs) ? auditDocs : []).map((d) => withId(d.id, d.data)),
  };
}

function toLocalShapedPayload(snap) {
  return {
    accounts: Array.isArray(snap.accounts) ? plainCopy(snap.accounts) : [],
    journal: plainCopy(snap.journal && typeof snap.journal === 'object' ? snap.journal : {}),
    executedTrades: Array.isArray(snap.executedTrades) ? plainCopy(snap.executedTrades) : [],
    legacyTrades: plainCopy(snap.legacyTrades && typeof snap.legacyTrades === 'object' ? snap.legacyTrades : {}),
    rules: Array.isArray(snap.rules) ? plainCopy(snap.rules) : [],
    setups: Array.isArray(snap.setups) ? plainCopy(snap.setups) : [],
    reviews: Array.isArray(snap.reviews) ? plainCopy(snap.reviews) : [],
    propConfigs: plainCopy(snap.propConfigs && typeof snap.propConfigs === 'object' ? snap.propConfigs : {}),
    improvements: Array.isArray(snap.improvements) ? plainCopy(snap.improvements) : [],
    audit: Array.isArray(snap.audit) ? plainCopy(snap.audit) : [],
  };
}

function writeSnapshotToLocal(username, snap) {
  writeLocal(`tradelog_folders_${username}`, snap.accounts || []);
  const journal = snap.journal || {};
  const legacy = snap.legacyTrades || {};
  const accountIds = new Set([
    ...(Array.isArray(snap.accounts) ? snap.accounts.map((a) => a && a.id).filter(Boolean).map(String) : []),
    ...Object.keys(journal),
    ...Object.keys(legacy),
  ]);
  for (const aid of accountIds) {
    if (Object.prototype.hasOwnProperty.call(journal, aid)) {
      writeLocal(`tradelog_journal_${aid}`, journal[aid]);
    }
    if (Object.prototype.hasOwnProperty.call(legacy, aid)) {
      writeLocal(`tradelog_trades_${aid}`, legacy[aid]);
    }
  }
  writeLocal(`tradelog_exectrades_${username}`, snap.executedTrades || []);
  writeLocal(`tradelog_rules_${username}`, snap.rules || []);
  writeLocal(`tradelog_setups_${username}`, snap.setups || []);
  writeLocal(`tradelog_reviews_${username}`, snap.reviews || []);
  writeLocal(`tradelog_propconfig_${username}`, snap.propConfigs || {});
  writeLocal(`tradelog_improvements_${username}`, snap.improvements || []);
  writeLocal(`tradelog_audit_${username}`, snap.audit || []);
}

// ---- Error classification (user-safe surface only) ----

function classifyError(err) {
  const code = String((err && err.code) || '').toLowerCase();
  const msg = String((err && err.message) || '').toLowerCase();
  if (code === 'permission-denied' || code === 'unauthenticated' || msg.includes('permission')) {
    return { key: 'permission', message: SAFE_MESSAGE.error };
  }
  if (
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'cancelled' ||
    code === 'failed-precondition' ||
    code.includes('network') ||
    msg.includes('network') ||
    msg.includes('offline') ||
    msg.includes('failed to fetch') ||
    msg.includes('timed out') ||
    msg.includes('timeout')
  ) {
    return { key: 'offline', message: SAFE_MESSAGE.offline };
  }
  if (err && err.signedOut === true) return { key: 'signed-out', message: SAFE_MESSAGE.signedOut };
  return { key: 'error', message: SAFE_MESSAGE.error };
}

// ---- Retry with capped exponential backoff ----

let _retryTimer = null;
let _retryAttempts = 0;
let _lastUsername = '';

function clearRetryTimer() {
  try {
    if (_retryTimer) clearTimeout(_retryTimer);
  } catch {
    // ignore
  }
  _retryTimer = null;
}

function scheduleRetry() {
  if (_retryAttempts >= RETRY_MAX_ATTEMPTS) {
    setState({ status: SYNC_STATES.ERROR, lastError: 'sync-failed', message: SAFE_MESSAGE.error });
    return;
  }
  const delay = Math.min(RETRY_BASE_MS * 2 ** _retryAttempts, RETRY_MAX_MS);
  _retryAttempts += 1;
  clearRetryTimer();
  try {
    _retryTimer = setTimeout(() => {
      _retryTimer = null;
      pushAll(_lastUsername).catch(() => {});
    }, delay);
  } catch {
    setState({ status: SYNC_STATES.ERROR, lastError: 'sync-failed', message: SAFE_MESSAGE.error });
  }
  setState({ status: SYNC_STATES.RETRYING, lastError: 'offline', message: SAFE_MESSAGE.retrying });
}

function noteFailure(err) {
  const c = classifyError(err);
  if (c.key === 'offline') {
    scheduleRetry();
    return { success: false, error: c.message };
  }
  setState({
    status: c.key === 'signed-out' ? SYNC_STATES.OFFLINE : SYNC_STATES.ERROR,
    lastError: c.key === 'signed-out' ? 'signed-out' : c.key === 'permission' ? 'permission' : 'sync-failed',
    message: c.message,
  });
  return { success: false, error: c.message };
}

// ---- Push coalescing + debounce ----

let _pushInFlight = null;
let _queuedUser = undefined;
let _debounceTimer = null;
let _beforeUnloadRegistered = false;

function beforeUnloadFlush() {
  // Best effort only: fire without awaiting so unload is never blocked.
  try {
    if (_lastUsername) pushAll(_lastUsername).catch(() => {});
  } catch {
    // unload path must never throw
  }
}

function ensureBeforeUnload() {
  if (_beforeUnloadRegistered) return;
  try {
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', beforeUnloadFlush);
      _beforeUnloadRegistered = true;
    }
  } catch {
    // environments without window stay unload-free
  }
}

export function schedulePush(user) {
  try {
    const username = resolveUsername(user);
    if (!username) return;
    _lastUsername = username;
    setState({ pendingWrites: _state.pendingWrites + 1 });
    if (_debounceTimer) {
      try {
        clearTimeout(_debounceTimer);
      } catch {
        // ignore
      }
    }
    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      pushAll(username).catch(() => {});
    }, PUSH_DEBOUNCE_MS);
  } catch {
    // scheduling never throws
  }
}

function buildPushEntries(uid, snap) {
  const entries = [];
  const counts = {
    accounts: 0,
    journal: 0,
    executedTrades: 0,
    legacyTrades: 0,
    rules: 0,
    setups: 0,
    reviews: 0,
    propConfigs: 0,
    improvements: 0,
    audit: 0,
  };
  for (const a of snap.accounts) {
    const aid = recordId(a);
    if (!aid) continue;
    // Doc ID already carries the account id; the duplicate id field is
    // stripped from the body and restored on pull.
    entries.push({ path: pAccount(uid, aid), data: stripId(a) });
    counts.accounts += 1;
    // Marker doc so an account's legacy trades stay discoverable even if
    // its account doc is ever missing remotely; carries no trade data.
    entries.push({ path: cLegacyAccounts(uid).concat([aid]), data: { accountId: aid, updatedAt: new Date().toISOString() } });
    for (const e of snap.journal[aid] || []) {
      const eid = recordId(e);
      if (!eid) continue;
      entries.push({ path: pJournal(uid, aid, eid), data: stripId(e) });
      counts.journal += 1;
    }
    for (const t of snap.legacyTrades[aid] || []) {
      const tid = recordId(t);
      if (!tid) continue;
      entries.push({ path: pLegacy(uid, aid, tid), data: stripId(t) });
      counts.legacyTrades += 1;
    }
  }
  const pushList = (list, pathFn, key) => {
    for (const r of Array.isArray(list) ? list : []) {
      const id = recordId(r);
      if (!id) continue;
      entries.push({ path: pathFn(uid, id), data: stripId(r) });
      counts[key] += 1;
    }
  };
  pushList(snap.executedTrades, pTrade, 'executedTrades');
  pushList(snap.rules, pRule, 'rules');
  pushList(snap.setups, pSetup, 'setups');
  pushList(snap.reviews, pReview, 'reviews');
  pushList(snap.improvements, pImprovement, 'improvements');
  pushList(snap.audit, pAudit, 'audit');
  const prop = snap.propConfigs && typeof snap.propConfigs === 'object' ? snap.propConfigs : {};
  for (const aid of Object.keys(prop)) {
    entries.push({ path: pPropConfig(uid, aid), data: plainCopy(prop[aid]) });
    counts.propConfigs += 1;
  }
  return { entries, counts };
}

async function doPush(username, uid) {
  const be = backend();
  const snap = readLocalSnapshot(username);
  let idsAdded = false;
  if (ensureIds(snap.accounts)) idsAdded = true;
  for (const aid of Object.keys(snap.journal)) if (ensureIds(snap.journal[aid])) idsAdded = true;
  for (const aid of Object.keys(snap.legacyTrades)) if (ensureIds(snap.legacyTrades[aid])) idsAdded = true;
  if (ensureIds(snap.executedTrades)) idsAdded = true;
  if (ensureIds(snap.rules)) idsAdded = true;
  if (ensureIds(snap.setups)) idsAdded = true;
  if (ensureIds(snap.reviews)) idsAdded = true;
  if (ensureIds(snap.improvements)) idsAdded = true;
  if (ensureIds(snap.audit)) idsAdded = true;
  if (idsAdded) writeSnapshotToLocal(username, snap);

  const existing = await be.getDocData(pProfile(uid)).catch(() => null);
  const profileBody = { username, schemaVersion: SCHEMA_VERSION };
  if (!existing || (existing && typeof existing === 'object' && existing.createdAt == null)) {
    profileBody.createdAt = new Date().toISOString();
  }
  const { entries, counts } = buildPushEntries(uid, snap);
  // Per-entity merge writes: each document commits independently, so a
  // partial failure corrupts nothing — failed docs simply retry later.
  let failedCount = 0;
  try {
    await be.setDocData(pProfile(uid), profileBody);
  } catch (e) {
    void e;
    failedCount += 1;
  }
  for (let i = 0; i < entries.length; i += BATCH_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + BATCH_CHUNK_SIZE);
    try {
      await be.batchSet(chunk);
    } catch (e) {
      void e;
      // One bad doc must not sink the chunk — retry docs individually.
      for (const entry of chunk) {
        try {
          await be.setDocData(entry.path, entry.data);
        } catch (inner) {
          void inner;
          failedCount += 1;
        }
      }
    }
  }
  return { counts, failedCount, total: entries.length };
}

export async function pushAll(user) {
  try {
    if (_pushInFlight) {
      _queuedUser = user;
      try {
        await _pushInFlight;
      } catch {
        // coalesced onto the in-flight push; the queued run follows
      }
      const next = _queuedUser;
      _queuedUser = undefined;
      if (next !== undefined) return pushAll(next);
      return { success: true, coalesced: true };
    }
    _pushInFlight = (async () => {
      const username = resolveUsername(user);
      const uid = resolveUid();
      if (!username) return { success: false, error: SAFE_MESSAGE.signedOut };
      if (!uid) {
        setState({ status: SYNC_STATES.OFFLINE, lastError: 'signed-out', message: SAFE_MESSAGE.signedOut });
        return { success: false, error: SIGNED_OUT_ERROR };
      }
      _lastUsername = username;
      setState({ status: SYNC_STATES.SYNCING, message: SAFE_MESSAGE.syncing });
      try {
        const { counts, failedCount } = await doPush(username, uid);
        setState({
          pendingWrites: 0,
          lastSyncedAt: new Date().toISOString(),
          lastError: failedCount > 0 ? 'sync-failed' : null,
          status: failedCount > 0 ? SYNC_STATES.ERROR : SYNC_STATES.SYNCED,
          message: failedCount > 0 ? SAFE_MESSAGE.error : SAFE_MESSAGE.synced,
        });
        _retryAttempts = 0;
        clearRetryTimer();
        if (failedCount > 0) return { success: false, error: SAFE_MESSAGE.error, uploaded: counts, failed: failedCount };
        return { success: true, uid, uploaded: counts };
      } catch (e) {
        return noteFailure(e);
      }
    })();
    const res = await _pushInFlight;
    _pushInFlight = null;
    if (_queuedUser !== undefined) {
      const next = _queuedUser;
      _queuedUser = undefined;
      return pushAll(next);
    }
    return res;
  } catch (e) {
    _pushInFlight = null;
    return noteFailure(e);
  }
}

export async function pullAll(user) {
  try {
    const username = resolveUsername(user);
    const uid = resolveUid();
    if (!username) return { success: false, error: SAFE_MESSAGE.signedOut };
    if (!uid) {
      setState({ status: SYNC_STATES.OFFLINE, lastError: 'signed-out', message: SAFE_MESSAGE.signedOut });
      return { success: false, error: SIGNED_OUT_ERROR };
    }
    _lastUsername = username;
    setState({ status: SYNC_STATES.SYNCING, message: SAFE_MESSAGE.syncing });
    let remote;
    try {
      remote = await fetchRemote(uid);
    } catch (e) {
      return noteFailure(e);
    }
    try {
      const local = readLocalSnapshot(username);
      const merged = {
        accounts: mergeById(local.accounts, remote.accounts).merged,
        journal: {},
        executedTrades: mergeById(local.executedTrades, remote.executedTrades).merged,
        legacyTrades: {},
        rules: mergeById(local.rules, remote.rules).merged,
        setups: mergeById(local.setups, remote.setups).merged,
        reviews: mergeById(local.reviews, remote.reviews).merged,
        propConfigs: { ...(local.propConfigs || {}) },
        improvements: mergeById(local.improvements, remote.improvements).merged,
        audit: mergeAuditEntries(
          Array.isArray(local.audit) ? local.audit : [],
          Array.isArray(remote.audit) ? remote.audit : [],
        ).events,
      };
      const journalIds = new Set([...Object.keys(local.journal || {}), ...Object.keys(remote.journal || {})]);
      for (const aid of journalIds) {
        merged.journal[aid] = mergeById(local.journal[aid] || [], remote.journal[aid] || []).merged;
      }
      const legacyIds = new Set([...Object.keys(local.legacyTrades || {}), ...Object.keys(remote.legacyTrades || {})]);
      for (const aid of legacyIds) {
        merged.legacyTrades[aid] = mergeById(local.legacyTrades[aid] || [], remote.legacyTrades[aid] || []).merged;
      }
      for (const aid of Object.keys(remote.propConfigs || {})) {
        const lw = local.propConfigs ? local.propConfigs[aid] : undefined;
        const rw = remote.propConfigs[aid];
        if (lw == null) {
          merged.propConfigs[aid] = rw;
        } else {
          merged.propConfigs[aid] = pickWinner(lw, rw).rec;
        }
      }
      writeSnapshotToLocal(username, merged);
      setState({
        status: SYNC_STATES.SYNCED,
        lastSyncedAt: new Date().toISOString(),
        lastError: null,
        message: SAFE_MESSAGE.synced,
      });
      _retryAttempts = 0;
      clearRetryTimer();
      return { success: true, data: toLocalShapedPayload(merged) };
    } catch (e) {
      return noteFailure(e);
    }
  } catch (e) {
    return noteFailure(e);
  }
}

function stripAccountBody(rec) {
  return stripId(rec);
}

export async function reconcile(user) {
  try {
    const username = resolveUsername(user);
    const uid = resolveUid();
    if (!username) return { success: false, error: SAFE_MESSAGE.signedOut };
    if (!uid) {
      setState({ status: SYNC_STATES.OFFLINE, lastError: 'signed-out', message: SAFE_MESSAGE.signedOut });
      return { success: false, error: SIGNED_OUT_ERROR };
    }
    _lastUsername = username;
    let remote;
    try {
      remote = await fetchRemote(uid);
    } catch (e) {
      return noteFailure(e);
    }
    const local = readLocalSnapshot(username);
    const plan = {};
    const actions = [];
    const uploads = [];
    const merged = {
      accounts: [],
      journal: {},
      executedTrades: [],
      legacyTrades: {},
      rules: [],
      setups: [],
      reviews: [],
      propConfigs: { ...(local.propConfigs || {}) },
      improvements: [],
      audit: [],
    };
    const reconcileList = (entity, localArr, remoteArr, pathFn, stripFn) => {
      const m = mergeById(localArr, remoteArr);
      merged[entity] = m.merged;
      const freshOnly = m.localOnly.length;
      const newerOnly = m.uploaded.filter((id) => !m.localOnly.includes(id));
      plan[entity] = {
        local: (Array.isArray(localArr) ? localArr : []).length,
        remote: (Array.isArray(remoteArr) ? remoteArr : []).length,
        uploaded: freshOnly + newerOnly.length,
        downloaded: m.downloaded.length,
        keptLocal: m.keptLocal.length,
      };
      const strip = stripFn || stripId;
      for (const id of m.localOnly) {
        const rec = (Array.isArray(localArr) ? localArr : []).find((r) => recordId(r) === id);
        if (rec) uploads.push({ path: pathFn(uid, id), data: strip(rec) });
        actions.push({ type: 'upload', entity, id });
      }
      for (const id of newerOnly) {
        const rec = m.merged.find((r) => recordId(r) === id);
        if (rec) uploads.push({ path: pathFn(uid, id), data: strip(rec) });
        actions.push({ type: 'upload', entity, id, reason: 'local-newer' });
      }
      for (const id of m.remoteOnly) actions.push({ type: 'download', entity, id });
      for (const id of m.downloaded) {
        if (!m.remoteOnly.includes(id)) actions.push({ type: 'download', entity, id, reason: 'remote-newer' });
      }
      for (const id of m.duplicates || []) {
        actions.push({ type: 'keep-local', entity, id, reason: 'no-timestamp-duplicate-candidate' });
      }
    };
    reconcileList('accounts', local.accounts, remote.accounts, (u, id) => pAccount(u, id), stripAccountBody);
    reconcileList('executedTrades', local.executedTrades, remote.executedTrades, (u, id) => pTrade(u, id));
    reconcileList('rules', local.rules, remote.rules, (u, id) => pRule(u, id));
    reconcileList('setups', local.setups, remote.setups, (u, id) => pSetup(u, id));
    reconcileList('reviews', local.reviews, remote.reviews, (u, id) => pReview(u, id));
    reconcileList('improvements', local.improvements, remote.improvements, (u, id) => pImprovement(u, id));

    const journalIds = new Set([...Object.keys(local.journal || {}), ...Object.keys(remote.journal || {})]);
    plan.journal = { local: 0, remote: 0, uploaded: 0, downloaded: 0, keptLocal: 0 };
    for (const aid of journalIds) {
      const m = mergeById(local.journal[aid] || [], remote.journal[aid] || []);
      merged.journal[aid] = m.merged;
      plan.journal.local += (local.journal[aid] || []).length;
      plan.journal.remote += (remote.journal[aid] || []).length;
      const upIds = [...m.localOnly, ...m.uploaded.filter((x) => !m.localOnly.includes(x))];
      for (const id of upIds) {
        const rec = m.merged.find((r) => recordId(r) === id);
        if (rec) uploads.push({ path: pJournal(uid, aid, id), data: stripId(rec) });
        actions.push({ type: 'upload', entity: 'journal', accountId: aid, id });
      }
      for (const id of m.downloaded) actions.push({ type: 'download', entity: 'journal', accountId: aid, id });
      plan.journal.uploaded += upIds.length;
      plan.journal.downloaded += m.downloaded.length;
      plan.journal.keptLocal += m.keptLocal.length;
      for (const id of m.duplicates || []) {
        actions.push({ type: 'keep-local', entity: 'journal', accountId: aid, id, reason: 'no-timestamp-duplicate-candidate' });
      }
    }

    const legacyIds = new Set([...Object.keys(local.legacyTrades || {}), ...Object.keys(remote.legacyTrades || {})]);
    plan.legacyTrades = { local: 0, remote: 0, uploaded: 0, downloaded: 0, keptLocal: 0 };
    for (const aid of legacyIds) {
      const m = mergeById(local.legacyTrades[aid] || [], remote.legacyTrades[aid] || []);
      merged.legacyTrades[aid] = m.merged;
      plan.legacyTrades.local += (local.legacyTrades[aid] || []).length;
      plan.legacyTrades.remote += (remote.legacyTrades[aid] || []).length;
      const upIds = [...m.localOnly, ...m.uploaded.filter((x) => !m.localOnly.includes(x))];
      if (upIds.length > 0) {
        uploads.push({ path: cLegacyAccounts(uid).concat([aid]), data: { accountId: aid, updatedAt: new Date().toISOString() } });
      }
      for (const id of upIds) {
        const rec = m.merged.find((r) => recordId(r) === id);
        if (rec) uploads.push({ path: pLegacy(uid, aid, id), data: stripId(rec) });
        actions.push({ type: 'upload', entity: 'legacyTrades', accountId: aid, id });
      }
      for (const id of m.downloaded) actions.push({ type: 'download', entity: 'legacyTrades', accountId: aid, id });
      plan.legacyTrades.uploaded += upIds.length;
      plan.legacyTrades.downloaded += m.downloaded.length;
      plan.legacyTrades.keptLocal += m.keptLocal.length;
      for (const id of m.duplicates || []) {
        actions.push({ type: 'keep-local', entity: 'legacyTrades', accountId: aid, id, reason: 'no-timestamp-duplicate-candidate' });
      }
    }

    plan.propConfigs = { local: 0, remote: 0, uploaded: 0, downloaded: 0, keptLocal: 0 };
    const propIds = new Set([...Object.keys(local.propConfigs || {}), ...Object.keys(remote.propConfigs || {})]);
    plan.propConfigs.local = Object.keys(local.propConfigs || {}).length;
    plan.propConfigs.remote = Object.keys(remote.propConfigs || {}).length;
    for (const aid of propIds) {
      const lw = local.propConfigs ? local.propConfigs[aid] : undefined;
      const rw = remote.propConfigs ? remote.propConfigs[aid] : undefined;
      if (lw == null && rw != null) {
        merged.propConfigs[aid] = rw;
        actions.push({ type: 'download', entity: 'propConfigs', accountId: aid, id: aid });
        plan.propConfigs.downloaded += 1;
      } else if (lw != null && rw == null) {
        uploads.push({ path: pPropConfig(uid, aid), data: plainCopy(lw) });
        actions.push({ type: 'upload', entity: 'propConfigs', accountId: aid, id: aid });
        plan.propConfigs.uploaded += 1;
      } else if (lw != null && rw != null) {
        const w = pickWinner(lw, rw);
        merged.propConfigs[aid] = w.rec;
        if (w.source === 'local') {
          uploads.push({ path: pPropConfig(uid, aid), data: plainCopy(lw) });
          actions.push({ type: 'upload', entity: 'propConfigs', accountId: aid, id: aid, reason: 'local-newer' });
          plan.propConfigs.keptLocal += 1;
          plan.propConfigs.uploaded += 1;
        } else {
          actions.push({ type: 'download', entity: 'propConfigs', accountId: aid, id: aid, reason: 'remote-newer' });
          plan.propConfigs.downloaded += 1;
        }
      }
    }

    const auditMerged = mergeAuditEntries(
      Array.isArray(local.audit) ? local.audit : [],
      Array.isArray(remote.audit) ? remote.audit : [],
    );
    merged.audit = auditMerged.events;
    plan.audit = {
      local: (Array.isArray(local.audit) ? local.audit : []).length,
      remote: (Array.isArray(remote.audit) ? remote.audit : []).length,
      uploaded: 0,
      downloaded: Math.max(0, merged.audit.length - (Array.isArray(local.audit) ? local.audit : []).length),
      keptLocal: 0,
    };
    for (const e of Array.isArray(local.audit) ? local.audit : []) {
      if (e && e.id != null) {
        uploads.push({ path: pAudit(uid, String(e.id)), data: stripId(plainCopy(e)) });
        actions.push({ type: 'upload', entity: 'audit', id: String(e.id) });
      }
    }
    plan.audit.uploaded = Array.isArray(local.audit) ? local.audit.length : 0;

    // Additive-only apply: upload local-newer/missing docs, then persist the
    // merged view locally. Nothing is ever deleted on either side.
    const be = backend();
    try {
      if (uploads.length > 0) await be.batchSet(uploads);
      const existing = await be.getDocData(pProfile(uid)).catch(() => null);
      const profileBody = { username, schemaVersion: SCHEMA_VERSION };
      if (!existing || (existing && typeof existing === 'object' && existing.createdAt == null)) {
        profileBody.createdAt = new Date().toISOString();
      }
      await be.setDocData(pProfile(uid), profileBody);
    } catch (e) {
      return noteFailure(e);
    }
    writeSnapshotToLocal(username, merged);
    setState({
      status: SYNC_STATES.SYNCED,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
      message: SAFE_MESSAGE.synced,
    });
    _retryAttempts = 0;
    clearRetryTimer();
    return { success: true, plan, actions };
  } catch (e) {
    return noteFailure(e);
  }
}

export async function retryNow() {
  try {
    clearRetryTimer();
    _retryAttempts = 0;
    const username = _lastUsername || resolveUsername();
    if (!username) return { success: false, error: SAFE_MESSAGE.signedOut };
    if (!resolveUid()) {
      setState({ status: SYNC_STATES.OFFLINE, lastError: 'signed-out', message: SAFE_MESSAGE.signedOut });
      return { success: false, error: SIGNED_OUT_ERROR };
    }
    return pushAll(username);
  } catch (e) {
    return noteFailure(e);
  }
}

export function handleSignedOut() {
  try {
    clearRetryTimer();
    if (_debounceTimer) {
      try {
        clearTimeout(_debounceTimer);
      } catch {
        // ignore
      }
      _debounceTimer = null;
    }
    _pushInFlight = null;
    _queuedUser = undefined;
    _retryAttempts = 0;
    _lastUsername = '';
    setState({
      status: SYNC_STATES.IDLE,
      lastError: null,
      pendingWrites: 0,
      message: SAFE_MESSAGE.signedOut,
    });
  } catch {
    // sign-out bookkeeping never throws
  }
}

export async function initSyncManager(user) {
  try {
    ensureBeforeUnload();
    const uid = resolveUid();
    if (!uid) {
      setState({ status: SYNC_STATES.OFFLINE, lastError: 'signed-out', message: SAFE_MESSAGE.signedOut });
      return { success: false, error: SIGNED_OUT_ERROR };
    }
    const username = resolveUsername(user);
    if (username) _lastUsername = username;
    return { success: true, uid, username };
  } catch (e) {
    return noteFailure(e);
  }
}
