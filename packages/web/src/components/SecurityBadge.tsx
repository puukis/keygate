import type { SecurityMode } from '../App';
import './SecurityBadge.css';

interface SecurityBadgeProps {
  mode: SecurityMode;
  spicyEnabled: boolean;
  onModeChange: (mode: SecurityMode) => void;
}

export function SecurityBadge({ mode, spicyEnabled, onModeChange }: SecurityBadgeProps) {
  const handleToggle = () => {
    onModeChange(mode === 'safe' ? 'spicy' : 'safe');
  };

  if (mode === 'spicy') {
    return (
      <button className="security-badge spicy" onClick={handleToggle}>
        <span className="badge-icon">🔴</span>
        <span className="badge-text">DANGER: SPICY MODE ACTIVE</span>
        <span className="badge-pulse" />
      </button>
    );
  }

  return (
    <button
      className="security-badge safe"
      onClick={handleToggle}
      disabled={!spicyEnabled}
      title={!spicyEnabled ? 'Spicy mode not enabled during installation' : 'Click to enable Spicy Mode'}
    >
      <span className="badge-icon">🟢</span>
      <span className="badge-text">Safe Mode</span>
      {spicyEnabled && <span className="badge-toggle">Switch</span>}
    </button>
  );
}
