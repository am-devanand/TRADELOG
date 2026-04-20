// ============================================
// Storage utility — localStorage + Firebase Sync
// ============================================
import { auth, db } from './firebase.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, setDoc, getDoc } from "firebase/firestore";

const SESSION_KEY = 'tradelog_session';

// Helper to convert username to fake email for Firebase Auth
const getEmail = (username) => `${username.toLowerCase()}@tradelog.app`;

// Helper to add timeout to promises
const withTimeout = (promise, ms, errorMessage = 'Operation timed out') => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMessage)), ms))
  ]);
};

export async function registerUser(username, password) {
  try {
    await createUserWithEmailAndPassword(auth, getEmail(username), password);
    // Initialize empty data in Firestore with a 5 second timeout
    await withTimeout(
      setDoc(doc(db, "users", username), { folders: [], trades: {}, journal: {} }),
      5000,
      'Could not connect to database. Did you create the Firestore Database in your Firebase Console?'
    );
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
  try {
    await signInWithEmailAndPassword(auth, getEmail(username), password);
    localStorage.setItem(SESSION_KEY, username);
    
    // Fetch user data from Firestore with a 5 second timeout
    const docSnap = await withTimeout(
      getDoc(doc(db, "users", username)),
      5000,
      'Could not load data. Did you create the Firestore Database in your Firebase Console?'
    );
    
    if (docSnap.exists()) {
      const data = docSnap.data();
      localStorage.setItem(`tradelog_folders_${username}`, JSON.stringify(data.folders || []));
      
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
        folders: JSON.parse(localStorage.getItem(`tradelog_folders_${user}`) || '[]'),
        trades: {},
        journal: {}
      };
      
      data.folders.forEach(f => {
        data.trades[f.id] = JSON.parse(localStorage.getItem(`tradelog_trades_${f.id}`) || '[]');
        data.journal[f.id] = JSON.parse(localStorage.getItem(`tradelog_journal_${f.id}`) || '[]');
      });
      
      await setDoc(doc(db, "users", user), data);
    } catch (e) {
      console.error("Failed to sync to Firebase:", e);
    }
  }, 1000);
}

// ---- Folder Operations ----
function foldersKey(user) { return `tradelog_folders_${user}`; }

export function getFolders(user) {
  return JSON.parse(localStorage.getItem(foldersKey(user)) || '[]');
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
  return JSON.parse(localStorage.getItem(tradesKey(folderId)) || '[]');
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
  return JSON.parse(localStorage.getItem(journalKey(folderId)) || '[]');
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
