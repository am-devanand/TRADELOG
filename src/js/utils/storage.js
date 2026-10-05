// ============================================
// Storage utility — localStorage + Firebase Sync
// ============================================
import { auth, db } from './firebase.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, setDoc, getDoc } from "firebase/firestore";
import { mergeAuditEntries } from './auditLog.js';

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
    await withTimeout(
      setDoc(doc(db, "users", clean), { folders: [], trades: {}, journal: {}, rules: [], setups: [], executedTrades: [], reviews: [], screenshots: [], propConfigs: {}, improvements: [], analyticsPrefs: {}, audit: [] }),
      5000,
      'Could not connect to database. Did you create the Firestore Database in your Firebase Console?'
    );
    if (typeof localStorage !== 'undefined' && localStorage.getItem(`tradelog_audit_${clean}`) == null) {
      localStorage.setItem(`tradelog_audit_${clean}`, JSON.stringify([]));
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
    
    const docSnap = await withTimeout(
      getDoc(doc(db, "users", clean)),
      5000,
      'Could not load data. Did you create the Firestore Database in your Firebase Console?'
    );
    
    if (docSnap.exists()) {
      const data = docSnap.data();
      localStorage.setItem(`tradelog_folders_${clean}`, JSON.stringify(data.folders || []));
      
      // Store trades
      if (data.trades) {
        Object.keys(data.trades).forEach(folderId => {
          localStorage.setItem(`tradelog_trades_${folderId}`, JSON.stringify(data.trades[folderId] || []));
        });
      }
      
      // Store journal
      if (data.journal) {
        Object.keys(data.journal).forEach(folderId => {
          localStorage.setItem(`tradelog_journal_${folderId}`, JSON.stringify(data.journal[folderId] || []));
        });
      }

      // Store rules (canonical shape, see ruleManager.js). Users without
      // remote rules get [] locally — no overwrite, no auto-seed.
      if (Array.isArray(data.rules)) {
        localStorage.setItem(`tradelog_rules_${clean}`, JSON.stringify(data.rules));
      } else if (localStorage.getItem(`tradelog_rules_${clean}`) == null) {
        localStorage.setItem(`tradelog_rules_${clean}`, JSON.stringify([]));
      }

      if (Array.isArray(data.setups)) {
        localStorage.setItem(`tradelog_setups_${clean}`, JSON.stringify(data.setups));
      } else if (localStorage.getItem(`tradelog_setups_${clean}`) == null) {
        localStorage.setItem(`tradelog_setups_${clean}`, JSON.stringify([]));
      }

      if (Array.isArray(data.executedTrades)) {
        localStorage.setItem(`tradelog_exectrades_${clean}`, JSON.stringify(data.executedTrades));
      } else if (localStorage.getItem(`tradelog_exectrades_${clean}`) == null) {
        localStorage.setItem(`tradelog_exectrades_${clean}`, JSON.stringify([]));
      }

      if (Array.isArray(data.reviews)) {
        localStorage.setItem(`tradelog_reviews_${clean}`, JSON.stringify(data.reviews));
      } else if (localStorage.getItem(`tradelog_reviews_${clean}`) == null) {
        localStorage.setItem(`tradelog_reviews_${clean}`, JSON.stringify([]));
      }

      // Screenshot metadata mirror: ID-only refs (blobs stay in IndexedDB).
      if (Array.isArray(data.screenshots)) {
        const shaped = data.screenshots
          .filter((m) => m && typeof m === 'object' && m.id)
          .map((m) => ({
            id: String(m.id),
            tradeId: m.tradeId ? String(m.tradeId) : '',
            setupId: m.setupId ? String(m.setupId) : '',
            reviewId: m.reviewId ? String(m.reviewId) : '',
            type: String(m.type || 'OTHER'),
            filename: String(m.filename || 'screenshot'),
            mimeType: String(m.mimeType || 'image/png'),
            size: Number.isFinite(Number(m.size)) ? Number(m.size) : 0,
            createdAt: m.createdAt || new Date().toISOString(),
          }));
        localStorage.setItem(`tradelog_screenshots_${clean}`, JSON.stringify(shaped));
      } else if (localStorage.getItem(`tradelog_screenshots_${clean}`) == null) {
        localStorage.setItem(`tradelog_screenshots_${clean}`, JSON.stringify([]));
      }

      if (data.propConfigs && typeof data.propConfigs === 'object' && !Array.isArray(data.propConfigs)) {
        localStorage.setItem(`tradelog_propconfig_${clean}`, JSON.stringify(data.propConfigs));
      } else if (localStorage.getItem(`tradelog_propconfig_${clean}`) == null) {
        localStorage.setItem(`tradelog_propconfig_${clean}`, JSON.stringify({}));
      }

      if (Array.isArray(data.improvements)) {
        localStorage.setItem(`tradelog_improvements_${clean}`, JSON.stringify(data.improvements));
      } else if (localStorage.getItem(`tradelog_improvements_${clean}`) == null) {
        localStorage.setItem(`tradelog_improvements_${clean}`, JSON.stringify([]));
      }

      if (data.analyticsPrefs && typeof data.analyticsPrefs === 'object' && !Array.isArray(data.analyticsPrefs)) {
        localStorage.setItem(`tradelog_analytics_prefs_${clean}`, JSON.stringify(data.analyticsPrefs));
      } else if (localStorage.getItem(`tradelog_analytics_prefs_${clean}`) == null) {
        localStorage.setItem(`tradelog_analytics_prefs_${clean}`, JSON.stringify({}));
      }

      // Audit log: append-only merge — never REPLACE local entries with fewer
      // remote ones. Union by entry id, keep newest, seed [] when absent.
      const auditKey = `tradelog_audit_${clean}`;
      const localAudit = safeParse(localStorage.getItem(auditKey), []);
      const localArr = Array.isArray(localAudit) ? localAudit : [];
      if (!Array.isArray(data.audit)) {
        if (localStorage.getItem(auditKey) == null) {
          localStorage.setItem(auditKey, JSON.stringify([]));
        }
      } else {
        const merged = mergeAuditEntries(localArr, data.audit);
        localStorage.setItem(auditKey, JSON.stringify(merged.events));
      }
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
  signOut(auth);
}

export function getCurrentUser() {
  return localStorage.getItem(SESSION_KEY);
}

export function isLoggedIn() {
  return !!getCurrentUser();
}

// ---- Background Sync to Firestore ----
let syncTimeout = null;
function syncToFirebase() {
  const user = getCurrentUser();
  if (!user) return;
  
  // Debounce to avoid too many writes
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    try {
      const data = {
        folders: safeParse(localStorage.getItem(`tradelog_folders_${user}`), []),
        trades: {},
        journal: {},
        rules: safeParse(localStorage.getItem(`tradelog_rules_${user}`), []),
        setups: safeParse(localStorage.getItem(`tradelog_setups_${user}`), []),
        executedTrades: (() => {
          const v = safeParse(localStorage.getItem(`tradelog_exectrades_${user}`), []);
          return Array.isArray(v) ? v : [];
        })(),
        reviews: (() => {
          const v = safeParse(localStorage.getItem(`tradelog_reviews_${user}`), []);
          return Array.isArray(v) ? v : [];
        })(),
        screenshots: (() => {
          const v = safeParse(localStorage.getItem(`tradelog_screenshots_${user}`), []);
          if (!Array.isArray(v)) return [];
          return v
            .filter((m) => m && typeof m === 'object' && m.id)
            .map((m) => ({
              id: String(m.id),
              tradeId: m.tradeId ? String(m.tradeId) : '',
              setupId: m.setupId ? String(m.setupId) : '',
              reviewId: m.reviewId ? String(m.reviewId) : '',
              type: String(m.type || 'OTHER'),
              filename: String(m.filename || 'screenshot'),
              mimeType: String(m.mimeType || 'image/png'),
              size: Number.isFinite(Number(m.size)) ? Number(m.size) : 0,
              createdAt: m.createdAt || new Date().toISOString(),
            }));
        })(),
        propConfigs: (() => {
          const v = safeParse(localStorage.getItem(`tradelog_propconfig_${user}`), {});
          return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        })(),
        improvements: (() => {
          const v = safeParse(localStorage.getItem(`tradelog_improvements_${user}`), []);
          return Array.isArray(v) ? v : [];
        })(),
        analyticsPrefs: (() => {
          const v = safeParse(localStorage.getItem(`tradelog_analytics_prefs_${user}`), {});
          return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        })(),
        audit: (() => {
          const v = safeParse(localStorage.getItem(`tradelog_audit_${user}`), []);
          return Array.isArray(v) ? v : [];
        })()
      };
      
      data.folders.forEach(f => {
        data.trades[f.id] = safeParse(localStorage.getItem(`tradelog_trades_${f.id}`), []);
        data.journal[f.id] = safeParse(localStorage.getItem(`tradelog_journal_${f.id}`), []);
      });
      
      await setDoc(doc(db, "users", user), data, { merge: true });
    } catch (e) {
      console.error("Failed to sync to Firebase:", e);
    }
  }, 1000);
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
