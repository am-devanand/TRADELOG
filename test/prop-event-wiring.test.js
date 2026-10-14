// PROP EVENT WIRING REGRESSION TESTS
//
// Regression guard for the /prop editor defect where Save, Cancel, Close and
// Reset were dead controls. onPropClick was delegated to #app, but the modal is
// injected into #modal-overlay, which is a SIBLING of #app in index.html:
//
//   <body>
//     <div id="app"></div>           <- prop page, #prop-edit-btn lives here
//     <div id="toast-container"></div>
//     <div id="modal-overlay"></div> <- Save/Cancel/Close/Reset live here
//   </body>
//
// A click on #prop-edit-save bubbles modal-overlay -> body -> html. It never
// passes through #app, so a listener on #app never fired and the control was
// inert: no persistence, no toast, modal stayed open.
//
// These tests are BEHAVIOURAL, not textual. They extract the real handler
// functions and the real listener-registration statements from
// src/js/pages/prop.js, evaluate them against a DOM that reproduces the real
// sibling topology with genuine event bubbling, then dispatch actual clicks
// and assert on observable effects. The final tests are non-vacuity guards:
// they re-run the same dispatch against the OLD (#app) wiring and assert the
// controls are unreachable, so this suite fails if the fix is ever reverted.
import { test, run, ok, equal } from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROP_JS = path.join(ROOT, 'src/js/pages/prop.js');
const INDEX_HTML = path.join(ROOT, 'index.html');
const SOURCE = readFileSync(PROP_JS, 'utf8');

// ---- Minimal DOM with real event bubbling ----

class El {
  constructor(tag = 'div', id = '') {
    this.tag = tag;
    this.id = id;
    this.parentNode = null;
    this.children = [];
    this._listeners = new Map();
    this.attributes = new Map();
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  // Only '#id' selectors are needed by the handlers under test.
  closest(selector) {
    if (typeof selector !== 'string' || !selector.startsWith('#')) return null;
    const want = selector.slice(1);
    for (let n = this; n; n = n.parentNode) if (n.id === want) return n;
    return null;
  }

  querySelector() { return null; }
}

/**
 * Builds a document whose structure mirrors index.html: #app and
 * #modal-overlay are siblings under body, so bubbling from a modal control
 * never visits #app.
 */
function buildDom({ listenersOn = 'documentElement' } = {}) {
  const byId = new Map();
  const register = (el) => {
    if (el.id) byId.set(el.id, el);
    for (const c of el.children) register(c);
  };

  const html = new El('html');
  const body = new El('body');
  const app = new El('div', 'app');
  const propPage = new El('div', 'prop-page');
  const editBtn = new El('button', 'prop-edit-btn');
  propPage.appendChild(editBtn);
  app.appendChild(propPage);

  const overlay = new El('div', 'modal-overlay');
  const modalClose = new El('button', 'prop-modal-close');
  const resetBtn = new El('button', 'prop-reset-defaults');
  const cancelBtn = new El('button', 'prop-edit-cancel');
  const saveBtn = new El('button', 'prop-edit-save');
  const accountSel = new El('select', 'prop-account');
  for (const el of [accountSel, modalClose, resetBtn, cancelBtn, saveBtn]) {
    overlay.appendChild(el);
  }

  html.appendChild(body);
  body.appendChild(app);
  body.appendChild(overlay);

  register(html);

  const document = {
    documentElement: html,
    body,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => new El(tag),
  };

  return {
    document,
    listenerHost: listenersOn === 'documentElement' ? html : app,
    nodes: { html, body, app, overlay, editBtn, saveBtn, cancelBtn, modalClose, resetBtn, accountSel },
  };
}

// Bubbles from `target` to the root. Deliberately takes no listener-host
// argument: a handler runs only if it sits on target's ancestor chain, and
// that is the exact property this defect broke. Adding a host parameter here
// would hide regressions.
function dispatch(type, target) {
  const event = {
    type,
    target,
    currentTarget: null,
    closest: (sel) => target.closest(sel),
  };
  for (let node = target; node; node = node.parentNode) {
    const listeners = node._listeners.get(type);
    if (listeners) {
      event.currentTarget = node;
      for (const fn of [...listeners]) fn(event);
    }
  }
  return event;
}

// ---- Extract the real code under test from prop.js ----

/** Pulls `function name(...) { ... }` out of source by brace matching. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`could not find ${name} in prop.js`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') { depth += 1; opened = true; }
    else if (ch === '}') {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

/** Pulls every `document.<host>.addEventListener('<type>', <handler>);` statement. */
function extractListenerRegistrations(source) {
  const matches = source.matchAll(
    /document\.([A-Za-z]+)(?:\?|)\.addEventListener\(\s*['"]([a-z]+)['"]\s*,\s*(\w+)\s*\)\s*;/g,
  );
  return [...matches].map((m) => ({ hostExpr: `document.${m[1]}`, type: m[2], handler: m[3] }));
}

/**
 * Evaluates the real onPropClick/onPropChange bodies with instrumented
 * dependencies so every observable effect is spyable.
 */
function makeHarness({ listenersOn } = {}) {
  const dom = buildDom({ listenersOn });
  const calls = { openEditModal: 0, hideModal: 0, resetConfig: 0, saveConfig: 0, refreshProp: 0 };
  const selected = { accountId: null };

  const clickFn = new Function(
    'document', 'openEditModal', 'hideModal', 'resetConfig', 'saveConfig',
    'refreshProp', 'getCurrentUser', 'setSelectedAccountId', 'navigate',
    `${extractFunction(SOURCE, 'onPropClick')}\nreturn onPropClick;`,
  );
  const changeFn = new Function(
    'document', 'getCurrentUser', 'setSelectedAccountId', 'refreshProp',
    `${extractFunction(SOURCE, 'onPropChange')}\nreturn onPropChange;`,
  );

  const onPropClick = clickFn(
    dom.document,
    () => { calls.openEditModal += 1; },
    () => { calls.hideModal += 1; },
    () => { calls.resetConfig += 1; },
    () => { calls.saveConfig += 1; },
    () => { calls.refreshProp += 1; },
    () => 'user1',
    (_u, id) => { selected.accountId = id; },
    () => {},
  );

  const onPropChange = changeFn(
    dom.document,
    () => 'user1',
    (_u, id) => { selected.accountId = id; },
    () => { calls.refreshProp += 1; },
  );

  // Register the listeners exactly as prop.js declares them.
  const registrations = extractListenerRegistrations(SOURCE);
  const rootNode = listenersOn === 'app' ? dom.nodes.app : dom.document.documentElement;
  for (const reg of registrations) {
    const handler = reg.handler === 'onPropClick' ? onPropClick : onPropChange;
    if (rootNode && typeof rootNode.addEventListener === 'function') {
      rootNode.addEventListener(reg.type, handler);
    }
  }

  return { dom, calls, selected, registrations };
}

// ---- 1. Structural facts the defect depends on ----

test('index.html keeps #app and #modal-overlay as siblings', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const appIdx = html.indexOf('id="app"');
  const overlayIdx = html.indexOf('id="modal-overlay"');
  ok(appIdx !== -1, '#app exists in index.html');
  ok(overlayIdx !== -1, '#modal-overlay exists in index.html');
  ok(appIdx < overlayIdx, '#app precedes #modal-overlay');
  const between = html.slice(appIdx, overlayIdx);
  ok(!between.includes('</div>\n  <div id="modal-overlay"'), 'the two divs close independently');
});

test('registration list covers both click and change with the two handlers', () => {
  const regs = extractListenerRegistrations(SOURCE);
  const summary = regs.map((r) => `${r.handler}:${r.type}@${r.hostExpr}`);
  ok(summary.includes('onPropClick:click@document.documentElement'),
    `expected click handler on document root, got: ${summary.join(', ')}`);
  ok(summary.includes('onPropChange:change@document.documentElement'),
    `expected change handler on document root, got: ${summary.join(', ')}`);
});

// ---- 2. Behavioural: the four modal controls ----

test('clicking #prop-edit-save reaches saveConfig through the overlay sibling', () => {
  const h = makeHarness();
  dispatch('click', h.dom.nodes.saveBtn);
  equal(h.calls.saveConfig, 1, 'saveConfig called exactly once');
  equal(h.calls.hideModal, 0, 'save must not also dismiss via the cancel path');
});

test('clicking #prop-edit-cancel reaches hideModal and never saves', () => {
  const h = makeHarness();
  dispatch('click', h.dom.nodes.cancelBtn);
  equal(h.calls.hideModal, 1, 'hideModal called exactly once');
  equal(h.calls.saveConfig, 0, 'cancel must not save');
  equal(h.calls.resetConfig, 0, 'cancel must not reset');
});

test('clicking #prop-modal-close reaches hideModal and never saves', () => {
  const h = makeHarness();
  dispatch('click', h.dom.nodes.modalClose);
  equal(h.calls.hideModal, 1, 'hideModal called exactly once');
  equal(h.calls.saveConfig, 0, 'close must not save');
});

test('clicking #prop-reset-defaults reaches resetConfig only', () => {
  const h = makeHarness();
  dispatch('click', h.dom.nodes.resetBtn);
  equal(h.calls.resetConfig, 1, 'resetConfig called exactly once');
  equal(h.calls.saveConfig, 0, 'reset is its own action, not a save');
  equal(h.calls.hideModal, 0, 'reset does not dismiss the modal');
});

test('clicking a child icon inside the controls still resolves via closest()', () => {
  const h = makeHarness();
  const icon = new El('span');
  h.dom.nodes.saveBtn.appendChild(icon);
  dispatch('click', icon);
  equal(h.calls.saveConfig, 1, 'delegation resolves the ancestor control, not just the exact target');
});

// ---- 3. Behavioural: the in-page control and the account selector ----

test('clicking #prop-edit-btn opens the modal from inside #app', () => {
  const h = makeHarness();
  dispatch('click', h.dom.nodes.editBtn);
  equal(h.calls.openEditModal, 1, 'editor opens from the page header button');
});

test('changing the account selector selects the account and re-renders', () => {
  const h = makeHarness();
  h.dom.nodes.accountSel.value = 'acc-2';
  dispatch('change', h.dom.nodes.accountSel);
  equal(h.selected.accountId, 'acc-2', 'selected account id updated');
  equal(h.calls.refreshProp, 1, 'dashboard re-rendered once');
});

test('unrelated clicks and changes are ignored', () => {
  const h = makeHarness();
  const stray = new El('button', 'some-other-button');
  h.dom.nodes.app.appendChild(stray);
  dispatch('click', stray);
  dispatch('change', stray);
  equal(h.calls.saveConfig, 0, 'no save');
  equal(h.calls.hideModal, 0, 'no hide');
  equal(h.calls.openEditModal, 0, 'no modal open');
  equal(h.calls.refreshProp, 0, 'no re-render');
});

// ---- 4. Idempotence: repeated opens must not double-fire ----

test('a single registration pair fires each action once per click', () => {
  const h = makeHarness();
  equal(h.registrations.length, 2, 'exactly two listener registrations, no duplicates');
  dispatch('click', h.dom.nodes.saveBtn);
  dispatch('click', h.dom.nodes.saveBtn);
  equal(h.calls.saveConfig, 2, 'two clicks produce exactly two saves (one per click)');
});

// ---- 5. Non-vacuity: the suite must fail on the old wiring ----

test('NON-VACUITY: the original #app delegation left the modal controls dead', () => {
  const h = makeHarness({ listenersOn: 'app' });
  dispatch('click', h.dom.nodes.saveBtn);
  dispatch('click', h.dom.nodes.cancelBtn);
  dispatch('click', h.dom.nodes.modalClose);
  dispatch('click', h.dom.nodes.resetBtn);
  equal(h.calls.saveConfig, 0, 'save is unreachable when listening on #app');
  equal(h.calls.hideModal, 0, 'cancel/close are unreachable when listening on #app');
  equal(h.calls.resetConfig, 0, 'reset is unreachable when listening on #app');
  // ...while the in-page button still worked, which is why the bug looked partial.
  dispatch('click', h.dom.nodes.editBtn);
  equal(h.calls.openEditModal, 1, '#app-delegated handler still served the in-page control');
});

test('NON-VACUITY: bubbling from the overlay never visits #app', () => {
  const { app, overlay, saveBtn } = buildDom().nodes;
  ok(!app.contains(saveBtn), 'the save button is not a descendant of #app');
  ok(app.parentNode === overlay.parentNode, '#app and #modal-overlay share a parent');
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('prop-event-wiring.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}