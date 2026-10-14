// ROUTE IMPORT RESOLUTION TESTS
//
// Regression guard for the production-only failure where five dynamic imports
// in pages/trade.js and pages/prop.js carried `/* @vite-ignore */`. That hint
// told the bundler to leave the specifier untouched, so at runtime the browser
// resolved it against the built chunk URL (`/utils/executedTrades.js` instead of
// `/assets/index-<hash>.js`), 404'd, and the `.catch()` swallowed it. The pages
// then silently used fallback branches for the whole session.
//
// These tests lock the three things that must hold:
//   1. no `@vite-ignore` on any dynamic import,
//   2. every dynamic import specifier is a relative literal resolving to a
//      file that exists on disk (no runtime-generated paths),
//   3. each target actually exports the symbol its consumer probes for.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { test, run, ok, equal } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SOURCE_FILES = walk(SRC);

// Matches import( ... ) where the first argument is a plain quoted literal.
// Template literals and variables are deliberately excluded so they show up as
// "unanalysable" rather than silently passing.
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(['"])(\.[^'"]+)\1\s*\)/g;

function rel(p) {
  return path.relative(ROOT, p);
}

/**
 * Strips comments but preserves string/template literals: this repo has
 * comments containing the text "import (", which a naive regex mistakes for a
 * real dynamic import. Quote tracking also keeps "//" in a URL intact.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

const CODE = new Map(SOURCE_FILES.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]));

// ---- 1. No @vite-ignore anywhere ----

// Matches @vite-ignore only when it is used as an import hint, not when prose
// merely mentions it. Scanned on raw text because the hint is itself a comment.
test('no dynamic import disables bundler analysis with @vite-ignore', () => {
  const offenders = SOURCE_FILES
    .filter((f) => /\bimport\s*\([^)]*@vite-ignore[^)]*\)/.test(readFileSync(f, 'utf8')))
    .map(rel);
  equal(offenders.length, 0, `imports using @vite-ignore: ${offenders.join(', ')}`);
});

test('no dynamic import uses a template literal or a computed specifier', () => {
  const offenders = [];
  for (const file of SOURCE_FILES) {
    for (const m of CODE.get(file).matchAll(/\bimport\s*\(([^)]{0,200})\)/g)) {
      const arg = m[1].trim();
      if (!arg) continue;
      if (/^['"]/.test(arg)) continue;
      offenders.push(`${rel(file)} -> ${arg.slice(0, 60)}`);
    }
  }
  equal(offenders.length, 0, `non-literal dynamic imports: ${offenders.join(' | ')}`);
});

// ---- 2. Every dynamic import resolves to a real file ----

test('every dynamic import specifier resolves to an existing file on disk', () => {
  const seen = [];
  const missing = [];
  for (const file of SOURCE_FILES) {
    for (const m of CODE.get(file).matchAll(DYNAMIC_IMPORT)) {
      const spec = m[2];
      const target = path.resolve(path.dirname(file), spec);
      seen.push(`${rel(file)} -> ${spec}`);
      if (!existsSync(target)) missing.push(`${rel(file)} -> ${spec}`);
    }
  }
  ok(seen.length > 0, 'at least one dynamic import was inspected');
  equal(missing.length, 0, `unresolvable specifiers: ${missing.join(', ')}`);
});

test('the five previously-broken route imports are present and resolvable', () => {
  const expected = [
    ['src/js/pages/trade.js', '../components/decisionCard.js'],
    ['src/js/pages/trade.js', '../utils/executedTrades.js'],
    ['src/js/pages/trade.js', '../pages/tradeDetail.js'],
    ['src/js/pages/prop.js', '../utils/propEngine.js'],
    ['src/js/pages/prop.js', '../utils/propRules.js'],
  ];
  const found = new Set();
  for (const file of SOURCE_FILES) {
    for (const m of CODE.get(file).matchAll(DYNAMIC_IMPORT)) found.add(`${rel(file)} -> ${m[2]}`);
  }
  for (const pair of expected) {
    ok(found.has(pair.join(' -> ')), `expected dynamic import ${pair.join(' -> ')}`);
  }
});

// ---- 3. Targets export what the consumers probe for ----

test('decisionCard.js exports renderDecisionCard (what trade.js assigns)', async () => {
  const mod = await import(pathToFileURL(path.join(SRC, 'js/components/decisionCard.js')).href);
  equal(typeof mod.renderDecisionCard, 'function', 'renderDecisionCard');
});

test('executedTrades.js exports the readers trade.js probes for', async () => {
  const mod = await import(pathToFileURL(path.join(SRC, 'js/utils/executedTrades.js')).href);
  equal(typeof mod.getOpenTrades, 'function', 'getOpenTrades');
  equal(typeof mod.getClosedTrades, 'function', 'getClosedTrades');
});

test('propEngine.js exports getAccountPropState (used by /prop and the command center)', async () => {
  const mod = await import(pathToFileURL(path.join(SRC, 'js/utils/propEngine.js')).href);
  equal(typeof mod.getAccountPropState, 'function', 'getAccountPropState');
  equal(typeof mod.evaluatePropRules, 'function', 'evaluatePropRules');
});

test('propRules.js exports updatePropRule and resetPropConfig (what prop.js probes for)', async () => {
  const mod = await import(pathToFileURL(path.join(SRC, 'js/utils/propRules.js')).href);
  equal(typeof mod.updatePropRule, 'function', 'updatePropRule');
  equal(typeof mod.resetPropConfig, 'function', 'resetPropConfig');
});

// ---- 4. Store-identity contracts the silent fallbacks violated ----

test('canonical executed trades and legacy storage trades are separate stores', () => {
  const exec = readFileSync(path.join(SRC, 'js/utils/executedTrades.js'), 'utf8');
  const storage = readFileSync(path.join(SRC, 'js/utils/storage.js'), 'utf8');
  ok(exec.includes('tradelog_exectrades_'), 'canonical store is tradelog_exectrades_');
  ok(storage.includes('tradelog_trades_'), 'legacy store is tradelog_trades_');
  ok(
    !storage.includes('tradelog_exectrades_'),
    'storage.js must not read the canonical executed-trade store, so the two paths stay distinguishable',
  );
});

test('propRules writes the single-object key that syncManager reads', () => {
  const rules = readFileSync(path.join(SRC, 'js/utils/propRules.js'), 'utf8');
  const sync = readFileSync(path.join(SRC, 'js/utils/syncManager.js'), 'utf8');
  ok(
    rules.includes('tradelog_propconfig_'),
    'propRules owns the canonical propconfig key',
  );
  ok(
    sync.includes('tradelog_propconfig_'),
    'syncManager reads the canonical propconfig key',
  );
  ok(
    !/tradelog_propconfig_\$\{[^}]*\}\$\{/.test(rules),
    'propRules key must not be per-account — syncManager cannot read a split key',
  );
});

export { run };
export default { run };

if (process.argv[1] && String(process.argv[1]).endsWith('route-imports.test.js')) {
  run().then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
