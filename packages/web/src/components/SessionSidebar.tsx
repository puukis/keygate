import { useState } from 'react';
import './SessionSidebar.css';

export type SidebarTabId =
  | 'chat'
  | 'overview'
  | 'channels'
  | 'instances'
  | 'sessions'
  | 'automations'
  | 'config'
  | 'usage'
  | 'agents'
  | 'debug'
  | 'logs'
  | 'docs';
export type SidebarActionId = 'open_config_plugins' | 'open_config_marketplace' | 'open_config_mcp_browser';
type SidebarSectionId = 'chat' | 'control' | 'agent' | 'settings' | 'resources';
type SidebarIconId =
  | 'chat'
  | 'overview'
  | 'channels'
  | 'instances'
  | 'sessions'
  | 'usage'
  | 'cronJobs'
  | 'agents'
  | 'skills'
  | 'plugins'
  | 'nodes'
  | 'config'
  | 'debug'
  | 'logs'
  | 'docs';

interface SidebarTabItem {
  kind: 'tab';
  id: SidebarTabId;
  label: string;
  icon: SidebarIconId;
}

interface SidebarActionItem {
  kind: 'action';
  id: SidebarActionId;
  label: string;
  icon: SidebarIconId;
}

type SidebarNavItem = SidebarTabItem | SidebarActionItem;

interface SidebarSection {
  id: SidebarSectionId;
  label: string;
  items: SidebarNavItem[];
}

interface SessionSidebarProps {
  activeTab: SidebarTabId;
  onSelectTab: (tab: SidebarTabId) => void;
  onAction: (action: SidebarActionId) => void;
}

export const SIDEBAR_SECTIONS: SidebarSection[] = [
  {
    id: 'chat',
    label: 'Chat',
    items: [
      { kind: 'tab', id: 'chat', label: 'Chat', icon: 'chat' },
    ],
  },
  {
    id: 'control',
    label: 'Control',
    items: [
      { kind: 'tab', id: 'overview', label: 'Overview', icon: 'overview' },
      { kind: 'tab', id: 'channels', label: 'Channels', icon: 'channels' },
      { kind: 'tab', id: 'instances', label: 'Instances', icon: 'instances' },
      { kind: 'tab', id: 'sessions', label: 'Sessions', icon: 'sessions' },
      { kind: 'tab', id: 'usage', label: 'Usage', icon: 'usage' },
      { kind: 'tab', id: 'automations', label: 'Cron Jobs', icon: 'cronJobs' },
    ],
  },
  {
    id: 'agent',
    label: 'Agent',
    items: [
      { kind: 'tab', id: 'agents', label: 'Agents', icon: 'agents' },
      { kind: 'action', id: 'open_config_plugins', label: 'Plugins', icon: 'plugins' },
      { kind: 'action', id: 'open_config_marketplace', label: 'Skills', icon: 'skills' },
      { kind: 'action', id: 'open_config_mcp_browser', label: 'Nodes', icon: 'nodes' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    items: [
      { kind: 'tab', id: 'config', label: 'Config', icon: 'config' },
      { kind: 'tab', id: 'debug', label: 'Debug', icon: 'debug' },
      { kind: 'tab', id: 'logs', label: 'Logs', icon: 'logs' },
    ],
  },
  {
    id: 'resources',
    label: 'Resources',
    items: [
      { kind: 'tab', id: 'docs', label: 'Docs', icon: 'docs' },
    ],
  },
];

const DEFAULT_COLLAPSED_SECTIONS: Record<SidebarSectionId, boolean> = {
  chat: false,
  control: false,
  agent: false,
  settings: false,
  resources: false,
};

function SidebarIcon({ id }: { id: SidebarIconId }) {
  switch (id) {
    case 'chat':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 8.5h10M7 12h7" />
          <path d="M6 4.5h12a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 17.5H9L4.5 21V7A2.5 2.5 0 0 1 7 4.5Z" />
        </svg>
      );
    case 'overview':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5.5 18.5V13M11.5 18.5V6.5M17.5 18.5V10M3.5 19.5h17" />
        </svg>
      );
    case 'channels':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M15.5 8.5 8.5 15.5M10.8 6.5h4.7a2.6 2.6 0 0 1 0 5.2h-1M13.2 17.5H8.5a2.6 2.6 0 1 1 0-5.2h1" />
        </svg>
      );
    case 'instances':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="1.3" />
          <path d="M7.2 12a4.8 4.8 0 0 1 9.6 0M4.5 12a7.5 7.5 0 0 1 15 0M2.5 12a9.5 9.5 0 0 1 19 0" />
        </svg>
      );
    case 'sessions':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 3.5h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z" />
          <path d="M14 3.5v4h4M9 12h6M9 15.5h6" />
        </svg>
      );
    case 'usage':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 18.5V13M11.5 18.5v-8M17 18.5V8M3.5 19.5h17" />
        </svg>
      );
    case 'cronJobs':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2.5v4M12 17.5v4M21.5 12h-4M6.5 12h-4M18.7 5.3l-2.8 2.8M8.1 15.9l-2.8 2.8M18.7 18.7l-2.8-2.8M8.1 8.1 5.3 5.3" />
          <circle cx="12" cy="12" r="2.2" />
        </svg>
      );
    case 'agents':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4.5 8.5a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-9Z" />
        </svg>
      );
    case 'skills':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m13 2.5-9 11h6l-1 8 9-11h-6l1-8Z" />
        </svg>
      );
    case 'plugins':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7.5 4.5h4v4h-4Z" />
          <path d="M12.5 4.5h4v4h-4Z" />
          <path d="M7.5 9.5h4v4h-4Z" />
          <path d="M12.5 9.5h4v4h-4Z" />
          <path d="M10 14.5v4M14 14.5v4M8 18.5h8" />
        </svg>
      );
    case 'nodes':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4.5" y="5.5" width="15" height="11" rx="1.8" />
          <path d="M12 16.5v3M8.5 19.5h7" />
        </svg>
      );
    case 'config':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
          <path d="M19.8 13.4v-2.8l-2.2-.5a5.9 5.9 0 0 0-.7-1.7l1.2-1.9-2-2-1.9 1.2a5.9 5.9 0 0 0-1.7-.7l-.5-2.2h-2.8l-.5 2.2a5.9 5.9 0 0 0-1.7.7L5 4.5l-2 2 1.2 1.9a5.9 5.9 0 0 0-.7 1.7l-2.2.5v2.8l2.2.5c.2.6.4 1.2.7 1.7L3 17.7l2 2 1.9-1.2c.5.3 1.1.5 1.7.7l.5 2.2h2.8l.5-2.2c.6-.2 1.2-.4 1.7-.7l1.9 1.2 2-2-1.2-1.9c.3-.5.5-1.1.7-1.7l2.2-.5Z" />
        </svg>
      );
    case 'debug':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9.2 6.5h5.6M10.2 3.5h3.6M8 16.8V9.5a4 4 0 0 1 8 0v7.3a2.2 2.2 0 0 1-2.2 2.2h-3.6A2.2 2.2 0 0 1 8 16.8Z" />
          <path d="M5.5 11h3M18.5 11h-3M6.5 6.5l2 2M17.5 6.5l-2 2" />
        </svg>
      );
    case 'logs':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V6A1.5 1.5 0 0 1 7 4.5Z" />
          <path d="M9 9.5h6M9 13h6M9 16.5h4" />
        </svg>
      );
    case 'docs':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="5.5" y="3.5" width="13" height="17" rx="1.8" />
          <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h5" />
        </svg>
      );
    default:
      return null;
  }
}

export function SessionSidebar({
  activeTab,
  onSelectTab,
  onAction,
}: SessionSidebarProps) {
  const [collapsedSections, setCollapsedSections] = useState<Record<SidebarSectionId, boolean>>(
    () => ({ ...DEFAULT_COLLAPSED_SECTIONS }),
  );

  return (
    <aside className="session-sidebar" aria-label="Primary navigation">
      {SIDEBAR_SECTIONS.map((section) => {
        const collapsed = collapsedSections[section.id];
        const sectionListId = `session-sidebar-section-${section.id}`;

        return (
          <section key={section.id} className="session-sidebar__section">
            <button
              type="button"
              className="session-sidebar__section-toggle"
              onClick={() => {
                setCollapsedSections((prev) => ({
                  ...prev,
                  [section.id]: !prev[section.id],
                }));
              }}
              aria-expanded={!collapsed}
              aria-controls={sectionListId}
            >
              <span className="session-sidebar__section-label">{section.label}</span>
              <span className="session-sidebar__section-indicator" aria-hidden="true">
                {collapsed ? '+' : '\u2212'}
              </span>
            </button>

            {!collapsed && (
              <ul className="session-sidebar__nav-list" id={sectionListId}>
                {section.items.map((item) => {
                  const active = item.kind === 'tab' && item.id === activeTab;

                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`session-sidebar__nav-item ${active ? 'session-sidebar__nav-item--active' : ''}`}
                        onClick={() => {
                          if (item.kind === 'tab') {
                            onSelectTab(item.id);
                            return;
                          }
                          onAction(item.id);
                        }}
                        aria-current={active ? 'page' : undefined}
                      >
                        <span className="session-sidebar__nav-icon">
                          <SidebarIcon id={item.icon} />
                        </span>
                        <span>{item.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </aside>
  );
}
