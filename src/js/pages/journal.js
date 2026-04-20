import { getCurrentUser, getFolder, getJournalEntries, saveJournalEntry, deleteJournalEntry } from '../utils/storage.js';
import { navigate, showToast, showConfirm, generateId, formatDate } from '../utils/helpers.js';
import { renderNavbar, bindNavbar } from '../components/navbar.js';

export function renderJournal(params) {
  const user = getCurrentUser();
  if (!user) return navigate('/login');
  const folder = getFolder(user, params.id);
  if (!folder) return navigate('/home');
  const entries = getJournalEntries(folder.id).sort((a, b) => new Date(b.date) - new Date(a.date));

  const app = document.getElementById('app');
  app.innerHTML = `
    ${renderNavbar()}
    <div class="page">
      <div class="page-header">
        <div>
          <button class="btn btn-ghost btn-sm" id="back-dash" style="margin-bottom:8px;">← Back to ${folder.name}</button>
          <h1 class="page-title">Trading Journal</h1>
          <p class="page-subtitle">Daily reflections and notes</p>
        </div>
      </div>
      <div class="card" style="margin-bottom:var(--space-xl);">
        <form id="journal-form">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Date</label>
              <input type="date" id="journal-date" value="${new Date().toISOString().split('T')[0]}" required>
            </div>
            <div class="form-group" style="display:flex;align-items:flex-end;">
              <button type="submit" class="btn btn-primary" style="width:100%;">Save Entry</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Your thoughts, observations, lessons...</label>
            <textarea id="journal-text" rows="5" placeholder="What did you learn today? How did you feel about your trades? What will you do differently?" required style="resize:vertical;"></textarea>
          </div>
        </form>
      </div>
      <div id="journal-entries">
        ${entries.length === 0 ? `<div class="empty-state"><h3>No journal entries yet</h3><p>Start writing about your trading day above</p></div>` :
          entries.map(e => `
            <div class="journal-entry">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div class="journal-date">📅 ${formatDate(e.date)}</div>
                <button class="btn btn-ghost btn-sm delete-journal" data-id="${e.id}" title="Delete">🗑</button>
              </div>
              <div class="journal-text">${e.text}</div>
            </div>
          `).join('')}
      </div>
    </div>
  `;
  bindNavbar();
  document.getElementById('back-dash').addEventListener('click', () => navigate('/folder/' + folder.id));
  document.getElementById('journal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const date = document.getElementById('journal-date').value;
    const text = document.getElementById('journal-text').value.trim();
    if (!text) return showToast('Please write something', 'error');
    saveJournalEntry(folder.id, { id: generateId(), date, text, createdAt: new Date().toISOString() });
    showToast('Journal entry saved!');
    renderJournal(params);
  });
  document.querySelectorAll('.delete-journal').forEach(btn => {
    btn.addEventListener('click', () => {
      showConfirm('Delete this journal entry?', () => {
        deleteJournalEntry(folder.id, btn.dataset.id);
        showToast('Entry deleted', 'error');
        renderJournal(params);
      });
    });
  });
}
