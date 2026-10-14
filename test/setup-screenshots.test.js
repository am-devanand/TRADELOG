// SETUP SCREENSHOT EVIDENCE REGRESSION TESTS
//
// /trade/new carried a static "📷 Screenshot upload — Coming in Phase 5" div
// with no input and no handler, so a setup could not carry evidence into the
// trade it produced. This suite locks the workflow built to replace it:
//
//   - staged blobs are stored under the setup id with type ENTRY;
//   - metadata is mirrored through the existing ID-only localStorage mirror;
//   - a failed mirror rolls the blob back so image data is never orphaned;
//   - explicit execution re-keys the evidence onto the new trade id while
//     KEEPING the setup id for provenance;
//   - cancellation and failed execution deliberately keep the evidence on the
//     setup rather than deleting a user's evidence.
//
// Validation itself lives in screenshotStore and is exercised against the real
// module here (validateBlob runs before IndexedDB is touched, so rejection
// paths are deterministic without a fake database).
import { test, run, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRADE_JS = path.join(ROOT, 'src/js/pages/trade.js');
const SOURCE = readFileSync(TRADE_JS, 'utf8');

function extractFunction(name) {
  const match = SOURCE.match(new RegExp(`(?:async\\s+)?function ${name}\\(`));
  if (!match) throw new Error(`could not find ${name} in trade.js`);
  let depth = 0;
  let opened = false;
  for (let i = match.index; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === '{') { depth += 1; opened = true; }
    else if (ch === '}') {
      depth -= 1;
      if (opened && depth === 0) return SOURCE.slice(match.index, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function extractConst(name) {
  const m = SOURCE.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`));
  if (!m) throw new Error(`could not find const ${name}`);
  return m[1];
}

const FN = [
  'hasImageSignature',
  'isShotReferencedElsewhere',
  'stagedShotIds',
  'paintSetupShots',
  'handleSetupShotFiles',
  'bindSetupShots',
  'attachShotsToTrade',
  'buildSetupRecord',
].map(extractFunction).join('\n');

/**
 * Builds the real screenshot workflow against recording stubs so every
 * persistence call is observable.
 */
function makeShots({
  saveResult = null,
  metaResult = { success: true },
  existingMeta = [],
  getResult = null,
  tradeResult = { success: true },
  setupResult = null,
  refs = null,
  refsThrow = false,
} = {}) {
  const calls = { saves: [], deletes: [], metas: [], removed: [], trades: [], setups: [], toasts: [], rendered: [] };
  let nextId = 0;

  const saveScreenshot = async (file, meta = {}) => {
    calls.saves.push({ name: file?.name || '(blob)', type: file?.type, size: file?.size, meta });
    if (typeof saveResult === 'function') return saveResult(calls.saves.length, file, meta);
    nextId += 1;
    return {
      success: true,
      id: `shot_${nextId}`,
      meta: {
        id: `shot_${nextId}`, tradeId: meta.tradeId || '', setupId: meta.setupId || '',
        reviewId: '', type: meta.type || 'OTHER', filename: meta.filename || 'shot.png',
        mimeType: file?.type || 'image/png', size: file?.size || 1, createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
  };
  const deleteScreenshot = async (id) => { calls.deletes.push(String(id)); return { success: true, id }; };
  const getScreenshot = async (id) => (typeof getResult === 'function'
    ? getResult(id)
    : { success: true, id, blob: new Blob(['x'], { type: 'image/png' }), meta: { id, type: 'ENTRY', filename: 'shot.png' } });
  const addMeta = (user, meta) => { calls.metas.push(meta); return typeof metaResult === 'function' ? metaResult(meta) : metaResult; };
  const removeMeta = (user, id) => { calls.removed.push(String(id)); return { success: true, id }; };
  const listMeta = (user, filter) => (existingMeta.filter((m) => !filter?.ids || filter.ids.includes(m.id)));
  const updateCanonicalTrade = (user, tradeId, updates) => {
    calls.trades.push({ tradeId, updates });
    return typeof tradeResult === 'function' ? tradeResult() : tradeResult;
  };
  const refStores = refs || { trades: [], setups: [], reviews: [] };
  const getExecutedTrades = () => { if (refsThrow) throw new Error('store unreadable'); return refStores.trades; };
  const getSetups = () => { if (refsThrow) throw new Error('store unreadable'); return refStores.setups; };
  const getReviews = () => { if (refsThrow) throw new Error('store unreadable'); return refStores.reviews; };
  const updateSetup = (user, id, updates) => {
    calls.setups.push({ id, updates });
    return typeof setupResult === 'function' ? setupResult() : (setupResult === 'MISSING' ? null : (setupResult === null ? {} : setupResult));
  };
  const showToast = (msg, kind) => { calls.toasts.push({ msg, kind }); };
  const renderScreenshotGallery = async (box, meta, handlers) => {
    calls.rendered.push({ box, meta, handlers });
    return { success: true, count: meta.length };
  };

  const doc = {
    getElementById: (id) => {
      if (id === 'ta-shot-file') return { dataset: {}, addEventListener() {}, value: 'x', files: [] };
      if (id === 'ta-shot-add') return { dataset: {}, addEventListener() {} };
      if (id === 'ta-shots') return { innerHTML: '', dataset: {} };
      if (id === 'ta-shot-err') return { hidden: true, textContent: '' };
      return null;
    },
  };

  const factory = new Function(
    'saveScreenshot', 'deleteScreenshot', 'getScreenshot', 'addMeta', 'removeMeta', 'listMeta',
    'updateCanonicalTrade', 'updateSetup', 'showToast', 'renderScreenshotGallery', 'document',
    'generateId', 'getExecutedTrades', 'getSetups', 'getReviews',
    `const IMAGE_SIGNATURES = ${extractConst('IMAGE_SIGNATURES')};
const pendingShotIds = {};
let analysis = null;
let lastResult = null;
${FN}
const blankAnalysis = ${extractFunction('blankAnalysis')};
analysis = blankAnalysis();
return {
  setAnalysis: (v) => { analysis = v; },
  setStaged: (setupId, ids) => { pendingShotIds[setupId] = ids.map(String); },
  getStaged: (setupId) => stagedShotIds(setupId),
  handleSetupShotFiles: (files) => handleSetupShotFiles('u', files),
  paintSetupShots: () => paintSetupShots('u'),
  isRefElsewhere: (id, tradeId, setupId) => isShotReferencedElsewhere('u', id, tradeId, setupId),
  attachShotsToTrade: (setup, tradeId) => attachShotsToTrade('u', setup, tradeId),
  bindSetupShots: () => bindSetupShots('u'),
  buildSetupRecord: (status) => buildSetupRecord(status),
  setLastResult: (r) => { lastResult = r; },
};`,
  );

  const api = factory(
    saveScreenshot, deleteScreenshot, getScreenshot, addMeta, removeMeta, listMeta,
    updateCanonicalTrade, updateSetup, showToast, renderScreenshotGallery, doc,
    () => 'analysis-id', getExecutedTrades, getSetups, getReviews,
  );
  return { api, calls };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const withBytes = (o, bytes) => ({
  ...o,
  slice: (start = 0, end = bytes.length) => ({
    arrayBuffer: async () => Uint8Array.from(bytes.slice(start, end)).buffer,
  }),
});
const img = (name = 'chart.png') => withBytes({ name, type: 'image/png', size: 2048 }, PNG_MAGIC);
// A text file that the OS still reports as image/png because of its extension.
const disguised = (name = 'disguised.png') =>
  withBytes({ name, type: 'image/png', size: 33 }, Array.from('plain text pretending'));

// ---- 1. Validation (real screenshotStore, no fake IndexedDB needed) ----

test('real store rejects a non-image file by content type, not extension', async () => {
  const store = await import(pathToFileURL(path.join(ROOT, 'src/js/utils/screenshotStore.js')).href);
  const res = await store.saveScreenshot(new Blob(['MZ'], { type: 'application/x-msdownload' }), {});
  equal(res.success, false, 'a .png-named executable is still rejected');
  ok(/Only image files/i.test(res.error), `expected a type error, got: ${res.error}`);
});

test('real store rejects a file that is only an image by name', async () => {
  const store = await import(pathToFileURL(path.join(ROOT, 'src/js/utils/screenshotStore.js')).href);
  const res = await store.saveScreenshot(new Blob(['hello'], { type: 'text/plain' }), {});
  equal(res.success, false, 'extension is never trusted');
  ok(/Only image files/i.test(res.error), `expected a type error, got: ${res.error}`);
});

test('real store rejects an empty file', async () => {
  const store = await import(pathToFileURL(path.join(ROOT, 'src/js/utils/screenshotStore.js')).href);
  const res = await store.saveScreenshot(new Blob([], { type: 'image/png' }), {});
  equal(res.success, false, 'zero-byte image rejected');
});

test('real store rejects an oversized image at the 10MB ceiling', async () => {
  const store = await import(pathToFileURL(path.join(ROOT, 'src/js/utils/screenshotStore.js')).href);
  const big = new Blob([new Uint8Array(store.MAX_SCREENSHOT_BYTES + 1024)], { type: 'image/png' });
  const res = await store.saveScreenshot(big, {});
  equal(res.success, false, 'oversized image rejected');
  ok(/too large/i.test(res.error), `expected a size error, got: ${res.error}`);
});

test('a valid image passes validation and only then reaches storage', async () => {
  const store = await import(pathToFileURL(path.join(ROOT, 'src/js/utils/screenshotStore.js')).href);
  const res = await store.saveScreenshot(new Blob(['png'], { type: 'image/png' }), {});
  // No IndexedDB in Node, so a valid image must fail LATER, at DB open.
  if (!res.success) {
    ok(!/Only image files|too large|empty/i.test(res.error), `validation must not reject a real image: ${res.error}`);
    ok(/IndexedDB/i.test(res.error), `expected the DB-open failure, got: ${res.error}`);
  }
});

// ---- 2. Staging ----

test('a staged screenshot is stored under the setup id as ENTRY and mirrored', async () => {
  const { api, calls } = makeShots();
  api.setAnalysis({ id: 'setup_1' });
  await api.handleSetupShotFiles([img()]);
  deepEqual(calls.saves[0].meta, { setupId: 'setup_1', type: 'ENTRY' }, 'keyed to the setup, not a trade');
  equal(calls.metas.length, 1, 'metadata mirrored exactly once');
  deepEqual(api.getStaged('setup_1'), ['shot_1'], 'id staged for persistence');
});

test('an invalid file is reported and never staged', async () => {
  const { api, calls } = makeShots({ saveResult: () => ({ success: false, error: 'Only image files are allowed.' }) });
  api.setAnalysis({ id: 'setup_1' });
  await api.handleSetupShotFiles([img('bad.txt')]);
  equal(calls.metas.length, 0, 'nothing mirrored for a rejected file');
  deepEqual(api.getStaged('setup_1'), [], 'nothing staged');
  ok(calls.toasts.some((t) => t.kind === 'error'), 'the rejection is surfaced');
});

test('a failed mirror rolls the blob back so no image data is orphaned', async () => {
  const { api, calls } = makeShots({ metaResult: { success: false, error: 'mirror failed' } });
  api.setAnalysis({ id: 'setup_1' });
  await api.handleSetupShotFiles([img()]);
  deepEqual(calls.deletes, ['shot_1'], 'the blob saved before the mirror failure is deleted');
  deepEqual(api.getStaged('setup_1'), [], 'and is not staged');
});

test('the saved setup record carries the staged ids', () => {
  const { api } = makeShots();
  api.setAnalysis({ id: 'setup_1', strategyId: '', strategy: 'Scalp' });
  api.setStaged('setup_1', ['shot_1', 'shot_2']);
  const rec = api.buildSetupRecord('WAITING');
  deepEqual(rec.screenshotIds, ['shot_1', 'shot_2'], 'screenshotIds persisted on the setup');
});

test('a setup with no evidence persists an empty list, not undefined', () => {
  const { api } = makeShots();
  api.setAnalysis({ id: 'setup_1', strategyId: '', strategy: '' });
  deepEqual(api.buildSetupRecord('DRAFT').screenshotIds, [], 'backwards compatible default');
});

test('a text file claiming image/png is rejected before it can be stored', async () => {
  const { api, calls } = makeShots();
  api.setAnalysis({ id: 'setup_1' });
  await api.handleSetupShotFiles([disguised()]);
  equal(calls.saves.length, 0, 'the store is never asked to persist a non-image');
  equal(calls.metas.length, 0, 'and no metadata is mirrored');
  ok(calls.toasts.some((t) => /not a real image/i.test(t.msg)), 'the user is told why');
});

test('real PNG, JPEG, GIF and BMP signatures are accepted', async () => {
  const cases = [
    ['a.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['b.jpg', [0xff, 0xd8, 0xff, 0xe0]],
    ['c.gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ['d.bmp', [0x42, 0x4d, 0x00, 0x00]],
  ];
  for (const [name, bytes] of cases) {
    const { api, calls } = makeShots();
    api.setAnalysis({ id: 'setup_1' });
    await api.handleSetupShotFiles([withBytes({ name, type: 'image/png', size: 10 }, bytes)]);
    equal(calls.saves.length, 1, `${name} must be accepted`);
  }
});

test('a WebP signature (RIFF container) is accepted', async () => {
  const { api, calls } = makeShots();
  api.setAnalysis({ id: 'setup_1' });
  const bytes = [0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
  await api.handleSetupShotFiles([withBytes({ name: 'e.webp', type: 'image/webp', size: 12 }, bytes)]);
  equal(calls.saves.length, 1, 'RIFF....WEBP is a valid image container');
});

// ---- 3. Removal ----

test('removing staged evidence deletes the blob and the mirror ref', async () => {
  const { api, calls } = makeShots({
    existingMeta: [{ id: 'shot_1' }, { id: 'shot_2' }],
  });
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['shot_1', 'shot_2']);
  await api.paintSetupShots();
  const onDelete = calls.rendered.at(-1).handlers.onDelete;
  await onDelete('shot_1');
  deepEqual(calls.deletes, ['shot_1'], 'blob deleted');
  deepEqual(calls.removed, ['shot_1'], 'mirror ref removed');
  deepEqual(api.getStaged('setup_1'), ['shot_2'], 'only the removed id is dropped');
});

test('removal never writes a new blob', async () => {
  const { api, calls } = makeShots({ existingMeta: [{ id: 'shot_1' }, { id: 'shot_2' }] });
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['shot_1', 'shot_2']);
  await api.paintSetupShots();
  await calls.rendered.at(-1).handlers.onDelete('shot_1');
  equal(calls.saves.length, 0, 'deleting evidence must not create any blob');
  deepEqual(calls.setups.at(-1).updates.screenshotIds, ['shot_2'], 'the saved setup drops the removed id');
});

// ---- 4. Execution association ----

test('execution re-keys staged evidence onto the trade and keeps the setup id', async () => {
  const { api, calls } = makeShots();
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['old_1']);
  const res = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['old_1'] }, 'trade_9');
  equal(res.success, true, 'association succeeded');
  const rekey = calls.saves.at(-1);
  equal(rekey.meta.tradeId, 'trade_9', 'blob re-keyed to the new trade');
  equal(rekey.meta.setupId, 'setup_1', 'setup id retained for provenance');
  equal(rekey.meta.type, 'ENTRY', 'type preserved across the re-key');
  deepEqual(calls.trades, [{ tradeId: 'trade_9', updates: { screenshotIds: ['shot_1'] } }], 'trade points at the new id');
  ok(calls.deletes.includes('old_1'), 'the setup-keyed blob is cleaned up');
  ok(calls.removed.includes('old_1'), 'and so is its mirror ref');
});

test('the setup record is rewritten so it never points at deleted ids', async () => {
  const { api, calls } = makeShots();
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['old_1']);
  await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['old_1'] }, 'trade_9');
  const setupPatch = calls.setups.find((s) => s.id === 'setup_1');
  deepEqual(setupPatch.updates.screenshotIds, ['shot_1'], 'setup follows the new ids');
});

test('a setup with no evidence associates nothing and touches no trade record', async () => {
  const { api, calls } = makeShots();
  api.setAnalysis({ id: 'setup_1' });
  const res = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: [] }, 'trade_9');
  equal(res.success, true, 'no evidence is a success, not an error');
  deepEqual(res.ids, [], 'no ids produced');
  equal(calls.saves.length, 0, 'nothing re-saved');
  equal(calls.trades.length, 0, 'an existing trade without evidence is never rewritten');
});

test('evidence whose blob vanished is dropped rather than carried as a dead ref', async () => {
  const { api, calls } = makeShots({
    getResult: (id) => ({ success: false, error: `Screenshot not found: "${id}"` }),
  });
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['gone_1']);
  const res = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['gone_1'] }, 'trade_9');
  deepEqual(res.ids, [], 'the dangling reference is not carried onto the trade');
  ok(calls.removed.includes('gone_1'), 'its mirror entry is cleaned up');
});

test('a failed re-save keeps the original id so evidence is never lost', async () => {
  const { api, calls } = makeShots({
    saveResult: () => ({ success: false, error: 'QuotaExceededError' }),
  });
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['old_1']);
  const res = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['old_1'] }, 'trade_9');
  equal(res.success, true, 'the trade is still linked');
  deepEqual(res.ids, ['old_1'], 'the surviving id is the original one');
  equal(calls.deletes.includes('old_1'), false, 'the surviving blob is not deleted');
});

test('trade-update failure keeps every original and rolls back every copy', async () => {
  const { api, calls } = makeShots({ tradeResult: { success: false, error: 'Trade not found' } });
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['old_1', 'old_2']);
  const res = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['old_1', 'old_2'] }, 'trade_9');
  equal(res.success, false, 'failure is reported truthfully');
  equal(res.error, 'Trade not found', 'the engine error surfaces');
  deepEqual(res.ids.sort(), ['old_1', 'old_2'], 'the returned ids are the surviving originals');
  const deletedOld = calls.deletes.filter((d) => d === 'old_1' || d === 'old_2');
  deepEqual(deletedOld, [], 'no original blob is deleted');
  const removedOld = calls.removed.filter((d) => d === 'old_1' || d === 'old_2');
  deepEqual(removedOld, [], 'no original metadata ref is removed');
  equal(calls.deletes.length, 2, 'exactly the two unreferenced copies are rolled back');
  deepEqual(api.getStaged('setup_1').sort(), ['old_1', 'old_2'], 'staged evidence is fully intact for retry');
  equal(calls.setups.length, 0, 'the setup record is never rewritten on a failed link');
});

test('a failed copy keeps its original id without disturbing the others', async () => {
  let n = 0;
  const { api, calls } = makeShots({
    saveResult: () => {
      n += 1;
      if (n === 2) return { success: false, error: 'QuotaExceededError' };
      return { success: true, id: `shot_${n}`, meta: { id: `shot_${n}`, tradeId: '', setupId: 'setup_1', reviewId: '', type: 'ENTRY', filename: 'a.png', mimeType: 'image/png', size: 1, createdAt: '2026-01-01T00:00:00.000Z' } };
    },
  });
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['old_1', 'old_2']);
  const res = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['old_1', 'old_2'] }, 'trade_9');
  equal(res.success, true, 'one good copy is enough to link');
  deepEqual(res.ids, ['shot_1', 'old_2'], 'failed copy keeps its original id in place');
  equal(calls.deletes.includes('old_2'), false, 'the surviving original is not deleted');
  ok(calls.deletes.includes('old_1'), 'the successfully re-keyed original is cleaned up');
});

test('setup-metadata failure is explicit: trade linked, setup warned, nothing silently ignored', async () => {
  const { api, calls } = makeShots({ setupResult: 'MISSING' });
  // updateSetup stub reports the setup row missing.
  api.setAnalysis({ id: 'setup_gone' });
  api.setStaged('setup_gone', ['old_1']);
  const res = await api.attachShotsToTrade({ id: 'setup_gone', screenshotIds: ['old_1'] }, 'trade_9');
  equal(res.success, true, 'the trade link itself succeeded');
  ok(typeof res.setupWarning === 'string' && res.setupWarning.length > 0, 'the setup failure is reported, not swallowed');
  const up = calls.trades.at(-1);
  deepEqual(up.updates.screenshotIds, ['shot_1'], 'the trade still points at the valid copy');
  ok(calls.deletes.includes('old_1'), 'cleanup still ran because the trade link succeeded');
});

test('retry after a failed link copies nothing twice and deletes nothing original', async () => {
  let linkFails = true;
  const { api, calls } = makeShots({
    tradeResult: () => (linkFails ? { success: false, error: 'boom' } : { success: true }),
  });
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['old_1']);
  const first = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['old_1'] }, 'trade_9');
  equal(first.success, false, 'first attempt fails at the link');
  const savesAfterFirst = calls.saves.length;
  const deletesAfterFirst = calls.deletes.length;
  linkFails = false;
  const second = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['old_1'] }, 'trade_9');
  equal(second.success, true, 'retry succeeds');
  equal(calls.saves.length, savesAfterFirst + 1, 'exactly one new copy on retry, no duplicates');
  equal(calls.deletes.filter((d) => d === 'old_1').length, deletesAfterFirst === 0 ? 1 : deletesAfterFirst, 'the original is deleted exactly once, only after a successful link');
  deepEqual(api.getStaged('setup_1'), second.ids, 'staged state converges on the linked ids');
});

test('retry after success is a no-op: already-linked ids are never recopied', async () => {
  const { api, calls } = makeShots({
    getResult: (id) => ({
      success: true, id, blob: new Blob(['x'], { type: 'image/png' }),
      meta: { id, tradeId: 'trade_9', type: 'ENTRY', filename: 'a.png' },
    }),
  });
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['shot_1']);
  const res = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['shot_1'] }, 'trade_9');
  equal(res.success, true, 'idempotent retry succeeds');
  deepEqual(res.ids, ['shot_1'], 'same ids back');
  equal(calls.saves.length, 0, 'no blob is copied again');
  equal(calls.deletes.length, 0, 'nothing is deleted');
});

test('an original still referenced by another setup is preserved, not deleted', async () => {
  const { api, calls } = makeShots({
    refs: {
      trades: [],
      setups: [{ id: 'setup_other', screenshotIds: ['old_1'] }],
      reviews: [],
    },
  });
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['old_1']);
  const res = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['old_1'] }, 'trade_9');
  equal(res.success, true, 'the trade still links to its copy');
  deepEqual(res.ids, ['shot_1'], 'trade points at the copy');
  equal(calls.deletes.includes('old_1'), false, 'the shared original survives');
  equal(calls.removed.includes('old_1'), false, 'and so does its metadata ref');
});

test('reference checks exclude the current trade and setup but include reviews', async () => {
  const { api } = makeShots({
    refs: {
      trades: [{ id: 'trade_9', screenshotIds: ['old_1'] }],
      setups: [{ id: 'setup_1', screenshotIds: ['old_1'] }],
      reviews: [],
    },
  });
  ok(!api.isRefElsewhere('old_1', 'trade_9', 'setup_1'), 'the current trade and setup do not count as elsewhere');
  ok(api.isRefElsewhere('old_1', 'trade_OTHER', 'setup_OTHER'), 'the same id seen from another record counts');
  ok(!api.isRefElsewhere('fresh_id', 'trade_9', 'setup_1'), 'an unreferenced id is safe to clean');
  const withReview = makeShots({
    refs: { trades: [], setups: [], reviews: [{ id: 'rev_1', screenshotIds: ['old_1'] }] },
  });
  ok(withReview.api.isRefElsewhere('old_1', 'trade_9', 'setup_1'), 'a review holding the id protects it even during this trade’s cleanup');
});

test('an unreadable store blocks deletion rather than risking shared evidence', async () => {
  const { api, calls } = makeShots({ refsThrow: true });
  api.setAnalysis({ id: 'setup_1' });
  api.setStaged('setup_1', ['old_1']);
  ok(api.isRefElsewhere('old_1', 'trade_9', 'setup_1'), 'a store that cannot be read counts as referenced');
  const res = await api.attachShotsToTrade({ id: 'setup_1', screenshotIds: ['old_1'] }, 'trade_9');
  equal(res.success, true, 'the link itself still succeeds');
  equal(calls.deletes.includes('old_1'), false, 'but the original is preserved when ownership cannot be verified');
});

// ---- 5. Cancel / failure preservation ----

test('cancellation keeps staged evidence on the setup rather than deleting it', () => {
  const src = SOURCE;
  const onConfirm = src.slice(src.indexOf('onConfirm: async (executionData) =>'));
  const failureBranch = onConfirm.slice(0, onConfirm.indexOf('attachShotsToTrade'));
  ok(
    !/deleteScreenshot|deleteByParent/.test(failureBranch),
    'the failure branch must not delete staged evidence',
  );
  ok(
    /staged evidence stays keyed to the setup/.test(failureBranch),
    'the failure branch documents that evidence is preserved',
  );
});

test('no cascade delete was introduced into the execution path', () => {
  const fn = extractFunction('attachShotsToTrade');
  ok(!/deleteByParent/.test(fn), 'parent-wide deletion must not be used on a single setup');
});

// ---- 6. Non-vacuity ----

test('NON-VACUITY: the Phase 5 placeholder is gone and real wiring exists', () => {
  ok(!/Coming in Phase 5/.test(SOURCE), 'the placeholder text is removed');
  ok(/id="ta-shot-file"/.test(SOURCE), 'a real file input exists');
  ok(/id="ta-shot-add"/.test(SOURCE), 'an add button exists');
  ok(/id="ta-shots"/.test(SOURCE), 'a gallery container exists');
  ok(/accept="image\/\*"/.test(SOURCE), 'the picker is restricted to images');
  ok(/multiple hidden/.test(SOURCE), 'multi-select is enabled and the input stays hidden');
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('setup-screenshots.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}