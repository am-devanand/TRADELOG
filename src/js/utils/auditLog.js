// ============================================
// Audit Log — append-only event log (offline-first)
// ============================================
// Answers WHAT changed / WHEN / WHICH entity — never current state.
// Trades/reviews/setups/rules/propConfigs/improvements remain the
// authoritative stores. Audit entries must never drive reads and the
// audit log is never a source of truth for current state.
//
// Storage: localStorage key `tradelog_audit_${clean}` holds a plain
// array of events (oldest → newest). Each event is exactly:
//   { id, entityType, entityId, action, timestamp, metadata }
//
// APPEND-ONLY: events are only ever pushed. There is no update or
// delete of individual events. Growth is capped at `maxEvents`
// (default 5000, keep newest); over-cap trims are recorded in the
// sidecar key `tradelog_audit_meta_${clean}` as { droppedCount },
// so trimming is never silent.
//
// Privacy: metadata is compact primitives only. Keys matching
// /password|token|secret|key|credential|uid|email|apiKey/i are
// dropped, values are capped in length, and nested objects/arrays
// are never stored. NEVER pass passwords, tokens, credentials,
// API keys, or full entity payloads as metadata.
//
// No side effects on import. No Firebase import (offline-safe).
// ============================================
import { generateId } from './helpers.js';

export const AUDIT_ACTIONS = Object.freeze({
  SETUP_CREATED: 'SETUP_CREATED',
  SETUP_STATUS_CHANGED: 'SETUP_STATUS_CHANGED',
  TRADE_CREATED: 'TRADE_CREATED',
  TRADE_SL_UPDATED: 'TRADE_SL_UPDATED',
  TRADE_TP_UPDATED: 'TRADE_TP_UPDATED',
  TRADE_NOTE_UPDATED: 'TRADE_NOTE_UPDATED',
  TRADE_CLOSED: 'TRADE_CLOSED',
  REVIEW_CREATED: 'REVIEW_CREATED',
  REVIEW_UPDATED: 'REVIEW_UPDATED',
  REVIEW_COMPLETED: 'REVIEW_COMPLETED',
  RULE_CREATED: 'RULE_CREATED',
  RULE_UPDATED: 'RULE_UPDATED',
  RULE_DISABLED: 'RULE_DISABLED',
  PROP_CONFIG_UPDATED: 'PROP_CONFIG_UPDATED',
  IMPROVEMENT_CREATED: 'IMPROVEMENT_CREATED',
  IMPROVEMENT_UPDATED: 'IMPROVEMENT_UPDATED',
});

export const DEFAULT_MAX_EVENTS = 5000;

const MAX_META_KEYS = 20;
const MAX_STRING_LEN = 200;
const MAX_KEY_LEN = 64;
const MAX_ENTITY_LEN = 128;

// Any metadata key hinting at secrets/identity is dropped outright.
const SENSITIVE_KEY_RE = /password|token|secret|key|credential|uid|email|apiKey/i;

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

function storageAvailable() {
  return typeof localStorage !== 'undefined';
}

function auditKey(user) {
  return `tradelog_audit_${normalizeUsername(user)}`;
}

function auditMetaKey(user) {
  return `tradelog_audit_meta_${normalizeUsername(user)}`;
}

function normalizeMaxEvents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_EVENTS;
  return Math.floor(n);
}

/** Read stored events (oldest → newest). Never throws; corrupt data reads as []. */
function readEvents(clean) {
  const parsed = safeParse(localStorage.getItem(auditKey(clean)), []);
  return Array.isArray(parsed) ? parsed : [];
}

function readDroppedCount(clean) {
  const meta = safeParse(localStorage.getItem(auditMetaKey(clean)), {});
  const n = meta && typeof meta === 'object' ? Number(meta.droppedCount) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function addDroppedCount(clean, n) {
  if (!(n > 0)) return;
  try {
    localStorage.setItem(auditMetaKey(clean), JSON.stringify({ droppedCount: readDroppedCount(clean) + n }));
  } catch {
    // Meta bookkeeping must never break the append path.
  }
}

/**
 * Compact + sanitize metadata: primitives only (string/number/boolean/null),
 * short length caps, sensitive-looking keys dropped. Never throws.
 */
function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const out = {};
  let count = 0;
  for (const k of Object.keys(metadata)) {
    if (count >= MAX_META_KEYS) break;
    if (typeof k !== 'string' || k.length === 0 || k.length > MAX_KEY_LEN) continue;
    if (SENSITIVE_KEY_RE.test(k)) continue;
    const v = metadata[k];
    if (v === null) {
      out[k] = null;
      count++;
      continue;
    }
    const t = typeof v;
    if (t === 'string') {
      out[k] = v.slice(0, MAX_STRING_LEN);
      count++;
    } else if (t === 'number') {
      if (Number.isFinite(v)) {
        out[k] = v;
        count++;
      }
    } else if (t === 'boolean') {
      out[k] = v;
      count++;
    }
    // Objects, arrays, functions, symbols, undefined: dropped (compact only).
  }
  return out;
}

/**
 * Append a single audit event. Never rewrites or deletes existing entries —
 * the only removal is oldest-first trimming when over maxEvents (recorded
 * in the meta sidecar so it is never silent).
 */
export function appendAudit(user, entry, options) {
  const clean = normalizeUsername(user);
  if (!clean) return { success: false, error: 'Invalid user' };
  if (!storageAvailable()) return { success: false, error: 'Storage unavailable' };
  const e = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const entityType = typeof e.entityType === 'string' ? e.entityType.trim() : '';
  const entityId = e.entityId == null ? '' : String(e.entityId).trim();
  if (!entityType) return { success: false, error: 'Invalid entityType' };
  if (!entityId) return { success: false, error: 'Invalid entityId' };
  if (typeof e.action !== 'string' || !Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, e.action)) {
    return { success: false, error: 'Invalid action' };
  }

  const maxEvents = normalizeMaxEvents(options && typeof options === 'object' ? options.maxEvents : undefined);
  const events = readEvents(clean);
  const record = {
    id: generateId(),
    entityType: entityType.slice(0, MAX_KEY_LEN),
    entityId: entityId.slice(0, MAX_ENTITY_LEN),
    action: e.action,
    timestamp: new Date().toISOString(),
    metadata: sanitizeMetadata(e.metadata),
  };
  events.push(record);

  let dropped = 0;
  if (events.length > maxEvents) {
    dropped = events.length - maxEvents;
    events.splice(0, dropped); // keep newest
  }
  try {
    localStorage.setItem(auditKey(clean), JSON.stringify(events));
  } catch {
    return { success: false, error: 'Failed to persist audit log' };
  }
  if (dropped > 0) addDroppedCount(clean, dropped);
  return { success: true, entry: record };
}

/**
 * Query audit events (oldest → newest). All filters optional:
 * { entityType, entityId, action, since, limit }.
 * `since` accepts an ISO string / epoch / Date; `limit` keeps the newest N.
 */
export function getAuditLog(user, filters) {
  const clean = normalizeUsername(user);
  if (!clean || !storageAvailable()) return [];
  const f = filters && typeof filters === 'object' && !Array.isArray(filters) ? filters : {};
  let events = readEvents(clean);
  if (f.entityType != null && f.entityType !== '') {
    events = events.filter((e) => e && e.entityType === f.entityType);
  }
  if (f.entityId != null && f.entityId !== '') {
    const wanted = String(f.entityId);
    events = events.filter((e) => e && String(e.entityId) === wanted);
  }
  if (f.action != null && f.action !== '') {
    events = events.filter((e) => e && e.action === f.action);
  }
  if (f.since != null && f.since !== '') {
    const sinceTime = new Date(f.since).getTime();
    if (!Number.isNaN(sinceTime)) {
      events = events.filter((e) => {
        if (!e) return false;
        const t = new Date(e.timestamp).getTime();
        return !Number.isNaN(t) && t >= sinceTime;
      });
    }
  }
  if (f.limit != null) {
    const n = Math.floor(Number(f.limit));
    if (Number.isFinite(n) && n >= 0) events = events.slice(events.length - n);
  }
  return events;
}

/** Full chronological history for one entity (oldest → newest). */
export function getEntityHistory(user, entityType, entityId) {
  if (typeof entityType !== 'string' || !entityType.trim()) return [];
  if (entityId == null || String(entityId).trim() === '') return [];
  return getAuditLog(user, { entityType: entityType.trim(), entityId: String(entityId) });
}

/** Number of stored audit events for the user. */
export function countAudit(user) {
  const clean = normalizeUsername(user);
  if (!clean || !storageAvailable()) return 0;
  return readEvents(clean).length;
}

/** Trim bookkeeping: { droppedCount } — how many oldest events were trimmed. */
export function getAuditMeta(user) {
  const clean = normalizeUsername(user);
  if (!clean || !storageAvailable()) return { droppedCount: 0 };
  return { droppedCount: readDroppedCount(clean) };
}

/**
 * Union two audit arrays by entry id (newest wins on id collision),
 * sorted oldest → newest and capped to maxEvents (keep newest).
 * Used by sync so a sync never REPLACES local entries with fewer remote ones.
 */
export function mergeAuditEntries(localEvents, remoteEvents, maxEvents) {
  const cap = normalizeMaxEvents(maxEvents);
  const byId = new Map();
  const collect = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const e of arr) {
      if (!e || typeof e !== 'object' || Array.isArray(e) || e.id == null) continue;
      const k = String(e.id);
      const cur = byId.get(k);
      if (!cur) {
        byId.set(k, e);
      } else {
        const ct = new Date(cur.timestamp).getTime();
        const nt = new Date(e.timestamp).getTime();
        if (!Number.isNaN(nt) && (Number.isNaN(ct) || nt > ct)) byId.set(k, e);
      }
    }
  };
  collect(localEvents);
  collect(remoteEvents);
  const merged = [...byId.values()].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  let dropped = 0;
  if (merged.length > cap) {
    dropped = merged.length - cap;
    merged.splice(0, dropped);
  }
  return { events: merged, dropped };
}

/**
 * Wipe the whole audit log. Requires explicit { confirm: true } —
 * individual events can never be updated or deleted.
 */
export function clearAuditLog(user, options) {
  const clean = normalizeUsername(user);
  if (!clean || !storageAvailable()) return { success: false, error: 'Storage unavailable' };
  const confirmed = !!options && typeof options === 'object' && options.confirm === true;
  if (!confirmed) return { success: false, error: 'Confirmation required' };
  const cleared = readEvents(clean).length;
  try {
    localStorage.setItem(auditKey(clean), JSON.stringify([]));
    localStorage.setItem(auditMetaKey(clean), JSON.stringify({ droppedCount: 0 }));
  } catch {
    return { success: false, error: 'Failed to clear audit log' };
  }
  return { success: true, cleared };
}
