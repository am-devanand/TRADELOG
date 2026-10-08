import { test, ok, equal, deepEqual } from './helpers.js';
import { readFileSync } from 'node:fs';

const ollama = await import('../src/js/utils/aiProviderOllama.js');
const contract = await import('../src/js/utils/aiAdapterContract.js');
const adapter = await import('../src/js/utils/aiProviderAdapter.js');

const {
  createOllamaProvider, buildChatBody, normalizeReply, extractJson, DEFAULT_MODEL,
} = ollama;

const CODE = new URL('../src/js/utils/aiProviderOllama.js', import.meta.url);

const fakeFetch = (handler) => (...args) => Promise.resolve(handler(...args));

/** Serve availability and chat separately; the boundary probes /api/tags first. */
const routedFetch = (chatBody) => (url) => {
  if (String(url).includes('/api/tags')) {
    return Promise.resolve({ ok: true, json: async () => ({ models: [{ name: 'llama3.2:3b' }] }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ message: { content: chatBody } }) });
};

const okJson = (obj) => ({ ok: true, json: async () => obj });

// ---------- shape translation ----------

test('ollama: extracts the first balanced JSON object from prose', () => {
  equal(extractJson('noise {"a":{"b":1}} tail'), '{"a":{"b":1}}');
  equal(extractJson('{"a":"}"}'), '{"a":"}"}', 'braces inside strings do not end the object');
  equal(extractJson('{"a":"\\""}'), '{"a":"\\""}', 'escaped quotes do not end the object');
  equal(extractJson('no json here'), 'no json here', 'returns input unchanged');
  equal(extractJson('{"unterminated": '), '{"unterminated": ', 'an unclosed object is left alone');
});

test('ollama: normalizeReply accepts a reply and refuses a non-reply', () => {
  const good = normalizeReply({ message: { content: '{"summary":"x"}' } });
  ok(good.ok);
  deepEqual(good.candidate, { summary: 'x' });

  for (const bad of [{ message: {} }, {}, { message: { content: 42 } }, { message: { content: 'plain prose' } }]) {
    equal(normalizeReply(bad).ok, false, `${JSON.stringify(bad).slice(0, 40)} refused`);
  }
  // A JSON array is not a contract object.
  equal(normalizeReply({ message: { content: '[1,2]' } }).ok, false);
});

test('ollama: a truncated reply is refused rather than repaired', () => {
  const cut = { message: { content: '{"summary":"x","observations":[{"text":"y"' } };
  equal(normalizeReply(cut).ok, false, 'an unfinished object must not be salvaged');
});

// ---------- request shape ----------

test('ollama: request is deterministic and asks for json', () => {
  const request = { prompt: 'P' };
  const a = buildChatBody(request, { model: 'llama3.2:3b', numPredict: 1000 });
  const b = buildChatBody(request, { model: 'llama3.2:3b', numPredict: 1000 });
  deepEqual(a, b, 'identical inputs give an identical body');
  equal(a.model, 'llama3.2:3b');
  equal(a.stream, false, 'a validation run must not stream');
  equal(a.format, 'json');
  equal(a.options.temperature, 0, 'decoding is deterministic');
  equal(a.options.seed, 0);
  equal(a.messages[0].role, 'system');
  equal(a.messages[0].content, 'P');
  equal(a.options.num_predict, 1000);
});

test('ollama: the request carries no credential material', () => {
  const body = buildChatBody({ prompt: 'P' }, {});
  const serialized = JSON.stringify(body);
  for (const forbidden of ['apiKey', 'api_key', 'Authorization', 'Bearer', 'token', 'secret']) {
    ok(!serialized.includes(forbidden), `request must not contain ${forbidden}`);
  }
});

// ---------- availability ----------

test('ollama: available only when the endpoint serves the model', async () => {
  const serving = fakeFetch(() => okJson({ models: [{ name: 'llama3.2:3b' }] }));
  equal(await createOllamaProvider({ fetchImpl: serving }).isAvailable(), true);

  const otherModel = fakeFetch(() => okJson({ models: [{ name: 'qwen3-vl:4b' }] }));
  equal(await createOllamaProvider({ fetchImpl: otherModel }).isAvailable(), false);

  const empty = fakeFetch(() => okJson({ models: [] }));
  equal(await createOllamaProvider({ fetchImpl: empty }).isAvailable(), false);

  const httpError = fakeFetch(() => ({ ok: false, status: 503 }));
  equal(await createOllamaProvider({ fetchImpl: httpError }).isAvailable(), false);

  const throwing = () => Promise.reject(new Error('fetch failed'));
  equal(await createOllamaProvider({ fetchImpl: throwing }).isAvailable(), false,
    'an unreachable endpoint is unavailable, not an error');
});

test('ollama: a tag-only model name still matches', async () => {
  const serving = fakeFetch(() => okJson({ models: [{ name: 'llama3.2:3b-instruct' }] }));
  equal(await createOllamaProvider({ fetchImpl: serving }).isAvailable(), true);
});

// ---------- boundary integration ----------

test('ollama: a compliant reply reaches the validator as a candidate', async () => {
  const compliant = {
    summary: 'Observations drawn from the supplied findings.',
    observations: [],
    questionsToInvestigate: [],
    possibleHypotheses: [],
  };
  const provider = createOllamaProvider({
    fetchImpl: routedFetch(JSON.stringify(compliant)),
  });
  const result = await adapter.runAiProvider({ insights: [], provider, config: { enabled: true } });
  equal(result.outcome, 'ok');
  equal(result.success, true);
});

test('ollama: an unreachable endpoint surfaces as unavailable, never as a rejection', async () => {
  const provider = createOllamaProvider({ fetchImpl: () => Promise.reject(new Error('fetch failed')) });
  const result = await adapter.runAiProvider({ insights: [], provider, config: { enabled: true } });
  equal(result.outcome, 'unavailable');
  equal(result.result, null);
});

test('ollama: a thrown transport surfaces as provider_error, never as a rejection', async () => {
  const provider = createOllamaProvider({ fetchImpl: routedFetch('{}') });
  // Force the call itself to fail after availability succeeds.
  const failing = { ...provider, generate: () => Promise.reject(new Error('boom')) };
  const result = await adapter.runAiProvider({ insights: [], provider: failing, config: { enabled: true } });
  equal(result.outcome, 'provider_error');
  equal(result.result, null);
});

test('ollama: a non-JSON reply is a contract rejection carrying MALFORMED_RESPONSE', async () => {
  const provider = createOllamaProvider({ fetchImpl: routedFetch('I cannot comply.') });
  const result = await adapter.runAiProvider({ insights: [], provider, config: { enabled: true } });
  equal(result.outcome, 'rejected');
  const codes = result.violations.map((v) => v.code);
  ok(codes.includes(contract.VIOLATION_CODES.MALFORMED_RESPONSE), `got ${codes.join(',')}`);
});

test('ollama: a truncated reply is rejected, never salvaged', async () => {
  const provider = createOllamaProvider({
    fetchImpl: routedFetch('{"summary":"x","observations":[{"text":"partial'),
  });
  const result = await adapter.runAiProvider({ insights: [], provider, config: { enabled: true } });
  equal(result.outcome, 'rejected');
});

// ---------- boundaries ----------

test('boundaries: provider-specific code stays inside the adapter', () => {
  const providerCode = readFileSync(CODE, 'utf8');
  // Nothing in the deterministic or contract layers may know this provider exists.
  for (const file of ['../src/js/utils/aiContextBuilder.js', '../src/js/utils/aiAdapterContract.js',
    '../src/js/utils/intelligenceConsolidation.js', '../src/js/pages/intelligence.js']) {
    const other = readFileSync(new URL(file, import.meta.url), 'utf8');
    ok(!other.includes('Ollama') && !other.includes('ollama') && !other.includes('11434'),
      `${file} must not reference the provider`);
  }
  ok(providerCode.includes('11434'), 'the endpoint lives in the provider file');
});

test('boundaries: the provider holds no credential and reaches no domain data', () => {
  const code = readFileSync(CODE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const forbidden of ['localStorage', 'getItem(', 'setItem(', 'apiKey', 'Authorization',
    'tradingAnalytics', 'performanceAttribution', 'degradationEngine', 'executedTrades',
    'tradeReviews', 'propEngine', 'ruleHistory', 'getCoreMetrics']) {
    ok(!code.includes(forbidden), `provider must not reference ${forbidden}`);
  }
  ok(!/retry|setTimeout\(.*retr/i.test(code), 'no retry loop');
});

test('boundaries: the provider declares a timeout and clears it', () => {
  const code = readFileSync(CODE, 'utf8');
  ok(code.includes('AbortController'), 'a timeout is enforced');
  ok(code.includes('clearTimeout'), 'the timer is always cleared');
  equal(typeof DEFAULT_MODEL, 'string');
  ok(DEFAULT_MODEL.length > 0);
});

export async function run() {
  const h = await import('./helpers.js');
  return h.run();
}