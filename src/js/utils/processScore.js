// ============================================
// Process Score — answers-only review scoring
// Vanilla ESM, offline-first. No side effects on import.
// Scores derive ONLY from review answers (never pnl,
// balance, or R). Grade via GRADE_BANDS from models.js.
// Each of the 4 sections is worth 25 pts (total 100).
// ============================================
import { REVIEW_QUESTIONS, GRADE_BANDS } from './models.js';

const SECTION_MAX = 25;

function round1(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 10) / 10;
}

function maxOptionScore(question) {
  const opts = Array.isArray(question?.options) ? question.options : [];
  let max = 0;
  for (const o of opts) {
    const s = Number(o?.score);
    if (Number.isFinite(s) && s > max) max = s;
  }
  return max > 0 ? max : 5;
}

function optionScore(question, value) {
  const opts = Array.isArray(question?.options) ? question.options : [];
  const hit = opts.find((o) => o && o.value === value);
  const s = Number(hit?.score);
  return Number.isFinite(s) && s >= 0 ? s : 0;
}

/** Score one questionnaire section (0-25) from its answer map. */
function sectionScore(questions, answerMap) {
  const list = Array.isArray(questions) ? questions : [];
  if (list.length === 0) return 0;
  const ans = answerMap && typeof answerMap === 'object' ? answerMap : {};
  let earned = 0;
  let possible = 0;
  for (const q of list) {
    const max = maxOptionScore(q);
    possible += max;
    earned += Math.min(optionScore(q, ans[q?.id]), max);
  }
  if (possible <= 0) return 0;
  return round1((earned / possible) * SECTION_MAX);
}

/**
 * Discipline score (0-25) from review-level answers only:
 * followedPlan is worth 15 (full / partial / none),
 * an empty ruleViolations list is worth 10.
 * Never touches trade pnl, balance, or R multiples.
 */
function disciplineScore(review) {
  const r = review && typeof review === 'object' ? review : {};
  const raw = r.followedPlan;
  const norm = String(raw === true ? 'yes' : (raw ?? '')).trim().toLowerCase();
  let planPts = 0;
  if (norm === 'yes' || norm === 'true' || norm === 'fully' || norm === 'full') planPts = 15;
  else if (norm === 'partial' || norm === 'partially' || norm === 'mostly' || norm === 'sometimes') planPts = 7;

  let violationPts = 0;
  if (Array.isArray(r.ruleViolations)) {
    if (r.ruleViolations.length === 0) violationPts = 10;
    else if (r.ruleViolations.length === 1) violationPts = 5;
  }
  return round1(Math.min(SECTION_MAX, Math.max(0, planPts + violationPts)));
}

/** Map a 0-100 total to a grade via GRADE_BANDS (first band with total >= min). */
export function gradeForTotal(total) {
  const t = Number(total);
  const safe = Number.isFinite(t) ? t : 0;
  const bands = Array.isArray(GRADE_BANDS) ? [...GRADE_BANDS].sort((a, b) => b.min - a.min) : [];
  for (const b of bands) {
    if (safe >= Number(b?.min)) return b.grade;
  }
  return 'F';
}

/** Alias kept for UI consumers: grade for a numeric process score. */
export function gradeForScore(score) {
  return gradeForTotal(score);
}

const GRADE_BAND_LABELS = {
  A: 'Excellent',
  B: 'Good',
  C: 'Average',
  D: 'Weak',
  F: 'Poor',
};

/** Human band label for a grade letter (tolerates a numeric score). */
export function gradeBand(grade) {
  let g = String(grade ?? '').trim().toUpperCase();
  if (g !== '' && !Number.isNaN(Number(g)) && !['A', 'B', 'C', 'D', 'F'].includes(g)) {
    g = gradeForScore(Number(g));
  }
  return GRADE_BAND_LABELS[g] ?? '';
}

function coerceGradeLetter(value) {
  if (value && typeof value === 'object') return coerceGradeLetter(resolveGrade(value));
  if (value == null || String(value).trim() === '') return '';
  const g = String(value).trim().toUpperCase();
  if (['A', 'B', 'C', 'D', 'F'].includes(g)) return g;
  const n = Number(value);
  if (Number.isFinite(n)) return gradeForScore(n);
  return '';
}

/**
 * Resolve the grade letter for a review record, a numeric total, or a letter.
 * Reads processScore.grade, then any flat total, then a raw letter.
 * Returns '' when nothing score-like is present.
 */
export function resolveGrade(review) {
  if (review == null) return '';
  if (typeof review === 'string' || typeof review === 'number') return coerceGradeLetter(review);
  if (typeof review !== 'object') return '';
  const nested = review.processScore && typeof review.processScore === 'object' ? review.processScore : {};
  const totals = [review.total, nested.total];
  for (const t of totals) {
    const n = Number(t);
    if (Number.isFinite(n)) return gradeForScore(n);
  }
  return coerceGradeLetter(nested.grade) || coerceGradeLetter(review.grade) || '';
}

/** Good process = A/B. Accepts a letter, score, or review. */
export function isGoodProcess(grade) {
  const g = coerceGradeLetter(grade);
  return g === 'A' || g === 'B';
}

/** Poor process = D/F. Accepts a letter, score, or review. C is neither. */
export function isPoorProcess(grade) {
  const g = coerceGradeLetter(grade);
  return g === 'D' || g === 'F';
}

const SUBSCORE_LABELS = [
  ['preTradeScore', 'Pre-Trade'],
  ['executionScore', 'Execution'],
  ['managementScore', 'Management'],
  ['disciplineScore', 'Discipline'],
];

/**
 * Display-ready [{label, value}] subscores for a review.
 * Reads processScore (tolerates flat fields); missing values become null.
 */
export function normalizeSubscores(review) {
  const r = review && typeof review === 'object' ? review : {};
  const nested = r.processScore && typeof r.processScore === 'object' ? r.processScore : {};
  return SUBSCORE_LABELS.map(([key, label]) => {
    const candidates = [nested[key], r[key]];
    let value = null;
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) {
        value = n;
        break;
      }
    }
    return { label, value };
  });
}

/**
 * Score a review from its answers only.
 * @param {object} review — must carry answers {preTrade, execution, management},
 *   followedPlan, and ruleViolations. Trade fields are ignored.
 * @returns {{preTradeScore, executionScore, managementScore, disciplineScore, total, grade}}
 */
export function calculateProcessScore(review) {
  const r = review && typeof review === 'object' ? review : {};
  const answers = r.answers && typeof r.answers === 'object' ? r.answers : {};
  const preTradeScore = sectionScore(REVIEW_QUESTIONS.preTrade, answers.preTrade);
  const executionScore = sectionScore(REVIEW_QUESTIONS.execution, answers.execution);
  const managementScore = sectionScore(REVIEW_QUESTIONS.management, answers.management);
  const disc = disciplineScore(r);
  const total = round1(
    Math.min(100, Math.max(0, preTradeScore + executionScore + managementScore + disc)),
  );
  return {
    preTradeScore,
    executionScore,
    managementScore,
    disciplineScore: disc,
    total,
    grade: gradeForTotal(total),
  };
}

export default {
  calculateProcessScore,
  gradeForTotal,
  gradeForScore,
  gradeBand,
  resolveGrade,
  isGoodProcess,
  isPoorProcess,
  normalizeSubscores,
};
