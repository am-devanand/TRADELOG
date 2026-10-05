// ============================================
// Backup & Restore — JSON export/import data layer
// Vanilla ESM, offline-first. No side effects on import.
// No network. No Firebase import anywhere in this file.
//
// Reads localStorage keys directly (never via storage.js /
// ruleManager.js, which import Firebase) so export + validation
// stay usable offline. JSON holds metadata + references ONLY:
// image blobs live in IndexedDB and are never embedded.
// ============================================

export const BACKUP_FORMAT = 'TRADELOG_BACKUP';
export const BACKUP_VERSION = 1;

const APP_VERSION = '0.0.0';

const USER_SECTIONS = [
  'accounts',
  'rules',
  'setups',
  'trades',
  'reviews',
  'propConfigs',
  'improvements',
  'audit',
  'analyticsPrefs',
  'screenshotMeta',
];

// Case-insensitive denylist swept at every depth on export. Prefix variants
// (ownerEmail, userToken, ...) are matched by suffix so a backup cannot leak
// identity or credentials under a renamed field.
// Per-record `userId` scope is intentionally NOT stripped here: it is
// re-stamped to the restoring user on import instead of leaking identity.
const SECRET_KEYS = new Set([
  'password',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'apikey',
  'api_key',
  'apisecret',
  'secret',
  'secretkey',
  'credential',
  'credentials',
  'uid',
  'username',
  'email',
  'useremail',
]);

const OWNER_KEYS = new Set(['userid', 'username', 'email', 'uid']);

const OWNER_PREFIXES = ['owner', 'user', 'account', 'profile'];

function isSensitiveKey(key) {
  const k = String(key).toLowerCase();
  if (SECRET_KEYS.has(k)) return true;
  return OWNER_PREFIXES.some(
    (p) => k.startsWith(p) && (SECRET_KEYS.has(k.slice(p.length)) || OWNER_KEYS.has(k.slice(p.length))),
  );
}

function normalizeUser(user) {
  return String(user || '').trim().toLowerCase();
}

function safeParse(raw, fallback) {
  try {
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return fallback;
  }
}

function readKey(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return safeParse(raw, fallback);
  } catch {
    return fallback;
  }
}

function deepClone(v) {
  try {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  } catch {
    return Array.isArray(v) ? [...v] : v;
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Deterministic key order so the same data always serializes identically.
function stableStringify(value) {
  const seen = new Set();
  const sort = (v) => {
    if (v == null || typeof v !== 'object') return v;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) return v.map(sort);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
    return out;
  };
  return JSON.stringify(sort(value));
}

function looksLikeBlobString(v) {
  return (
    typeof v === 'string' &&
    (v.startsWith('data:image/') ||
      v.startsWith('data:application/') ||
      v.startsWith('data:video/') ||
      v.startsWith('blob:'))
  );
}

// Strip secrets + blob strings at any depth; drop owner identity fields
// (re-stamped on restore). Round nothing — values stay authoritative.
function sanitizeForExport(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const s = sanitizeForExport(item);
      if (s !== undefined) out.push(s);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      const low = k.toLowerCase();
      if (isSensitiveKey(k)) continue;
      if (low === 'base64' || low === 'blob' || low === 'dataurl' || low === 'imagedata') continue;
      const s = sanitizeForExport(value[k]);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  if (looksLikeBlobString(value)) return undefined;
  return value;
}

// auditLog.js may be built in parallel, so it is never statically imported
// here (a static import of a missing file would break this whole module).
// Audit entries are read from the conventional localStorage keys instead.
function readAuditSnapshot(user) {
  const clean = normalizeUser(user);
  const candidates = [
    `tradelog_audit_${clean}`,
    `tradelog_auditlog_${clean}`,
    `tradelog_audit_log_${clean}`,
  ];
  for (const key of candidates) {
    const v = readKey(key, null);
    if (Array.isArray(v)) return { entries: v, from: key };
  }
  return {
    entries: [],
    from: null,
    reason: 'auditLog store not found; exported an empty audit array',
  };
}

function toScreenshotMetaShape(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec) || !rec.id) return null;
  return {
    id: String(rec.id),
    type: String(rec.type || 'OTHER'),
    filename: String(rec.filename || 'screenshot'),
    mimeType: String(rec.mimeType || 'image/png'),
    size: Number.isFinite(Number(rec.size)) ? Number(rec.size) : 0,
    createdAt: rec.createdAt || new Date().toISOString(),
  };
}

function storageKeys(user) {
  const u = normalizeUser(user);
  return {
    accounts: `tradelog_folders_${u}`,
    rules: `tradelog_rules_${u}`,
    setups: `tradelog_setups_${u}`,
    trades: `tradelog_exectrades_${u}`,
    reviews: `tradelog_reviews_${u}`,
    propConfigs: `tradelog_propconfig_${u}`,
    improvements: `tradelog_improvements_${u}`,
    analyticsPrefs: `tradelog_analytics_prefs_${u}`,
    screenshots: `tradelog_screenshots_${u}`,
  };
}

function collectUserData(user) {
  const keys = storageKeys(user);
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const rawScreenshots = asArray(readKey(keys.screenshots, []));
  const audit = readAuditSnapshot(user);
  return {
    data: {
      accounts: asArray(readKey(keys.accounts, [])),
      rules: asArray(readKey(keys.rules, [])),
      setups: asArray(readKey(keys.setups, [])),
      trades: asArray(readKey(keys.trades, [])),
      reviews: asArray(readKey(keys.reviews, [])),
      propConfigs: asObject(readKey(keys.propConfigs, {})),
      improvements: asArray(readKey(keys.improvements, [])),
      audit: asArray(audit.entries),
      analyticsPrefs: asObject(readKey(keys.analyticsPrefs, {})),
      screenshotMeta: rawScreenshots.map(toScreenshotMetaShape).filter(Boolean),
    },
    auditReason: audit.reason || null,
  };
}

/** Build the full backup payload for a user. Pure read — never writes. */
export function exportBackup(user) {
  const clean = normalizeUser(user);
  const { data, auditReason } = collectUserData(clean);
  const warnings = [];
  if (auditReason) warnings.push(auditReason);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    applicationVersion: APP_VERSION,
    screenshotsIncluded: false,
    screenshotNote:
      'JSON backup carries screenshot metadata only; image blobs stay in IndexedDB and are never embedded.',
    userData: sanitizeForExport(data),
    warnings,
  };
}

/** Serialize a backup deterministically for file output. */
export function buildBackupBlob(backup) {
  const text = stableStringify(backup);
  return new Blob([text], { type: 'application/json' });
}

/** Trigger a browser download of the backup JSON. No-op off-browser. */
export function downloadBackup(backup, filename) {
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
      return { success: false, error: 'Download is only available in a browser' };
    }
    const blob = buildBackupBlob(backup);
    const name =
      filename ||
      `tradelog-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { success: true, filename: String(name) };
  } catch (e) {
    return { success: false, error: e?.message || 'Download failed' };
  }
}

/** Top-level structural check: format tag, version type, section shapes. */
export function validateBackupSchema(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Backup must be an object'] };
  }
  if (data.format !== BACKUP_FORMAT) {
    errors.push(`Unknown backup format: ${String(data.format)} (expected ${BACKUP_FORMAT})`);
  }
  if (!Number.isInteger(data.version)) {
    errors.push('Backup "version" must be an integer');
  }
  if (typeof data.exportedAt !== 'string' || data.exportedAt === '') {
    errors.push('Backup "exportedAt" must be a non-empty string');
  }
  const ud = data.userData;
  if (!ud || typeof ud !== 'object' || Array.isArray(ud)) {
    errors.push('Backup "userData" must be an object');
  } else {
    for (const section of USER_SECTIONS) {
      const v = ud[section];
      if (section === 'propConfigs' || section === 'analyticsPrefs') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          errors.push(`userData.${section} must be an object`);
        }
      } else if (!Array.isArray(v)) {
        errors.push(`userData.${section} must be an array`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function isRecord(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function checkIds(list, section, errors) {
  const seen = new Set();
  list.forEach((rec, i) => {
    if (!isRecord(rec)) {
      errors.push(`${section}[${i}] must be an object`);
      return;
    }
    if (typeof rec.id !== 'string' || rec.id === '') {
      errors.push(`${section}[${i}] must have a string "id"`);
      return;
    }
    if (seen.has(rec.id)) errors.push(`${section} has a duplicate id: "${rec.id}"`);
    seen.add(rec.id);
  });
  return seen;
}

/** Per-record shape checks (no cross-section logic here). */
export function validateEntities(data) {
  const errors = [];
  const schema = validateBackupSchema(data);
  if (!schema.valid) return { valid: false, errors: schema.errors };
  const ud = data.userData;
  checkIds(ud.accounts, 'accounts', errors);
  const ruleIds = checkIds(ud.rules, 'rules', errors);
  void ruleIds;
  ud.rules.forEach((r, i) => {
    if (!isRecord(r)) return;
    if (typeof r.name !== 'string' || r.name.trim() === '') {
      errors.push(`rules[${i}] must have a non-empty "name"`);
    }
  });
  checkIds(ud.setups, 'setups', errors);
  checkIds(ud.trades, 'trades', errors);
  checkIds(ud.reviews, 'reviews', errors);
  ud.reviews.forEach((r, i) => {
    if (!isRecord(r)) return;
    if (typeof r.tradeId !== 'string' || r.tradeId === '') {
      errors.push(`reviews[${i}] must have a non-empty "tradeId"`);
    }
  });
  for (const key of Object.keys(ud.propConfigs)) {
    const cfg = ud.propConfigs[key];
    if (!isRecord(cfg)) {
      errors.push(`propConfigs["${key}"] must be an object`);
      continue;
    }
    if (cfg.rules !== undefined && !Array.isArray(cfg.rules)) {
      errors.push(`propConfigs["${key}"].rules must be an array`);
    }
  }
  checkIds(ud.improvements, 'improvements', errors);
  ud.improvements.forEach((rec, i) => {
    if (!isRecord(rec)) return;
    if (typeof rec.title !== 'string' || rec.title.trim() === '') {
      errors.push(`improvements[${i}] must have a non-empty "title"`);
    }
  });
  ud.audit.forEach((entry, i) => {
    if (!isRecord(entry)) errors.push(`audit[${i}] must be an object`);
  });
  ud.screenshotMeta.forEach((m, i) => {
    if (!isRecord(m)) {
      errors.push(`screenshotMeta[${i}] must be an object`);
      return;
    }
    if (typeof m.id !== 'string' || m.id === '') {
      errors.push(`screenshotMeta[${i}] must have a string "id"`);
    }
  });
  return { valid: errors.length === 0, errors };
}

/**
 * Cross-section reference checks. A review without its trade is a hard
 * error (reviews are meaningless dangling); other dangling refs are
 * warnings since live data can hold them (e.g. a setup deleted after
 * its trade executed, or a folder removed while trades remain).
 */
export function validateReferences(data) {
  const errors = [];
  const warnings = [];
  const entities = validateEntities(data);
  if (!entities.valid) return { valid: false, errors: entities.errors, warnings };
  const ud = data.userData;
  const accountIds = new Set(ud.accounts.map((a) => a.id));
  const setupIds = new Set(ud.setups.map((s) => s.id));
  const tradeIds = new Set(ud.trades.map((t) => t.id));
  const reviewIds = new Set(ud.reviews.map((r) => r.id));
  for (const r of ud.reviews) {
    if (!tradeIds.has(r.tradeId)) {
      errors.push(`Review "${r.id}" points at missing trade "${r.tradeId}"`);
    }
    if (r.setupId != null && r.setupId !== '' && !setupIds.has(String(r.setupId))) {
      warnings.push(`Review "${r.id}" points at missing setup "${r.setupId}"`);
    }
    if (r.accountId != null && r.accountId !== '' && !accountIds.has(String(r.accountId))) {
      warnings.push(`Review "${r.id}" points at missing account "${r.accountId}"`);
    }
  }
  for (const t of ud.trades) {
    if (t.accountId != null && t.accountId !== '' && !accountIds.has(String(t.accountId))) {
      warnings.push(`Trade "${t.id}" points at missing account "${t.accountId}"`);
    }
    if (t.setupId != null && t.setupId !== '' && !setupIds.has(String(t.setupId))) {
      warnings.push(`Trade "${t.id}" points at missing setup "${t.setupId}"`);
    }
  }
  for (const s of ud.setups) {
    if (s.accountId != null && s.accountId !== '' && !accountIds.has(String(s.accountId))) {
      warnings.push(`Setup "${s.id}" points at missing account "${s.accountId}"`);
    }
  }
  for (const m of ud.screenshotMeta) {
    for (const [field, ids] of [
      ['tradeId', tradeIds],
      ['setupId', setupIds],
      ['reviewId', reviewIds],
    ]) {
      if (m[field] != null && m[field] !== '' && !ids.has(String(m[field]))) {
        warnings.push(`Screenshot "${m.id}" points at missing ${field} "${m[field]}"`);
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** Counts per section plus export metadata. Pure read — never writes. */
export function previewBackup(data) {
  const parsed = typeof data === 'string' ? safeParse(data, null) : data;
  const schema = validateBackupSchema(parsed);
  if (!schema.valid) {
    return { success: false, error: schema.errors.join('; ') || 'Invalid backup' };
  }
  const ud = parsed.userData;
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  const keys = (v) => (v && typeof v === 'object' ? Object.keys(v).length : 0);
  return {
    success: true,
    format: parsed.format,
    version: parsed.version,
    exportedAt: parsed.exportedAt,
    applicationVersion: parsed.applicationVersion || '',
    screenshotsIncluded: parsed.screenshotsIncluded === true,
    counts: {
      accounts: len(ud.accounts),
      rules: len(ud.rules),
      setups: len(ud.setups),
      trades: len(ud.trades),
      reviews: len(ud.reviews),
      propConfigs: keys(ud.propConfigs),
      improvements: len(ud.improvements),
      audit: len(ud.audit),
      analyticsPrefs: keys(ud.analyticsPrefs),
      screenshotMeta: len(ud.screenshotMeta),
    },
  };
}

/**
 * Version gate for forward migration. Backups newer than this app are
 * rejected outright — never guessed at — while v1 payloads pass through
 * with missing sections defaulted.
 */
export function migrateBackup(data) {
  const parsed = typeof data === 'string' ? safeParse(data, null) : data;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { success: false, error: 'Backup must be an object' };
  }
  if (parsed.format !== BACKUP_FORMAT) {
    return { success: false, error: `Unknown backup format: ${String(parsed.format)}` };
  }
  if (!Number.isInteger(parsed.version)) {
    return { success: false, error: 'Backup "version" must be an integer' };
  }
  if (parsed.version > BACKUP_VERSION) {
    return {
      success: false,
      error: `Unsupported backup version ${parsed.version} (app supports up to v${BACKUP_VERSION}); refusing to import a newer backup`,
    };
  }
  if (parsed.version < BACKUP_VERSION) {
    return { success: false, error: `Unknown backup version ${parsed.version}` };
  }
  const ud = parsed.userData && typeof parsed.userData === 'object' ? parsed.userData : {};
  const backup = deepClone(parsed);
  backup.userData = {
    accounts: Array.isArray(ud.accounts) ? ud.accounts : [],
    rules: Array.isArray(ud.rules) ? ud.rules : [],
    setups: Array.isArray(ud.setups) ? ud.setups : [],
    trades: Array.isArray(ud.trades) ? ud.trades : [],
    reviews: Array.isArray(ud.reviews) ? ud.reviews : [],
    propConfigs:
      ud.propConfigs && typeof ud.propConfigs === 'object' && !Array.isArray(ud.propConfigs)
        ? ud.propConfigs
        : {},
    improvements: Array.isArray(ud.improvements) ? ud.improvements : [],
    audit: Array.isArray(ud.audit) ? ud.audit : [],
    analyticsPrefs:
      ud.analyticsPrefs && typeof ud.analyticsPrefs === 'object' && !Array.isArray(ud.analyticsPrefs)
        ? ud.analyticsPrefs
        : {},
    screenshotMeta: Array.isArray(ud.screenshotMeta) ? ud.screenshotMeta : [],
  };
  return { success: true, backup };
}

function uniqueId(existing) {
  let id = newId();
  let guard = 0;
  while (existing.has(id) && guard < 10) {
    id = newId();
    guard += 1;
  }
  existing.add(id);
  return id;
}

// Remap old ids to fresh ones in copy mode so imported records sit
// alongside existing data, then rewrite every cross-reference through
// the same map before anything is written.
function buildCopyPlan(userData, existingIds) {
  const plan = deepClone(userData);
  const idMap = new Map();
  const sections = ['accounts', 'rules', 'setups', 'trades', 'reviews', 'improvements'];
  for (const section of sections) {
    for (const rec of plan[section]) {
      if (!isRecord(rec) || typeof rec.id !== 'string' || rec.id === '') continue;
      const fresh = uniqueId(existingIds);
      idMap.set(`${section}:${rec.id}`, fresh);
      rec.id = fresh;
    }
  }
  const shots = [];
  for (const m of plan.screenshotMeta) {
    if (!isRecord(m) || typeof m.id !== 'string' || m.id === '') continue;
    const fresh = uniqueId(existingIds);
    idMap.set(`screenshotMeta:${m.id}`, fresh);
    m.id = fresh;
    shots.push(m);
  }
  void shots;
  const pick = (section, oldId) => {
    if (oldId == null || oldId === '') return oldId;
    return idMap.get(`${section}:${String(oldId)}`) ?? oldId;
  };
  for (const t of plan.trades) {
    if (!isRecord(t)) continue;
    t.accountId = pick('accounts', t.accountId);
    t.setupId = pick('setups', t.setupId);
  }
  for (const s of plan.setups) {
    if (!isRecord(s)) continue;
    s.accountId = pick('accounts', s.accountId);
  }
  for (const r of plan.reviews) {
    if (!isRecord(r)) continue;
    r.tradeId = pick('trades', r.tradeId);
    r.setupId = pick('setups', r.setupId);
    r.accountId = pick('accounts', r.accountId);
  }
  for (const rec of plan.improvements) {
    if (!isRecord(rec)) continue;
    if (rec.sourceType === 'TRADE' || rec.sourceType === 'trade') {
      rec.sourceId = pick('trades', rec.sourceId);
    } else if (rec.sourceType === 'REVIEW' || rec.sourceType === 'review') {
      rec.sourceId = pick('reviews', rec.sourceId);
    } else if (rec.sourceType === 'SETUP' || rec.sourceType === 'setup') {
      rec.sourceId = pick('setups', rec.sourceId);
    }
  }
  for (const m of plan.screenshotMeta) {
    if (!isRecord(m)) continue;
    if (m.tradeId != null && m.tradeId !== '') m.tradeId = pick('trades', m.tradeId);
    if (m.setupId != null && m.setupId !== '') m.setupId = pick('setups', m.setupId);
    if (m.reviewId != null && m.reviewId !== '') m.reviewId = pick('reviews', m.reviewId);
  }
  const nextPropConfigs = {};
  for (const key of Object.keys(plan.propConfigs)) {
    const remapped = pick('accounts', key);
    const cfg = plan.propConfigs[key];
    const finalKey = typeof remapped === 'string' && remapped !== '' ? remapped : key;
    nextPropConfigs[finalKey] =
      isRecord(cfg) && cfg.accountId != null ? { ...cfg, accountId: finalKey } : cfg;
  }
  plan.propConfigs = nextPropConfigs;
  return plan;
}

function stampOwner(plan, user) {
  const clean = normalizeUser(user);
  for (const section of ['rules', 'setups', 'trades', 'reviews', 'improvements']) {
    for (const rec of plan[section]) {
      if (isRecord(rec)) rec.userId = clean;
    }
  }
  return plan;
}

function collectExistingIds(user) {
  const keys = storageKeys(user);
  const ids = new Set();
  for (const key of [keys.accounts, keys.rules, keys.setups, keys.trades, keys.reviews]) {
    for (const rec of readKey(key, [])) {
      if (isRecord(rec) && rec.id != null && rec.id !== '') ids.add(String(rec.id));
    }
  }
  for (const m of readKey(keys.screenshots, [])) {
    if (isRecord(m) && m.id != null && m.id !== '') ids.add(String(m.id));
  }
  return ids;
}

/**
 * Restore a backup into localStorage.
 * - mode 'copy' (default): import alongside existing data with fresh ids.
 * - mode 'replace': overwrite every section; requires { confirm: true }.
 *
 * Everything is validated and staged into a plan FIRST; localStorage is
 * only touched in the final commit loop. Any validation failure returns
 * { success: false, error } with zero writes, so existing data is never
 * left half-modified.
 */
export function restoreBackup(user, backup, options = {}) {
  const clean = normalizeUser(user);
  if (!clean) return { success: false, error: 'User is required' };
  const opts = options && typeof options === 'object' ? options : {};
  const mode = opts.mode == null || opts.mode === '' ? 'copy' : String(opts.mode).toLowerCase();
  if (mode !== 'copy' && mode !== 'replace') {
    return { success: false, error: `Unknown restore mode: "${opts.mode}" (use "copy" or "replace")` };
  }
  // Never silently overwrite: replace demands an explicit confirm flag.
  if (mode === 'replace' && opts.confirm !== true) {
    return { success: false, error: 'Replace mode requires { confirm: true }' };
  }
  if (typeof localStorage === 'undefined') {
    return { success: false, error: 'localStorage unavailable' };
  }

  const migrated = migrateBackup(backup);
  if (!migrated.success) return { success: false, error: migrated.error };
  const schema = validateBackupSchema(migrated.backup);
  if (!schema.valid) return { success: false, error: schema.errors.join('; ') };
  const entities = validateEntities(migrated.backup);
  if (!entities.valid) return { success: false, error: entities.errors.join('; ') };
  const refs = validateReferences(migrated.backup);
  if (!refs.valid) return { success: false, error: refs.errors.join('; ') };

  // ---- Stage (pure; no writes yet) ----
  const keys = storageKeys(clean);
  let staged;
  if (mode === 'copy') {
    const existingIds = collectExistingIds(clean);
    staged = buildCopyPlan(migrated.backup.userData, existingIds);
    staged = stampOwner(staged, clean);
    for (const section of ['accounts', 'rules', 'setups', 'trades', 'reviews', 'improvements']) {
      const current = readKey(keys[section], []);
      staged[section] = [...(Array.isArray(current) ? current : []), ...staged[section]];
    }
    const currentShots = readKey(keys.screenshots, []);
    const incomingShots = staged.screenshotMeta.map(toScreenshotMetaShape).filter(Boolean);
    staged.screenshotMeta = [...(Array.isArray(currentShots) ? currentShots : []), ...incomingShots];
    const currentProps =
      readKey(keys.propConfigs, {}) && typeof readKey(keys.propConfigs, {}) === 'object'
        ? readKey(keys.propConfigs, {})
        : {};
    staged.propConfigs = { ...(currentProps || {}), ...staged.propConfigs };
  } else {
    staged = stampOwner(deepClone(migrated.backup.userData), clean);
    staged.screenshotMeta = staged.screenshotMeta.map(toScreenshotMetaShape).filter(Boolean);
  }

  // ---- Commit (the only place that writes) ----
  try {
    localStorage.setItem(keys.accounts, JSON.stringify(staged.accounts));
    localStorage.setItem(keys.rules, JSON.stringify(staged.rules));
    localStorage.setItem(keys.setups, JSON.stringify(staged.setups));
    localStorage.setItem(keys.trades, JSON.stringify(staged.trades));
    localStorage.setItem(keys.reviews, JSON.stringify(staged.reviews));
    localStorage.setItem(keys.propConfigs, JSON.stringify(staged.propConfigs));
    localStorage.setItem(keys.improvements, JSON.stringify(staged.improvements));
    localStorage.setItem(keys.analyticsPrefs, JSON.stringify(staged.analyticsPrefs));
    localStorage.setItem(keys.screenshots, JSON.stringify(staged.screenshotMeta));
  } catch (e) {
    return { success: false, error: e?.message || 'Restore commit failed' };
  }
  const preview = previewBackup(migrated.backup);
  return {
    success: true,
    mode,
    counts: preview.success ? preview.counts : {},
    warnings: refs.warnings || [],
  };
}

export default {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  exportBackup,
  buildBackupBlob,
  downloadBackup,
  validateBackupSchema,
  validateEntities,
  validateReferences,
  previewBackup,
  restoreBackup,
  migrateBackup,
};
