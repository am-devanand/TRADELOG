import './css/base.css';
import { isLoggedIn, getCurrentUser, getTheme, setTheme } from './js/utils/storage.js';
import { migrateUser } from './js/utils/migration.js';
import { registerRoute, startRouter, navigate } from './js/utils/helpers.js';
import { renderLogin } from './js/pages/login.js';
import { renderRegister } from './js/pages/register.js';
import { renderHome } from './js/pages/home.js';
import { renderDashboard } from './js/pages/dashboard.js';
import { renderReports } from './js/pages/reports.js';
import { renderAnalytics } from './js/pages/analytics.js';
import { renderJournal } from './js/pages/journal.js';
import { renderRules } from './js/pages/rules.js';
import { renderTrade, renderTradeNew } from './js/pages/trade.js';
import { renderTradeDetail } from './js/pages/tradeDetail.js';
import { renderTradeReview } from './js/pages/tradeReview.js';
import { renderProp } from './js/pages/prop.js';
import { renderStrategyAnalytics, renderStrategyDetail } from './js/pages/strategyAnalytics.js';
import { renderProcessAnalytics } from './js/pages/processAnalytics.js';
import { renderImprovements } from './js/pages/improvements.js';
import { renderCommandCenter } from './js/pages/commandCenter.js';
import { renderSettings } from './js/pages/settings.js';
import { renderIntegrityPage } from './js/pages/integrity.js';
import { showToast } from './js/utils/helpers.js';
import { getExecutedTrade } from './js/utils/executedTrades.js';

// Initialize theme
setTheme(getTheme());

// Auth guard wrapper
function authGuard(handler) {
  return (params) => {
    if (!isLoggedIn()) return navigate('/login');
    try { migrateUser(getCurrentUser()); } catch { /* offline-safe: app works without migration */ }
    handler(params);
  };
}

// Register all routes
// / — command center is the app home. /command is its alias.
registerRoute('/', authGuard(renderCommandCenter));
registerRoute('/command', authGuard(renderCommandCenter));
registerRoute('/login', renderLogin);
registerRoute('/register', renderRegister);
registerRoute('/home', authGuard(renderHome));
registerRoute('/rules', authGuard(renderRules));
registerRoute('/trade', authGuard(renderTrade));
registerRoute('/trade/new', authGuard(renderTradeNew));
// /trade/:id/review — 3 segments, no conflict with /trade/:id (2 segments).
registerRoute('/trade/:id/review', authGuard(renderTradeReview));
// /trade/:id — executed trade first, fallback to saved-setup reopen view.
registerRoute('/trade/:id', authGuard((params) => {
  const user = getCurrentUser();
  if (user && getExecutedTrade(user, params.id)) return renderTradeDetail(params);
  try {
    let found = false;
    try {
      const raw = localStorage.getItem(`tradelog_setups_${String(user || '').trim().toLowerCase()}`);
      const list = raw ? JSON.parse(raw) : [];
      found = Array.isArray(list) && list.some((s) => s && String(s.id) === String(params.id));
    } catch { /* offline-safe */ }
    if (found) {
      try { sessionStorage.setItem('tradelog_reopen_setup', params.id); } catch { /* noop */ }
      return renderTradeNew();
    }
  } catch { /* fall through */ }
  return renderTradeDetail(params); // renders not-found state
}));
registerRoute('/folder/:id', authGuard(renderDashboard));
registerRoute('/folder/:id/reports', authGuard(renderReports));
registerRoute('/folder/:id/analytics', authGuard(renderAnalytics));
registerRoute('/folder/:id/journal', authGuard(renderJournal));
registerRoute('/prop', authGuard(renderProp));
registerRoute('/settings', authGuard(renderSettings));
// /settings/integrity — 2 segments like /trade/:id, but literal segments
// differ ('settings'/'integrity' vs 'trade'/:id) and the router matches
// per-pattern (length + literal check), so no cross-capture.
registerRoute('/settings/integrity', authGuard(renderIntegrityPage));
// /analytics — Phase 7 hub; lands on the strategies overview.
registerRoute('/analytics', authGuard(() => navigate('/analytics/strategies')));
registerRoute('/analytics/strategies', authGuard(renderStrategyAnalytics));
// /analytics/strategies/:id — 3 segments, same length as /trade/:id/review
// but literal segments differ ('analytics'/'strategies' vs 'trade'/:id/'review'),
// and the router matches per-pattern (length + literal check), so no cross-capture.
registerRoute('/analytics/strategies/:id', authGuard(renderStrategyDetail));
registerRoute('/analytics/process', authGuard(renderProcessAnalytics));
registerRoute('/analytics/improvements', authGuard(renderImprovements));
// /calendar — calendar agent owns ./js/pages/calendar.js; lazy dynamic import
// with @vite-ignore keeps the build green when the file lands later.
registerRoute('/calendar', authGuard((params) => {
  import(/* @vite-ignore */ './js/pages/calendar.js')
    .then((m) => {
      if (m && typeof m.renderCalendar === 'function') m.renderCalendar(params);
      else showToast('Calendar view is not available yet', 'error');
    })
    .catch(() => showToast('Calendar view is not available yet', 'error'));
}));

// Start
if (!window.location.hash) window.location.hash = '/';
startRouter();
