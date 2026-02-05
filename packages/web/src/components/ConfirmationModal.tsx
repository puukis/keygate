import './ConfirmationModal.css';

interface ConfirmationModalProps {
  prompt: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmationModal({ prompt, onConfirm, onCancel }: ConfirmationModalProps) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content animate-slide-in" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-icon">🔐</span>
          <h2>Confirmation Required</h2>
        </div>
        
        <div className="modal-body">
          <pre className="modal-prompt">{prompt}</pre>
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onCancel}>
            ❌ Cancel
          </button>
          <button className="btn-confirm" onClick={onConfirm}>
            ✅ Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
