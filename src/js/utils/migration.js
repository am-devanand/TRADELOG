// Migration v1 — backfill missing trade/folder fields (idempotent, never deletes data)
import { generateId } from './helpers.js';
import { makeAccountDefaults, makeTradeDefaults } from './models.js';

const MIGRATION_VERSION = 1;
const MIGRATION_VERSION_V2 = 2;
const MIGRATION_VERSION_V3 = 3;
const MIGRATION_VERSION_V4 = 4;
const MIGRATION_VERSION_V5 = 5;
const MIGRATION_VERSION_V6 = 6;
const MIGRATION_VERSION_V7 = 7;
const MIGRATION_VERSION_V8 = 8;
const MIGRATION_VERSION_V9 = 9;
const MIGRATION_VERSION_V10 = 10;

// Storage key for the idempotency flag
function flagKey(user) {
  return `tradelog_migration_v1_${user}`;
}

function flagKeyV2(user) {
  return `tradelog_migration_v2_${user}`;
}

function flagKeyV3(user) {
  return `tradelog_migration_v3_${user}`;
}

function flagKeyV4(user) {
  return `tradelog_migration_v4_${user}`;
}

function flagKeyV5(user) {
  return `tradelog_migration_v5_${user}`;
}

function flagKeyV6(user) {
  return `tradelog_migration_v6_${user}`;
}

function flagKeyV7(user) {
  return `tradelog_migration_v7_${user}`;
}

function flagKeyV8(user) {
  return `tradelog_migration_v8_${user}`;
}

function flagKeyV9(user) {
  return `tradelog_migration_v9_${user}`;
}

function flagKeyV10(user) {
  return `tradelog_migration_v10_${user}`;
}

// Local parse that never throws (avoids importing firebase via storage.js)
function safeParse(raw, fallback) {
  try {
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Returns 10 when v10 migrated, 9 when v9 migrated, down to 0 when never migrated */
export function getMigrationVersion(user) {
  if (!user || typeof localStorage === 'undefined') return 0;
  if (localStorage.getItem(flagKeyV10(user))) return MIGRATION_VERSION_V10;
  if (localStorage.getItem(flagKeyV8(user))) return MIGRATION_VERSION_V8;
  if (localStorage.getItem(flagKeyV7(user))) return MIGRATION_VERSION_V7;
  if (localStorage.getItem(flagKeyV6(user))) return MIGRATION_VERSION_V6;
  if (localStorage.getItem(flagKeyV5(user))) return MIGRATION_VERSION_V5;
  if (localStorage.getItem(flagKeyV4(user))) return MIGRATION_VERSION_V4;
  if (localStorage.getItem(flagKeyV3(user))) return MIGRATION_VERSION_V3;
  if (localStorage.getItem(flagKeyV2(user))) return MIGRATION_VERSION_V2;
  return localStorage.getItem(flagKey(user)) ? MIGRATION_VERSION : 0;
}

/** Fill a single trade record in place without dropping unknown fields */
function migrateTrade(trade) {
  const d = makeTradeDefaults();
  if (trade.id == null || trade.id === '') trade.id = generateId();
  if (trade.direction == null || trade.direction === '') trade.direction = d.direction;
  if (trade.riskPercent == null || trade.riskPercent === '') trade.riskPercent = d.riskPercent;
  if (trade.status == null || trade.status === '') trade.status = d.status;
  if (trade.checklistScore == null || trade.checklistScore === '') trade.checklistScore = d.checklistScore;
  if (trade.strategyId == null) trade.strategyId = d.strategyId;
  if (trade.createdAt == null || trade.createdAt === '') trade.createdAt = new Date().toISOString();
  return trade;
}

/** Backfill folders + trades for user; safe to run multiple times */
export function migrateUser(user) {
  if (!user || typeof localStorage === 'undefined') return { migrated: false, version: 0 };
  let migrated = false;

  if (!localStorage.getItem(flagKey(user))) {
    const accountDefaults = makeAccountDefaults();
    const folders = safeParse(localStorage.getItem(`tradelog_folders_${user}`), []);
    const nextFolders = Array.isArray(folders) ? folders : [];

    for (const folder of nextFolders) {
      if (folder == null || typeof folder !== 'object') continue;
      if (folder.id == null || folder.id === '') folder.id = generateId();
      if (folder.type == null || folder.type === '') folder.type = accountDefaults.type;
      if (folder.createdAt == null || folder.createdAt === '') folder.createdAt = new Date().toISOString();
      const trades = safeParse(localStorage.getItem(`tradelog_trades_${folder.id}`), []);
      if (!Array.isArray(trades)) continue;
      const next = trades.map((t) => (t && typeof t === 'object' ? migrateTrade({ ...t }) : t));
      localStorage.setItem(`tradelog_trades_${folder.id}`, JSON.stringify(next));
    }

    localStorage.setItem(`tradelog_folders_${user}`, JSON.stringify(nextFolders));
    localStorage.setItem(flagKey(user), String(MIGRATION_VERSION));
    migrated = true;
  }

  const v2 = migrateSetups(user);
  if (v2.migrated) migrated = true;

  const v3 = migrateLegacyTrades(user);
  if (v3.migrated) migrated = true;

  const v4 = migrateReviews(user);
  if (v4.migrated) migrated = true;

  const v5 = migrateScreenshotMeta(user);
  if (v5.migrated) migrated = true;

  const v6 = migrateScreenshotFlags(user);
  if (v6.migrated) migrated = true;

  const v7 = migratePropConfigs(user);
  if (v7.migrated) migrated = true;

  const v8 = migrateImprovements(user);
  if (v8.migrated) migrated = true;

  const v9 = migrateAudit(user);
  if (v9.migrated) migrated = true;

  const v10 = migrateStrategies(user);
  if (v10.migrated) migrated = true;

  if (migrated) return { migrated: true, version: getMigrationVersion(user) };
  return { migrated: false, version: getMigrationVersion(user) };
}

export function migrateSetups(user) {
  if (!user || typeof localStorage === 'undefined') return { migrated: false, version: 0 };
  if (localStorage.getItem(flagKeyV2(user))) return { migrated: false, version: MIGRATION_VERSION_V2 };
  const raw = localStorage.getItem(`tradelog_setups_${user}`);
  if (raw == null) {
    localStorage.setItem(`tradelog_setups_${user}`, JSON.stringify([]));
  } else {
    const parsed = safeParse(raw, []);
    if (!Array.isArray(parsed)) localStorage.setItem(`tradelog_setups_${user}`, JSON.stringify([]));
  }
  localStorage.setItem(flagKeyV2(user), String(MIGRATION_VERSION_V2));
  return { migrated: true, version: MIGRATION_VERSION_V2 };
}

function normalizeLegacyDirection(raw) {
  const d = String(raw ?? 'LONG').trim().toUpperCase();
  if (d === 'SHORT' || d === 'SELL') return 'SHORT';
  return 'LONG';
}

function migrateLegacyTradeV3(trade) {
  if (!trade || typeof trade !== 'object' || Array.isArray(trade)) return trade;
  if (trade.direction == null || trade.direction === '') trade.direction = 'LONG';
  else trade.direction = normalizeLegacyDirection(trade.direction);
  if (trade.status == null || trade.status === '') trade.status = 'CLOSED';
  if (trade.pnl == null || trade.pnl === '') {
    const amt = Number(trade.amount);
    if (Number.isFinite(amt)) {
      trade.pnl = trade.type === 'SL' ? -Math.abs(amt) : trade.type === 'TP' ? Math.abs(amt) : amt;
    }
  }
  return trade;
}

export function migrateLegacyTrades(user) {
  if (!user || typeof localStorage === 'undefined') return { migrated: false, version: 0 };
  if (localStorage.getItem(flagKeyV3(user))) return { migrated: false, version: MIGRATION_VERSION_V3 };
  const folders = safeParse(localStorage.getItem(`tradelog_folders_${user}`), []);
  if (Array.isArray(folders)) {
    for (const folder of folders) {
      if (!folder || typeof folder !== 'object' || !folder.id) continue;
      const trades = safeParse(localStorage.getItem(`tradelog_trades_${folder.id}`), []);
      if (!Array.isArray(trades)) continue;
      const next = trades.map((t) =>
        t && typeof t === 'object' && !Array.isArray(t) ? migrateLegacyTradeV3({ ...t }) : t,
      );
      localStorage.setItem(`tradelog_trades_${folder.id}`, JSON.stringify(next));
    }
  }
  localStorage.setItem(flagKeyV3(user), String(MIGRATION_VERSION_V3));
  return { migrated: true, version: MIGRATION_VERSION_V3 };
}

/** v4 — ensure the reviews store exists (idempotent, never deletes data) */
export function migrateReviews(user) {
  if (!user || typeof localStorage === 'undefined') return { migrated: false, version: 0 };
  if (localStorage.getItem(flagKeyV4(user))) return { migrated: false, version: MIGRATION_VERSION_V4 };
  const raw = localStorage.getItem(`tradelog_reviews_${user}`);
  if (raw == null) {
    localStorage.setItem(`tradelog_reviews_${user}`, JSON.stringify([]));
  } else {
    const parsed = safeParse(raw, []);
    if (!Array.isArray(parsed)) localStorage.setItem(`tradelog_reviews_${user}`, JSON.stringify([]));
  }
  localStorage.setItem(flagKeyV4(user), String(MIGRATION_VERSION_V4));
  return { migrated: true, version: MIGRATION_VERSION_V4 };
}

/** v5 — ensure the screenshot metadata mirror exists (idempotent, never deletes data) */
export function migrateScreenshotMeta(user) {
  if (!user || typeof localStorage === 'undefined') return { migrated: false, version: 0 };
  if (localStorage.getItem(flagKeyV5(user))) return { migrated: false, version: MIGRATION_VERSION_V5 };
  const raw = localStorage.getItem(`tradelog_screenshots_${user}`);
  if (raw == null) {
    localStorage.setItem(`tradelog_screenshots_${user}`, JSON.stringify([]));
  } else {
    const parsed = safeParse(raw, []);
    if (!Array.isArray(parsed)) localStorage.setItem(`tradelog_screenshots_${user}`, JSON.stringify([]));
  }
  localStorage.setItem(flagKeyV5(user), String(MIGRATION_VERSION_V5));
  return { migrated: true, version: MIGRATION_VERSION_V5 };
}

/** v6 — confirm the screenshots mirror flag (idempotent, never deletes data) */
export function migrateScreenshotFlags(user) {
  if (!user || typeof localStorage === 'undefined') return { migrated: false, version: 0 };
  if (localStorage.getItem(flagKeyV6(user))) return { migrated: false, version: MIGRATION_VERSION_V6 };
  const raw = localStorage.getItem(`tradelog_screenshots_${user}`);
  if (raw == null) {
    localStorage.setItem(`tradelog_screenshots_${user}`, JSON.stringify([]));
  } else {
    const parsed = safeParse(raw, []);
    if (!Array.isArray(parsed)) localStorage.setItem(`tradelog_screenshots_${user}`, JSON.stringify([]));
  }
  localStorage.setItem(flagKeyV6(user), String(MIGRATION_VERSION_V6));
  return { migrated: true, version: MIGRATION_VERSION_V6 };
}

export function migratePropConfigs(user) {
  if (!user || typeof localStorage === 'undefined') return { migrated: false, version: 0 };
  if (localStorage.getItem(flagKeyV7(user))) return { migrated: false, version: MIGRATION_VERSION_V7 };
  const raw = localStorage.getItem(`tradelog_propconfig_${user}`);
  if (raw == null) {
    localStorage.setItem(`tradelog_propconfig_${user}`, JSON.stringify({}));
  } else {
    const parsed = safeParse(raw, {});
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      localStorage.setItem(`tradelog_propconfig_${user}`, JSON.stringify({}));
    }
  }
  localStorage.setItem(flagKeyV7(user), String(MIGRATION_VERSION_V7));
  return { migrated: true, version: MIGRATION_VERSION_V7 };
}

/** v8 — ensure the user-owned improvements store + analytics prefs exist (idempotent, never deletes data) */
export function migrateImprovements(user) {
  if (!user || typeof localStorage === 'undefined') return { migrated: false, version: 0 };
  if (localStorage.getItem(flagKeyV8(user))) return { migrated: false, version: MIGRATION_VERSION_V8 };
  const rawImprovements = localStorage.getItem(`tradelog_improvements_${user}`);
  if (rawImprovements == null) {
    localStorage.setItem(`tradelog_improvements_${user}`, JSON.stringify([]));
  } else {
    const parsed = safeParse(rawImprovements, []);
    if (!Array.isArray(parsed)) localStorage.setItem(`tradelog_improvements_${user}`, JSON.stringify([]));
  }
  const rawPrefs = localStorage.getItem(`tradelog_analytics_prefs_${user}`);
  if (rawPrefs == null) {
    localStorage.setItem(`tradelog_analytics_prefs_${user}`, JSON.stringify({}));
  } else {
    const parsed = safeParse(rawPrefs, {});
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      localStorage.setItem(`tradelog_analytics_prefs_${user}`, JSON.stringify({}));
    }
  }
  localStorage.setItem(flagKeyV8(user), String(MIGRATION_VERSION_V8));
  return { migrated: true, version: MIGRATION_VERSION_V8 };
}

/** v9 — ensure the append-only audit log + trading lock + analytics prefs exist (idempotent, never deletes data) */
export function migrateAudit(user) {
  if (!user || typeof localStorage === 'undefined') return { migrated: false, version: 0 };
  if (localStorage.getItem(flagKeyV9(user))) return { migrated: false, version: MIGRATION_VERSION_V9 };
  const auditRaw = localStorage.getItem(`tradelog_audit_${user}`);
  if (auditRaw == null) {
    localStorage.setItem(`tradelog_audit_${user}`, JSON.stringify([]));
  } else {
    const parsed = safeParse(auditRaw, []);
    if (!Array.isArray(parsed)) localStorage.setItem(`tradelog_audit_${user}`, JSON.stringify([]));
  }
  const lockRaw = localStorage.getItem(`tradelog_lock_${user}`);
  if (lockRaw == null) {
    localStorage.setItem(`tradelog_lock_${user}`, JSON.stringify({ enabled: false }));
  } else {
    const parsed = safeParse(lockRaw, null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.enabled !== 'boolean') {
        localStorage.setItem(`tradelog_lock_${user}`, JSON.stringify({ ...parsed, enabled: false }));
      }
    } else {
      localStorage.setItem(`tradelog_lock_${user}`, JSON.stringify({ enabled: false }));
    }
  }
  if (localStorage.getItem(`tradelog_analytics_prefs_${user}`) == null) {
    localStorage.setItem(`tradelog_analytics_prefs_${user}`, JSON.stringify({}));
  }
  localStorage.setItem(flagKeyV9(user), String(MIGRATION_VERSION_V9));
  return { migrated: true, version: MIGRATION_VERSION_V9 };
}

/** v10 — ensure the versioned strategy stores exist (idempotent, never deletes data) */
export function migrateStrategies(user) {
  if (!user || typeof localStorage === 'undefined') return { migrated: false, version: 0 };
  if (localStorage.getItem(flagKeyV10(user))) return { migrated: false, version: MIGRATION_VERSION_V10 };
  const rawStrategies = localStorage.getItem(`tradelog_strategies_${user}`);
  if (rawStrategies == null) {
    localStorage.setItem(`tradelog_strategies_${user}`, JSON.stringify([]));
  } else {
    const parsed = safeParse(rawStrategies, []);
    if (!Array.isArray(parsed)) localStorage.setItem(`tradelog_strategies_${user}`, JSON.stringify([]));
  }
  const rawVersions = localStorage.getItem(`tradelog_strategyversions_${user}`);
  if (rawVersions == null) {
    localStorage.setItem(`tradelog_strategyversions_${user}`, JSON.stringify([]));
  } else {
    const parsed = safeParse(rawVersions, []);
    if (!Array.isArray(parsed)) localStorage.setItem(`tradelog_strategyversions_${user}`, JSON.stringify([]));
  }
  localStorage.setItem(flagKeyV10(user), String(MIGRATION_VERSION_V10));
  return { migrated: true, version: MIGRATION_VERSION_V10 };
}
