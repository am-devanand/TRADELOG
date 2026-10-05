// Test entrypoint: discovers and runs every test/*.test.js.
// Prints a per-suite summary; exits 1 if any assertion fails. No deps.
import './helpers.js'; // install DOM/localStorage stubs before test modules load
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = (await readdir(here)).filter((f) => f.endsWith('.test.js')).sort();

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
let totalTests = 0;
let suites = 0;

for (const f of files) {
  const mod = await import(pathToFileURL(path.join(here, f)).href);
  if (typeof mod.run !== 'function') {
    console.log(`suite ${f}: no run() export — skipped`);
    continue;
  }
  suites += 1;
  console.log(`suite ${f}:`);
  const r = await mod.run();
  totalPassed += r.passed;
  totalFailed += r.failed;
  totalSkipped += r.skipped ?? 0;
  totalTests += r.total;
  console.log(`  -> ${f}: ${r.passed} passed, ${r.failed} failed, ${r.skipped ?? 0} skipped`);
}

console.log(`\nTOTAL: ${suites} suite(s), ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped, ${totalTests} tests`);
// Force exit: firebase SDK (reached transitively via ruleManager) keeps
// async handles open in Node, so the loop would otherwise hang after success.
process.exit(totalFailed > 0 ? 1 : 0);
