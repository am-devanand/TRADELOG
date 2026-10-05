// ============================================
// Screenshot store — IndexedDB blob storage
// Vanilla ESM, offline-first. Blobs live ONLY here
// (DB 'tradelog-media', store 'screenshots').
// localStorage/Firestore/trade/review records hold
// ID-only metadata, never blobs or base64.
// All fns return {success,...} — never throw, never
// fake success when IndexedDB is unavailable.
// ============================================

const DB_NAME = 'tradelog-media';
const STORE_NAME = 'screenshots';
const DB_VERSION = 1;

export const SCREENSHOT_TYPES = ['ENTRY', 'MANAGEMENT', 'EXIT', 'OTHER'];
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024; // 10MB

function idbAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function fail(error) {
  return { success: false, error: String(error || 'Screenshot storage unavailable') };
}

let dbPromise = null;

/** Open (or reuse) the IndexedDB handle. Resolves {success, db|error}. */
export function initDB() {
  if (!idbAvailable()) {
    return Promise.resolve(fail('IndexedDB is unavailable (private mode or SSR?) — screenshots disabled.'));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        dbPromise = null;
        resolve(fail(e?.message || 'Could not open screenshot database'));
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        let store;
        if (db.objectStoreNames.contains(STORE_NAME)) {
          store = req.transaction.objectStore(STORE_NAME);
        } else {
          store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
        for (const idx of ['tradeId', 'setupId', 'reviewId', 'type']) {
          if (!store.indexNames.contains(idx)) store.createIndex(idx, idx, { unique: false });
        }
      };
      req.onsuccess = () => resolve({ success: true, db: req.result });
      req.onerror = () => {
        dbPromise = null;
        resolve(fail(req.error?.message || 'Could not open screenshot database'));
      };
      req.onblocked = () => {
        // Resolve anyway with the open handle if we get one; otherwise fail below.
      };
    });
  }
  return dbPromise;
}

function generateId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const VALID_TYPES = new Set(SCREENSHOT_TYPES);

function normalizeType(raw) {
  const t = String(raw || 'OTHER').trim().toUpperCase();
  return VALID_TYPES.has(t) ? t : 'OTHER';
}

/** Metadata shape — exactly these fields, no blob. */
function toMeta(rec) {
  if (!rec || typeof rec !== 'object') return null;
  return {
    id: String(rec.id || ''),
    tradeId: rec.tradeId ? String(rec.tradeId) : '',
    setupId: rec.setupId ? String(rec.setupId) : '',
    reviewId: rec.reviewId ? String(rec.reviewId) : '',
    type: normalizeType(rec.type),
    filename: String(rec.filename || 'screenshot'),
    mimeType: String(rec.mimeType || rec.blob?.type || 'image/png'),
    size: Number.isFinite(Number(rec.size)) ? Number(rec.size) : Number(rec.blob?.size) || 0,
    createdAt: rec.createdAt || new Date().toISOString(),
  };
}

function validateBlob(file) {
  const blob = file instanceof Blob ? file : null;
  if (!blob) return { ok: false, error: 'No image data provided (expected a File or Blob).' };
  const mime = String(blob.type || '');
  if (!mime.startsWith('image/')) {
    return { ok: false, error: `Only image files are allowed (got "${mime || 'unknown type'}").` };
  }
  if (blob.size > MAX_SCREENSHOT_BYTES) {
    return {
      ok: false,
      error: `Image is too large (${(blob.size / 1048576).toFixed(1)}MB). Max is 10MB.`,
    };
  }
  if (blob.size <= 0) return { ok: false, error: 'Image file is empty.' };
  return { ok: true, blob };
}

/**
 * Persist an image blob. saveScreenshot(file|blob, meta) where meta may
 * carry {tradeId, setupId, reviewId, type, filename}.
 * Resolves {success:true, id, meta} or {success:false, error}.
 */
export async function saveScreenshot(file, meta = {}) {
  const check = validateBlob(file);
  if (!check.ok) return fail(check.error);
  const opened = await initDB();
  if (!opened.success) return opened;
  const m = meta && typeof meta === 'object' ? meta : {};
  const blob = check.blob;
  const record = {
    id: generateId(),
    tradeId: m.tradeId ? String(m.tradeId) : '',
    setupId: m.setupId ? String(m.setupId) : '',
    reviewId: m.reviewId ? String(m.reviewId) : '',
    type: normalizeType(m.type),
    filename: String(m.filename || file?.name || 'screenshot'),
    mimeType: blob.type || 'image/png',
    size: blob.size,
    createdAt: new Date().toISOString(),
    blob,
  };
  return new Promise((resolve) => {
    let t;
    try {
      t = opened.db.transaction(STORE_NAME, 'readwrite');
    } catch (e) {
      resolve(fail(e?.message || 'Could not save screenshot'));
      return;
    }
    const os = t.objectStore(STORE_NAME);
    const req = os.add(record);
    req.onsuccess = () => resolve({ success: true, id: record.id, meta: toMeta(record) });
    req.onerror = () => resolve(fail(req.error?.message || 'Could not save screenshot'));
    t.onerror = () => resolve(fail(t.error?.message || 'Could not save screenshot'));
  });
}

/** Fetch one record (meta + blob). Resolves {success, meta, blob|error}. */
export async function getScreenshot(id) {
  if (!id) return fail('Screenshot id is required');
  const opened = await initDB();
  if (!opened.success) return opened;
  return new Promise((resolve) => {
    let t;
    try {
      t = opened.db.transaction(STORE_NAME, 'readonly');
    } catch (e) {
      resolve(fail(e?.message || 'Could not read screenshot'));
      return;
    }
    const req = t.objectStore(STORE_NAME).get(String(id));
    req.onsuccess = () => {
      const rec = req.result;
      if (!rec) return resolve(fail(`Screenshot not found: "${id}"`));
      resolve({ success: true, id: rec.id, meta: toMeta(rec), blob: rec.blob || null });
    };
    req.onerror = () => resolve(fail(req.error?.message || 'Could not read screenshot'));
  });
}

/** Fetch many records. Filter: {tradeId, setupId, reviewId, type}. */
export async function getScreenshots(filter = {}) {
  const opened = await initDB();
  if (!opened.success) return opened;
  const f = filter && typeof filter === 'object' ? filter : {};
  const want = {
    tradeId: f.tradeId != null && f.tradeId !== '' ? String(f.tradeId) : null,
    setupId: f.setupId != null && f.setupId !== '' ? String(f.setupId) : null,
    reviewId: f.reviewId != null && f.reviewId !== '' ? String(f.reviewId) : null,
    type: f.type ? normalizeType(f.type) : null,
  };
  // Prefer an indexed lookup when exactly one parent key is given.
  const indexKey = want.tradeId ? 'tradeId' : want.reviewId ? 'reviewId' : want.setupId ? 'setupId' : null;
  return new Promise((resolve) => {
    let t;
    try {
      t = opened.db.transaction(STORE_NAME, 'readonly');
    } catch (e) {
      resolve(fail(e?.message || 'Could not list screenshots'));
      return;
    }
    const os = t.objectStore(STORE_NAME);
    const source = indexKey ? os.index(indexKey) : os;
    const key = indexKey ? (want.tradeId ?? want.reviewId ?? want.setupId) : null;
    const req = key != null ? source.getAll(key) : source.getAll();
    req.onsuccess = () => {
      let rows = Array.isArray(req.result) ? req.result : [];
      rows = rows.filter((r) => {
        if (!r) return false;
        if (want.tradeId && String(r.tradeId || '') !== want.tradeId) return false;
        if (want.setupId && String(r.setupId || '') !== want.setupId) return false;
        if (want.reviewId && String(r.reviewId || '') !== want.reviewId) return false;
        if (want.type && normalizeType(r.type) !== want.type) return false;
        return true;
      });
      rows.sort((a, b) => String(a?.createdAt || '').localeCompare(String(b?.createdAt || '')));
      resolve({
        success: true,
        screenshots: rows.map((r) => ({ ...toMeta(r), blob: r.blob || null })),
      });
    };
    req.onerror = () => resolve(fail(req.error?.message || 'Could not list screenshots'));
  });
}

/** List every screenshot record (meta + blob). */
export async function listAll() {
  const res = await getScreenshots({});
  return res;
}

/** Delete one screenshot by id. */
export async function deleteScreenshot(id) {
  if (!id) return fail('Screenshot id is required');
  const opened = await initDB();
  if (!opened.success) return opened;
  return new Promise((resolve) => {
    let t;
    try {
      t = opened.db.transaction(STORE_NAME, 'readwrite');
    } catch (e) {
      resolve(fail(e?.message || 'Could not delete screenshot'));
      return;
    }
    const req = t.objectStore(STORE_NAME).delete(String(id));
    req.onsuccess = () => resolve({ success: true, id: String(id) });
    req.onerror = () => resolve(fail(req.error?.message || 'Could not delete screenshot'));
  });
}

/**
 * Delete all screenshots under a parent.
 * deleteByParent({tradeId, reviewId, setupId}) — at least one required.
 */
export async function deleteByParent(parent = {}) {
  const p = parent && typeof parent === 'object' ? parent : {};
  const ids = [p.tradeId, p.reviewId, p.setupId].filter((v) => v != null && v !== '');
  if (ids.length === 0) return fail('deleteByParent needs tradeId, reviewId, or setupId');
  const found = await getScreenshots({
    tradeId: p.tradeId || undefined,
    reviewId: p.reviewId || undefined,
    setupId: p.setupId || undefined,
  });
  if (!found.success) return found;
  let rows = found.screenshots;
  if (p.tradeId && p.reviewId) {
    rows = rows.filter(
      (r) => String(r.tradeId || '') === String(p.tradeId) && String(r.reviewId || '') === String(p.reviewId),
    );
  } else if (p.tradeId && p.setupId) {
    rows = rows.filter(
      (r) => String(r.tradeId || '') === String(p.tradeId) && String(r.setupId || '') === String(p.setupId),
    );
  }
  const errors = [];
  for (const r of rows) {
    const del = await deleteScreenshot(r.id);
    if (!del.success) errors.push(del.error);
  }
  if (errors.length > 0) return { success: false, error: errors.join(' ') };
  return { success: true, deleted: rows.map((r) => r.id) };
}

/** Convenience for UI previews: object URL for a stored blob (caller must revoke). */
export async function objectURLFor(id) {
  const res = await getScreenshot(id);
  if (!res.success) return res;
  if (!res.blob) return fail(`Screenshot has no image data: "${id}"`);
  try {
    return { success: true, url: URL.createObjectURL(res.blob), meta: res.meta };
  } catch (e) {
    return fail(e?.message || 'Could not preview screenshot');
  }
}

export default {
  SCREENSHOT_TYPES,
  MAX_SCREENSHOT_BYTES,
  initDB,
  saveScreenshot,
  getScreenshot,
  getScreenshots,
  listAll,
  deleteScreenshot,
  deleteByParent,
  objectURLFor,
};
