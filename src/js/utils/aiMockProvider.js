// ============================================
// Mock AI provider — deterministic, offline.
// Vanilla ESM, offline-first. No side effects on import.
//
// Phase 10E-C test support. Lets the provider contract be proven in full
// before any external API, key or network call is involved.
//
// Deterministic by construction: no network, no timers, no randomness, no
// clock. The same scenario always yields the same response, so a test
// failure means the contract changed rather than the provider being moody.
import { AI_RESULT_SECTIONS } from './aiAdapterContract.js';

function observation(text, insightIds, factIds, groundedOn = 'record') {
  return { text, insightIds, factIds, groundedOn };
}

/**
 * A scripted, valid answer.
 *
 * Every figure it states cites the fact it rests on, no metric is
 * misattributed, and the direction it describes matches a derived fact's
 * sign. It is deliberately boring: a compliant answer, not a clever one.
 */
export function validScenario(request) {
  const context = request?.context ?? {};
  const insights = Array.isArray(context.insights) ? context.insights : [];
  const record = insights.find((i) => i.traceability === 'record');
  const changeFact = (record?.permittedFactIds || [])
    .map((id) => (context.allowedNumericFacts || []).find((f) => f.id === id))
    .find((f) => f && f.kind === 'derived' && Number(f.value) < 0);

  const observations = [];
  if (record) {
    observations.push(observation(
      'The engine flagged this area as worth watching rather than acting on.',
      [record.id],
      [],
      record.traceability,
    ));
  }
  if (changeFact) {
    observations.push(observation(
      `The change reported by the engine was ${changeFact.value}.`,
      [record.id],
      [changeFact.id],
      record.traceability,
    ));
  }

  const questionTargets = insights.length > 0 ? [insights[0].id] : [];
  return {
    summary: 'These are deterministic observations drawn from the supplied findings.',
    observations,
    questionsToInvestigate: questionTargets.length
      ? ['What would you want recorded consistently here before this can be judged?']
      : [],
    possibleHypotheses: record
      ? [observation('Sample composition may differ between the compared windows.', [record.id], [], record.traceability)]
      : [],
  };
}

/**
 * Scenario catalogue. Each returns a response that breaks exactly one rule,
 * so a test failure points at a single contract clause.
 */
export const SCENARIOS = {
  /** No citations on a figure: a contract violation, not a repairable gap. */
  missingFactId: (request) => {
    const record = (request?.context?.insights || []).find((i) => i.traceability === 'record');
    return validScenario(request) && {
      ...validScenario(request),
      observations: [observation('The change reported by the engine was -0.05.', [record.id], [])],
    };
  },

  /** Cites a fact id that was never published. */
  wrongFactId: (request) => {
    const record = (request?.context?.insights || []).find((i) => i.traceability === 'record');
    return {
      ...validScenario(request),
      observations: [observation('The change reported by the engine was -0.05.', [record.id], ['no-such-fact'])],
    };
  },

  /** A real figure attached to the wrong metric. */
  wrongMetric: (request) => {
    const record = (request?.context?.insights || []).find((i) => i.traceability === 'record');
    const facts = request?.context?.allowedNumericFacts || [];
    // Cite a fact whose value matches the figure but belongs to a different
    // metric, so the metric rule is what fails rather than the numeric one.
    const pfHistorical = facts.find((f) => String(f.id).includes('profitFactor.historical'));
    const wc = facts.find((f) => String(f.id).includes('winRate.historical'));
    return {
      ...validScenario(request),
      observations: [observation('Win rate was 80.', [record.id], [pfHistorical?.id ?? wc?.id].filter(Boolean))],
    };
  },

  /** A decline direction with no derived fact carrying a negative sign. */
  wrongSign: (request) => {
    const record = (request?.context?.insights || []).find((i) => i.traceability === 'record');
    const facts = request?.context?.allowedNumericFacts || [];
    const hist = facts.find((f) => String(f.id).includes('winRate.historical'));
    return {
      ...validScenario(request),
      observations: [observation('Win rate decreased by 80.', [record.id], hist ? [hist.id] : [])],
    };
  },

  /** A figure that exists nowhere in the package. */
  inventedNumber: (request) => {
    const record = (request?.context?.insights || []).find((i) => i.traceability === 'record');
    const facts = request?.context?.allowedNumericFacts || [];
    const hist = facts.find((f) => String(f.id).includes('winRate.historical'));
    return {
      ...validScenario(request),
      observations: [observation('Win rate was 99.', [record.id], hist ? [hist.id] : [])],
    };
  },

  /** Attribution the evidence does not support. */
  causalClaim: (request) => {
    const record = (request?.context?.insights || []).find((i) => i.traceability === 'record');
    return {
      ...validScenario(request),
      observations: [observation('The session caused the decline.', [record.id], [])],
    };
  },

  /** A trading instruction. */
  tradingInstruction: (request) => {
    const record = (request?.context?.insights || []).find((i) => i.traceability === 'record');
    return {
      ...validScenario(request),
      observations: [observation('You should reduce your risk here.', [record.id], [])],
    };
  },

  /** Claims a state the cited insight does not carry. */
  unsupportedState: (request) => {
    const record = (request?.context?.insights || []).find((i) => i.traceability === 'record');
    return {
      ...validScenario(request),
      observations: [observation('This strategy is degrading.', [record.id], [])],
    };
  },

  /** Carries its own verdict, which the deterministic layer owns. */
  selfAssignedState: (request) => ({ ...validScenario(request), state: 'DEGRADED' }),

  /** Upgrades a pattern-level finding to record-level reasoning. */
  recordGroundingUpgrade: (request) => {
    const pattern = (request?.context?.insights || []).find((i) => i.traceability === 'pattern');
    const target = pattern ?? (request?.context?.insights || [])[0];
    if (!target) return validScenario(request);
    return {
      ...validScenario(request),
      observations: [observation('These individual trades show the pattern clearly.', [target.id], [], 'record')],
    };
  },

  /** An unknown section. */
  unknownSection: (request) => ({ ...validScenario(request), recommendations: ['do something'] }),
};

/**
 * Build a provider adapter from a scenario name.
 *
 * @param {object} options — { scenario, available, mode }
 *   scenario: a key of SCENARIOS, or 'valid' for the compliant answer.
 *   available: what isAvailable() reports.
 *   mode: 'object' (default), 'json' (JSON string), 'malformed' (not JSON),
 *         'notObject' (JSON array), 'empty' (empty string), 'null', 'throw'
 * @returns {object} a provider adapter satisfying isValidProviderAdapter.
 */
export function createMockProvider(options = {}) {
  const { scenario = 'valid', available = true, mode = 'object' } = options;
  return {
    id: `mock-${scenario}`,
    label: `Mock provider (${scenario})`,
    isAvailable: () => available,
    generate: (request) => {
      if (mode === 'throw') throw new Error('mock provider failure');
      const base = scenario === 'valid' ? validScenario(request) : SCENARIOS[scenario](request);
      if (mode === 'json') return JSON.stringify(base);
      if (mode === 'malformed') return '{ this is not json';
      if (mode === 'notObject') return JSON.stringify([base]);
      if (mode === 'empty') return '   ';
      if (mode === 'null') return null;
      return base;
    },
  };
}

export { AI_RESULT_SECTIONS };

export default { validScenario, SCENARIOS, createMockProvider };