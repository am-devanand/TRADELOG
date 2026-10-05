// Screenshot gallery UI — grouped thumbnails + lightbox.
// Vanilla ESM. Blobs come from IndexedDB (screenshotStore);
// this module never persists anything. Every object URL it
// creates is tracked and revoked on close/replace.
// Exports: renderScreenshotGallery(container, meta, handlers),
// bindScreenshotViewer(container, handlers), revokeGalleryUrls.
import { getScreenshot } from '../utils/screenshotStore.js';
import { escapeHtml, showConfirm } from '../utils/helpers.js';

const GROUP_ORDER = ['ENTRY', 'MANAGEMENT', 'EXIT', 'OTHER'];
const GROUP_LABEL = { ENTRY: 'ENTRY', MANAGEMENT: 'MANAGEMENT', EXIT: 'EXIT', OTHER: 'OTHER' };

const liveUrls = new WeakMap();
const liveHandlers = new WeakMap();
const knownGalleries = new Set();
let lightboxEl = null;

function trackUrl(container, url) {
  if (!url) return url;
  let set = liveUrls.get(container);
  if (!set) {
    set = new Set();
    liveUrls.set(container, set);
  }
  set.add(url);
  return url;
}

/** Revoke every object URL created for a gallery container. */
export function revokeGalleryUrls(container) {
  const set = container ? liveUrls.get(container) : null;
  if (set) {
    for (const url of set) {
      try { URL.revokeObjectURL(url); } catch { /* noop */ }
    }
    set.clear();
  }
  if (!container && lightboxEl) closeLightbox();
}

/** Revoke URLs for all galleries rendered so far (call before full repaints). */
export function revokeAllGalleries() {
  for (const el of knownGalleries) revokeGalleryUrls(el);
  knownGalleries.clear();
}

function groupOf(meta) {
  const t = String(meta?.type || 'OTHER').trim().toUpperCase();
  return GROUP_ORDER.includes(t) ? t : 'OTHER';
}

function gallerySkeleton(list) {
  const groups = new Map(GROUP_ORDER.map((g) => [g, []]));
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || !m.id) continue;
    groups.get(groupOf(m)).push(m);
  }
  const parts = [];
  for (const g of GROUP_ORDER) {
    const items = groups.get(g);
    if (items.length === 0) continue;
    parts.push(`
      <div class="shot-group" data-group="${g}">
        <div class="shot-group-title">${GROUP_LABEL[g]} (${items.length})</div>
        <div class="shot-grid">
          ${items.map((m) => `
            <figure class="shot-thumb" data-shot-id="${escapeHtml(String(m.id))}" data-type="${escapeHtml(String(m.type || g))}" tabindex="0" role="button" aria-label="Preview ${escapeHtml(String(m.filename || 'screenshot'))}">
              <img loading="lazy" alt="${escapeHtml(String(m.filename || 'screenshot'))}" data-shot-img="${escapeHtml(String(m.id))}">
              <figcaption class="shot-name" title="${escapeHtml(String(m.filename || ''))}">${escapeHtml(String(m.filename || 'screenshot'))}</figcaption>
              <button type="button" class="shot-del" data-shot-del="${escapeHtml(String(m.id))}" aria-label="Delete ${escapeHtml(String(m.filename || 'screenshot'))}">×</button>
            </figure>`).join('')}
        </div>
      </div>`);
  }
  if (parts.length === 0) return `<div class="shot-empty">📷 No screenshots yet — they stay on this device, even offline.</div>`;
  return `<div class="shot-groups">${parts.join('')}</div>`;
}

async function fillThumbnails(container, list, resolveUrl) {
  const jobs = (Array.isArray(list) ? list : []).filter((m) => m && m.id);
  await Promise.all(jobs.map(async (m) => {
    const img = container.querySelector(`[data-shot-img="${CSS.escape(String(m.id))}"]`);
    if (!img) return;
    try {
      let url = null;
      if (typeof resolveUrl === 'function') url = await resolveUrl(m);
      else {
        const res = await getScreenshot(m.id);
        if (res.success && res.blob) url = URL.createObjectURL(res.blob);
      }
      if (url == null) return;
      if (typeof url === 'string') trackUrl(container, url);
      const el = container.querySelector(`[data-shot-img="${CSS.escape(String(m.id))}"]`);
      if (el) el.src = typeof url === 'string' ? url : String(url);
    } catch { /* thumbnail stays empty; gallery still usable */ }
  }));
}

function ensureLightbox() {
  if (lightboxEl && document.body.contains(lightboxEl)) return lightboxEl;
  lightboxEl = document.createElement('div');
  lightboxEl.className = 'shot-lightbox';
  lightboxEl.setAttribute('hidden', '');
  lightboxEl.innerHTML = `
    <img id="shot-lightbox-img" alt="Screenshot preview">
    <div class="shot-lightbox-bar">
      <span id="shot-lightbox-name"></span>
      <button type="button" class="btn btn-secondary btn-sm" id="shot-lightbox-close">CLOSE</button>
    </div>`;
  document.body.appendChild(lightboxEl);
  lightboxEl.addEventListener('click', (e) => {
    if (e.target === lightboxEl) closeLightbox();
  });
  lightboxEl.querySelector('#shot-lightbox-close')?.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightboxEl && !lightboxEl.hasAttribute('hidden')) closeLightbox();
  });
  return lightboxEl;
}

let lightboxUrl = null;

function openLightbox(meta, url) {
  const box = ensureLightbox();
  closeLightboxUrlOnly();
  lightboxUrl = typeof url === 'string' ? url : null;
  const img = box.querySelector('#shot-lightbox-img');
  const name = box.querySelector('#shot-lightbox-name');
  if (img) {
    img.src = typeof url === 'string' ? url : '';
    img.alt = String(meta?.filename || 'Screenshot preview');
  }
  if (name) name.textContent = String(meta?.filename || '');
  box.removeAttribute('hidden');
}

export function closeLightbox() {
  closeLightboxUrlOnly();
  if (lightboxEl) lightboxEl.setAttribute('hidden', '');
}

function closeLightboxUrlOnly() {
  if (lightboxUrl) {
    try { URL.revokeObjectURL(lightboxUrl); } catch { /* noop */ }
    lightboxUrl = null;
  }
  const box = lightboxEl;
  if (box) {
    const img = box.querySelector('#shot-lightbox-img');
    if (img) img.removeAttribute('src');
  }
}

async function previewMeta(container, meta, resolveUrl) {
  try {
    let url = null;
    if (typeof resolveUrl === 'function') url = await resolveUrl(meta);
    else {
      const res = await getScreenshot(meta.id);
      if (!res.success) return res;
      if (!res.blob) return { success: false, error: 'Screenshot has no image data.' };
      url = URL.createObjectURL(res.blob);
    }
    openLightbox(meta, url);
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message || 'Could not preview screenshot' };
  }
}

/**
 * Render thumbnails for ID-only metadata. handlers: {onDelete(id),
 * resolveUrl(meta)->Promise<string|URL>, onPreviewError(error)}.
 * Async-safe: thumbs fill after paint; stale fills are dropped.
 */
export async function renderScreenshotGallery(container, meta, handlers = {}) {
  if (!container) return { success: false, error: 'Gallery container is required' };
  const h = handlers && typeof handlers === 'object' ? handlers : {};
  knownGalleries.add(container);
  const list = (Array.isArray(meta) ? meta : []).filter((m) => m && m.id);
  const token = Symbol('gallery');
  container.dataset.galleryToken = String(token.description || 'gallery');
  revokeGalleryUrls(container);
  container.innerHTML = gallerySkeleton(list);
  const myToken = container.dataset.galleryToken;
  await fillThumbnails(container, list, h.resolveUrl);
  if (container.dataset.galleryToken !== myToken || !container.isConnected) {
    revokeGalleryUrls(container);
    return { success: true, stale: true };
  }
  bindScreenshotViewer(container, { ...h, meta: list });
  return { success: true, count: list.length };
}

/**
 * Delegate thumb preview (click/Enter) + delete (×) inside a gallery.
 * Safe to call repeatedly — previous listener is replaced.
 */
export function bindScreenshotViewer(container, handlers = {}) {
  if (!container) return;
  const h = handlers && typeof handlers === 'object' ? handlers : {};
  liveHandlers.set(container, h);
  if (container.dataset.viewerBound === '1') return;
  container.dataset.viewerBound = '1';
  const current = () => liveHandlers.get(container) || {};
  container.addEventListener('click', async (e) => {
    const hNow = current();
    const delBtn = e.target?.closest?.('[data-shot-del]');
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.getAttribute('data-shot-del');
      if (typeof hNow.onDelete === 'function') {
        showConfirm('Delete this screenshot? It stays deleted on this device.', () => hNow.onDelete(id));
      }
      return;
    }
    const thumb = e.target?.closest?.('[data-shot-id]');
    if (!thumb || !container.contains(thumb)) return;
    const id = thumb.getAttribute('data-shot-id');
    const meta = (Array.isArray(hNow.meta) ? hNow.meta : []).find((m) => String(m?.id) === String(id))
      || { id, filename: thumb.querySelector('.shot-name')?.textContent || 'screenshot' };
    const res = await previewMeta(container, meta, hNow.resolveUrl);
    if (!res.success && typeof hNow.onPreviewError === 'function') hNow.onPreviewError(res.error);
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const thumb = e.target?.closest?.('[data-shot-id]');
    if (!thumb || !container.contains(thumb)) return;
    e.preventDefault();
    thumb.click();
  });
}

export default { renderScreenshotGallery, bindScreenshotViewer, revokeGalleryUrls, revokeAllGalleries, closeLightbox };
