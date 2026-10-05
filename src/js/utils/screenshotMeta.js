// ============================================
// Screenshot metadata mirror — localStorage only.
// Key: tradelog_screenshots_{user}. Holds ID-only
// metadata objects, NEVER blobs or base64:
// {id,tradeId,setupId,reviewId,type,filename,mimeType,size,createdAt}.
// Included in the Firebase sync payload (see storage.js)
// so refs survive login; blobs stay in IndexedDB.
// ============================================

const VALID_TYPES = new Set(['ENTRY', 'MANAGEMENT', 'EXIT', 'OTHER']);

function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function metaKey(user) {
  return `tradelog_screenshots_${normalizeUser(user)}`;
}

function safeParse(raw, fallback) {
  try {
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeType(raw) {
  const t = String(raw || 'OTHER').trim().toUpperCase();
  return VALID_TYPES.has(t) ? t : 'OTHER';
}

/**
 * Strip any record down to the exact metadata shape.
 * Drops blob/base64/dataUrl fields if ever present.
 */
export function toMetaShape(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (!rec.id) return null;
  return {
    id: String(rec.id),
    tradeId: rec.tradeId ? String(rec.tradeId) : '',
    setupId: rec.setupId ? String(rec.setupId) : '',
    reviewId: rec.reviewId ? String(rec.reviewId) : '',
    type: normalizeType(rec.type),
    filename: String(rec.filename || 'screenshot'),
    mimeType: String(rec.mimeType || 'image/png'),
    size: Number.isFinite(Number(rec.size)) ? Number(rec.size) : 0,
    createdAt: rec.createdAt || new Date().toISOString(),
  };
}

function readAll(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(metaKey(user)), [])
    .map(toMetaShape)
    .filter(Boolean);
}

function writeAll(user, list) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(metaKey(user), JSON.stringify(list));
}

function matches(meta, filter) {
  const f = filter && typeof filter === 'object' ? filter : {};
  if (f.tradeId != null && f.tradeId !== '' && meta.tradeId !== String(f.tradeId)) return false;
  if (f.setupId != null && f.setupId !== '' && meta.setupId !== String(f.setupId)) return false;
  if (f.reviewId != null && f.reviewId !== '' && meta.reviewId !== String(f.reviewId)) return false;
  if (f.type && normalizeType(f.type) !== meta.type) {
    // Exact match only when a valid type filter was passed
    if (VALID_TYPES.has(String(f.type).trim().toUpperCase())) return false;
  }
  if (Array.isArray(f.ids) && f.ids.length > 0) {
    const set = new Set(f.ids.map(String));
    if (!set.has(meta.id)) return false;
  }
  return true;
}

/** Ensure the mirror key exists (seed []). Idempotent, never deletes. */
export function ensureMirror(user) {
  if (typeof localStorage === 'undefined') return { success: false, error: 'localStorage unavailable' };
  const clean = normalizeUser(user);
  if (!clean) return { success: false, error: 'User is required' };
  if (localStorage.getItem(metaKey(clean)) == null) {
    writeAll(clean, []);
  }
  return { success: true };
}

/** List ID-only metadata, optionally filtered by {tradeId,setupId,reviewId,type,ids}. */
export function listMeta(user, filter = {}) {
  if (typeof localStorage === 'undefined') return [];
  const clean = normalizeUser(user);
  if (!clean) return [];
  return readAll(clean).filter((m) => matches(m, filter));
}

/** Add (or replace by id) one metadata record. Never stores blobs. */
export function addMeta(user, meta) {
  const clean = normalizeUser(user);
  if (!clean) return { success: false, error: 'User is required' };
  const shaped = toMetaShape(meta);
  if (!shaped) return { success: false, error: 'Screenshot metadata must include an id' };
  const all = readAll(clean);
  const idx = all.findIndex((m) => m.id === shaped.id);
  if (idx === -1) all.push(shaped);
  else all[idx] = shaped;
  writeAll(clean, all);
  return { success: true, meta: shaped };
}

/** Remove one metadata record by id. */
export function removeMeta(user, id) {
  const clean = normalizeUser(user);
  if (!clean) return { success: false, error: 'User is required' };
  if (!id) return { success: false, error: 'Screenshot id is required' };
  const all = readAll(clean);
  const next = all.filter((m) => m.id !== String(id));
  if (next.length === all.length) return { success: false, error: `Screenshot ref not found: "${id}"` };
  writeAll(clean, next);
  return { success: true, id: String(id) };
}

/** Remove all metadata refs under a parent ({tradeId,reviewId,setupId}). */
export function removeByParent(user, parent = {}) {
  const clean = normalizeUser(user);
  if (!clean) return { success: false, error: 'User is required' };
  const p = parent && typeof parent === 'object' ? parent : {};
  if (p.tradeId == null && p.reviewId == null && p.setupId == null) {
    return { success: false, error: 'removeByParent needs tradeId, reviewId, or setupId' };
  }
  const all = readAll(clean);
  const strict = all.filter((m) => {
    if (p.tradeId != null && p.tradeId !== '' && m.tradeId !== String(p.tradeId)) return false;
    if (p.reviewId != null && p.reviewId !== '' && m.reviewId !== String(p.reviewId)) return false;
    if (p.setupId != null && p.setupId !== '' && m.setupId !== String(p.setupId)) return false;
    return true;
  });
  writeAll(
    clean,
    all.filter((m) => !strict.some((s) => s.id === m.id)),
  );
  return { success: true, removed: strict.map((s) => s.id) };
}

/** Raw mirror read for sync payloads (array of ID-only metas). */
export function getMirrorForSync(user) {
  const clean = normalizeUser(user);
  if (!clean) return [];
  return readAll(clean);
}

/** Overwrite the mirror from a sync payload (keeps ID-only shape). */
export function setMirrorFromSync(user, list) {
  const clean = normalizeUser(user);
  if (!clean) return { success: false, error: 'User is required' };
  const shaped = (Array.isArray(list) ? list : []).map(toMetaShape).filter(Boolean);
  writeAll(clean, shaped);
  return { success: true, count: shaped.length };
}

export default {
  toMetaShape,
  ensureMirror,
  listMeta,
  addMeta,
  removeMeta,
  removeByParent,
  getMirrorForSync,
  setMirrorFromSync,
};
