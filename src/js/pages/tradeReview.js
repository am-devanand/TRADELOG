// ============================================
// Trade review — /trade/:id/review (vanilla ESM)
// CLOSED executed trades only. Header P/L is read-only
// (from the trade, never editable). Questionnaire renders
// from REVIEW_QUESTIONS; findings prefill suggestions but
// every answer stays trader-editable. Process score is
// answers-only (never P/L) and recalculates on each input.
// One review per trade: SAVE creates or updates. Reviews
// never mutate trade status or pnl.
// ============================================
import '../../css/tradeReview.css';
import '../../css/screenshots.css';
import { getCurrentUser, getFolder, getJournalEntries, saveJournalEntry } from '../utils/storage.js';
import { getExecutedTrade } from '../utils/executedTrades.js';
import { saveScreenshot, deleteScreenshot } from '../utils/screenshotStore.js';
import { listMeta, addMeta, removeMeta } from '../utils/screenshotMeta.js';
import { renderScreenshotGallery, revokeAllGalleries } from '../components/screenshotViewer.js';
import {
  getReviewByTradeId,
  calculateReview,
  createReview,
  updateReview,
  REVIEW_QUESTIONS,
  MISTAKE_TYPES,
  STRENGTH_TYPES,
} from '../utils/tradeReviews.js';
import { calculateProcessScore } from '../utils/processScore.js';
import {
  navigate,
  showToast,
  escapeHtml,
  formatCurrency,
  formatDate,
  generateId,
} from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';

const EMOTIONS = ['calm', 'focused', 'anxious', 'frustrated', 'confident', 'neutral'];

// Screenshot ids saved before the review exists; merged on SAVE.
const pendingByTrade = {};

function fmt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function findingChip(label, bad) {
  return `<span class="badge ${bad ? 'finding-bad' : 'finding-ok'}">${escapeHtml(label)}</span>`;
}

function questionHtml(section, q, current) {
  const opts = Array.isArray(q.options) ? q.options : [];
  return `
    <fieldset class="review-q" data-section="${escapeHtml(section)}" data-q="${escapeHtml(String(q.id))}">
      <legend class="review-q-title">${escapeHtml(String(q.question || q.id))}</legend>
      <div class="review-opts">
        ${opts.map((o) => `
          <label class="review-opt">
            <input type="radio" name="rv-${escapeHtml(section)}-${escapeHtml(String(q.id))}" value="${escapeHtml(String(o.value))}"${current === o.value ? ' checked' : ''}>
            ${escapeHtml(String(o.label ?? o.value))}
          </label>`).join('')}
      </div>
    </fieldset>`;
}

function tagGridHtml(name, tags, selected) {
  const set = new Set(Array.isArray(selected) ? selected : []);
  return `
    <div class="tag-grid" data-tags="${escapeHtml(name)}">
      ${tags.map((t) => `
        <label class="tag-check">
          <input type="checkbox" name="rv-tag-${escapeHtml(name)}" value="${escapeHtml(String(t))}"${set.has(t) ? ' checked' : ''}>
          ${escapeHtml(String(t).replace(/_/g, ' '))}
        </label>`).join('')}
    </div>`;
}

function scoreCardHtml(score) {
  const s = score && typeof score === 'object' ? score : {};
  const bars = [
    ['Pre-Trade', s.preTradeScore],
    ['Execution', s.executionScore],
    ['Management', s.managementScore],
    ['Discipline', s.disciplineScore],
  ];
  return `
    <div class="card" aria-label="Process quality score">
      <div class="trade-section-title"><h2>Process quality</h2><p>From your answers only — never from profit</p></div>
      ${bars.map(([label, v]) => {
        const n = Number(v);
        const safe = Number.isFinite(n) ? n : 0;
        const pct = Math.min(100, Math.max(0, (safe / 25) * 100));
        return `
          <div style="margin-bottom:10px;">
            <div class="score-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(safe))} / 25</strong></div>
            <div class="score-bar" role="img" aria-label="${escapeHtml(label)} ${escapeHtml(String(safe))} of 25"><div style="width:${pct}%;"></div></div>
          </div>`;
      }).join('')}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;">
        <div><div class="risk-label">Total</div><div class="score-total" id="rv-total">${escapeHtml(String(Number.isFinite(Number(s.total)) ? s.total : 0))} / 100</div></div>
        <div class="score-grade" id="rv-grade">${escapeHtml(String(s.grade || 'F'))}</div>
      </div>
    </div>`;
}

export function renderTradeReview(params = {}) {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const id = params.id;
  const trade = getExecutedTrade(user, id);
  const app = document.getElementById('app');

  if (!trade) {
    app.innerHTML = `
      ${renderNavbar()}
      <div class="page">
        <button class="btn btn-ghost btn-sm" id="rv-back">← Back to Trade</button>
        <div class="empty-state"><h3>Trade not found</h3><p>No executed trade with id ${escapeHtml(String(id ?? ''))}</p></div>
      </div>`;
    bindNavbar();
    document.getElementById('rv-back')?.addEventListener('click', () => navigate('/trade'));
    return;
  }

  const status = String(trade.status || '').toUpperCase();
  if (status !== 'CLOSED') {
    app.innerHTML = `
      ${renderNavbar()}
      <div class="page">
        <button class="btn btn-ghost btn-sm" id="rv-back" style="margin-bottom:8px;">← Back to Trade</button>
        <div class="page-header"><div>
          <h1 class="page-title">${escapeHtml(String(trade.pair || '—'))} <span style="font-size:var(--font-size-sm);color:var(--text-secondary);">${escapeHtml(String(trade.direction || ''))}</span></h1>
          <p class="page-subtitle">Review is available after the trade closes</p>
        </div></div>
        <div class="empty-state"><h3>⏳ Trade not ready for review</h3><p>This trade is ${escapeHtml(status || 'OPEN')}. Close it first — reviews cover completed trades only.</p>
        <button class="btn btn-secondary" id="rv-view">VIEW TRADE</button></div>
      </div>`;
    bindNavbar();
    document.getElementById('rv-back')?.addEventListener('click', () => navigate('/trade'));
    document.getElementById('rv-view')?.addEventListener('click', () => navigate(`/trade/${trade.id}`));
    return;
  }

  paint(user, trade);
}

function suggestedAnswers(findings) {
  const f = findings && typeof findings === 'object' ? findings : {};
  const preTrade = {};
  const execution = {};
  const management = {};
  if (f.riskViolation) preTrade.pt_risk = 'oversized';
  if (f.sessionViolation) preTrade.pt_context = 'partial';
  if (f.slMoved || f.tpMoved) management.mg_levels = 'moved';
  if (f.exitDeviation === 'EARLY_EXIT') management.mg_exit = 'early_exit';
  else if (f.exitDeviation) management.mg_exit = 'slightly_off';
  else management.mg_exit = 'per_plan';
  return { preTrade, execution, management };
}

function collectDraft(app) {
  const answers = { preTrade: {}, execution: {}, management: {} };
  app.querySelectorAll('fieldset.review-q').forEach((fs) => {
    const section = fs.dataset.section;
    const qid = fs.dataset.q;
    if (!answers[section]) return;
    const checked = fs.querySelector('input[type="radio"]:checked');
    if (checked) answers[section][qid] = checked.value;
  });
  const checkedTags = (name) =>
    [...app.querySelectorAll(`[data-tags="${name}"] input[type="checkbox"]:checked`)].map((el) => el.value);
  const val = (id) => document.getElementById(id)?.value ?? '';
  return {
    answers,
    mistakes: checkedTags('mistakes'),
    strengths: checkedTags('strengths'),
    emotionBefore: val('rv-emotion-before'),
    emotionDuring: val('rv-emotion-during'),
    emotionAfter: val('rv-emotion-after'),
    confidenceBefore: val('rv-conf-before'),
    confidenceAfter: val('rv-conf-after'),
    whatWentWell: val('rv-well'),
    whatWentWrong: val('rv-wrong'),
    lesson: val('rv-lesson'),
    improvementAction: val('rv-action'),
    followedPlan: val('rv-followed') || 'NO',
    wouldTakeAgain: val('rv-again') || 'NO',
  };
}

function liveScoreFor(draft) {
  try {
    const confs = [Number(draft.confidenceBefore), Number(draft.confidenceAfter)]
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
    return calculateProcessScore({
      answers: draft.answers,
      followedPlan: draft.followedPlan,
      ruleViolations: [],
      confidence: confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : 3,
    });
  } catch {
    return { preTradeScore: 0, executionScore: 0, managementScore: 0, disciplineScore: 0, total: 0, grade: 'F' };
  }
}

function paint(user, trade) {
  const t = getExecutedTrade(user, trade.id) || trade;
  revokeAllGalleries();
  const app = document.getElementById('app');
  const folder = t.accountId ? getFolder(user, t.accountId) : null;
  const cur = folder?.currency || 'USD';

  const calc = calculateReview(t.id, user);
  const findings = calc && calc.success ? calc.automaticFindings || {} : {};
  const events = calc && calc.success && Array.isArray(calc.events) ? [...calc.events].reverse() : [];
  const checklist = calc && calc.success && Array.isArray(calc.snapshots?.checklist) ? calc.snapshots.checklist : [];
  const setupSnap = calc && calc.success ? calc.snapshots?.setup : null;

  const existing = getReviewByTradeId(user, t.id);
  const base = suggestedAnswers(findings);
  const ans = existing?.answers && typeof existing.answers === 'object' ? existing.answers : base;
  const cur2 = (section, qid) => (ans?.[section] && typeof ans[section] === 'object' ? ans[section][qid] : undefined) ?? base?.[section]?.[qid];
  const emo = (key) => (existing && existing[key]) || '';
  const txt = (key) => (existing && typeof existing[key] === 'string' ? existing[key] : '');
  const sel = (key, fallback) => (existing && existing[key] ? String(existing[key]) : fallback);
  const confVal = (key) => (existing && existing[key] !== undefined && existing[key] !== '' ? String(existing[key]) : '');

  const initialScore = liveScoreFor({
    answers: {
      preTrade: { ...(base.preTrade || {}), ...((ans && ans.preTrade) || {}) },
      execution: { ...(base.execution || {}), ...((ans && ans.execution) || {}) },
      management: { ...(base.management || {}), ...((ans && ans.management) || {}) },
    },
    followedPlan: sel('followedPlan', 'NO'),
    confidenceBefore: confVal('confidenceBefore'),
    confidenceAfter: confVal('confidenceAfter'),
    mistakes: [], strengths: [],
  });

  const emotionOpts = (id, current) => `
    <select id="${id}">
      <option value="">— Select —</option>
      ${EMOTIONS.map((e) => `<option value="${escapeHtml(e)}"${current === e ? ' selected' : ''}>${escapeHtml(e)}</option>`).join('')}
    </select>`;

  const confOpts = (id, current) => `
    <select id="${id}">
      <option value="">—</option>
      ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${String(current) === String(n) ? ' selected' : ''}>${n}</option>`).join('')}
    </select>`;

  const shots = Array.isArray(existing?.screenshotIds) ? existing.screenshotIds : [];
  const pendingCount = (pendingByTrade[t.id] || []).length;
  const shotCount = shots.length + pendingCount;

  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <button class="btn btn-ghost btn-sm" id="rv-back" style="margin-bottom:8px;">← Back to Trade Detail</button>
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(String(t.pair || '—'))} <span style="font-size:var(--font-size-sm);color:var(--text-secondary);">${escapeHtml(String(t.direction || ''))}</span></h1>
          <p class="page-subtitle">Trade review · ${escapeHtml(String(t.id))}${existing ? ' · <span class="badge badge-tp">✓ REVIEWED</span>' : ''}</p>
        </div>
        <div><span class="badge badge-sl">■ CLOSED</span></div>
      </div>

      <div class="card" style="margin-bottom:var(--space-lg);border-width:2px;" aria-label="Authoritative result">
        <div class="stat-label">Realized P/L (from trade — read-only, never editable here)</div>
        <div class="stat-value ${fmt(t.realizedPL) >= 0 ? 'positive' : 'negative'}" style="font-size:2rem;">${fmt(t.realizedPL) >= 0 ? '+' : '−'}${escapeHtml(formatCurrency(Math.abs(fmt(t.realizedPL)), cur).replace('-', ''))} <span style="font-size:var(--font-size-md);">(${escapeHtml(String(fmt(t.realizedR)))}R)</span></div>
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-top:6px;">Entry ${escapeHtml(String(t.entry))} → Exit ${escapeHtml(String(t.exitPrice ?? '—'))} · ${escapeHtml(String(t.closeReason || '—'))}${shotCount > 0 ? ` · ${escapeHtml(String(shotCount))} screenshot${shotCount === 1 ? '' : 's'}` : ''}</div>
      </div>

      <div class="card" aria-label="Screenshots" style="margin-bottom:var(--space-lg);">
        <div class="trade-section-title"><h2>📎 SCREENSHOTS</h2><p>Stored on this device only — works offline</p></div>
        <div class="shot-add-row">
          <button class="btn btn-secondary btn-sm" id="rv-shot-add">+ ADD SCREENSHOT</button>
          <input type="file" id="rv-shot-file" accept="image/*" multiple hidden>
        </div>
        <div id="rv-shots"></div>
        <div class="shot-err" id="rv-shot-err" role="alert" hidden></div>
        ${existing ? '' : '<p style="font-size:var(--font-size-xs);color:var(--text-muted);margin-top:8px;">No review saved yet — shots added now attach automatically when you save.</p>'}
      </div>

      <div class="review-layout">
        <div class="review-main" id="rv-form">
          <details class="card review-section" open>
            <summary><div><h2>Automatic findings</h2><p>Objective, from trade snapshots + events — suggestions only</p></div></summary>
            <div class="review-section-body">
              <div class="finding-chips">
                ${findingChip(`Risk: ${findings.riskViolation ? 'VIOLATION' : 'OK'}`, !!findings.riskViolation)}
                ${findingChip(`RR: ${findings.rrViolation ? 'VIOLATION' : 'OK'}`, !!findings.rrViolation)}
                ${findingChip(`Session: ${findings.sessionViolation ? 'VIOLATION' : 'OK'}`, !!findings.sessionViolation)}
                ${findingChip(`SL moved: ${findings.slMoved ? 'YES' : 'NO'}`, false)}
                ${findingChip(`TP moved: ${findings.tpMoved ? 'YES' : 'NO'}`, false)}
                ${findingChip(`Exit: ${findings.exitDeviation || 'PER PLAN'}`, !!findings.exitDeviation)}
                ${findingChip(`Outcome: ${escapeHtml(String(calc?.outcome || ''))}`, false)}
              </div>
            </div>
          </details>

          <details class="card review-section" open>
            <summary><div><h2>Rules at the time</h2><p>Frozen checklist snapshot from execution — read-only</p></div></summary>
            <div class="review-section-body">
              ${setupSnap ? `<div style="font-size:var(--font-size-sm);color:var(--text-secondary);">Setup score ${escapeHtml(String(setupSnap.score ?? setupSnap.checklistScore ?? '—'))} · ${escapeHtml(String(setupSnap.decision ?? setupSnap.status ?? ''))}</div>` : ''}
              ${checklist.length ? checklist.map((c) => {
                if (c && typeof c === 'object') return `<div class="review-q"><div class="review-q-title">${escapeHtml(String(c.name || c.id || 'Rule'))}</div><div style="font-size:var(--font-size-xs);color:var(--text-secondary);">${escapeHtml(String(c.category || ''))}${c.enabled === false ? ' · disabled' : ''}</div></div>`;
                return `<div class="review-q"><div class="review-q-title">${escapeHtml(String(c))}</div></div>`;
              }).join('') : '<p style="color:var(--text-muted);font-size:var(--font-size-sm);">No rules snapshot recorded at execution.</p>'}
            </div>
          </details>

          <details class="card review-section" open>
            <summary><div><h2>Pre-trade</h2><p>Planning quality — 4 questions</p></div></summary>
            <div class="review-section-body">
              ${(REVIEW_QUESTIONS.preTrade || []).map((q) => questionHtml('preTrade', q, cur2('preTrade', q.id))).join('')}
            </div>
          </details>

          <details class="card review-section" open>
            <summary><div><h2>Execution</h2><p>Entry quality and plan adherence</p></div></summary>
            <div class="review-section-body">
              ${(REVIEW_QUESTIONS.execution || []).map((q) => questionHtml('execution', q, cur2('execution', q.id))).join('')}
            </div>
          </details>

          <details class="card review-section" open>
            <summary><div><h2>Management</h2><p>SL/TP moves + exit — prefilled from findings, editable</p></div></summary>
            <div class="review-section-body">
              ${(REVIEW_QUESTIONS.management || []).map((q) => questionHtml('management', q, cur2('management', q.id))).join('')}
              <div>
                <div class="review-q-title" style="margin-bottom:6px;">Event history (excerpt)</div>
                <div class="review-events">
                  ${events.length ? events.slice(0, 6).map((e) => `<div class="review-event"><time>${escapeHtml(String((e.at || '').slice(0, 16).replace('T', ' ')))} · ${escapeHtml(String(e.type || ''))}</time>${escapeHtml(String(e.message || ''))}</div>`).join('') : '<p style="color:var(--text-muted);font-size:var(--font-size-sm);">No events recorded.</p>'}
                </div>
              </div>
            </div>
          </details>

          <details class="card review-section" open>
            <summary><div><h2>Discipline</h2><p>Your tags only — never auto-filled</p></div></summary>
            <div class="review-section-body">
              <div><div class="review-q-title" style="margin-bottom:6px;">Mistakes</div>${tagGridHtml('mistakes', MISTAKE_TYPES, existing?.mistakes)}</div>
              <div><div class="review-q-title" style="margin-bottom:6px;">Strengths</div>${tagGridHtml('strengths', STRENGTH_TYPES, existing?.strengths)}</div>
            </div>
          </details>

          <details class="card review-section" open>
            <summary><div><h2>Psychology</h2><p>Lightweight emotional context — unscored</p></div></summary>
            <div class="review-section-body">
              <div class="form-row" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">
                <div class="form-group"><label class="form-label" for="rv-emotion-before">Before</label>${emotionOpts('rv-emotion-before', emo('emotionBefore'))}</div>
                <div class="form-group"><label class="form-label" for="rv-emotion-during">During</label>${emotionOpts('rv-emotion-during', emo('emotionDuring'))}</div>
                <div class="form-group"><label class="form-label" for="rv-emotion-after">After</label>${emotionOpts('rv-emotion-after', emo('emotionAfter'))}</div>
              </div>
              <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                <div class="form-group"><label class="form-label" for="rv-conf-before">Confidence before (1-5)</label>${confOpts('rv-conf-before', confVal('confidenceBefore'))}</div>
                <div class="form-group"><label class="form-label" for="rv-conf-after">Confidence after (1-5)</label>${confOpts('rv-conf-after', confVal('confidenceAfter'))}</div>
              </div>
            </div>
          </details>

          <details class="card review-section" open>
            <summary><div><h2>Lesson</h2><p>What you take into the next trade</p></div></summary>
            <div class="review-section-body">
              <div class="form-group"><label class="form-label" for="rv-well">What went well</label><textarea id="rv-well" rows="2">${escapeHtml(txt('whatWentWell'))}</textarea></div>
              <div class="form-group"><label class="form-label" for="rv-wrong">What went wrong</label><textarea id="rv-wrong" rows="2">${escapeHtml(txt('whatWentWrong'))}</textarea></div>
              <div class="form-group"><label class="form-label" for="rv-lesson">Lesson</label><textarea id="rv-lesson" rows="2">${escapeHtml(txt('lesson'))}</textarea></div>
              <div class="form-group"><label class="form-label" for="rv-action">Improvement action</label><textarea id="rv-action" rows="2">${escapeHtml(txt('improvementAction'))}</textarea></div>
              <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                <div class="form-group"><label class="form-label" for="rv-followed">Followed plan</label>
                  <select id="rv-followed">${['YES', 'PARTIALLY', 'NO'].map((v) => `<option value="${v}"${sel('followedPlan', 'NO') === v ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
                <div class="form-group"><label class="form-label" for="rv-again">Would take again</label>
                  <select id="rv-again">${['YES', 'NO'].map((v) => `<option value="${v}"${sel('wouldTakeAgain', 'NO') === v ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
              </div>
            </div>
          </details>
        </div>

        <div class="review-side">
          <div class="review-order-score" id="rv-score">${scoreCardHtml(initialScore)}</div>
        </div>
      </div>

      <div class="review-savebar card" style="margin-top:var(--space-lg);">
        <button class="btn btn-primary" id="rv-save">${existing ? 'UPDATE REVIEW' : 'SAVE REVIEW'}</button>
        <span id="rv-journal-slot" style="display:contents;"></span>
      </div>
      <div style="height:8px;"></div>
    </div>
  `;

  bindNavbar();
  document.getElementById('rv-back')?.addEventListener('click', () => navigate(`/trade/${t.id}`));

  const refreshScore = () => {
    const draft = collectDraft(app);
    const score = liveScoreFor(draft);
    const slot = document.getElementById('rv-score');
    if (slot) slot.innerHTML = scoreCardHtml(score);
  };
  app.querySelector('#rv-form')?.addEventListener('input', refreshScore);
  app.querySelector('#rv-form')?.addEventListener('change', refreshScore);

  const paintJournalSlot = (reviewId) => {
    const slot = document.getElementById('rv-journal-slot');
    if (!slot || !reviewId) return;
    let linked = null;
    try {
      if (t.accountId) {
        linked = getJournalEntries(t.accountId).find((e) => e && String(e.reviewId || '') === String(reviewId));
      }
    } catch { linked = null; }
    if (linked) {
      slot.innerHTML = `<button class="btn btn-secondary" disabled>✓ IN JOURNAL (${escapeHtml(formatDate(linked.date))})</button>`;
      return;
    }
    slot.innerHTML = `<button class="btn btn-secondary" id="rv-add-journal">ADD TO JOURNAL</button>`;
    document.getElementById('rv-add-journal')?.addEventListener('click', () => {
      if (!t.accountId) return showToast('Trade has no account — cannot file a journal entry', 'error');
      const d = collectDraft(app);
      const score = liveScoreFor(d);
      const text = `Trade review — ${t.pair || ''} ${t.direction || ''}: process ${score.total}/100 (${score.grade}). Lesson: ${(d.lesson || '').trim() || '—'} [trade:${t.id}] [review:${reviewId}]`;
      try {
        saveJournalEntry(t.accountId, {
          id: generateId(),
          date: new Date().toISOString().split('T')[0],
          text,
          tradeId: t.id,
          reviewId,
          createdAt: new Date().toISOString(),
        });
        showToast('Added to journal');
        paintJournalSlot(reviewId);
      } catch (e) {
        showToast(e?.message || 'Journal save failed', 'error');
      }
    });
  };
  if (existing) paintJournalSlot(existing.id);

  document.getElementById('rv-save')?.addEventListener('click', () => {
    const d = collectDraft(app);
    const confs = [Number(d.confidenceBefore), Number(d.confidenceAfter)]
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
    const payload = {
      user,
      status: 'COMPLETED',
      answers: d.answers,
      ruleViolations: [],
      mistakes: d.mistakes,
      strengths: d.strengths,
      emotions: [d.emotionBefore, d.emotionDuring, d.emotionAfter].filter(Boolean),
      emotionBefore: d.emotionBefore,
      emotionDuring: d.emotionDuring,
      emotionAfter: d.emotionAfter,
      confidenceBefore: d.confidenceBefore,
      confidenceAfter: d.confidenceAfter,
      confidence: confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : 3,
      followedPlan: d.followedPlan,
      wouldTakeAgain: d.wouldTakeAgain,
      whatWentWell: d.whatWentWell.trim(),
      whatWentWrong: d.whatWentWrong.trim(),
      lesson: d.lesson.trim(),
      improvementAction: d.improvementAction.trim(),
    };
    const current = getReviewByTradeId(user, t.id);
    const pending = pendingByTrade[t.id] || [];
    payload.screenshotIds = current
      ? [...new Set([...(current.screenshotIds || []).map(String), ...pending.map(String)])]
      : [...new Set(pending.map(String))];
    const res = current
      ? updateReview(user, current.id, payload)
      : createReview(t.id, payload);
    if (!res || !res.success) {
      showToast(res?.error || 'Review save failed', 'error');
      return;
    }
    pendingByTrade[t.id] = [];
    showToast(current ? 'Review updated' : 'Review saved');
    paint(user, t);
    paintJournalSlot(res.review?.id);
  });

  bindReviewShotButtons(user, t, existing);
  paintReviewShots(user, t, existing);
}

function bindReviewShotButtons(user, trade, existing) {
  const input = document.getElementById('rv-shot-file');
  document.getElementById('rv-shot-add')?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', () => {
    handleReviewShotFiles(user, trade, input.files, existing);
  });
}

async function handleReviewShotFiles(user, trade, files, existing) {
  const list = [...(files || [])];
  if (list.length === 0) return;
  const review = existing || getReviewByTradeId(user, trade.id);
  const base = review && Array.isArray(review.screenshotIds) ? [...review.screenshotIds.map(String)] : [];
  let added = 0;
  for (const file of list) {
    const saved = await saveScreenshot(file, {
      tradeId: trade.id,
      reviewId: review?.id || '',
      type: 'OTHER',
    });
    if (!saved.success) {
      showToast(saved.error || 'Could not save screenshot', 'error');
      continue;
    }
    const mirrored = addMeta(user, saved.meta);
    if (!mirrored.success) {
      await deleteScreenshot(saved.id);
      showToast(mirrored.error || 'Could not record screenshot', 'error');
      continue;
    }
    if (review) base.push(saved.id);
    else {
      if (!pendingByTrade[trade.id]) pendingByTrade[trade.id] = [];
      pendingByTrade[trade.id].push(saved.id);
    }
    added += 1;
  }
  if (added > 0 && review) {
    const up = updateReview(user, review.id, { screenshotIds: [...new Set(base)] });
    if (!up.success) showToast(up.error || 'Could not link screenshots to review', 'error');
    else showToast(`${added} screenshot${added > 1 ? 's' : ''} saved on this device`);
  } else if (added > 0) {
    showToast(`${added} screenshot${added > 1 ? 's' : ''} staged — save the review to attach`);
  }
  const input = document.getElementById('rv-shot-file');
  if (input) input.value = '';
  paint(user, trade);
}

async function paintReviewShots(user, trade, existing) {
  const box = document.getElementById('rv-shots');
  if (!box) return;
  const review = getReviewByTradeId(user, trade.id) || existing;
  const stored = review && Array.isArray(review.screenshotIds) ? review.screenshotIds.map(String) : [];
  const pending = pendingByTrade[trade.id] || [];
  const ids = [...new Set([...stored, ...pending.map(String)])];
  const meta = ids.length > 0 ? listMeta(user, { ids }) : [];
  const err = document.getElementById('rv-shot-err');
  if (err) {
    const missing = ids.length - meta.length;
    if (missing > 0) {
      err.hidden = false;
      err.textContent = `${missing} screenshot${missing > 1 ? 's' : ''} referenced but not on this device (blobs never sync).`;
    } else {
      err.hidden = true;
      err.textContent = '';
    }
  }
  await renderScreenshotGallery(box, meta, {
    onDelete: async (id) => {
      const del = await deleteScreenshot(id);
      if (!del.success) {
        showToast(del.error || 'Could not delete screenshot', 'error');
        return;
      }
      removeMeta(user, id);
      const pend = pendingByTrade[trade.id] || [];
      if (pend.map(String).includes(String(id))) {
        pendingByTrade[trade.id] = pend.filter((x) => String(x) !== String(id));
        showToast('Screenshot deleted');
        paint(user, trade);
        return;
      }
      const cur = getReviewByTradeId(user, trade.id);
      if (cur) {
        const remaining = (cur.screenshotIds || []).map(String).filter((x) => x !== String(id));
        const up = updateReview(user, cur.id, { screenshotIds: remaining });
        if (!up.success) showToast(up.error || 'Could not update review', 'error');
        else showToast('Screenshot deleted');
      }
      paint(user, trade);
    },
    onPreviewError: (error) => showToast(error || 'Could not preview screenshot', 'error'),
  });
}

export default { renderTradeReview };
