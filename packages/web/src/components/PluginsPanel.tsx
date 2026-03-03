import { useEffect, useMemo, useState } from 'react';
import './PluginsPanel.css';

export interface PluginRouteView {
  method: string;
  path: string;
  auth: 'public' | 'operator';
}

export interface PluginManifestView {
  id: string;
  name: string;
  version?: string | null;
  description?: string | null;
  entry?: string | null;
  skillsDirs?: string[];
}

export interface PluginListEntryView {
  manifest: PluginManifestView;
  status: 'active' | 'disabled' | 'unhealthy' | 'available';
  enabled: boolean;
  sourceKind: string;
  scope: 'workspace' | 'global' | null;
  version: string | null;
  description: string | null;
  tools: string[];
  rpcMethods: string[];
  httpRoutes: PluginRouteView[];
  cliCommands: string[];
  serviceIds: string[];
  lastError: string | null;
  configSchema: Record<string, unknown> | null;
}

export interface PluginInfoView extends PluginListEntryView {
  manifestJson: Record<string, unknown>;
  config: Record<string, unknown>;
  env: Record<string, string>;
}

export interface PluginValidationView {
  valid: boolean;
  issues: Array<{ path: string; message: string }>;
  schema: Record<string, unknown> | null;
}

interface PluginsPanelProps {
  connected: boolean;
  disabled: boolean;
  plugins: PluginListEntryView[];
  selectedPlugin: PluginInfoView | null;
  validation: PluginValidationView | null;
  onRefresh: () => void;
  onSelectPlugin: (pluginId: string) => void;
  onInstall: (source: string, scope: 'workspace' | 'global', link: boolean) => void;
  onEnable: (pluginId: string) => void;
  onDisable: (pluginId: string) => void;
  onReload: (pluginId: string) => void;
  onUpdate: (pluginId: string) => void;
  onRemove: (pluginId: string, purge: boolean) => void;
  onValidate: (pluginId: string) => void;
  onSaveConfig: (pluginId: string, configValue: Record<string, unknown>) => void;
}

export function PluginsPanel({
  connected,
  disabled,
  plugins,
  selectedPlugin,
  validation,
  onRefresh,
  onSelectPlugin,
  onInstall,
  onEnable,
  onDisable,
  onReload,
  onUpdate,
  onRemove,
  onValidate,
  onSaveConfig,
}: PluginsPanelProps) {
  const [installSource, setInstallSource] = useState('');
  const [installScope, setInstallScope] = useState<'workspace' | 'global'>('workspace');
  const [installLink, setInstallLink] = useState(false);
  const [configDraft, setConfigDraft] = useState<Record<string, unknown>>({});
  const [rawConfigDraft, setRawConfigDraft] = useState('{}');
  const [rawConfigError, setRawConfigError] = useState<string | null>(null);

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  useEffect(() => {
    if (!selectedPlugin) {
      setConfigDraft({});
      setRawConfigDraft('{}');
      setRawConfigError(null);
      return;
    }

    const nextConfig = { ...(selectedPlugin.config ?? {}) };
    setConfigDraft(nextConfig);
    setRawConfigDraft(JSON.stringify(nextConfig, null, 2));
    setRawConfigError(null);
  }, [selectedPlugin]);

  const supportedSchema = useMemo(() => {
    const schema = selectedPlugin?.configSchema ?? null;
    return schema && supportsSchemaDrivenEditor(schema) ? schema : null;
  }, [selectedPlugin]);

  const canSaveStructured = Boolean(selectedPlugin && supportedSchema);
  const parsedRawConfig = useMemo(() => {
    try {
      const parsed = JSON.parse(rawConfigDraft) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }, [rawConfigDraft]);

  return (
    <div className="plugins-panel">
      <div className="plugins-panel__toolbar">
        <div className="plugins-panel__install">
          <input
            type="text"
            value={installSource}
            onChange={(event) => setInstallSource(event.target.value)}
            placeholder="npm spec, git URL, local dir, or .tgz"
            spellCheck={false}
            autoComplete="off"
            disabled={!connected || disabled}
          />
          <select
            value={installScope}
            onChange={(event) => setInstallScope(event.target.value as 'workspace' | 'global')}
            disabled={!connected || disabled}
          >
            <option value="workspace">Workspace</option>
            <option value="global">Global</option>
          </select>
          <label className="plugins-panel__toggle">
            <input
              type="checkbox"
              checked={installLink}
              onChange={(event) => setInstallLink(event.target.checked)}
              disabled={!connected || disabled}
            />
            <span>Link</span>
          </label>
          <button
            className="btn-secondary"
            onClick={() => {
              const source = installSource.trim();
              if (!source) {
                return;
              }
              onInstall(source, installScope, installLink);
              setInstallSource('');
            }}
            disabled={!connected || disabled || installSource.trim().length === 0}
          >
            Install
          </button>
        </div>
        <button
          className="btn-secondary"
          onClick={onRefresh}
          disabled={!connected || disabled}
        >
          Refresh
        </button>
      </div>

      <div className="plugins-panel__layout">
        <div className="plugins-panel__list">
          {plugins.length === 0 ? (
            <div className="plugins-panel__empty">No plugins discovered yet.</div>
          ) : (
            <ul className="plugins-panel__items">
              {plugins.map((plugin) => {
                const active = selectedPlugin?.manifest.id === plugin.manifest.id;
                return (
                  <li key={plugin.manifest.id}>
                    <button
                      type="button"
                      className={`plugins-panel__item${active ? ' plugins-panel__item--active' : ''}`}
                      onClick={() => onSelectPlugin(plugin.manifest.id)}
                    >
                      <span className="plugins-panel__item-header">
                        <strong>{plugin.manifest.id}</strong>
                        <span className={`plugins-panel__status plugins-panel__status--${plugin.status}`}>
                          {plugin.status}
                        </span>
                      </span>
                      <span className="plugins-panel__item-copy">
                        {plugin.description || plugin.manifest.name}
                      </span>
                      <span className="plugins-panel__item-meta">
                        {plugin.scope || plugin.sourceKind}
                        {plugin.version ? ` • ${plugin.version}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="plugins-panel__detail">
          {selectedPlugin ? (
            <>
              <div className="plugins-panel__detail-header">
                <div>
                  <h4>{selectedPlugin.manifest.id}</h4>
                  <p>{selectedPlugin.description || selectedPlugin.manifest.name}</p>
                </div>
                <div className="plugins-panel__actions">
                  {selectedPlugin.enabled ? (
                    <button
                      className="btn-secondary"
                      onClick={() => onDisable(selectedPlugin.manifest.id)}
                      disabled={!connected || disabled}
                    >
                      Disable
                    </button>
                  ) : (
                    <button
                      className="btn-secondary"
                      onClick={() => onEnable(selectedPlugin.manifest.id)}
                      disabled={!connected || disabled}
                    >
                      Enable
                    </button>
                  )}
                  <button
                    className="btn-secondary"
                    onClick={() => onReload(selectedPlugin.manifest.id)}
                    disabled={!connected || disabled}
                  >
                    Reload
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => onUpdate(selectedPlugin.manifest.id)}
                    disabled={!connected || disabled}
                  >
                    Update
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => onRemove(selectedPlugin.manifest.id, false)}
                    disabled={!connected || disabled}
                  >
                    Remove
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => onRemove(selectedPlugin.manifest.id, true)}
                    disabled={!connected || disabled}
                  >
                    Purge
                  </button>
                </div>
              </div>

              <div className="plugins-panel__stats">
                <div><strong>Tools</strong><span>{selectedPlugin.tools.length}</span></div>
                <div><strong>RPC</strong><span>{selectedPlugin.rpcMethods.length}</span></div>
                <div><strong>Routes</strong><span>{selectedPlugin.httpRoutes.length}</span></div>
                <div><strong>Commands</strong><span>{selectedPlugin.cliCommands.length}</span></div>
              </div>

              <div className="plugins-panel__meta">
                <p><strong>Status:</strong> {selectedPlugin.status}</p>
                <p><strong>Scope:</strong> {selectedPlugin.scope || selectedPlugin.sourceKind}</p>
                <p><strong>Version:</strong> {selectedPlugin.version || '(none)'}</p>
                <p><strong>Entry:</strong> {firstString(selectedPlugin.manifestJson['entry']) || '(none)'}</p>
                {selectedPlugin.lastError && (
                  <p className="plugins-panel__error"><strong>Last Error:</strong> {selectedPlugin.lastError}</p>
                )}
              </div>

              <div className="plugins-panel__section">
                <div className="plugins-panel__section-header">
                  <h5>Config</h5>
                  <button
                    className="btn-secondary"
                    onClick={() => onValidate(selectedPlugin.manifest.id)}
                    disabled={!connected || disabled}
                  >
                    Validate
                  </button>
                </div>

                {supportedSchema ? (
                  <SchemaForm
                    schema={supportedSchema}
                    value={configDraft}
                    onChange={(nextValue) => {
                      setConfigDraft(nextValue);
                      setRawConfigDraft(JSON.stringify(nextValue, null, 2));
                      setRawConfigError(null);
                    }}
                  />
                ) : (
                  <>
                    <textarea
                      className="plugins-panel__json"
                      value={rawConfigDraft}
                      onChange={(event) => {
                        const next = event.target.value;
                        setRawConfigDraft(next);
                        try {
                          const parsed = JSON.parse(next) as Record<string, unknown>;
                          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                            setRawConfigError('Config JSON must be an object.');
                            return;
                          }
                          setConfigDraft(parsed);
                          setRawConfigError(null);
                        } catch {
                          setRawConfigError('Config JSON is invalid.');
                        }
                      }}
                      spellCheck={false}
                      disabled={!connected || disabled}
                    />
                    <small className="config-note">
                      Using raw JSON because this schema uses unsupported advanced constructs.
                    </small>
                  </>
                )}

                {validation && !validation.valid && (
                  <div className="plugins-panel__validation">
                    {validation.issues.map((issue) => (
                      <div key={`${issue.path}:${issue.message}`}>
                        {issue.path}: {issue.message}
                      </div>
                    ))}
                  </div>
                )}
                {rawConfigError && (
                  <div className="plugins-panel__validation">{rawConfigError}</div>
                )}

                <button
                  className="btn-secondary"
                  onClick={() => {
                    if (!selectedPlugin) {
                      return;
                    }
                    if (canSaveStructured) {
                      onSaveConfig(selectedPlugin.manifest.id, configDraft);
                      return;
                    }
                    if (!parsedRawConfig || rawConfigError) {
                      return;
                    }
                    onSaveConfig(selectedPlugin.manifest.id, parsedRawConfig);
                  }}
                  disabled={!connected || disabled || Boolean(rawConfigError)}
                >
                  Save Config
                </button>
              </div>

              <div className="plugins-panel__section">
                <h5>Exposed Surfaces</h5>
                <div className="plugins-panel__chips">
                  {selectedPlugin.tools.map((tool) => (
                    <span key={tool} className="plugins-panel__chip">{tool}</span>
                  ))}
                  {selectedPlugin.cliCommands.map((command) => (
                    <span key={command} className="plugins-panel__chip">{command}</span>
                  ))}
                  {selectedPlugin.httpRoutes.map((route) => (
                    <span key={`${route.method}:${route.path}`} className="plugins-panel__chip">
                      {route.method} /api/plugins/{selectedPlugin.manifest.id}/{route.path}
                    </span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="plugins-panel__empty">Select a plugin to inspect and manage it.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (nextValue: Record<string, unknown>) => void;
}) {
  const properties = normalizeProperties(schema['properties']);

  return (
    <div className="plugins-panel__schema-grid">
      {Object.entries(properties).map(([key, propertySchema]) => (
        <SchemaField
          key={key}
          label={key}
          schema={propertySchema}
          value={value[key]}
          onChange={(nextFieldValue) => {
            onChange({
              ...value,
              [key]: nextFieldValue,
            });
          }}
        />
      ))}
    </div>
  );
}

function SchemaField({
  label,
  schema,
  value,
  onChange,
}: {
  label: string;
  schema: Record<string, unknown>;
  value: unknown;
  onChange: (nextValue: unknown) => void;
}) {
  const type = firstString(schema['type']);
  const enumValues = Array.isArray(schema['enum']) ? schema['enum'].filter((entry): entry is string => typeof entry === 'string') : [];

  if (type === 'object') {
    const objectValue = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const properties = normalizeProperties(schema['properties']);
    return (
      <fieldset className="plugins-panel__nested">
        <legend>{label}</legend>
        {Object.entries(properties).map(([key, childSchema]) => (
          <SchemaField
            key={key}
            label={key}
            schema={childSchema}
            value={objectValue[key]}
            onChange={(nextFieldValue) => {
              onChange({
                ...objectValue,
                [key]: nextFieldValue,
              });
            }}
          />
        ))}
      </fieldset>
    );
  }

  if (type === 'boolean') {
    return (
      <label className="plugins-panel__field plugins-panel__field--checkbox">
        <span>{label}</span>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    );
  }

  if (type === 'array') {
    const items = schema['items'] && typeof schema['items'] === 'object' && !Array.isArray(schema['items'])
      ? schema['items'] as Record<string, unknown>
      : null;
    const itemType = items ? firstString(items['type']) : null;
    const current = Array.isArray(value) ? value.map((entry) => String(entry)) : [];
    return (
      <label className="plugins-panel__field">
        <span>{label}</span>
        <input
          type="text"
          value={current.join(', ')}
          onChange={(event) => {
            const next = event.target.value
              .split(',')
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0);
            onChange(itemType === 'number' || itemType === 'integer'
              ? next.map((entry) => Number(entry))
              : next);
          }}
        />
      </label>
    );
  }

  if (enumValues.length > 0) {
    return (
      <label className="plugins-panel__field">
        <span>{label}</span>
        <select
          value={typeof value === 'string' ? value : enumValues[0] ?? ''}
          onChange={(event) => onChange(event.target.value)}
        >
          {enumValues.map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </select>
      </label>
    );
  }

  if (type === 'number' || type === 'integer') {
    return (
      <label className="plugins-panel__field">
        <span>{label}</span>
        <input
          type="number"
          step={type === 'integer' ? 1 : 'any'}
          value={typeof value === 'number' && Number.isFinite(value) ? String(value) : ''}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === '' ? undefined : Number(raw));
          }}
        />
      </label>
    );
  }

  return (
    <label className="plugins-panel__field">
      <span>{label}</span>
      <input
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function supportsSchemaDrivenEditor(schema: Record<string, unknown>): boolean {
  if ('oneOf' in schema || 'anyOf' in schema || 'allOf' in schema || 'patternProperties' in schema) {
    return false;
  }

  const type = firstString(schema['type']);
  if (type === 'object') {
    const properties = normalizeProperties(schema['properties']);
    return Object.values(properties).every((child) => supportsSchemaDrivenEditor(child));
  }

  if (type === 'array') {
    const items = schema['items'];
    if (!items || Array.isArray(items) || typeof items !== 'object') {
      return false;
    }
    return supportsSchemaDrivenEditor(items as Record<string, unknown>);
  }

  return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean';
}

function normalizeProperties(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(([key, entry]) => [key, entry as Record<string, unknown>]);

  return Object.fromEntries(entries);
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
