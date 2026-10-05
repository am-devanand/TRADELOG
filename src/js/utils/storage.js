// ============================================
// Storage utility — localStorage + Firebase Sync
// ============================================
// Local-first: every write below commits to localStorage first, then
// schedules a debounced UID-keyed push via syncManager.js. A failed push
// never blocks or rolls back the local write — sync state is observable
// via getSyncState() instead of a console.error swallow.
import { auth } from './firebase.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { initSyncManager, pushAll, pullAll, reconcile, schedulePush, handleSignedOut } from './syncManager.js';

const SESSION_KEY = 'tradelog_session';

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function safeParse(raw, fallback) {
  try {
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const getEmail = (username) => `${normalizeUsername(username)}@tradelog.app`;

// Helper to add timeout to promises
const withTimeout = (promise, ms, errorMessage = 'Operation timed out') => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMessage)), ms))
  ]);
};

export async function registerUser(username, password) {
  const clean = normalizeUsername(username);
  if (!/^[a-z0-9._-]{3,32}$/.test(clean)) {
    return { success: false, error: 'Username must be 3-32 chars: letters, numbers, . _ -' };
  }
  try {
    await createUserWithEmailAndPassword(auth, getEmail(clean), password);
    if (typeof localStorage !== 'undefined' && localStorage.getItem(`tradelog_audit_${clean}`) == null) {
      localStorage.setItem(`tradelog_audit_${clean}`, JSON.stringify([]));
    }
    // Best-effort profile creation under users/{uid}. A sync failure never
    // fails registration — local-first, the next push retries.
    try {
      await initSyncManager(clean);
      await withTimeout(
        pushAll(clean),
        5000,
        'Could not connect to database. Did you create the Firestore Database in your Firebase Console?'
      );
    } catch {
      // observable via getSyncState(); registration still succeeds
    }
    return { success: true };
  } catch (error) {
    if (error.code === 'auth/email-already-in-use') {
      return { success: false, error: 'Username already exists' };
    }
    if (error.code === 'auth/operation-not-allowed') {
      return { success: false, error: 'Please enable Email/Password auth in Firebase Console' };
    }
    return { success: false, error: error.message.replace('Firebase: ', '') };
  }
}

export async function loginUser(username, password) {
  const clean = normalizeUsername(username);
  try {
    await signInWithEmailAndPassword(auth, getEmail(clean), password);
    localStorage.setItem(SESSION_KEY, clean);

    // Hydrate from UID-keyed collections via additive merge (local data is
    // never deleted), then upload any local-only records so a first login
    // on a fresh remote migrates local data up. Both are best-effort:
    // login succeeds regardless; failures surface via getSyncState().
    try {
      await initSyncManager(clean);
      await withTimeout(
        pullAll(clean),
        8000,
        'Could not load data. Did you create the Firestore Database in your Firebase Console?'
      );
      await withTimeout(
        reconcile(clean),
        8000,
        'Could not load data. Did you create the Firestore Database in your Firebase Console?'
      );
    } catch {
      // offline-first: local data intact, background retry via retryNow()
    }
    return { success: true };
  } catch (error) {
    if (error.code === 'auth/invalid-credential') {
      return { success: false, error: 'User not found or Wrong password' };
    }
    if (error.code === 'auth/operation-not-allowed') {
      return { success: false, error: 'Please enable Email/Password auth in Firebase Console' };
    }
    return { success: false, error: error.message.replace('Firebase: ', '') };
  }
}

export function logoutUser() {
  localStorage.removeItem(SESSION_KEY);
  try {
    handleSignedOut();
  } catch {
    // sign-out bookkeeping never blocks logout
  }
  signOut(auth);
}

export function getCurrentUser() {
  return localStorage.getItem(SESSION_KEY);
}

export function isLoggedIn() {
  return !!getCurrentUser();
}

// ---- Background Sync (debounced UID-keyed push via syncManager) ----
function syncToFirebase() {
  try {
    const user = getCurrentUser();
    if (!user) return;
    schedulePush(user);
  } catch {
    // scheduling never blocks a local write
  }
}

// ---- Folder Operations ----
function foldersKey(user) { return `tradelog_folders_${user}`; }

export function getFolders(user) {
  return safeParse(localStorage.getItem(foldersKey(user)), []);
}

export function saveFolder(user, folder) {
  const folders = getFolders(user);
  folders.push(folder);
  localStorage.setItem(foldersKey(user), JSON.stringify(folders));
  syncToFirebase();
}

export function updateFolder(user, folderId, updates) {
  let folders = getFolders(user);
  folders = folders.map(f => f.id === folderId ? { ...f, ...updates } : f);
  localStorage.setItem(foldersKey(user), JSON.stringify(folders));
  syncToFirebase();
}

export function deleteFolder(user, folderId) {
  let folders = getFolders(user);
  folders = folders.filter(f => f.id !== folderId);
  localStorage.setItem(foldersKey(user), JSON.stringify(folders));
  localStorage.removeItem(`tradelog_trades_${folderId}`);
  localStorage.removeItem(`tradelog_journal_${folderId}`);
  syncToFirebase();
}

export function getFolder(user, folderId) {
  return getFolders(user).find(f => f.id === folderId);
}

// ---- Trade Operations ----
function tradesKey(folderId) { return `tradelog_trades_${folderId}`; }

export function getTrades(folderId) {
  return safeParse(localStorage.getItem(tradesKey(folderId)), []);
}

export function saveTrade(folderId, trade) {
  const trades = getTrades(folderId);
  trades.push(trade);
  localStorage.setItem(tradesKey(folderId), JSON.stringify(trades));
  syncToFirebase();
}

export function updateTrade(folderId, tradeId, updates) {
  let trades = getTrades(folderId);
  trades = trades.map(t => t.id === tradeId ? { ...t, ...updates } : t);
  localStorage.setItem(tradesKey(folderId), JSON.stringify(trades));
  syncToFirebase();
}

export function deleteTrade(folderId, tradeId) {
  let trades = getTrades(folderId);
  trades = trades.filter(t => t.id !== tradeId);
  localStorage.setItem(tradesKey(folderId), JSON.stringify(trades));
  syncToFirebase();
}

export function recalculateBalances(user, folderId) {
  const folder = getFolder(user, folderId);
  if (!folder) return;
  let trades = getTrades(folderId);
  trades.sort((a, b) => new Date(a.date) - new Date(b.date) || new Date(a.createdAt) - new Date(b.createdAt));
  let balance = folder.startingBalance;
  trades = trades.map(t => {
    if (t.type === 'TP') balance += t.amount;
    else balance -= t.amount;
    return { ...t, balanceAfter: Math.round(balance * 100) / 100 };
  });
  localStorage.setItem(tradesKey(folderId), JSON.stringify(trades));
  updateFolder(user, folderId, { currentBalance: Math.round(balance * 100) / 100 });
  syncToFirebase();
  return balance;
}

// ---- Journal Operations ----
function journalKey(folderId) { return `tradelog_journal_${folderId}`; }

export function getJournalEntries(folderId) {
  return safeParse(localStorage.getItem(journalKey(folderId)), []);
}

export function saveJournalEntry(folderId, entry) {
  const entries = getJournalEntries(folderId);
  entries.push(entry);
  localStorage.setItem(journalKey(folderId), JSON.stringify(entries));
  syncToFirebase();
}

export function deleteJournalEntry(folderId, entryId) {
  let entries = getJournalEntries(folderId);
  entries = entries.filter(e => e.id !== entryId);
  localStorage.setItem(journalKey(folderId), JSON.stringify(entries));
  syncToFirebase();
}

// ---- Theme ----
export function getTheme() {
  return localStorage.getItem('tradelog_theme') || 'dark';
}

export function setTheme(theme) {
  localStorage.setItem('tradelog_theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
}
