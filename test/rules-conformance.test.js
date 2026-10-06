// Guards the boundary between app write paths and firestore.rules.
//
// A rules file can be individually sensible and still deny the app's real
// documents, which is exactly how sync stayed broken while looking correct.
// Every document path the app writes must be covered by a rules match that
// re-checks ownership of the outer {uid} segment.

import { readFileSync } from 'node:fs';
import { test } from './helpers.js';

const rulesSrc = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const syncSrc = readFileSync(new URL('../src/js/utils/syncManager.js', import.meta.url), 'utf8');

const appPaths = collectAppPaths(syncSrc);
const rules = parseRules(rulesSrc);

let failed = 0;
const problems = [];
const fail = (m) => { problems.push(m); failed++; };

test('rules: every app write path has an exact ownership-gated match', () => {
  if (appPaths.length === 0) throw new Error('no app paths parsed - parser is broken');
  for (const { fn, segments } of appPaths) {
    if (segments.length % 2 !== 0) {
      throw new Error(`${fn}: "${segments.join('/')}" has an odd segment count, so it cannot address a document`);
    }
    const match = findCover(rules, segments);
    if (!match) {
      throw new Error(`${fn}: no rules match covers "${segments.join('/')}" - default-deny would block it`);
    }
    if (!match.gated) {
      throw new Error(`${fn}: "${match.path}" is not gated on ownership`);
    }
  }
});

test('rules: no recursive wildcard and no ungated grant', () => {
  for (const r of rules) {
    if (r.path.includes('**')) throw new Error(`recursive wildcard at "${r.path}" would leak sibling users`);
    if (r.hasAllow && !r.gated) throw new Error(`rule "${r.path}" grants access but is not ownership-gated`);
  }
});

test('rules: authorization derives only from request.auth.uid', () => {
  if (/request\.auth\.token/.test(rulesSrc) || /request\.resource\.data\.(email|username)/.test(rulesSrc)) {
    throw new Error('rules derive authorization from a client-controlled claim or field');
  }
});

export async function run() {
  const helpers = await import('./helpers.js');
  const result = await helpers.run();
  if (result.passed) {
    console.log(`  (app document paths checked: ${appPaths.length}; rules blocks: ${rules.length})`);
  }
  return result;
}



// 'users', uid, 'accounts', String(accountId)  ->  ['users','{uid}','accounts','{accountId}']
function collectAppPaths(src) {
  const out = [];
  const re = /const (p[A-Za-z]+) = \(uid[^=]*=>\s*\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(src))) {
    const segments = m[2].split(',').map((raw) => {
      const s = raw.trim();
      if (!s) return null;
      if (s.startsWith("'")) return s.slice(1, -1);
      const call = s.match(/^String\((\w+)\)$/);
      if (call) return `{${call[1]}}`;
      if (/^\w+$/.test(s)) return `{${s}}`;
      return s;
    }).filter(Boolean);
    if (segments[0] === 'users') out.push({ fn: m[1], segments });
  }
  return out;
}

// Rule paths are written relative to their nesting level, so absolute paths are
// rebuilt with one linear brace-depth walk. Plain function bodies also contain
// braces, so depth is tracked for every brace and a match block is only popped
// when the depth returns to the level it opened at.
function parseRules(src) {
  const rules = [];
  const stack = [];
  let depth = 0;
  const re = /match\s+((?:\/[\w{}=*]+)+)\s*\{|\{|\}/g;
  let m;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (tok === '{') { depth++; continue; }
    if (tok === '}') {
      depth--;
      const top = stack[stack.length - 1];
      if (top && top.depth === depth) stack.pop();
      continue;
    }
    const path = m[1];
    const bodyStart = m.index + tok.length;
    const next = src.indexOf('}', bodyStart);
    const body = src.slice(bodyStart, next === -1 ? src.length : next);
    rules.push({
      path: stack.map((e) => e.path).concat(path).join(''),
      gated: /isOwner\(/.test(body),
      hasAllow: /\ballow\b/.test(body),
    });
    stack.push({ path, depth });
    depth++;
  }
  return rules;
}

// Firestore wildcards are positional: {ruleId} matches any single segment, so
// the client's field name for an id is irrelevant. Compare segment-wise.
//
// Only an EXACT segment-count match counts. Firestore rules do NOT cascade:
// an allow on /users/{uid} covers the profile document alone, never its
// subcollections. Treating a parent as covering a child is precisely the
// mistake that leaves the app default-denied.
function segMatches(patternSeg, actualSeg) {
  return /^\{.*\}$/.test(patternSeg) || patternSeg === actualSeg;
}

function findCover(rules, segments) {
  for (const r of rules) {
    // Drop the /databases/{database}/documents service root, which is matched
    // implicitly by the Firestore runtime and never written to directly.
    const all = r.path.split('/').filter(Boolean);
    const at = all.indexOf('users');
    if (at === -1) continue;
    const shape = all.slice(at);
    if (shape[0] !== 'users') continue;
    if (shape.length !== segments.length) continue;
    let ok = true;
    for (let i = 1; i < shape.length; i++) {
      if (!segMatches(shape[i], segments[i])) { ok = false; break; }
    }
    if (ok) return { ...r, exact: true };
  }
  return null;
}

function balanced(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(from, i);
}