# Plugin Manifest

Keygate plugin manifests are stored as `keygate.plugin.json`.

## Runtime plugin fields

- `schemaVersion`
- `id`
- `name`
- `version`
- `description`
- `entry`
- `engine.keygate`
- `skillsDirs`
- `configSchema`
- `cli.commands`

## Compatibility fields

Legacy skill-only manifests can still use:

- `enabled`
- `requiresConfig`

If `entry` is omitted and `skillsDirs` is present, Keygate treats the manifest as a skill-only plugin manifest and keeps the old discovery behavior.

## Validation

- all relative paths must resolve inside the plugin root
- `entry` must be a JavaScript file
- `configSchema` must be a JSON file
- `engine.keygate` must satisfy the installed core version
- CLI registrations must match `cli.commands` exactly
