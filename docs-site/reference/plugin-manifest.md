# Plugin Manifest Reference

Keygate uses `keygate.plugin.json` for both runtime plugins and legacy skill-only plugins.

## Runtime manifest

```json
{
  "schemaVersion": 1,
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "1.2.3",
  "description": "Adds tools and runtime hooks",
  "entry": "./dist/index.js",
  "engine": {
    "keygate": "^0.1.11"
  },
  "skillsDirs": ["./skills"],
  "configSchema": "./plugin.config.schema.json",
  "cli": {
    "commands": [
      {
        "name": "example",
        "summary": "Run the example command"
      }
    ]
  }
}
```

## Required fields for runtime plugins

- `schemaVersion` defaults to `1` when omitted
- `id` must match `^[a-z0-9][a-z0-9-]{1,62}$`
- `name`
- `version`
- `description`
- `entry`
- `engine.keygate`

## Optional runtime fields

- `skillsDirs`
- `configSchema`
- `cli.commands`

## Legacy compatibility

Older skill-only manifests still work when they omit `entry` and only provide `skillsDirs`.

Legacy fields that remain supported for compatibility:

- `enabled`
- `requiresConfig`

## Validation rules

- all manifest-relative paths must stay inside the plugin root after path resolution
- `entry` must point to `.js`, `.mjs`, or `.cjs`
- `configSchema` must point to a `.json` file
- `engine.keygate` must match the installed `@puukis/core` version
- `cli.commands` reserve top-level command names before plugin code loads
- runtime registration must exactly match `cli.commands`

## Collision rules

- duplicate plugin ids are resolved by source precedence
- higher-precedence manifests win
- dropped duplicates are reported in plugin diagnostics
- built-in CLI commands cannot be shadowed by plugins
