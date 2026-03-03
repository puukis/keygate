# Plugin Configuration

Plugin settings live in `~/.config/keygate/config.json` under the `plugins` block.

## Persisted shape

```json
{
  "server": {
    "apiToken": "shared-bearer-token-for-operator-routes"
  },
  "plugins": {
    "load": {
      "watch": true,
      "watchDebounceMs": 250,
      "paths": []
    },
    "install": {
      "nodeManager": "npm"
    },
    "entries": {
      "example-plugin": {
        "enabled": true,
        "config": {},
        "env": {}
      }
    }
  }
}
```

## `plugins.load`

- `watch`: enables file watching for hot reload
- `watchDebounceMs`: debounces repeated file events
- `paths`: explicit plugin search roots

If `plugins.load.paths` is empty, Keygate still honors the legacy `skills.load.pluginDirs` search roots.

## `plugins.install`

- `nodeManager`: package manager used for `pack` and dependency install steps

Allowed values:

- `npm`
- `pnpm`
- `yarn`
- `bun`

## `plugins.entries`

Each plugin id can persist:

- `enabled`
- `config`
- `env`

`config` is validated against the plugin’s JSON Schema (if present) before activation and before saves from the CLI or web app.

## `server.apiToken`

This token is required for plugin HTTP routes that declare `auth: "operator"`.

Requests must send:

```http
Authorization: Bearer <server.apiToken>
```

If a plugin registers an operator route and no token is configured, plugin activation fails.

## Environment variables

- `KEYGATE_SERVER_API_TOKEN`
- `KEYGATE_PLUGINS_WATCH`
- `KEYGATE_PLUGINS_WATCH_DEBOUNCE_MS`
- `KEYGATE_PLUGINS_PATHS`
- `KEYGATE_PLUGINS_NODE_MANAGER`
