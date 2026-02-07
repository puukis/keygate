import './ConfirmationModal.css';

interface ConfirmationDetails {
  tool: string;
  action: string;
  summary: string;
  command?: string;
  cwd?: string;
  path?: string;
  args?: Record<string, unknown>;
}

interface ConfirmationModalProps {
  prompt: string;
  details?: ConfirmationDetails;
  onAllowOnce: () => void;
  onAllowAlways: () => void;
  onCancel: () => void;
}

function formatArgs(args?: Record<string, unknown>): string | null {
  if (!args || Object.keys(args).length === 0) {
    return null;
  }

  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return null;
  }
}

export function ConfirmationModal({
  prompt,
  details,
  onAllowOnce,
  onAllowAlways,
  onCancel,
}: ConfirmationModalProps) {
  const argsPreview = formatArgs(details?.args);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content animate-slide-in" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-kicker">Approval</span>
          <h2>Confirmation Required</h2>
        </div>
        
        <div className="modal-body">
          <pre className="modal-prompt">{prompt}</pre>
          {details && (
            <div className="modal-details">
              <div className="modal-grid">
                <div>
                  <span className="modal-label">Tool</span>
                  <code>{details.tool}</code>
                </div>
                <div>
                  <span className="modal-label">Action</span>
                  <code>{details.action}</code>
                </div>
                {details.command && (
                  <div className="modal-span">
                    <span className="modal-label">Command</span>
                    <code>{details.command}</code>
                  </div>
                )}
                {details.cwd && (
                  <div className="modal-span">
                    <span className="modal-label">Directory</span>
                    <code>{details.cwd}</code>
                  </div>
                )}
                {details.path && (
                  <div className="modal-span">
                    <span className="modal-label">Path</span>
                    <code>{details.path}</code>
                  </div>
                )}
              </div>
              {argsPreview && (
                <div className="modal-args">
                  <span className="modal-label">Arguments</span>
                  <pre>{argsPreview}</pre>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-confirm-secondary" onClick={onAllowOnce}>
            Allow Once
          </button>
          <button className="btn-confirm" onClick={onAllowAlways}>
            Allow Always
          </button>
        </div>
      </div>
    </div>
  );
}
