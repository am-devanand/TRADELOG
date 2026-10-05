// ============================================
// Backup Manager — backup/restore display + thin binding (presentational only)
// Vanilla ESM, no storage, no network, no business logic.
// All work arrives via handler props {onExport, onRestoreFile, onRunIntegrity} —
// this module never imports backup/dataIntegrity/storage engines.
// Restore flow: file input → preview counts BEFORE applying → explicit
// Cancel / RESTORE AS COPY / REPLACE LOCAL DATA (replace needs a second
// confirmation). CSV exports are four separate buttons, never one
// flattened CSV. Storage text is caller-supplied from a real API; when
// absent this renders exactly "Storage estimate unavailable" — never
// fabricated numbers.
// ============================================

import { escapeHtml } from '../utils/helpers.js';

export const BACKUP_CSV_KINDS = ['csv-trades', 'csv-reviews', 'csv-daily', 'csv-strategy'];

const CSV_BUTTONS = [
  { kind: 'csv-trades', label: 'Trades CSV' },
  { kind: 'csv-reviews', label: 'Reviews CSV' },
  { kind: 'csv-daily', label: 'Daily Aggregates CSV' },
  { kind: 'csv-strategy', label: 'Strategy Analytics CSV' },
];

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function fmtBytes(n) {
  if (!Number.isFinite(Number(n))) return null;
  const bytes = Number(n);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/**
 * Resolve the storage line. Caller passes text measured from a real API
 * (e.g. navigator.storage.estimate()). Never fabricates numbers.
 */
function storageLine(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const text = s.storageText ?? s.storageEstimate ?? s.storage ?? '';
  if (typeof text === 'string' && text.trim()) return String(text).trim();
  const usage = Number(s.usageBytes ?? s.usage ?? s.bytesUsed);
  const quota = Number(s.quotaBytes ?? s.quota ?? s.bytesQuota);
  if (Number.isFinite(usage) && usage >= 0) {
    const u = fmtBytes(usage);
    if (Number.isFinite(quota) && quota > 0) return `${u} of ${fmtBytes(quota)} used`;
    return `${u} used`;
  }
  return 'Storage estimate unavailable';
}

function countsLine(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const counts = s.counts && typeof s.counts === 'object' ? s.counts : null;
  if (!counts) return '';
  const parts = Object.entries(counts)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .map(([k, v]) => `${k}: ${Number(v)}`);
  if (parts.length === 0) return '';
  return parts.join(' · ');
}

/** Count top-level collections in a parsed backup for the pre-apply preview. */
function previewCounts(parsed) {
  if (Array.isArray(parsed)) return [{ name: 'records', count: parsed.length }];
  if (parsed && typeof parsed === 'object') {
    const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
    const rows = [];
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (Array.isArray(v)) rows.push({ name: k, count: v.length });
      else if (v && typeof v === 'object') rows.push({ name: k, count: Object.keys(v).length });
    }
    return rows.slice(0, 12);
  }
  return [];
}

/**
 * Render the backup manager. Returns an HTML string (no DOM writes).
 * @param {{stats?:Object}} [input] stats.counts (local counts), stats.storageText (real-API text)
 */
export function renderBackupManager({ stats } = {}) {
  const store = storageLine(stats);
  const counts = countsLine(stats);
  const csvHtml = CSV_BUTTONS.map((b) => `
    <button type="button" class="btn btn-secondary p8-btn" data-csv-kind="${escapeHtml(b.kind)}">${escapeHtml(b.label)}</button>`).join('');

  return `
    <section class="card p8-backup" aria-label="Backup manager">
      <h3 class="p8-title">Backup manager</h3>
      ${counts ? `<p class="p8-sub">Local data — ${escapeHtml(counts)}</p>` : ''}
      <div class="p8-backup-grid">
        <div class="p8-backup-block">
          <h4 class="p8-block-title">JSON backup</h4>
          <p class="p8-muted">Full local snapshot for safekeeping or moving devices.</p>
          <div class="p8-actions">
            <button type="button" class="btn btn-primary p8-btn" id="p8-backup-export">Export JSON backup</button>
            <button type="button" class="btn btn-secondary p8-btn" id="p8-backup-integrity">Run integrity check</button>
          </div>
        </div>
        <div class="p8-backup-block">
          <h4 class="p8-block-title">CSV exports</h4>
          <p class="p8-muted">Separate files per dataset — never one flattened CSV.</p>
          <div class="p8-actions p8-actions-wrap" role="group" aria-label="CSV exports">
            ${csvHtml}
          </div>
        </div>
        <div class="p8-backup-block">
          <h4 class="p8-block-title">Restore from file</h4>
          <p class="p8-muted">Preview counts appear before anything is applied.</p>
          <div class="form-group">
            <label class="form-label" for="p8-restore-file">Backup JSON file</label>
            <input type="file" id="p8-restore-file" accept="application/json,.json">
          </div>
          <div id="p8-restore-preview" class="p8-restore-preview" aria-live="polite"></div>
          <div class="p8-actions p8-actions-wrap" id="p8-restore-actions" hidden>
            <button type="button" class="btn btn-secondary p8-btn" id="p8-restore-cancel">Cancel</button>
            <button type="button" class="btn btn-primary p8-btn" id="p8-restore-copy">Restore as copy</button>
            <button type="button" class="btn btn-danger p8-btn" id="p8-restore-replace">Replace local data</button>
          </div>
        </div>
        <div class="p8-backup-block">
          <h4 class="p8-block-title">Local storage usage</h4>
          <p class="p8-storage" id="p8-storage-estimate">${escapeHtml(store)}</p>
        </div>
      </div>
    </section>`;
}

function renderPreviewInto(container, fileName, rows) {
  if (!container) return;
  if (rows.length === 0) {
    container.innerHTML = `<p class="p8-muted">“${escapeHtml(fileName)}” parsed, but no countable collections were found. Nothing has been applied.</p>`;
    return;
  }
  container.innerHTML = `
    <div class="p8-preview-card" role="status">
      <p><strong>Preview — “${escapeHtml(fileName)}”.</strong> Nothing has been applied yet.</p>
      <ul class="p8-preview-list">${rows.map((r) => `<li>${escapeHtml(r.name)}: <strong>${escapeHtml(String(r.count))}</strong></li>`).join('')}</ul>
    </div>`;
}

/**
 * Wire backup buttons + restore flow. No-ops for missing elements.
 * onExport(kind): 'json' | 'csv-trades' | 'csv-reviews' | 'csv-daily' | 'csv-strategy'
 * onRestoreFile(parsed, mode): mode 'copy' | 'replace'
 * @param {{onExport?:Function, onRestoreFile?:Function, onRunIntegrity?:Function}} handlers
 * @returns {Function} cleanup
 */
export function bindBackupManager({ onExport, onRestoreFile, onRunIntegrity } = {}) {
  const cleanups = [];
  const on = (el, evt, fn) => {
    if (!el) return;
    el.addEventListener(evt, fn);
    cleanups.push(() => el.removeEventListener(evt, fn));
  };
  const cleanup = () => { cleanups.forEach((fn) => { try { fn(); } catch { /* noop */ } }); };

  const exportBtn = document.getElementById('p8-backup-export');
  const integrityBtn = document.getElementById('p8-backup-integrity');
  const fileInput = document.getElementById('p8-restore-file');
  const preview = document.getElementById('p8-restore-preview');
  const actions = document.getElementById('p8-restore-actions');
  const cancelBtn = document.getElementById('p8-restore-cancel');
  const copyBtn = document.getElementById('p8-restore-copy');
  const replaceBtn = document.getElementById('p8-restore-replace');

  let pending = null; // { name, parsed }

  on(exportBtn, 'click', () => { if (typeof onExport === 'function') onExport('json'); });
  on(integrityBtn, 'click', () => { if (typeof onRunIntegrity === 'function') onRunIntegrity(); });

  toArray(document.querySelectorAll('[data-csv-kind]')).forEach((btn) => {
    on(btn, 'click', () => { if (typeof onExport === 'function') onExport(btn.getAttribute('data-csv-kind')); });
  });

  const resetRestore = () => {
    pending = null;
    if (fileInput) fileInput.value = '';
    if (preview) preview.innerHTML = '';
    if (actions) actions.hidden = true;
    if (replaceBtn) {
      replaceBtn.removeAttribute('data-armed');
      replaceBtn.textContent = 'Replace local data';
    }
  };

  on(fileInput, 'change', () => {
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed = null;
      try {
        parsed = JSON.parse(String(reader.result ?? ''));
      } catch {
        if (preview) preview.innerHTML = `<p class="p8-error" role="alert">“${escapeHtml(file.name)}” is not valid JSON. Nothing has been applied.</p>`;
        if (actions) actions.hidden = true;
        pending = null;
        return;
      }
      pending = { name: file.name, parsed };
      renderPreviewInto(preview, file.name, previewCounts(parsed));
      if (actions) actions.hidden = false;
    };
    reader.onerror = () => {
      if (preview) preview.innerHTML = `<p class="p8-error" role="alert">Could not read “${escapeHtml(file.name)}”. Nothing has been applied.</p>`;
    };
    reader.readAsText(file);
  });

  on(cancelBtn, 'click', resetRestore);
  on(copyBtn, 'click', () => {
    if (!pending) return;
    if (typeof onRestoreFile === 'function') onRestoreFile(pending.parsed, 'copy');
  });
  on(replaceBtn, 'click', () => {
    if (!pending || !replaceBtn) return;
    // Second confirmation for destructive replace: first click arms, second applies.
    if (!replaceBtn.hasAttribute('data-armed')) {
      replaceBtn.setAttribute('data-armed', 'true');
      replaceBtn.textContent = 'Confirm replace — click again';
      return;
    }
    if (typeof onRestoreFile === 'function') onRestoreFile(pending.parsed, 'replace');
  });

  // If none of the expected nodes exist, binding is a harmless no-op.
  return cleanup;
}
