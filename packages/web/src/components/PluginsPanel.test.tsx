import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PluginsPanel } from './PluginsPanel';

describe('PluginsPanel', () => {
  it('renders plugin list entries and config actions', () => {
    const html = renderToStaticMarkup(
      <PluginsPanel
        connected
        disabled={false}
        plugins={[{
          manifest: {
            id: 'echo-tool',
            name: 'Echo Tool',
          },
          status: 'active',
          enabled: true,
          sourceKind: 'workspace',
          scope: 'workspace',
          version: '0.1.0',
          description: 'Example plugin',
          tools: ['echo-tool.echo'],
          rpcMethods: ['echo'],
          httpRoutes: [{ method: 'POST', path: 'echo', auth: 'operator' }],
          cliCommands: ['echo-tool'],
          serviceIds: ['echo-tool.heartbeat'],
          lastError: null,
          configSchema: null,
        }]}
        selectedPlugin={null}
        validation={null}
        onRefresh={vi.fn()}
        onSelectPlugin={vi.fn()}
        onInstall={vi.fn()}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onReload={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
        onValidate={vi.fn()}
        onSaveConfig={vi.fn()}
      />,
    );

    expect(html).toContain('echo-tool');
    expect(html).toContain('Install');
    expect(html).toContain('Select a plugin');
  });
});
