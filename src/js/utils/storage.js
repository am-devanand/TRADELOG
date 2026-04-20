// ============================================
// Storage utility — all localStorage operations
// ============================================

const USERS_KEY = 'tradelog_users';
const SESSION_KEY = 'tradelog_session';

function getUsers() {
  return JSON.parse(localStorage.getItem(USERS_KEY) || '{}');
}

function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

export function registerUser(username, password) {
  const users = getUsers();
  if (users[username]) return { success: false, error: 'Username already exists' };
  users[username] = { username, password: btoa(password), createdAt: new Date().toISOString() };
  saveUsers(users);
  return { success: true };
}

export function loginUser(username, password) {
  const users = getUsers();
  if (!users[username]) return { success: false, error: 'User not found' };
  if (users[username].password !== btoa(password)) return { success: false, error: 'Wrong password' };
  localStorage.setItem(SESSION_KEY, username);
  return { success: true };
}

export function logoutUser() {
  localStorage.removeItem(SESSION_KEY);
}

export function getCurrentUser() {
  return localStorage.getItem(SESSION_KEY);
}

export function isLoggedIn() {
  return !!getCurrentUser();
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
}

export function updateFolder(user, folderId, updates) {
  let folders = getFolders(user);
  folders = folders.map(f => f.id === folderId ? { ...f, ...updates } : f);
  localStorage.setItem(foldersKey(user), JSON.stringify(folders));
}

export function deleteFolder(user, folderId) {
  let folders = getFolders(user);
  folders = folders.filter(f => f.id !== folderId);
  localStorage.setItem(foldersKey(user), JSON.stringify(folders));
  localStorage.removeItem(`tradelog_trades_${folderId}`);
  localStorage.removeItem(`tradelog_journal_${folderId}`);
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
}

export function updateTrade(folderId, tradeId, updates) {
  let trades = getTrades(folderId);
  trades = trades.map(t => t.id === tradeId ? { ...t, ...updates } : t);
  localStorage.setItem(tradesKey(folderId), JSON.stringify(trades));
}

export function deleteTrade(folderId, tradeId) {
  let trades = getTrades(folderId);
  trades = trades.filter(t => t.id !== tradeId);
  localStorage.setItem(tradesKey(folderId), JSON.stringify(trades));
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
}

export function deleteJournalEntry(folderId, entryId) {
  let entries = getJournalEntries(folderId);
  entries = entries.filter(e => e.id !== entryId);
  localStorage.setItem(journalKey(folderId), JSON.stringify(entries));
}

// ---- Theme ----
export function getTheme() {
  return localStorage.getItem('tradelog_theme') || 'dark';
}

export function setTheme(theme) {
  localStorage.setItem('tradelog_theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
}
