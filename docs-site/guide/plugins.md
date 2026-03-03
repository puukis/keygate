# Plugins

Keygate includes a first-class runtime plugin platform. Plugins are loaded in-process and can extend the gateway with tools, WebSocket RPC methods, HTTP routes, top-level CLI commands, background services, and bundled skills.

## What plugins can add

- namespaced tools exposed to the model as `pluginId.toolName`
- WebSocket RPC handlers invoked through `plugin_invoke`
- HTTP routes under `/api/plugins/<pluginId>/...`
- top-level CLI commands reserved in the plugin manifest
- background services with startup and shutdown hooks
- `skillsDirs` that flow into the existing skills discovery system

This feature does **not** include plugin-defined messaging channels or plugin-injected frontend bundles.

## Install sources

Keygate accepts all of the following:

- npm package specs
- git URLs
- local directories
- local `.tgz` tarballs

Examples:

```bash
keygate plugins install @acme/keygate-plugin --scope workspace
keygate plugins install https://github.com/acme/keygate-plugin.git --scope global
keygate plugins install ./path/to/local-plugin --scope workspace
keygate plugins install ./keygate-plugin.tgz --scope global
```

For local directories, `--link` creates a symlink or junction instead of copying files:

```bash
keygate plugins install ./path/to/local-plugin --link
```

## Local plugin directory requirements

A local plugin directory should contain:

- `keygate.plugin.json`
- the built JavaScript entry file referenced by `entry`
- an optional `plugin.config.schema.json`
- optional skills folders referenced by `skillsDirs`

During install and load, Keygate validates manifest-relative paths so they stay inside the plugin root.

## Manage plugins

```bash
keygate plugins list
keygate plugins info <plugin-id>
keygate plugins enable <plugin-id>
keygate plugins disable <plugin-id>
keygate plugins reload <plugin-id>
keygate plugins update <plugin-id>
keygate plugins remove <plugin-id>
keygate plugins remove <plugin-id> --purge
```

## How plugin surfaces map into Keygate

Once installed, a plugin id becomes the namespace used across the runtime:

- tools are exposed as `<plugin-id>.<tool-name>`
- RPC handlers are called through `plugin_invoke`
- HTTP routes are mounted under `/api/plugins/<pluginId>/...`
- CLI commands run as `keygate <command>`
- background services are started and stopped by the plugin host

## Web app management

The web app has a dedicated **Plugins** section in the configuration screen.

From there you can:

- install from a source string
- inspect plugin status and exposed surfaces
- enable, disable, reload, update, remove, or purge plugins
- edit plugin config using a schema-driven form when the plugin exposes a supported JSON Schema
- fall back to raw JSON editing for advanced schemas

## Hot reload behavior

When `plugins.load.watch` is enabled, Keygate watches active plugin roots and attempts an in-process reload after file changes.

- successful reloads replace the live instance atomically
- failed reloads keep the previous working instance active
- reload failures are surfaced as plugin diagnostics and `lastError`

## Trust model

Plugins run inside the Keygate process. Treat them as trusted code:

- review plugin source before installing it
- prefer local or pinned sources
- use `server.apiToken` before exposing operator-only plugin routes
- remember that plugin services and tools run with the same host privileges as the Keygate runtime

## Further reading

- [Plugin Manifest Reference](/reference/plugin-manifest)
- [Plugin Configuration](/reference/plugin-configuration)
- [Plugin SDK Reference](/reference/plugin-sdk)
