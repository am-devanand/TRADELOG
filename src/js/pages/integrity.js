import '../../css/phase8.css';
import '../../css/pagesPhase8.css';
import { getCurrentUser } from '../utils/storage.js';
import { getIntegrityReport } from '../utils/dataIntegrity.js';
import {
  renderIntegrityReport,
  renderReconciliationList,
  bindIntegrityReport,
} from '../components/integrityReport.js';
import { navigate, escapeHtml } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';

const DOMAIN_BY_ENTITY = {
  account: 'Accounts',
  trade: 'Trades',
  setup: 'Setups',
  review: 'Reviews',
  rule: 'Rules',
  propconfig: 'Prop Config',
  prop: 'Prop Config',
  improvement: 'Improvements',
};

function issueMessage(issue) {
  if (typeof issue === 'string') return issue;
  if (issue && typeof issue === 'object') {
    return String(issue.message ?? issue.reason ?? issue.detail ?? JSON.stringify(issue));
  }
  return String(issue ?? '');
}

function toComponentReport(report) {
  const r = report && typeof report === 'object' ? report : {};
  const domains = {};
  const all = [...(r.errors || []), ...(r.warnings || [])];
  for (const issue of all) {
    const raw = String(issue?.entityType ?? issue?.entity ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const domain = DOMAIN_BY_ENTITY[raw] || null;
    if (!domain) continue;
    if (!domains[domain]) domains[domain] = { status: 'pass', errors: [], warnings: [] };
  }
  for (const issue of r.errors || []) {
    const raw = String(issue?.entityType ?? issue?.entity ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const domain = DOMAIN_BY_ENTITY[raw];
    if (!domain) continue;
    domains[domain].errors.push(issueMessage(issue));
    domains[domain].status = 'error';
  }
  for (const issue of r.warnings || []) {
    const raw = String(issue?.entityType ?? issue?.entity ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const domain = DOMAIN_BY_ENTITY[raw];
    if (!domain) continue;
    domains[domain].warnings.push(issueMessage(issue));
    if (domains[domain].status !== 'error') domains[domain].status = 'warning';
  }
  return {
    checkedAt: r.checkedAt || '',
    domains,
  };
}

function toReconciliationEntries(report) {
  const r = report && typeof report === 'object' ? report : {};
  const groups = r.reconciliations && typeof r.reconciliations === 'object' ? r.reconciliations : {};
  const labels = {
    accountBalance: 'Account balance',
    propVsAccount: 'Prop vs account',
    analyticsVsTrades: 'Analytics vs trades',
  };
  const out = [];
  for (const key of Object.keys(labels)) {
    const list = Array.isArray(groups[key]) ? groups[key] : [];
    for (const rec of list) {
      if (!rec || typeof rec !== 'object') continue;
      const skipped = rec.skipped === true;
      const status = skipped ? 'na' : rec.valid === true ? 'pass' : 'warning';
      const msgs = [...(rec.errors || []), ...(rec.warnings || [])].map(issueMessage);
      const accountId = rec.accountId != null && rec.accountId !== '' ? ` — ${rec.accountId}` : '';
      out.push({
        label: `${labels[key]}${accountId}`,
        status,
        message: skipped
          ? `Check could not run${msgs[0] ? `: ${msgs[0]}` : '.'}`
          : msgs[0] || 'Agrees within tolerance.',
      });
    }
  }
  return out;
}

function paint(user) {
  const body = document.getElementById('integrity-body');
  if (!body) return;
  let report = null;
  try {
    report = getIntegrityReport(user);
  } catch {
    report = { errors: [], warnings: [], checkedAt: '', reconciliations: {} };
  }
  const errorCount = Array.isArray(report?.errors) ? report.errors.length : 0;
  const warningCount = Array.isArray(report?.warnings) ? report.warnings.length : 0;
  body.innerHTML = `
    <div class="card cc-summary-strip" role="status">
      <span class="badge badge-gold">${escapeHtml(String(warningCount))} WARNINGS · ${escapeHtml(String(errorCount))} ERRORS</span>
      <span class="p8-muted">Read-only report — issues are flagged, never auto-repaired.</span>
    </div>
    ${renderIntegrityReport(toComponentReport(report))}
    ${renderReconciliationList(toReconciliationEntries(report))}
    <div class="p8-actions">
      <button type="button" class="btn btn-primary" id="p8-integrity-run-full">RUN FULL CHECK</button>
      <a class="btn btn-secondary" href="#/settings">BACK TO SETTINGS</a>
    </div>`;
  bindIntegrityReport({ onRunCheck: () => paint(user) });
  document.getElementById('p8-integrity-run-full')?.addEventListener('click', () => paint(user));
}

export function renderIntegrityPage() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">Data Integrity</h1>
          <p class="page-subtitle">Read-only health check across every local domain</p>
        </div>
      </div>
      <div id="integrity-body" aria-live="polite"></div>
    </div>`;
  bindNavbar();
  paint(user);
}

export default { renderIntegrityPage };
