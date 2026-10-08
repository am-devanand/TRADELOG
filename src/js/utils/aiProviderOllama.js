// ============================================
// Ollama provider adapter — provider-specific, isolated.
// Vanilla ESM, offline-first. No side effects on import.
//
// Phase 10E-E1. A local model behind the existing 10E-C provider interface.
//
// Everything provider-specific lives in this file: the endpoint, the request
// shape, the response shape and the transport. Nothing here is imported by
// the context builder, the contract, the adapter boundary or any page, so no
// provider detail can leak into the deterministic intelligence layer.
//
// Local by design: no API key, no credential storage, no outbound network.
// The key-security question therefore does not arise for this provider.
//
// Guarantees inherited from the boundary rather than reimplemented here:
// the response is never repaired, there is no retry, a timeout surfaces as
// provider_error and an unreachable endpoint surfaces as unavailable. This
// file only translates shapes and classifies transport outcomes.
const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.2:3b';

function text(value) {
  const s = value == null ? '' : String(value).trim();
  return s === '' ? null : s;
}

function classify(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '').toLowerCase();
  if (name === 'AbortError' || message.includes('abort') || message.includes('timeout')) {
    return 'timeout';
  }
  if (message.includes('fetch failed') || message.includes('econnrefused')
    || message.includes('network') || message.includes('failed to fetch')) {
    return 'unreachable';
  }
  return 'error';
}

/**
 * Ollama chat responses put the reply text in message.content. When the
 * model emits reasoning or prose around the JSON, the first balanced object
 * in the text is the candidate. Nothing is invented and nothing is repaired:
 * if no object can be located, the text is returned unchanged so the
 * boundary's parser decides it is malformed.
 */
export function extractJson(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  if (start === -1) return raw;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return raw;
}

export function buildChatBody(request, options = {}) {
  return {
    model: options.model ?? DEFAULT_MODEL,
    stream: false,
    // Deterministic decoding: a validation run must not vary between attempts
    // for reasons unrelated to the contract.
    options: { temperature: 0, top_p: 1, seed: 0, num_predict: options.numPredict ?? 900 },
    messages: [
      { role: 'system', content: request.prompt },
      {
        role: 'user',
        content: 'Respond with one JSON object and nothing else.',
      },
    ],
    format: 'json',
  };
}

/** Reduce an Ollama reply to the candidate object for contract validation. */
export function normalizeReply(json) {
  const message = json?.message;
  const content = message?.content;
  if (typeof content !== 'string') return { ok: false, reason: 'provider response had no message content' };
  const candidate = extractJson(content);
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'provider response was not a JSON object' };
    }
    return { ok: true, candidate: parsed };
  } catch {
    return { ok: false, reason: 'provider response was not valid JSON' };
  }
}

/**
 * Create the provider adapter.
 *
 * @param {object} options — { endpoint, model, timeoutMs, fetchImpl }
 *   fetchImpl is injectable so the adapter can be tested without a model.
 */
export function createOllamaProvider(options = {}) {
  const endpoint = String(options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 120000;
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));

  return {
    id: 'ollama',
    label: `Ollama (${model})`,
    model,

    async isAvailable() {
      try {
        const response = await fetchImpl(`${endpoint}/api/tags`, { method: 'GET' });
        if (!response || response.ok === false) return false;
        const body = await response.json();
        const names = Array.isArray(body?.models) ? body.models.map((m) => String(m?.name ?? '')) : [];
        // A served endpoint with no usable model is not "available".
        return names.some((n) => n === model || n.startsWith(`${model.split(':')[0]}:`));
      } catch {
        return false;
      }
    },

    async generate(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildChatBody(request, { model, numPredict: options.numPredict })),
          signal: controller.signal,
        });
        if (!response || response.ok === false) {
          const error = new Error(`ollama responded ${response?.status ?? 'unknown'}`);
          error.name = 'ProviderHttpError';
          throw error;
        }
        const json = await response.json();
        // Translate the provider's reply shape into what the boundary parses.
        // A reply that is not JSON is returned verbatim so the boundary
        // classifies it as malformed rather than this file repairing it.
        const normalized = normalizeReply(json);
        return normalized.ok ? normalized.candidate : String(json?.message?.content ?? '');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export { DEFAULT_ENDPOINT, DEFAULT_MODEL };

export default { createOllamaProvider, buildChatBody, normalizeReply, extractJson, DEFAULT_MODEL };