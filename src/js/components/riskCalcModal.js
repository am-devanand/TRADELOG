import { showModal, hideModal, formatCurrency } from '../utils/helpers.js';

export function showRiskCalcModal() {
  showModal(`
    <div class="modal-header">
      <h3 class="modal-title">🧮 Risk Calculator</h3>
      <button class="modal-close" onclick="document.getElementById('modal-overlay').classList.remove('active')">×</button>
    </div>
    <div class="risk-calc" style="max-width:100%;border:none;padding:0;">
      <div class="form-group">
        <label class="form-label">Account Balance ($)</label>
        <input type="number" id="rc-balance" placeholder="e.g. 10000" step="0.01">
      </div>
      <div class="form-group">
        <label class="form-label">Risk Percentage (%)</label>
        <input type="number" id="rc-risk" placeholder="e.g. 2" step="0.1">
      </div>
      <div class="risk-result" id="rc-result">$0.00</div>
      <p style="text-align:center;color:var(--text-muted);font-size:var(--font-size-xs);">Maximum amount you should risk on this trade</p>
    </div>
  `);
  setTimeout(() => {
    const calc = () => {
      const bal = parseFloat(document.getElementById('rc-balance')?.value || 0);
      const risk = parseFloat(document.getElementById('rc-risk')?.value || 0);
      const result = (bal * risk) / 100;
      const el = document.getElementById('rc-result');
      if (el) el.textContent = formatCurrency(result);
    };
    document.getElementById('rc-balance')?.addEventListener('input', calc);
    document.getElementById('rc-risk')?.addEventListener('input', calc);
  }, 50);
}
