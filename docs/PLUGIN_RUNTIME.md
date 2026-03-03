# Plugin Runtime

This document describes the in-process plugin host added to Keygate.

## Host lifecycle

1. Keygate loads config and discovers plugin manifests.
2. Runtime plugin config is validated against the plugin JSON Schema, if present.
3. The plugin entry module is imported dynamically.
4. `setup(api)` runs against a staging registry.
5. Registered services start before the staged instance replaces the live one.
6. If setup or service startup fails, the previous live instance remains active.

## Extension surfaces

Plugins can register:

- namespaced tools
- WebSocket RPC handlers
- HTTP routes under `/api/plugins/<pluginId>/...`
- top-level CLI commands
- background services
- bundled skills through `skillsDirs`

## Hot reload

When plugin watch mode is enabled, the runtime watches active plugin roots and attempts a debounced reload.

- Successful reloads replace the plugin atomically.
- Failed reloads keep the current instance active and store the failure in `lastError`.

## Trust model

Plugins run in the same Node.js process as the gateway. They are trusted code and should be reviewed before installation.

## Deliberate exclusions

This runtime feature does not support:

- plugin-defined messaging channels
- plugin-injected frontend bundles
- remote plugin marketplace services
