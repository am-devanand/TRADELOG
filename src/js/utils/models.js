// Models — shared rule/trade/account defaults (pure, no storage side effects)
import { generateId } from './helpers.js';

export const RULE_CATEGORIES = [
  'RISK',
  'ENTRY',
  'TECHNICAL',
  'STRATEGY',
  'SESSION',
  'PSYCHOLOGY',
  'EXECUTION',
  'TRADE_MANAGEMENT',
  'PROP_FIRM',
  'GENERAL',
];

export const RULE_TYPES = [
  'CHECKBOX',
  'NUMERIC_LIMIT',
  'PERCENTAGE_LIMIT',
  'TIME_RESTRICTION',
  'COUNT_LIMIT',
  'RR_LIMIT',
  'BOOLEAN',
];

export const DEFAULT_THRESHOLDS = { ready: 80, waiting: 60 };

export const DEFAULT_RULE = {
  id: '',
  userId: '',
  name: '',
  description: '',
  category: 'GENERAL',
  type: 'CHECKBOX',
  enabled: true,
  weight: 1,
  required: false,
  severity: 'MEDIUM',
  applicableSessions: [],
  applicableStrategies: [],
  applicablePairs: [],
  validation: { operator: '>=', value: 0, unit: 'count' },
  createdAt: '',
  updatedAt: '',
};

/** Build a rule with fresh id/timestamps over DEFAULT_RULE */
export function makeRule(overrides = {}, userId = '') {
  const now = new Date().toISOString();
  return {
    ...DEFAULT_RULE,
    applicableSessions: [...DEFAULT_RULE.applicableSessions],
    applicableStrategies: [...DEFAULT_RULE.applicableStrategies],
    applicablePairs: [...DEFAULT_RULE.applicablePairs],
    validation: { ...DEFAULT_RULE.validation },
    id: generateId(),
    userId: overrides.userId ?? userId ?? '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
    // Never allow shared array refs from caller defaults to leak
    applicableSessions: [...(overrides.applicableSessions ?? [])],
    applicableStrategies: [...(overrides.applicableStrategies ?? [])],
    applicablePairs: [...(overrides.applicablePairs ?? [])],
    validation: { ...DEFAULT_RULE.validation, ...(overrides.validation ?? {}) },
  };
}

/** Defaults for account/folder records lacking newer fields */
export function makeAccountDefaults() {
  return { type: 'LIVE' };
}

/** Defaults for trade records lacking newer fields */
export function makeTradeDefaults() {
  return {
    direction: 'LONG',
    riskPercent: 0,
    status: 'CLOSED',
    checklistScore: 0,
    strategyId: '',
  };
}

// ---- Setups (Phase 3 trade-page planning layer; pure, no storage side effects) ---

export const SETUP_STATUSES = [
  'DRAFT',
  'WAITING',
  'READY',
  'NO_TRADE',
  'ENTERED',
  'CLOSED',
  'REVIEWED',
];

export const PAIRS = [
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'AUD/USD',
  'USD/CAD',
  'USD/CHF',
  'NZD/USD',
  'EUR/GBP',
  'EUR/JPY',
  'GBP/JPY',
  'XAU/USD',
  'NAS100',
  'US30',
  'BTCUSD',
];

export const SESSIONS = ['London', 'New York', 'Asia', 'Overlap'];

export const TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

function toFiniteNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSetupDirection(raw) {
  const d = String(raw ?? 'LONG').trim().toUpperCase();
  if (d === 'BUY' || d === 'LONG') return 'LONG';
  if (d === 'SELL' || d === 'SHORT') return 'SHORT';
  return 'LONG';
}

function normalizeSetupStatus(raw) {
  const s = String(raw ?? 'DRAFT').trim().toUpperCase();
  return SETUP_STATUSES.includes(s) ? s : 'DRAFT';
}

export const DEFAULT_SETUP = {
  id: '',
  userId: '',
  accountId: '',
  pair: '',
  direction: 'LONG',
  strategyId: '',
  session: '',
  timeframe: '',
  setupType: '',
  entryPrice: 0,
  stopLoss: 0,
  takeProfit: 0,
  riskPercent: 0,
  riskAmount: 0,
  potentialLoss: 0,
  potentialProfit: 0,
  rr: 0,
  checklistScore: 0,
  checklistResults: [],
  decision: '',
  blockers: [],
  warnings: [],
  status: 'DRAFT',
  screenshotIds: [],
  notes: '',
  createdAt: '',
  updatedAt: '',
};

/** Build a setup with fresh id/timestamps over DEFAULT_SETUP */
export function makeSetup(overrides = {}, userId = '') {
  const now = new Date().toISOString();
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    ...DEFAULT_SETUP,
    ...o,
    id: o.id || generateId(),
    userId: String(o.userId ?? userId ?? '').trim().toLowerCase(),
    accountId: o.accountId ?? '',
    pair: o.pair ?? '',
    direction: normalizeSetupDirection(o.direction),
    strategyId: o.strategyId ?? '',
    session: o.session ?? '',
    timeframe: o.timeframe ?? '',
    setupType: o.setupType ?? '',
    entryPrice: toFiniteNumber(o.entryPrice, 0),
    stopLoss: toFiniteNumber(o.stopLoss, 0),
    takeProfit: toFiniteNumber(o.takeProfit, 0),
    riskPercent: toFiniteNumber(o.riskPercent, 0),
    riskAmount: toFiniteNumber(o.riskAmount, 0),
    potentialLoss: toFiniteNumber(o.potentialLoss, 0),
    potentialProfit: toFiniteNumber(o.potentialProfit, 0),
    rr: toFiniteNumber(o.rr, 0),
    checklistScore: toFiniteNumber(o.checklistScore, 0),
    checklistResults: Array.isArray(o.checklistResults) ? [...o.checklistResults] : [],
    decision: o.decision ?? '',
    blockers: Array.isArray(o.blockers) ? [...o.blockers] : [],
    warnings: Array.isArray(o.warnings) ? [...o.warnings] : [],
    status: normalizeSetupStatus(o.status),
    screenshotIds: Array.isArray(o.screenshotIds) ? [...o.screenshotIds] : [],
    notes: o.notes ?? '',
    createdAt: o.createdAt || now,
    updatedAt: now,
  };
}

// ---- Executed trades (Phase 4 live-trade layer; pure, no storage side effects) ---

export const TRADE_STATUSES = ['OPEN', 'PARTIALLY_CLOSED', 'CLOSED'];

export const CLOSE_REASONS = [
  'TP_HIT',
  'SL_HIT',
  'MANUAL_EXIT',
  'PARTIAL_EXIT',
  'BREAKEVEN',
  'OTHER',
];

function normalizeTradeDirection(raw) {
  const d = String(raw ?? 'LONG').trim().toUpperCase();
  if (d === 'BUY' || d === 'LONG') return 'LONG';
  if (d === 'SELL' || d === 'SHORT') return 'SHORT';
  return 'LONG';
}

function normalizeTradeStatus(raw) {
  const s = String(raw ?? 'OPEN').trim().toUpperCase();
  return TRADE_STATUSES.includes(s) ? s : 'OPEN';
}

function normalizeCloseReason(raw) {
  const r = String(raw ?? '').trim().toUpperCase();
  return CLOSE_REASONS.includes(r) ? r : '';
}

export const DEFAULT_TRADE = {
  id: '',
  userId: '',
  accountId: '',
  setupId: '',
  pair: '',
  direction: 'LONG',
  strategyId: '',
  session: '',
  timeframe: '',
  setupType: '',
  lotSize: 0,
  entryPrice: 0,
  exitPrice: 0,
  stopLoss: 0,
  takeProfit: 0,
  initialSL: 0,
  initialTP: 0,
  riskAmount: 0,
  riskPercent: 0,
  potentialLoss: 0,
  potentialProfit: 0,
  rr: 0,
  pnl: 0,
  pnlPercent: 0,
  rMultiple: 0,
  status: 'OPEN',
  openedAt: '',
  closedAt: '',
  closeReason: '',
  entryReason: '',
  notes: '',
  checklistScore: 0,
  checklistResults: [],
  rulesSnapshot: [],
  events: [],
  screenshotIds: [],
  createdAt: '',
  updatedAt: '',
};

/** Build an executed trade with fresh id/timestamps over DEFAULT_TRADE */
export function makeTrade(overrides = {}, userId = '') {
  const now = new Date().toISOString();
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    ...DEFAULT_TRADE,
    ...o,
    id: o.id || generateId(),
    userId: String(o.userId ?? userId ?? '').trim().toLowerCase(),
    accountId: o.accountId ?? '',
    setupId: o.setupId ?? '',
    pair: o.pair ?? '',
    direction: normalizeTradeDirection(o.direction),
    strategyId: o.strategyId ?? '',
    session: o.session ?? '',
    timeframe: o.timeframe ?? '',
    setupType: o.setupType ?? '',
    lotSize: toFiniteNumber(o.lotSize, 0),
    entryPrice: toFiniteNumber(o.entryPrice, 0),
    exitPrice: toFiniteNumber(o.exitPrice, 0),
    stopLoss: toFiniteNumber(o.stopLoss, 0),
    takeProfit: toFiniteNumber(o.takeProfit, 0),
    initialSL: toFiniteNumber(o.initialSL ?? o.stopLoss, 0),
    initialTP: toFiniteNumber(o.initialTP ?? o.takeProfit, 0),
    riskAmount: toFiniteNumber(o.riskAmount, 0),
    riskPercent: toFiniteNumber(o.riskPercent, 0),
    potentialLoss: toFiniteNumber(o.potentialLoss, 0),
    potentialProfit: toFiniteNumber(o.potentialProfit, 0),
    rr: toFiniteNumber(o.rr, 0),
    pnl: toFiniteNumber(o.pnl, 0),
    pnlPercent: toFiniteNumber(o.pnlPercent, 0),
    rMultiple: toFiniteNumber(o.rMultiple, 0),
    status: normalizeTradeStatus(o.status),
    openedAt: o.openedAt || now,
    closedAt: o.closedAt ?? '',
    closeReason: o.closeReason ? normalizeCloseReason(o.closeReason) : '',
    entryReason: o.entryReason ?? '',
    notes: o.notes ?? '',
    checklistScore: toFiniteNumber(o.checklistScore, 0),
    checklistResults: Array.isArray(o.checklistResults) ? [...o.checklistResults] : [],
    rulesSnapshot: Array.isArray(o.rulesSnapshot) ? [...o.rulesSnapshot] : [],
    events: Array.isArray(o.events) ? [...o.events] : [],
    screenshotIds: Array.isArray(o.screenshotIds) ? [...o.screenshotIds] : [],
    createdAt: o.createdAt || now,
    updatedAt: now,
  };
}

// ---- Trade reviews (post-trade review layer; pure, no storage side effects) ---
// Reviews never mutate trades: trade status stays CLOSED, snapshots are frozen
// copies. Findings are structural only (never psychological labels).

export const REVIEW_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED'];

export const PROCESS_GRADES = ['A', 'B', 'C', 'D', 'F'];

export const GRADE_BANDS = [
  { min: 90, grade: 'A' },
  { min: 80, grade: 'B' },
  { min: 70, grade: 'C' },
  { min: 60, grade: 'D' },
  { min: 0, grade: 'F' },
];

export const REVIEW_OUTCOMES = ['WIN', 'LOSS', 'BREAKEVEN'];

// Structural mistake tags (15). Neutral execution facts only — no psychology.
export const MISTAKE_TYPES = [
  'LATE_ENTRY',
  'EARLY_ENTRY',
  'EARLY_EXIT',
  'LATE_EXIT',
  'MOVED_STOPLOSS',
  'REMOVED_STOPLOSS',
  'MOVED_TAKE_PROFIT',
  'OVERSIZED_POSITION',
  'OVERTRADING',
  'REVENGE_TRADE',
  'FOMO_ENTRY',
  'IGNORED_CHECKLIST',
  'POOR_RISK_REWARD',
  'WRONG_SESSION',
  'NO_TRADE_PLAN',
];

// Strength tags (10)
export const STRENGTH_TYPES = [
  'FOLLOWED_PLAN',
  'PATIENCE',
  'GOOD_ENTRY_TIMING',
  'GOOD_EXIT_TIMING',
  'DISCIPLINED_RISK',
  'HELD_WINNER',
  'CUT_LOSSER',
  'ADAPTED_TO_MARKET',
  'GOOD_SESSION_CHOICE',
  'CLEAN_CHECKLIST',
];

function reviewOption(value, label, score) {
  return { value, label, score };
}

// Questionnaire schema: preTrade 4qs, execution 3qs, management 3qs.
// Each option carries an answers-only score (0-5); processScore.js maps
// selected values to scores, so option lists are the single source of truth.
export const REVIEW_QUESTIONS = {
  preTrade: [
    {
      id: 'pt_plan',
      question: 'Did you have a clear trade plan before entry?',
      options: [
        reviewOption('fully', 'Yes, fully planned', 5),
        reviewOption('mostly', 'Mostly planned', 4),
        reviewOption('partially', 'Partially planned', 2),
        reviewOption('none', 'No plan', 0),
      ],
    },
    {
      id: 'pt_setup_quality',
      question: 'How clean was the setup against your checklist?',
      options: [
        reviewOption('a_plus', 'A+ setup', 5),
        reviewOption('good', 'Good setup', 4),
        reviewOption('average', 'Average setup', 2),
        reviewOption('poor', 'Poor setup', 0),
      ],
    },
    {
      id: 'pt_context',
      question: 'Did you check session and news context before entry?',
      options: [
        reviewOption('yes', 'Yes, checked', 5),
        reviewOption('partial', 'Partially checked', 2),
        reviewOption('no', 'Did not check', 0),
      ],
    },
    {
      id: 'pt_risk',
      question: 'Was the position sized per your risk plan?',
      options: [
        reviewOption('correct', 'Sized correctly', 5),
        reviewOption('slightly_off', 'Slightly off plan', 3),
        reviewOption('oversized', 'Oversized / off plan', 0),
      ],
    },
  ],
  execution: [
    {
      id: 'ex_timing',
      question: 'How was your entry timing?',
      options: [
        reviewOption('perfect', 'On trigger, no hesitation', 5),
        reviewOption('good', 'Good, minor slip', 4),
        reviewOption('early_late', 'Early or late', 2),
        reviewOption('chased', 'Chased the move', 0),
      ],
    },
    {
      id: 'ex_levels',
      question: 'Were SL/TP placed per plan at entry?',
      options: [
        reviewOption('yes', 'Yes, per plan', 5),
        reviewOption('adjusted', 'Placed with adjustment', 2),
        reviewOption('no', 'Not per plan', 0),
      ],
    },
    {
      id: 'ex_state',
      question: 'What was your state at entry?',
      options: [
        reviewOption('calm', 'Calm and focused', 5),
        reviewOption('nervous', 'Nervous but controlled', 4),
        reviewOption('rushed', 'Rushed', 1),
        reviewOption('tilted', 'Tilted / emotional', 0),
      ],
    },
  ],
  management: [
    {
      id: 'mg_plan',
      question: 'Did you manage the trade per plan?',
      options: [
        reviewOption('yes', 'Yes, per plan', 5),
        reviewOption('minor', 'Minor deviation', 3),
        reviewOption('major', 'Major deviation', 0),
      ],
    },
    {
      id: 'mg_exit',
      question: 'How was your exit?',
      options: [
        reviewOption('per_plan', 'Exited per plan', 5),
        reviewOption('slightly_off', 'Slightly early or late', 3),
        reviewOption('early_exit', 'Early exit', 1),
        reviewOption('moved_targets', 'Moved targets mid-trade', 0),
      ],
    },
    {
      id: 'mg_levels',
      question: 'Did you move SL/TP against the plan?',
      options: [
        reviewOption('no', 'No moves against plan', 5),
        reviewOption('breakeven', 'Only moved SL to breakeven', 4),
        reviewOption('moved', 'Moved SL/TP against plan', 0),
      ],
    },
  ],
};

/** Derive a neutral outcome label from trade pnl (never from psychology). */
export function outcomeForPnl(pnl) {
  const n = Number(pnl);
  if (!Number.isFinite(n) || n === 0) return 'BREAKEVEN';
  return n > 0 ? 'WIN' : 'LOSS';
}

function normalizeReviewStatus(raw) {
  const s = String(raw ?? 'PENDING').trim().toUpperCase();
  return REVIEW_STATUSES.includes(s) ? s : 'PENDING';
}

function normalizeOutcome(raw) {
  const o = String(raw ?? '').trim().toUpperCase();
  return REVIEW_OUTCOMES.includes(o) ? o : '';
}

function clampConfidence(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

export const DEFAULT_REVIEW = {
  id: '',
  userId: '',
  tradeId: '',
  accountId: '',
  setupId: '',
  pair: '',
  direction: 'LONG',
  outcome: '',
  status: 'PENDING',
  answers: { preTrade: {}, execution: {}, management: {} },
  ruleViolations: [],
  mistakes: [],
  strengths: [],
  emotions: [],
  confidence: 3,
  followedPlan: false,
  wouldTakeAgain: false,
  whatWentWell: '',
  whatWentWrong: '',
  lesson: '',
  improvementAction: '',
  screenshotIds: [],
  tradeSnapshot: null,
  setupSnapshot: null,
  checklistSnapshot: [],
  automaticFindings: {
    riskViolation: false,
    rrViolation: false,
    sessionViolation: false,
    slMoved: false,
    tpMoved: false,
    exitDeviation: null,
  },
  processScore: {
    preTradeScore: 0,
    executionScore: 0,
    managementScore: 0,
    disciplineScore: 0,
    total: 0,
    grade: 'F',
  },
  total: 0,
  ruleAdherence: 100,
  createdAt: '',
  updatedAt: '',
};

/** Build a trade review with fresh id/timestamps over DEFAULT_REVIEW */
export function makeTradeReview(overrides = {}, userId = '') {
  const now = new Date().toISOString();
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const answers = o.answers && typeof o.answers === 'object' ? o.answers : {};
  const findings =
    o.automaticFindings && typeof o.automaticFindings === 'object' ? o.automaticFindings : {};
  const score = o.processScore && typeof o.processScore === 'object' ? o.processScore : {};
  return {
    ...DEFAULT_REVIEW,
    ...o,
    id: o.id || generateId(),
    userId: String(o.userId ?? userId ?? '').trim().toLowerCase(),
    tradeId: o.tradeId ?? '',
    accountId: o.accountId ?? '',
    setupId: o.setupId ?? '',
    pair: o.pair ?? '',
    direction: normalizeSetupDirection(o.direction),
    outcome: normalizeOutcome(o.outcome),
    status: normalizeReviewStatus(o.status),
    answers: {
      preTrade: { ...(answers.preTrade ?? {}) },
      execution: { ...(answers.execution ?? {}) },
      management: { ...(answers.management ?? {}) },
    },
    ruleViolations: Array.isArray(o.ruleViolations) ? [...o.ruleViolations] : [],
    mistakes: Array.isArray(o.mistakes) ? [...o.mistakes] : [],
    strengths: Array.isArray(o.strengths) ? [...o.strengths] : [],
    emotions: Array.isArray(o.emotions) ? [...o.emotions] : [],
    confidence: clampConfidence(o.confidence),
    followedPlan: o.followedPlan === true || String(o.followedPlan).toLowerCase() === 'yes',
    wouldTakeAgain: o.wouldTakeAgain === true || String(o.wouldTakeAgain).toLowerCase() === 'yes',
    whatWentWell: o.whatWentWell ?? '',
    whatWentWrong: o.whatWentWrong ?? '',
    lesson: o.lesson ?? '',
    improvementAction: o.improvementAction ?? '',
    screenshotIds: Array.isArray(o.screenshotIds) ? [...o.screenshotIds] : [],
    tradeSnapshot: o.tradeSnapshot ?? null,
    setupSnapshot: o.setupSnapshot ?? null,
    checklistSnapshot: Array.isArray(o.checklistSnapshot) ? [...o.checklistSnapshot] : [],
    automaticFindings: { ...DEFAULT_REVIEW.automaticFindings, ...findings },
    processScore: { ...DEFAULT_REVIEW.processScore, ...score },
    total: Number.isFinite(Number(o.total)) ? Number(o.total) : 0,
    ruleAdherence: Number.isFinite(Number(o.ruleAdherence)) ? Number(o.ruleAdherence) : 100,
    createdAt: o.createdAt || now,
    updatedAt: now,
  };
}

// ---- Prop-firm evaluation (Phase 6 data layer; pure, no storage side effects) ---

export const PROP_STATUSES = ['SAFE', 'WARNING', 'CRITICAL', 'BREACH'];

export const PROP_RULE_TYPES = [
  'PROFIT_TARGET',
  'DAILY_LOSS',
  'MAX_DRAWDOWN',
  'MIN_TRADING_DAYS',
  'CONSISTENCY',
  'MAX_RISK_PER_TRADE',
  'MAX_OPEN_RISK',
  'CUSTOM',
];

export const PROP_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// ---- Analytics (canonical analytics engine; pure, no storage side effects) ---

export const ANALYTICS_THRESHOLDS = {
  minimumSample: 5,
  repeatedPatternCount: 3,
  highProcessScore: 80,
  lowProcessScore: 60,
};

export const PROCESS_QUALITY_THRESHOLD = 80;

export const ANALYTICS_OUTCOMES = ['WIN', 'LOSS', 'BREAKEVEN'];

export const REVIEW_FILTERS = ['ALL', 'REVIEWED', 'UNREVIEWED'];

export const IMPROVEMENT_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED'];

export const ANALYTICS_DATE_PRESETS = [
  '7D',
  '30D',
  '90D',
  'THIS_MONTH',
  'THIS_YEAR',
  'ALL_TIME',
  'CUSTOM',
];

// ---- Data integrity (read-only audit layer; pure, no storage side effects) ---
// dataIntegrity.js is the sole consumer. These constants are append-only:
// never rename a code (stored reports reference them), only add new ones.

export const INTEGRITY_LEVELS = { ERROR: 'ERROR', WARNING: 'WARNING' };

export const INTEGRITY_CODES = {
  TRADE_NOT_FOUND: 'TRADE_NOT_FOUND',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  SETUP_NOT_FOUND: 'SETUP_NOT_FOUND',
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',
  TRADE_STATUS_INVALID: 'TRADE_STATUS_INVALID',
  SETUP_STATUS_INVALID: 'SETUP_STATUS_INVALID',
  SETUP_ENTERED_MISSING_TRADE: 'SETUP_ENTERED_MISSING_TRADE',
  REVIEW_TRADE_MISSING: 'REVIEW_TRADE_MISSING',
  REVIEW_TRADE_NOT_CLOSED: 'REVIEW_TRADE_NOT_CLOSED',
  REVIEW_DUPLICATE: 'REVIEW_DUPLICATE',
  TRADE_ACCOUNT_MISSING: 'TRADE_ACCOUNT_MISSING',
  TRADE_PNL_INVALID: 'TRADE_PNL_INVALID',
  TRADE_R_MULTIPLE_INVALID: 'TRADE_R_MULTIPLE_INVALID',
  TRADE_DATES_INVALID: 'TRADE_DATES_INVALID',
  TRADE_DATES_UNPARSEABLE: 'TRADE_DATES_UNPARSEABLE',
  TRADE_LEVELS_INVALID: 'TRADE_LEVELS_INVALID',
  TRADE_LOT_SIZE_INVALID: 'TRADE_LOT_SIZE_INVALID',
  TRADE_ACCOUNT_ID_MISSING: 'TRADE_ACCOUNT_ID_MISSING',
  SETUP_ACCOUNT_MISSING: 'SETUP_ACCOUNT_MISSING',
  REVIEW_NON_CLOSED_TRADE: 'REVIEW_NON_CLOSED_TRADE',
  RULE_DUPLICATE_ID: 'RULE_DUPLICATE_ID',
  RULE_WEIGHT_INVALID: 'RULE_WEIGHT_INVALID',
  TRADE_BALANCE_INCONSISTENT: 'TRADE_BALANCE_INCONSISTENT',
  RECON_BALANCE_MISMATCH: 'RECON_BALANCE_MISMATCH',
  RECON_BALANCE_SKIPPED: 'RECON_BALANCE_SKIPPED',
  RECON_PROP_MISMATCH: 'RECON_PROP_MISMATCH',
  RECON_PROP_SKIPPED: 'RECON_PROP_SKIPPED',
  RECON_ANALYTICS_MISMATCH: 'RECON_ANALYTICS_MISMATCH',
  RECON_ANALYTICS_SKIPPED: 'RECON_ANALYTICS_SKIPPED',
};

export const RECONCILIATION_TOLERANCE = 0.01;

// ---- Strategies (Phase 9A versioned strategy storage; pure, no storage side effects) ---
// Append-only contract: the replay engine is built against these exact keys.
// Strategies never influence real trading decisions.

export const STRATEGY_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'];

export const STRATEGY_CONDITION_TYPES = [
  'PRICE_ABOVE',
  'PRICE_BELOW',
  'CROSS_UP',
  'CROSS_DOWN',
  'TOUCHES_LEVEL',
  'BREAKS_STRUCTURE',
  'HTF_BIAS',
  'CANDLE_CLOSE',
  'INSIDE_RANGE',
  'CUSTOM',
];

export const STRATEGY_SL_MODELS = ['FIXED_POINTS', 'FIXED_PERCENT', 'STRUCTURE'];

export const STRATEGY_TP_MODELS = ['FIXED_POINTS', 'FIXED_PERCENT', 'STRUCTURE'];

export const STRATEGY_EXIT_MODELS = ['FIXED_RR', 'FIXED_TP', 'STRUCTURE', 'TRAILING'];

export const STRATEGY_DIRECTIONS = ['AUTO', 'LONG', 'SHORT'];

export const SIMULATED_TRADE_STATUS = 'SIMULATED';

export const REPLAY_EXIT_REASONS = ['SL_HIT', 'TP_HIT', 'MAX_HOLD', 'END_OF_DATA', 'MANUAL'];

function normalizeStrategyStatus(raw) {
  const s = String(raw ?? 'DRAFT').trim().toUpperCase();
  return STRATEGY_STATUSES.includes(s) ? s : 'DRAFT';
}

function normalizeStrategyDirection(raw) {
  const d = String(raw ?? 'AUTO').trim().toUpperCase();
  return STRATEGY_DIRECTIONS.includes(d) ? d : 'AUTO';
}

function normalizeStrategyExitModel(raw) {
  const m = String(raw ?? 'FIXED_RR').trim().toUpperCase();
  return STRATEGY_EXIT_MODELS.includes(m) ? m : 'FIXED_RR';
}

function normalizeStrategyConditions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
    .map((c) => ({
      id: c.id ?? '',
      type: STRATEGY_CONDITION_TYPES.includes(String(c.type ?? '').trim().toUpperCase())
        ? String(c.type).trim().toUpperCase()
        : 'CUSTOM',
      params: c.params && typeof c.params === 'object' && !Array.isArray(c.params) ? { ...c.params } : {},
    }));
}

export const DEFAULT_STRATEGY = {
  id: '',
  userId: '',
  name: '',
  description: '',
  status: 'DRAFT',
  version: 1,
  pairs: [],
  sessions: [],
  timeframes: [],
  direction: 'AUTO',
  entryConditions: [],
  confirmationConditions: [],
  minRR: null,
  riskPercent: null,
  stopLoss: { model: 'FIXED_POINTS', value: null },
  takeProfit: { model: 'FIXED_TP', value: null },
  exitModel: 'FIXED_RR',
  maxHoldCandles: null,
  ruleRefs: [],
  createdAt: '',
  updatedAt: '',
  versionCreatedAt: '',
};

/** Build a strategy with fresh id/timestamps over DEFAULT_STRATEGY */
export function makeStrategy(overrides = {}, userId = '') {
  const now = new Date().toISOString();
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const slSrc = o.stopLoss && typeof o.stopLoss === 'object' ? o.stopLoss : {};
  const tpSrc = o.takeProfit && typeof o.takeProfit === 'object' ? o.takeProfit : {};
  const slModel = STRATEGY_SL_MODELS.includes(String(slSrc.model ?? 'FIXED_POINTS').trim().toUpperCase())
    ? String(slSrc.model).trim().toUpperCase()
    : 'FIXED_POINTS';
  const tpModel = STRATEGY_TP_MODELS.includes(String(tpSrc.model ?? 'FIXED_TP').trim().toUpperCase())
    ? String(tpSrc.model).trim().toUpperCase()
    : 'FIXED_TP';
  const slValue = slSrc.value == null || slSrc.value === ''
    ? null
    : (Number.isFinite(Number(slSrc.value)) ? Number(slSrc.value) : null);
  const tpValue = tpSrc.value == null || tpSrc.value === ''
    ? null
    : (Number.isFinite(Number(tpSrc.value)) ? Number(tpSrc.value) : null);
  const versionRaw = Number(o.version);
  return {
    ...DEFAULT_STRATEGY,
    ...o,
    id: o.id || generateId(),
    userId: String(o.userId ?? userId ?? '').trim().toLowerCase(),
    name: String(o.name ?? ''),
    description: o.description ?? '',
    status: normalizeStrategyStatus(o.status),
    version: Number.isInteger(versionRaw) && versionRaw >= 1 ? versionRaw : 1,
    pairs: Array.isArray(o.pairs) ? [...o.pairs] : [],
    sessions: Array.isArray(o.sessions) ? [...o.sessions] : [],
    timeframes: Array.isArray(o.timeframes) ? [...o.timeframes] : [],
    direction: normalizeStrategyDirection(o.direction),
    entryConditions: normalizeStrategyConditions(o.entryConditions),
    confirmationConditions: normalizeStrategyConditions(o.confirmationConditions),
    minRR: o.minRR == null || o.minRR === '' ? null : (Number.isFinite(Number(o.minRR)) ? Number(o.minRR) : null),
    riskPercent: o.riskPercent == null || o.riskPercent === ''
      ? null
      : (Number.isFinite(Number(o.riskPercent)) ? Number(o.riskPercent) : null),
    stopLoss: { model: slModel, value: slValue },
    takeProfit: { model: tpModel, value: tpValue },
    exitModel: normalizeStrategyExitModel(o.exitModel),
    maxHoldCandles: o.maxHoldCandles == null || o.maxHoldCandles === ''
      ? null
      : (Number.isInteger(Number(o.maxHoldCandles)) ? Number(o.maxHoldCandles) : null),
    ruleRefs: Array.isArray(o.ruleRefs) ? [...o.ruleRefs] : [],
    createdAt: o.createdAt || now,
    updatedAt: now,
    versionCreatedAt: o.versionCreatedAt || o.createdAt || now,
  };
}

// ---- Simulated trades (Phase 9A replay output; pure, no storage side effects) ---
// Simulated trades are reproducible from (runId + entryIndex) and are never
// synced to the cloud. Ids are caller-supplied deterministic seeds — never
// generateId() — so a replay re-run yields identical records.

export const DEFAULT_SIMULATED_TRADE = {
  id: '',
  userId: '',
  runId: '',
  strategyId: '',
  strategyVersion: 1,
  pair: '',
  direction: 'LONG',
  entryIndex: 0,
  entryTime: '',
  entryPrice: 0,
  exitTime: '',
  exitPrice: 0,
  exitReason: '',
  pnl: 0,
  rMultiple: 0,
  status: 'SIMULATED',
  createdAt: '',
};

/** Build a simulated trade with a deterministic id from the caller's seed */
export function makeSimulatedTrade(overrides = {}, seed = '') {
  const now = new Date().toISOString();
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const s = String(seed ?? '').trim();
  // Deterministic id only: replay reproducibility forbids generateId() here.
  // Precedence: explicit id > explicit seed > runId+entryIndex > runId > ''.
  let id = String(o.id ?? '');
  if (!id && s) id = `sim_${s}`;
  if (!id && o.runId != null && String(o.runId) !== '') {
    id = o.entryIndex != null && String(o.entryIndex) !== ''
      ? `sim_${String(o.runId)}_${String(o.entryIndex)}`
      : `sim_${String(o.runId)}`;
  }
  const exitReason = String(o.exitReason ?? '').trim().toUpperCase();
  return {
    ...DEFAULT_SIMULATED_TRADE,
    ...o,
    id,
    userId: String(o.userId ?? '').trim().toLowerCase(),
    runId: String(o.runId ?? ''),
    strategyId: o.strategyId ?? '',
    strategyVersion: Number.isInteger(Number(o.strategyVersion)) && Number(o.strategyVersion) >= 1
      ? Number(o.strategyVersion)
      : 1,
    pair: o.pair ?? '',
    direction: normalizeSetupDirection(o.direction),
    entryIndex: Number.isInteger(Number(o.entryIndex)) ? Number(o.entryIndex) : 0,
    entryTime: o.entryTime ?? '',
    entryPrice: Number.isFinite(Number(o.entryPrice)) ? Number(o.entryPrice) : 0,
    exitTime: o.exitTime ?? '',
    exitPrice: Number.isFinite(Number(o.exitPrice)) ? Number(o.exitPrice) : 0,
    exitReason: REPLAY_EXIT_REASONS.includes(exitReason) ? exitReason : '',
    pnl: Number.isFinite(Number(o.pnl)) ? Number(o.pnl) : 0,
    rMultiple: Number.isFinite(Number(o.rMultiple)) ? Number(o.rMultiple) : 0,
    status: SIMULATED_TRADE_STATUS,
    createdAt: o.createdAt || now,
  };
}
