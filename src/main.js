import './css/base.css';
import { isLoggedIn, getTheme, setTheme } from './js/utils/storage.js';
import { registerRoute, startRouter, navigate } from './js/utils/helpers.js';
import { renderLogin } from './js/pages/login.js';
import { renderRegister } from './js/pages/register.js';
import { renderHome } from './js/pages/home.js';
import { renderDashboard } from './js/pages/dashboard.js';
import { renderReports } from './js/pages/reports.js';
import { renderAnalytics } from './js/pages/analytics.js';
import { renderJournal } from './js/pages/journal.js';

// Initialize theme
setTheme(getTheme());

// Auth guard wrapper
function authGuard(handler) {
  return (params) => {
    if (!isLoggedIn()) return navigate('/login');
    handler(params);
  };
}

// Register all routes
registerRoute('/login', renderLogin);
registerRoute('/register', renderRegister);
registerRoute('/home', authGuard(renderHome));
registerRoute('/folder/:id', authGuard(renderDashboard));
registerRoute('/folder/:id/reports', authGuard(renderReports));
registerRoute('/folder/:id/analytics', authGuard(renderAnalytics));
registerRoute('/folder/:id/journal', authGuard(renderJournal));

// Start
startRouter();
