import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SIDEBAR_SECTIONS, SessionSidebar } from './SessionSidebar';

describe('SIDEBAR_SECTIONS', () => {
  it('keeps the expected section order', () => {
    expect(SIDEBAR_SECTIONS.map((section) => section.label)).toEqual([
      'Chat',
      'Control',
      'Agent',
      'Settings',
      'Resources',
    ]);
  });

  it('maps control items and cron jobs to the expected ids', () => {
    const control = SIDEBAR_SECTIONS.find((section) => section.id === 'control');
    expect(control).toBeTruthy();
    expect(control?.items.map((item) => item.label)).toEqual([
      'Overview',
      'Channels',
      'Instances',
      'Sessions',
      'Usage',
      'Cron Jobs',
    ]);

    const cronJobsItem = control?.items.find((item) => item.label === 'Cron Jobs');
    expect(cronJobsItem).toMatchObject({
      kind: 'tab',
      id: 'automations',
    });
  });

  it('keeps action routes for skills/nodes and a dedicated config tab', () => {
    const allItems = SIDEBAR_SECTIONS.flatMap((section) => section.items);

    const skills = allItems.find((item) => item.label === 'Skills');
    expect(skills).toMatchObject({
      kind: 'action',
      id: 'open_config_marketplace',
    });

    const nodes = allItems.find((item) => item.label === 'Nodes');
    expect(nodes).toMatchObject({
      kind: 'action',
      id: 'open_config_mcp_browser',
    });

    const config = allItems.find((item) => item.label === 'Config');
    expect(config).toMatchObject({
      kind: 'tab',
      id: 'config',
    });
  });
});

describe('SessionSidebar rendering', () => {
  it('renders all grouped sections expanded by default', () => {
    const html = renderToStaticMarkup(
      <SessionSidebar
        activeTab="chat"
        onSelectTab={() => {}}
        onAction={() => {}}
      />,
    );

    expect(html).toContain('Control');
    expect(html).toContain('Agent');
    expect(html).toContain('Settings');
    expect(html).toContain('Resources');
    expect(html).toContain('Cron Jobs');
    expect(html).toContain('aria-expanded="true"');
  });

  it('applies aria-current on the active tab', () => {
    const html = renderToStaticMarkup(
      <SessionSidebar
        activeTab="automations"
        onSelectTab={() => {}}
        onAction={() => {}}
      />,
    );

    expect(html).toContain('aria-current="page"');
  });
});
