// ============================================
// Improvements — user-owned improvement records.
// Vanilla ESM, offline-first (localStorage-first).
// No side effects on import. No network.
//
// The user-owned decision layer: analytics surfaces
// evidence; only the trader creates/accepts an
// improvement. Records store ONLY refs + counts —
// never copies of trade/review data.
//
// Key: tradelog_improvements_{user}
// Model: {id,title,description,category,source,
//   sourceType,sourceId,evidenceCount,status,
//   createdAt,updatedAt,completedAt}
// Statuses: OPEN / IN_PROGRESS / COMPLETED / ARCHIVED
// ============================================
import { generateId } from './helpers.js';
import { appendAudit } from './auditLog.js';

function safeAudit(user, entry) {
  try {
    appendAudit(user, entry);
  } catch {
    /* audit must never break improvement operations */
  }
}

export const IMPROVEMENT_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED'];

export function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function improvementsKey(user) {
  return `tradelog_improvements_${normalizeUser(user)}`;
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

function fail(error) {
  return { success: false, error: String(error || 'Unknown error') };
}

function normalizeStatus(raw) {
  const s = String(raw ?? 'OPEN').trim().toUpperCase();
  return IMPROVEMENT_STATUSES.includes(s) ? s : 'OPEN';
}

function toCount(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function readRaw(user) {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(improvementsKey(user)), []);
}

function writeAll(user, list) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(improvementsKey(user), JSON.stringify(list));
}

function normalizeImprovement(raw, user) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const now = new Date().toISOString();
  return {
    id: src.id || generateId(),
    title: String(src.title ?? ''),
    description: String(src.description ?? ''),
    category: String(src.category ?? 'GENERAL'),
    source: String(src.source ?? 'MANUAL'),
    sourceType: src.sourceType ? String(src.sourceType) : '',
    sourceId: src.sourceId ? String(src.sourceId) : '',
    evidenceCount: toCount(src.evidenceCount, 0),
    status: normalizeStatus(src.status),
    createdAt: src.createdAt || now,
    updatedAt: src.updatedAt || now,
    completedAt: src.completedAt ?? null,
  };
}

function sortNewest(list) {
  return list.sort((a, b) => {
    const da = new Date(a?.createdAt).getTime();
    const db = new Date(b?.createdAt).getTime();
    if (Number.isFinite(db) && Number.isFinite(da) && db !== da) return db - da;
    return 0;
  });
}

/** Stamp/clear completedAt from a status transition. */
function applyStatus(rec, nextStatus) {
  const status = normalizeStatus(nextStatus);
  rec.status = status;
  if (status === 'COMPLETED') {
    if (!rec.completedAt) rec.completedAt = new Date().toISOString();
  } else {
    rec.completedAt = null;
  }
  return rec;
}

// ---- Reads (return plain arrays/records; [] / undefined on bad input) ----

/** All improvements for a user (newest first). */
export function getImprovements(user) {
  const clean = normalizeUser(user);
  if (!clean) return [];
  return sortNewest(readRaw(clean).map((r) => normalizeImprovement(r, clean)));
}

/** One improvement by id, or undefined. */
export function getImprovement(user, id) {
  if (!id) return undefined;
  return getImprovements(user).find((r) => r && r.id === String(id));
}

/** OPEN + IN_PROGRESS improvements (newest first). */
export function getActiveImprovements(user) {
  return getImprovements(user).filter(
    (r) => r && (r.status === 'OPEN' || r.status === 'IN_PROGRESS'),
  );
}

/** Improvements linked to a source ref (sourceType + sourceId). */
export function getImprovementsBySource(user, sourceType, sourceId) {
  const clean = normalizeUser(user);
  if (!clean || !sourceType || !sourceId) return [];
  const st = String(sourceType);
  const sid = String(sourceId);
  return getImprovements(clean).filter((r) => r && r.sourceType === st && r.sourceId === sid);
}

// ---- Writes (return {success, improvement?, error?}) ----

/**
 * Create a user-owned improvement. Stores refs + counts only —
 * title/description are the trader's own words, sourceType/
 * sourceId point back at the evidence, never a data copy.
 */
export function createImprovement(user, data = {}) {
  try {
    const clean = normalizeUser(user);
    if (!clean) return fail('User is required');
    const d = data && typeof data === 'object' ? data : {};
    const title = String(d.title ?? '').trim();
    if (!title) return fail('Title is required');
    const now = new Date().toISOString();
    const rec = normalizeImprovement(
      { ...d, id: d.id || generateId(), title, createdAt: now, updatedAt: now },
      clean,
    );
    applyStatus(rec, d.status ?? 'OPEN');
    const all = readRaw(clean);
    if (all.some((r) => r && r.id === rec.id)) {
      return fail(`Duplicate improvement id: "${rec.id}"`);
    }
    all.push(rec);
    writeAll(clean, all);
    safeAudit(clean, {
      entityType: 'improvement',
      entityId: String(rec.id),
      action: 'IMPROVEMENT_CREATED',
      metadata: { title: String(rec.title ?? ''), status: String(rec.status ?? '') },
    });
    return { success: true, improvement: normalizeImprovement(rec, clean) };
  } catch (e) {
    return fail(e?.message || 'Failed to create improvement');
  }
}

const IMMUTABLE_IMPROVEMENT_FIELDS = new Set(['id', 'createdAt']);

/**
 * Update an improvement's own fields. Setting status COMPLETED
 * stamps completedAt; leaving COMPLETED clears it.
 */
export function updateImprovement(user, id, updates = {}) {
  try {
    const clean = normalizeUser(user);
    if (!clean) return fail('User is required');
    if (!id) return fail('Improvement id is required');
    const src = updates && typeof updates === 'object' && !Array.isArray(updates) ? updates : {};
    const all = readRaw(clean);
    const idx = all.findIndex((r) => r && r.id === String(id));
    if (idx === -1) return fail(`Improvement not found: "${id}"`);
    const stored = normalizeImprovement(all[idx], clean);
    const cleanUpdates = {};
    for (const k of Object.keys(src)) {
      if (!IMMUTABLE_IMPROVEMENT_FIELDS.has(k)) cleanUpdates[k] = src[k];
    }
    const merged = normalizeImprovement(
      { ...stored, ...cleanUpdates, id: stored.id, updatedAt: new Date().toISOString() },
      clean,
    );
    if (Object.prototype.hasOwnProperty.call(cleanUpdates, 'status')) {
      applyStatus(merged, cleanUpdates.status);
    } else if (stored.status === 'COMPLETED') {
      merged.completedAt = stored.completedAt;
    }
    all[idx] = merged;
    writeAll(clean, all);
    safeAudit(clean, {
      entityType: 'improvement',
      entityId: String(merged.id),
      action: 'IMPROVEMENT_UPDATED',
      metadata: { status: String(merged.status ?? '') },
    });
    return { success: true, improvement: merged };
  } catch (e) {
    return fail(e?.message || 'Failed to update improvement');
  }
}

/** Delete an improvement. Evidence (trades/reviews) is never touched. */
export function deleteImprovement(user, id) {
  try {
    const clean = normalizeUser(user);
    if (!clean) return fail('User is required');
    if (!id) return fail('Improvement id is required');
    const all = readRaw(clean);
    const next = all.filter((r) => !(r && r.id === String(id)));
    if (next.length === all.length) return fail(`Improvement not found: "${id}"`);
    writeAll(clean, next);
    return { success: true };
  } catch (e) {
    return fail(e?.message || 'Failed to delete improvement');
  }
}

export default {
  IMPROVEMENT_STATUSES,
  normalizeUser,
  getImprovements,
  getImprovement,
  getActiveImprovements,
  getImprovementsBySource,
  createImprovement,
  updateImprovement,
  deleteImprovement,
};
