# Plugin SDK Reference

The publishable SDK package is `@puukis/plugin-sdk`.

## Core helper

```ts
import { definePlugin } from '@puukis/plugin-sdk';

export default definePlugin({
  async setup(api) {
    api.registerCliCommand({
      name: 'example',
      description: 'Run the example command',
      run: async ({ stdout }) => {
        stdout.write('hello\n');
      },
    });
  },
});
```

## `PluginSetupApi`

The runtime passes a `PluginSetupApi` object into `setup(api)`.

### Read-only runtime context

- `pluginId`
- `manifest`
- `pluginConfig`
- `env`
- `coreConfig`
- `logger`
- `paths`

### Read-only runtime helpers

- `events.on(eventName, listener)`
- `sendMessageToSession(sessionId, content, source?)`
- `listSessions()`
- `getSessionHistory(sessionId, limit?)`

### Registration helpers

- `registerTool(definition)`
- `registerRpcMethod(name, handler)`
- `registerHttpRoute(definition)`
- `registerCliCommand(definition)`
- `registerService(definition)`

## Namespacing rules

- Tools are automatically exposed as `pluginId.localName`.
- RPC methods are called through the `plugin_invoke` envelope and stay local inside the plugin.
- HTTP routes are mounted under `/api/plugins/<pluginId>/<path>`.
- CLI commands are not prefixed automatically and must be declared in `manifest.cli.commands`.
- Services are stored internally as `pluginId.serviceId`.

## Config helpers

The SDK also exports:

- `definePluginConfigSchema(schema)` for authoring JSON Schema objects
- `isPluginHttpResult(value)` for runtime type narrowing

## Runtime constraints

- Plugins must ship compiled JavaScript.
- Keygate does not transpile TypeScript at runtime.
- Plugins run in-process, so untrusted plugins should not be installed.
