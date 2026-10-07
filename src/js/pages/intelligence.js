// ============================================
// Intelligence (Phase 10D)
// Vanilla ESM. Reads the consolidated intelligence layer only — it
// computes no metrics and re-decides no verdicts.
//
// Presentation answers one question: what deserves my attention?
// Every card states what happened, why it was surfaced, the evidence,
// how strong the sample is, whether it can be ranked, and what to
// investigate. Wording stays observational throughout.
// ============================================
import '../../css/analytics.css';
import '../../css/pagesAnalytics.css';
import '../../css/pagesIntelligence.css';
import { getCurrentUser } from '../utils/storage.js';
import { buildIntelligenceGroups } from '../utils/intelligenceService.js';
import { INSIGHT_CATEGORIES } from '../utils/intelligenceContracts.js';
import { INTELLIGENCE_STATES } from '../utils/intelligenceLayer.js';
import { renderSampleBadge } from '../components/analytics/sampleBadge.js';
import { escapeHtml } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';

const SECTIONS = [
  { state: 'NEEDS_ATTENTION', title: 'Needs attention', empty: 'Nothing flagged from this evidence.' },
  { state: 'IMPROVING', title: 'Improving', empty: 'No improving patterns in this sample.' },
  { state: 'WATCH', title: 'Watch', empty: 'No borderline shifts in this sample.' },
  { state: 'INSUFFICIENT_EVIDENCE', title: 'Insufficient evidence', empty: 'Everything here has enough evidence to speak.' },
  { state: 'STABLE', title: 'Stable and browsable', empty: 'No stable findings.' },
];

const STATE_BADGE = {
  NEEDS_ATTENTION: 'badge-sl',
  IMPROVING: 'badge-tp',
  WATCH: 'badge-gold',
  STABLE: 'badge-gold',
  INSUFFICIENT_EVIDENCE: 'badge-gold',
};

const SOURCE_LABEL = {
  degradation: 'Degradation',
  attribution: 'Attribution',
  improvement: 'Improvements',
};

let filters = { source: 'ALL', category: 'ALL' };

function humanize(value) {
  const s = String(value ?? '').trim();
  if (!s) return 'Unavailable';
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function evidenceBlock(insight) {
  const rows = (insight.evidence || [])
    .map((entry) => {
      // "What happened" already shows this observation verbatim. Repeating it
      // here reads as a duplicated card, so the evidence row carries only the
      // structured backing underneath it.
      const description = entry.description && entry.description !== insight.summary
        ? escapeHtml(entry.description)
        : '';
      const body = [
        description,
        `<div class="int-ref">${
          Array.isArray(entry.refIds) && entry.refIds.length
            ? escapeHtml(`${entry.refIds.length} source record(s) referenced`)
            : 'Aggregate slice — no single record cited'
        }</div>`,
        `<div class="int-prov">${
          Array.isArray(entry.sources) && entry.sources.length
            ? escapeHtml(`Computed by ${entry.sources.join(', ')}`)
            : 'Provenance unavailable'
        }</div>`,
      ].filter(Boolean).join('');
      return `<li class="int-evidence-item">${body}</li>`;
    })
    .join('');
  return `<ul class="int-evidence">${rows}</ul>`;
}

function insightCard(insight) {
  const badge = STATE_BADGE[insight.state] || 'badge-gold';
  const ranking = insight.ranking || {};
  const rankingBlock = ranking.eligible
    ? `<div class="int-ranking int-ranking-ok">${escapeHtml(ranking.label || 'Rankable')}</div>`
    : `<div class="int-ranking int-ranking-suppressed">Not rankable — ${escapeHtml(
        ranking.suppressionReason || 'no reason recorded',
      )}</div>`;

  const sourceLabel = SOURCE_LABEL[insight.source] || 'Unknown source';
  const categoryLabel = humanize(insight.category);
  // Degradation insights are category DEGRADATION from source degradation,
  // which renders as two identical badges. Show the category only when it
  // actually says something the source label does not.
  const categoryBadge = categoryLabel.toLowerCase() === sourceLabel.toLowerCase()
    ? ''
    : `<span class="badge badge-gold">${escapeHtml(categoryLabel)}</span>`;

  const sample = insight.sample || {};
  const sampleBlock =
    `${escapeHtml(humanize(sample.level))} — ${sample.sampleSize ?? 0} record(s) ` +
    `against a minimum of ${sample.minimumSample ?? 5}.` +
    (sample.sufficient ? ' Sufficient to describe.' : ' Too few to support a finding.');

  return `
    <article class="card int-card" data-int-id="${escapeHtml(insight.id)}">
      <header class="int-card-head">
        <h3 class="int-card-title">${escapeHtml(insight.title)}</h3>
        <span class="badge ${badge}">${escapeHtml(humanize(insight.state))}</span>
      </header>
      <div class="int-meta">
        <span class="badge badge-gold">${escapeHtml(sourceLabel)}</span>
        ${categoryBadge}
        ${renderSampleBadge(insight.sample?.sampleSize ?? 0, {
          minimumSample: sample.minimumSample ?? 5,
        })}
      </div>
      <dl class="int-questions">
        <dt>What happened</dt>
        <dd>${escapeHtml(insight.summary)}</dd>
        <dt>Why surfaced</dt>
        <dd>${escapeHtml(insight.whySurfaced)}</dd>
        <dt>How strong is sample</dt>
        <dd>${sampleBlock}</dd>
        <dt>Evidence</dt>
        <dd>${evidenceBlock(insight)}</dd>
        <dt>Can it be ranked</dt>
        <dd>${rankingBlock}</dd>
        <dt>What to investigate</dt>
        <dd>${escapeHtml(insight.investigationQuestion)}</dd>
      </dl>
    </article>`;
}

function filtersBar() {
  const sources = ['ALL', 'degradation', 'attribution', 'improvement'];
  const categories = ['ALL', ...INSIGHT_CATEGORIES];
  const sourceOptions = sources
    .map((v) => `<option value="${escapeHtml(v)}"${filters.source === v ? ' selected' : ''}>${escapeHtml(v === 'ALL' ? 'All sources' : SOURCE_LABEL[v] || v)}</option>`)
    .join('');
  const categoryOptions = categories
    .map((v) => `<option value="${escapeHtml(v)}"${filters.category === v ? ' selected' : ''}>${escapeHtml(v === 'ALL' ? 'All categories' : humanize(v))}</option>`)
    .join('');
  return `
    <section class="card int-filters" aria-label="Insight filters">
      <div class="int-filter-row">
        <label class="form-group">
          <span>Source</span>
          <select id="int-filter-source">${sourceOptions}</select>
        </label>
        <label class="form-group">
          <span>Category</span>
          <select id="int-filter-category">${categoryOptions}</select>
        </label>
      </div>
    </section>`;
}

function matchesFilters(insight) {
  if (filters.source !== 'ALL' && insight.source !== filters.source) return false;
  if (filters.category !== 'ALL' && insight.category !== filters.category) return false;
  return true;
}

function sectionsHtml(groups) {
  const blocks = SECTIONS.map(({ state, title, empty }) => {
    const all = groups[state] || [];
    const shown = all.filter(matchesFilters);
    const hidden = all.length - shown.length;
    const body = shown.length
      ? `<div class="int-grid">${shown.map(insightCard).join('')}</div>`
      : `<p class="int-empty">${escapeHtml(empty)}</p>`;
    const hiddenNote = hidden > 0
      ? `<p class="int-filtered">${hidden} hidden by the current filters.</p>`
      : '';
    return `
      <section class="int-section" aria-label="${escapeHtml(title)}" data-state="${escapeHtml(state)}">
        <h2 class="int-section-title">${escapeHtml(title)} <span class="int-count">${shown.length}</span></h2>
        ${body}
        ${hiddenNote}
      </section>`;
  }).join('');
  return blocks;
}

export function renderIntelligence() {
  const user = getCurrentUser();
  const userId = typeof user === 'string' ? user : user?.id || '';

  let insights = [];
  let groups = {};
  try {
    const built = buildIntelligenceGroups('', { user: userId, filters: { user: userId } });
    insights = built.insights;
    groups = built.groups;
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
        <h1 class="page-title">Intelligence <span class="badge badge-gold">Observational</span></h1>
        <p class="page-subtitle">What deserves my attention — built from your recorded trades and reviews. Describes what the evidence shows; it does not explain why, and it never changes a trade, rule or risk setting.</p>
      </header>

      <section class="card int-summary" aria-label="Intelligence summary">
        <p><strong>${insights.length}</strong> finding(s) · <strong>${attention}</strong> need attention · ${escapeHtml(String(INTELLIGENCE_STATES.length))} states tracked</p>
      </section>

      ${filtersBar()}

      <div id="int-sections">${sectionsHtml(groups)}</div>

      <p class="int-footnote">Findings come from the existing analytics engines and are never recomputed here. Sample strength and ranking eligibility are shown on every card so a thin result is never mistaken for a firm one.</p>
    </main>`;

  const rerenderSections = () => {
    const host = document.getElementById('int-sections');
    if (host) host.innerHTML = sectionsHtml(groups);
  };

  const sourceSelect = document.getElementById('int-filter-source');
  if (sourceSelect) {
    sourceSelect.addEventListener('change', (e) => {
      filters.source = e.target.value;
      rerenderSections();
    });
  }
  const categorySelect = document.getElementById('int-filter-category');
  if (categorySelect) {
    categorySelect.addEventListener('change', (e) => {
      filters.category = e.target.value;
      rerenderSections();
    });
  }

  bindNavbar();
}

export default renderIntelligence;