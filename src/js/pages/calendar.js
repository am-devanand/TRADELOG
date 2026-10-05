// ============================================
// Calendar — trading-day-aware month view
// Vanilla ESM, offline-first. Read-only: aggregates
// via public readers (executedTrades, tradeReviews,
// processScore, storage). Never creates trades.
// ============================================
import '../../css/calendar.css';
import { getCurrentUser, getFolders } from '../utils/storage.js';
import { getClosedTrades, getOpenTrades } from '../utils/executedTrades.js';
import { getCompletedReviews } from '../utils/tradeReviews.js';
import { gradeForTotal } from '../utils/processScore.js';
import { navigate, escapeHtml, formatCurrency } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';
import { toLocalISO as toLocalDayKey } from '../utils/dayKey.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function toFinite(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local YYYY-MM-DD for a Date (no UTC shift). */
export function toLocalISO(d) {
  return toLocalDayKey(d);
}

function todayLocalISO() {
  return toLocalISO(new Date());
}

function parseToDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Local calendar day for a trade: closedAt for CLOSED trades,
 * openedAt fallback (covers OPEN / PARTIALLY_CLOSED trades).
 * Returns '' when neither parses.
 */
function dayKeyForTrade(trade) {
  if (!trade || typeof trade !== 'object') return '';
  const status = String(trade.status || '').trim().toUpperCase();
  if (status === 'CLOSED') {
    const closed = parseToDate(trade.closedAt);
    if (closed) return toLocalISO(closed);
  }
  const opened = parseToDate(trade.openedAt);
  return opened ? toLocalISO(opened) : '';
}

function reviewTotal(review) {
  if (!review || typeof review !== 'object') return NaN;
  const nested = review.processScore && typeof review.processScore === 'object'
    ? review.processScore.total
    : NaN;
  const flat = review.total;
  const n = Number(nested);
  if (Number.isFinite(n)) return n;
  const f = Number(flat);
  return Number.isFinite(f) ? f : NaN;
}

/**
 * Per-day aggregates for one calendar month (local days).
 * One entry per day of the month, in order; no-trade days carry
 * empty trades, pnl 0, r 0, grade '' and count 0 (never fabricated).
 *
 * @returns {Array<{dateISO:string,trades:Array,pnl:number,r:number,grade:string,count:number,avgScore:number|null,reviewCount:number}>}
 */
export function getDailyAggregates(user, accountId, year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 0 || m > 11) return [];
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prefix = `${y}-${pad2(m + 1)}`;

  let trades = [];
  try {
    const closed = getClosedTrades(user, accountId || undefined) || [];
    const open = getOpenTrades(user, accountId || undefined) || [];
    const seen = new Set();
    trades = [...closed, ...open].filter((t) => {
      if (!t || !t.id) return false;
      const id = String(t.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  } catch {
    trades = [];
  }

  let completedByTrade = new Map();
  try {
    const completed = getCompletedReviews(user) || [];
    for (const r of completed) {
      if (r && r.tradeId) completedByTrade.set(String(r.tradeId), r);
    }
  } catch {
    completedByTrade = new Map();
  }

  const byDay = new Map();
  for (const t of trades) {
    const key = dayKeyForTrade(t);
    if (!key || !key.startsWith(prefix)) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t);
  }

  const out = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dateISO = `${prefix}-${pad2(d)}`;
    const dayTrades = byDay.get(dateISO) || [];
    let pnl = 0;
    let r = 0;
    for (const t of dayTrades) {
      pnl += toFinite(t.pnl, 0);
      r += toFinite(t.rMultiple, 0);
    }
    const scores = [];
    for (const t of dayTrades) {
      const rev = completedByTrade.get(String(t.id));
      const total = reviewTotal(rev);
      if (Number.isFinite(total)) scores.push(total);
    }
    const avgScore = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null;
    out.push({
      dateISO,
      trades: dayTrades,
      pnl: Math.round(pnl * 100) / 100,
      r: Math.round(r * 100) / 100,
      grade: avgScore === null ? '' : gradeForTotal(avgScore),
      count: dayTrades.length,
      avgScore,
      reviewCount: scores.length,
    });
  }
  return out;
}

function signedMoney(n, currency) {
  const amount = toFinite(n, 0);
  if (amount > 0) {
    return { text: `+${formatCurrency(Math.abs(amount), currency)}`, cls: 'positive' };
  }
  if (amount < 0) {
    return { text: `\u2212${formatCurrency(Math.abs(amount), currency)}`, cls: 'negative' };
  }
  return { text: formatCurrency(0, currency), cls: 'flat' };
}

function signedR(n) {
  const amount = toFinite(n, 0);
  const abs = Math.abs(amount).toFixed(2);
  if (amount > 0) return { text: `+${abs}R`, cls: 'positive' };
  if (amount < 0) return { text: `\u2212${abs}R`, cls: 'negative' };
  return { text: '0.00R', cls: 'flat' };
}

function monthLabel(year, month) {
  try {
    return new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  } catch {
    return `${month + 1}/${year}`;
  }
}

function dayNum(dateISO) {
  return String(Number(dateISO.slice(8, 10)));
}

function cellStateClass(agg, isFuture) {
  if (isFuture) return 'is-future';
  if (!agg || agg.count === 0) return 'is-empty';
  if (agg.pnl > 0) return 'has-profit';
  if (agg.pnl < 0) return 'has-loss';
  return 'is-flat';
}

function cellHtml(dateObj, inMonth, agg, currency, isFuture, isWeekend, selectedISO) {
  const dateISO = toLocalISO(dateObj);
  const classes = ['cal-cell', cellStateClass(agg, isFuture)];
  if (!inMonth) classes.push('is-outside');
  if (isWeekend) classes.push('is-weekend');
  if (dateISO === todayLocalISO()) classes.push('is-today');
  if (dateISO === selectedISO) classes.push('is-selected');

  let body;
  if (!agg || agg.count === 0) {
    body = '<span class="cal-notrades">NO TRADES</span>';
  } else {
    const pnl = signedMoney(agg.pnl, currency);
    const r = signedR(agg.r);
    const tradeWord = agg.count === 1 ? 'trade' : 'trades';
    const gradeBadge = agg.grade
      ? `<span class="badge badge-gold cal-grade grade-${escapeHtml(agg.grade)}">${escapeHtml(agg.grade)}</span>`
      : '';
    body = `
      <span class="cal-count">${agg.count} ${tradeWord}</span>
      <span class="cal-pnl ${pnl.cls}">${escapeHtml(pnl.text)}</span>
      <span class="cal-r ${r.cls}">${escapeHtml(r.text)}</span>
      ${gradeBadge}
    `;
  }
  return `
    <button type="button" class="${classes.join(' ')}" data-date="${escapeHtml(dateISO)}" aria-label="${escapeHtml(dateISO)}${agg && agg.count ? `, ${agg.count} trades` : ', no trades'}">
      <span class="cal-daynum">${escapeHtml(dayNum(dateISO))}</span>
      ${body}
    </button>
  `;
}

function summaryHtml(aggregates, currency, label) {
  const withTrades = aggregates.filter((a) => a.count > 0);
  const totalTrades = withTrades.reduce((a, d) => a + d.count, 0);
  const net = withTrades.reduce((a, d) => a + toFinite(d.pnl, 0), 0);
  const totalR = withTrades.reduce((a, d) => a + toFinite(d.r, 0), 0);
  const scoredDays = withTrades.filter((d) => d.avgScore !== null);
  const scoreVals = scoredDays.map((d) => d.avgScore);
  // Weighted by reviewed-trade count per day would need review arrays;
  // day averages are already means, so average them (guard divide-by-zero).
  const avgScore = scoreVals.length
    ? scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length
    : null;
  const avgGrade = avgScore === null ? '' : gradeForTotal(avgScore);

  let best = null;
  let worst = null;
  for (const d of withTrades) {
    if (!best || d.pnl > best.pnl) best = d;
    if (!worst || d.pnl < worst.pnl) worst = d;
  }

  const netFmt = signedMoney(net, currency);
  const rFmt = signedR(totalR);
  const stat = (labelText, valueHtml) => `
    <div class="stat-card"><div class="stat-label">${escapeHtml(labelText)}</div><div class="stat-value">${valueHtml}</div></div>
  `;
  return `
    <div class="stats-grid cal-summary" aria-label="Month summary for ${escapeHtml(label)}">
      ${stat('Total trades', escapeHtml(String(totalTrades)))}
      ${stat('Net P/L', `<span class="${netFmt.cls}">${escapeHtml(netFmt.text)}</span>`)}
      ${stat('Total R', `<span class="${rFmt.cls}">${escapeHtml(rFmt.text)}</span>`)}
      ${stat('Avg process score', avgScore === null
        ? '<span class="cal-muted">—</span>'
        : `${escapeHtml(avgScore.toFixed(1))} <span class="badge badge-gold cal-grade grade-${escapeHtml(avgGrade)}">${escapeHtml(avgGrade)}</span>`)}
      ${stat('Best day', best ? escapeHtml(`${best.dateISO} · ${signedMoney(best.pnl, currency).text}`) : '<span class="cal-muted">—</span>')}
      ${stat('Worst day', worst ? escapeHtml(`${worst.dateISO} · ${signedMoney(worst.pnl, currency).text}`) : '<span class="cal-muted">—</span>')}
      ${stat('Trading days', escapeHtml(String(withTrades.length)))}
    </div>
  `;
}

function detailHtml(agg, currency, completedByTrade) {
  if (!agg) {
    return '<div class="empty-state"><h3>Select a day</h3><p>Click any calendar day to see its trades.</p></div>';
  }
  const label = (() => {
    try {
      return new Date(`${agg.dateISO}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } catch {
      return agg.dateISO;
    }
  })();

  if (agg.count === 0) {
    return `
      <div class="cal-detail-head"><h3>${escapeHtml(label)}</h3></div>
      <div class="empty-state"><h3>NO TRADES</h3><p>No trades recorded on this day.</p></div>
    `;
  }

  const grossProfit = agg.trades.reduce((a, t) => a + Math.max(0, toFinite(t.pnl, 0)), 0);
  const grossLoss = agg.trades.reduce((a, t) => a + Math.min(0, toFinite(t.pnl, 0)), 0);
  const closed = agg.trades.filter((t) => String(t.status || '').toUpperCase() === 'CLOSED');
  const wins = closed.filter((t) => toFinite(t.pnl, 0) > 0).length;
  const winRate = closed.length ? `${((wins / closed.length) * 100).toFixed(1)}%` : '—';
  const net = signedMoney(agg.pnl, currency);
  const r = signedR(agg.r);

  const rows = agg.trades.map((t) => {
    const id = String(t.id);
    const pair = t.pair ? String(t.pair) : '—';
    const dir = String(t.direction || '—').toUpperCase();
    const pnl = signedMoney(t.pnl, currency);
    const rVal = signedR(t.rMultiple);
    const status = String(t.status || '—').toUpperCase();
    const reviewed = completedByTrade.has(id);
    return `
      <tr>
        <td>${escapeHtml(pair)}</td>
        <td><span class="badge ${dir === 'SHORT' ? 'badge-sl' : 'badge-tp'}">${escapeHtml(dir)}</span></td>
        <td class="${pnl.cls}">${escapeHtml(pnl.text)}</td>
        <td class="${rVal.cls}">${escapeHtml(rVal.text)}</td>
        <td><span class="badge badge-gold">${escapeHtml(status)}</span></td>
        <td><a href="#/trade/${escapeHtml(id)}">View</a>${reviewed ? ` · <a href="#/trade/${escapeHtml(id)}/review">Review</a>` : ` · <a href="#/trade/${escapeHtml(id)}/review">Start review</a>`}</td>
      </tr>
    `;
  }).join('');

  const gradeBlock = agg.avgScore === null
    ? '<span class="cal-muted">No completed reviews</span>'
    : `${escapeHtml(agg.avgScore.toFixed(1))} <span class="badge badge-gold cal-grade grade-${escapeHtml(agg.grade)}">${escapeHtml(agg.grade)}</span> <span class="cal-muted">(${agg.reviewCount} reviewed)</span>`;

  return `
    <div class="cal-detail-head"><h3>${escapeHtml(label)}</h3></div>
    <div class="stats-grid cal-daytotals">
      <div class="stat-card"><div class="stat-label">Trades</div><div class="stat-value">${agg.count}</div></div>
      <div class="stat-card"><div class="stat-label">Gross profit</div><div class="stat-value positive">+${escapeHtml(formatCurrency(grossProfit, currency))}</div></div>
      <div class="stat-card"><div class="stat-label">Gross loss</div><div class="stat-value negative">\u2212${escapeHtml(formatCurrency(Math.abs(grossLoss), currency))}</div></div>
      <div class="stat-card"><div class="stat-label">Net</div><div class="stat-value"><span class="${net.cls}">${escapeHtml(net.text)}</span></div></div>
      <div class="stat-card"><div class="stat-label">Total R</div><div class="stat-value"><span class="${r.cls}">${escapeHtml(r.text)}</span></div></div>
      <div class="stat-card"><div class="stat-label">Win rate (closed)</div><div class="stat-value">${escapeHtml(winRate)}</div></div>
      <div class="stat-card"><div class="stat-label">Day process grade</div><div class="stat-value cal-grade-val">${gradeBlock}</div></div>
    </div>
    <div class="trade-table-container">
      <table>
        <thead><tr><th>Pair</th><th>Dir</th><th>P/L</th><th>R</th><th>Status</th><th>Links</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

export function renderCalendar() {
  const user = getCurrentUser();
  if (!user) return navigate('/login');

  const folders = (() => {
    try {
      return getFolders(user) || [];
    } catch {
      return [];
    }
  })();

  const now = new Date();
  const state = {
    accountId: 'all',
    year: now.getFullYear(),
    month: now.getMonth(),
    selectedISO: '',
  };

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page cal-page">
      <div class="page-header">
        <div>
          <h1 class="page-title">Calendar</h1>
          <p class="page-subtitle">Trading days at a glance — P/L, R and process grade per day</p>
        </div>
        <div class="cal-controls">
          <select id="cal-account" aria-label="Account">
            <option value="all">All accounts</option>
            ${folders.map((f) => `<option value="${escapeHtml(String(f.id))}">${escapeHtml(String(f.name || 'Account'))}</option>`).join('')}
          </select>
          <div class="cal-nav">
            <button class="btn btn-secondary btn-sm" id="cal-prev" aria-label="Previous month">← Prev</button>
            <button class="btn btn-ghost btn-sm" id="cal-today">TODAY</button>
            <button class="btn btn-secondary btn-sm" id="cal-next" aria-label="Next month">Next →</button>
          </div>
        </div>
      </div>
      <h2 class="cal-month" id="cal-month"></h2>
      <div id="cal-summary"></div>
      <div class="card cal-grid-card">
        <div class="cal-weekdays" aria-hidden="true">
          ${WEEKDAYS.map((d) => `<span>${d}</span>`).join('')}
        </div>
        <div class="cal-grid" id="cal-grid" role="grid"></div>
      </div>
      <div class="card cal-detail" id="cal-detail"></div>
    </div>
  `;
  bindNavbar();

  const currencyFor = () => {
    if (state.accountId === 'all') return 'USD';
    const f = folders.find((x) => String(x.id) === String(state.accountId));
    return (f && f.currency) || 'USD';
  };

  const paint = () => {
    const label = monthLabel(state.year, state.month);
    document.getElementById('cal-month').textContent = label;
    const currency = currencyFor();
    const aggregates = getDailyAggregates(
      user,
      state.accountId === 'all' ? '' : state.accountId,
      state.year,
      state.month,
    );
    const byISO = new Map(aggregates.map((a) => [a.dateISO, a]));

    let completedByTrade = new Map();
    try {
      for (const r of getCompletedReviews(user) || []) {
        if (r && r.tradeId) completedByTrade.set(String(r.tradeId), r);
      }
    } catch {
      completedByTrade = new Map();
    }

    document.getElementById('cal-summary').innerHTML = summaryHtml(aggregates, currency, label);

    // Mon-first 6-week grid (42 cells).
    const offset = (new Date(state.year, state.month, 1).getDay() + 6) % 7;
    const today = todayLocalISO();
    let cells = '';
    for (let i = 0; i < 42; i += 1) {
      const dateObj = new Date(state.year, state.month, 1 - offset + i);
      const inMonth = dateObj.getMonth() === state.month;
      const dateISO = toLocalISO(dateObj);
      const agg = byISO.get(dateISO) || null;
      const dow = dateObj.getDay();
      cells += cellHtml(dateObj, inMonth, agg, currency, dateISO > today, dow === 0 || dow === 6, state.selectedISO);
    }
    document.getElementById('cal-grid').innerHTML = cells;

    const detailAgg = state.selectedISO ? byISO.get(state.selectedISO) || null : null;
    document.getElementById('cal-detail').innerHTML = detailHtml(detailAgg, currency, completedByTrade);

    document.querySelectorAll('#cal-grid .cal-cell').forEach((el) => {
      el.addEventListener('click', () => {
        const iso = el.dataset.date || '';
        state.selectedISO = iso;
        const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso);
        if (m) {
          state.year = Number(m[1]);
          state.month = Number(m[2]) - 1;
        }
        paint();
      });
    });
  };

  document.getElementById('cal-prev').addEventListener('click', () => {
    const d = new Date(state.year, state.month - 1, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    paint();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    const d = new Date(state.year, state.month + 1, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    paint();
  });
  document.getElementById('cal-today').addEventListener('click', () => {
    const t = new Date();
    state.year = t.getFullYear();
    state.month = t.getMonth();
    state.selectedISO = todayLocalISO();
    paint();
  });
  document.getElementById('cal-account').addEventListener('change', (e) => {
    state.accountId = e.target.value || 'all';
    paint();
  });

  paint();
}

export default { renderCalendar, getDailyAggregates, toLocalISO };
