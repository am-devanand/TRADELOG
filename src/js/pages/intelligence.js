// ============================================
// Trading Intelligence (Phase 10D)
// Vanilla ESM. Reads the consolidated canonical insights only — it
// computes no metrics and re-decides no verdicts.
//
// Answers one question: what deserves my attention?
// Every card states what happened, why it was surfaced, how strong the
// sample is, the evidence, ranking status, what to investigate, and the
// authoritative provenance. Wording stays observational throughout.
// ============================================
import '../../css/analytics.css';
import '../../css/pagesAnalytics.css';
import '../../css/pagesIntelligence.css';
import { getCurrentUser } from '../utils/storage.js';
import { buildConsolidatedInsightGroups } from '../utils/intelligenceService.js';
import {
  INSIGHT_CATEGORIES,
  INSIGHT_SOURCES,
  INSIGHT_STATES,
} from '../utils/intelligenceConsolidation.js';
import { escapeHtml } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';

const PAGE_TITLE = 'Trading Intelligence';
const PAGE_INTRO =
  'Evidence-based observations from your trading history. ' +
  'Intelligence highlights patterns worth reviewing; it does not make trading decisions.';

const INSUFFICIENT_NOTE =
  'Not enough evidence to draw a reliable conclusion yet. ' +
  'Absence of a strong finding here does not mean this category is performing well.';

/** Section order is the presentation order; data order is set by INSIGHT_STATES. */
const SECTIONS = [
  { state: 'NEEDS_ATTENTION', title: 'Needs Attention' },
  { state: 'IMPROVING', title: 'Improving' },
  { state: 'WATCH', title: 'Watch' },
  { state: 'STABLE', title: 'Stable' },
  { state: 'INSUFFICIENT_DATA', title: 'Insufficient Evidence', note: INSUFFICIENT_NOTE },
];

const STATE_BADGE = {
  NEEDS_ATTENTION: 'badge-sl',
  IMPROVING: 'badge-tp',
  WATCH: 'badge-gold',
  STABLE: 'badge-gold',
  INSUFFICIENT_DATA: 'badge-gold',
};

const SOURCE_LABEL = {
  degradationEngine: 'Degradation Engine',
  attributionIntelligence: 'Attribution Intelligence',
  improvementEngine: 'Improvement Engine',
};

const BANDS = ['STRONG', 'ADEQUATE', 'THIN', 'INSUFFICIENT'];

const EMPTY_SECTION = {
  NEEDS_ATTENTION: 'Nothing flagged from the current evidence.',
  IMPROVING: 'No improving observations in this sample.',
  WATCH: 'No borderline signals in this sample.',
  STABLE: 'No stable findings in this sample.',
  INSUFFICIENT_DATA: 'Everything here currently has enough evidence to speak.',
};

let filters = { source: 'ALL', category: 'ALL', state: 'ALL', band: 'ALL' };

function humanize(value) {
  const s = String(value ?? '').trim();
  if (!s) return 'Unavailable';
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function sampleBlock(sample) {
  const band = humanize(sample?.band ?? null);
  const size = sample?.size ?? null;
  return `${band} · ${size === null ? 'size unavailable' : `${size} record(s)`}`;
}

function evidenceBlock(insight) {
  const items = (insight.evidence || []).map((entry) => {
    const parts = [];
    if (entry.description) parts.push(`<div class="int-ev-text">${escapeHtml(entry.description)}</div>`);
    parts.push(`<div class="int-ref">${
      Array.isArray(entry.refIds) && entry.refIds.length
        ? escapeHtml(`${entry.refIds.length} source record(s) referenced`)
        : 'Aggregate slice — no single record cited'
    }</div>`);
    if (entry.window) parts.push(`<div class="int-ref">Window ${escapeHtml(entry.window)}</div>`);
    return `<li class="int-evidence-item">${parts.join('')}</li>`;
  }).join('');
  return `<ul class="int-evidence">${items}</ul>`;
}

function rankingBlock(ranking) {
  if (!ranking) return '<div class="int-ranking int-ranking-suppressed">Not rankable</div>';
  if (ranking.eligible) {
    return `<div class="int-ranking int-ranking-ok">${escapeHtml(ranking.label || 'Rankable')}</div>`;
  }
  return `<div class="int-ranking int-ranking-suppressed">Not rankable</div>
          <div class="int-ref">Reason: ${escapeHtml(ranking.suppressionReason || 'not recorded')}</div>`;
}

function insightCard(insight) {
  const badge = STATE_BADGE[insight.state] || 'badge-gold';
  const sourceLabel = SOURCE_LABEL[insight.source] || insight.source || 'Unknown source';
  const provenance = (insight.provenance || []).join(', ');
  const stateText = insight.state ? humanize(insight.state) : `Unavailable (source reported ${insight.sourceState ?? 'none'})`;

  return `
    <article class="card int-card" data-int-id="${escapeHtml(insight.id ?? 'unknown')}">
      <header class="int-card-head">
        <h3 class="int-card-title">${escapeHtml(insight.title)}</h3>
        <span class="badge ${badge}">${escapeHtml(stateText)}</span>
      </header>
      <div class="int-meta">
        <span class="badge badge-gold">${escapeHtml(sourceLabel)}</span>
        <span class="badge badge-gold">${escapeHtml(humanize(insight.category))}</span>
      </div>
      <dl class="int-questions">
        <dt>What happened</dt>
        <dd>${escapeHtml(insight.summary ?? 'Not reported')}</dd>
        <dt>Why surfaced</dt>
        <dd>${escapeHtml(insight.whySurfaced)}</dd>
        <dt>How strong is sample</dt>
        <dd>${escapeHtml(sampleBlock(insight.sample))}
            <div class="int-ref">${escapeHtml(insight.sample?.qualificationReason ?? 'No qualification recorded')}</div></dd>
        <dt>Evidence</dt>
        <dd>${evidenceBlock(insight)}</dd>
        <dt>Can it be ranked</dt>
        <dd>${rankingBlock(insight.ranking)}</dd>
        <dt>What to investigate</dt>
        <dd>${escapeHtml(insight.investigationQuestion)}</dd>
        <dt>Source</dt>
        <dd>
          <div>${escapeHtml(sourceLabel)}</div>
          <div class="int-prov">${escapeHtml(provenance || 'Provenance unavailable')}</div>
        </dd>
      </dl>
    </article>`;
}

function matchesFilters(insight) {
  if (filters.source !== 'ALL' && insight.source !== filters.source) return false;
  if (filters.category !== 'ALL' && insight.category !== filters.category) return false;
  if (filters.state !== 'ALL' && insight.state !== filters.state) return false;
  if (filters.band !== 'ALL' && insight.sample?.band !== filters.band) return false;
  return true;
}

function selectHtml(id, label, options, selected) {
  const opts = options
    .map((o) => `<option value="${escapeHtml(o)}"${selected === o ? ' selected' : ''}>${escapeHtml(
      o === 'ALL' ? label : humanize(o),
    )}</option>`)
    .join('');
  return `
    <label class="form-group">
      <span>${escapeHtml(label)}</span>
      <select id="${escapeHtml(id)}">${opts}</select>
    </label>`;
}

function filtersBar() {
  return `
    <section class="card int-filters" aria-label="Insight filters">
      <div class="int-filter-row">
        ${selectHtml('int-filter-source', 'All sources', ['ALL', ...INSIGHT_SOURCES], filters.source)}
        ${selectHtml('int-filter-category', 'All categories', ['ALL', ...INSIGHT_CATEGORIES], filters.category)}
        ${selectHtml('int-filter-state', 'All states', ['ALL', ...INSIGHT_STATES], filters.state)}
        ${selectHtml('int-filter-band', 'All sample strengths', ['ALL', ...BANDS], filters.band)}
      </div>
      <button type="button" class="btn btn-secondary int-clear" id="int-clear-filters">Clear filters</button>
    </section>`;
}

function sectionsHtml(groups) {
  return SECTIONS.map(({ state, title, note }) => {
    const all = groups[state] || [];
    const shown = all.filter(matchesFilters);
    const hidden = all.length - shown.length;
    const body = shown.length
      ? `<div class="int-grid">${shown.map(insightCard).join('')}</div>`
      : `<p class="int-empty">${escapeHtml(EMPTY_SECTION[state] ?? 'No findings in this section.')}</p>`;
    const noteHtml = note ? `<p class="int-note">${escapeHtml(note)}</p>` : '';
    const hiddenHtml = hidden > 0 ? `<p class="int-filtered">${hidden} hidden by the current filters.</p>` : '';
    return `
      <section class="int-section" aria-label="${escapeHtml(title)}" data-state="${escapeHtml(state)}">
        <h2 class="int-section-title">${escapeHtml(title)} <span class="int-count">${shown.length}</span></h2>
        ${noteHtml}
        ${body}
        ${hiddenHtml}
      </section>`;
  }).join('');
}

export function renderIntelligence() {
  const user = getCurrentUser();
  const userId = typeof user === 'string' ? user : user?.id || '';

  let insights = [];
  let groups = {};
  let unmapped = [];
  try {
    const built = buildConsolidatedInsightGroups('', { user: userId, filters: { user: userId } });
    insights = built.insights;
    groups = built.groups;
    unmapped = built.unmapped || [];
  } catch {
    insights = [];
    groups = {};
  }

  const attention = (groups.NEEDS_ATTENTION || []).length;
  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <main class="page" id="int-page">
      <header class="page-header">
        <h1 class="page-title">${escapeHtml(PAGE_TITLE)}</h1>
        <p class="page-subtitle">${escapeHtml(PAGE_INTRO)}</p>
      </header>

      <section class="card int-summary" aria-label="Intelligence summary">
        <p><strong>${insights.length}</strong> finding(s) · <strong>${attention}</strong> need attention${
          unmapped.length ? ` · <strong>${unmapped.length}</strong> with an unmapped state` : ''
        }</p>
      </section>

      ${filtersBar()}

      <div id="int-sections">${sectionsHtml(groups)}</div>

      <p class="int-footnote">Findings come from the existing analytics engines and are never recomputed here. Sample strength and ranking eligibility are shown on every card so a thin result is never mistaken for a firm one.</p>
    </main>`;

  const rerenderSections = () => {
    const host = document.getElementById('int-sections');
    if (host) host.innerHTML = sectionsHtml(groups);
  };

  const bind = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', (e) => {
      filters[key] = e.target.value;
      rerenderSections();
    });
  };
  bind('int-filter-source', 'source');
  bind('int-filter-category', 'category');
  bind('int-filter-state', 'state');
  bind('int-filter-band', 'band');

  const clear = document.getElementById('int-clear-filters');
  if (clear) {
    clear.addEventListener('click', () => {
      filters = { source: 'ALL', category: 'ALL', state: 'ALL', band: 'ALL' };
      for (const [id, key] of [
        ['int-filter-source', 'source'],
        ['int-filter-category', 'category'],
        ['int-filter-state', 'state'],
        ['int-filter-band', 'band'],
      ]) {
        const el = document.getElementById(id);
        if (el) el.value = filters[key];
      }
      rerenderSections();
    });
  }

  bindNavbar();
}

export default renderIntelligence;
