# Plugin SDK Reference

The publishable SDK package is `@puukis/plugin-sdk`.

## Minimal example

```ts
import { definePlugin } from '@puukis/plugin-sdk';

export default definePlugin({
  async setup(api) {
    api.registerHook('before_model_resolve', async (payload) => {
      if (payload.sessionId.startsWith('web:ops')) {
        return {
          model: 'gpt-4o',
        };
      }
    }, { priority: 100 });

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

Keygate passes `setup(api)` a runtime API with context, helpers, and registration functions.

### Context fields

- `pluginId`
- `manifest`
- `pluginConfig`
- `env`
- `coreConfig`
- `logger`
- `paths`

### Read-only helpers

- `events.on(eventName, listener)`
- `sendMessageToSession(sessionId, content, source?)`
- `listSessions()`
- `getSessionHistory(sessionId, limit?)`

### Registration helpers

- `registerHook(name, handler, { priority? })`
- `registerTool(definition)`
- `registerRpcMethod(name, handler)`
- `registerHttpRoute(definition)`
- `registerCliCommand(definition)`
- `registerService(definition)`

## Runtime hooks

Keygate now exposes first-class typed runtime hooks in addition to the low-level event bus.

### Mutating hooks

These can return a partial payload and Keygate merges the result into the working payload:

- `before_model_resolve`
- `before_prompt_build`
- `message_received`
- `before_tool_call`
- `before_compaction`

Typical use cases:

- override the model for one class of sessions
- inject prompt context
- add env overlay values
- rewrite tool arguments
- redact or normalize inbound content before model dispatch

### Observer hooks

These are notification-style hooks. Return values are ignored:

- `message_sent`
- `after_tool_call`
- `after_compaction`
- `session_start`
- `session_end`
- `subagent_spawning`
- `subagent_spawned`
- `subagent_ended`
- `gateway_start`
- `gateway_stop`

Typical use cases:

- auditing
- telemetry
- side-channel alerts
- plugin-maintained caches or indexes

### Hook ordering and failure behavior

- higher `priority` runs first
- equal priority falls back to plugin id ordering
- hook failures do not abort the turn
- failures are recorded in plugin diagnostics and surfaced by `keygate doctor`

## Hook list

- `before_model_resolve`: inspect or override provider/model/reasoning before the Brain resolves the turn model
- `before_prompt_build`: edit the system prompt or env overlay before prompt assembly
- `message_received`: inspect or rewrite normalized inbound content
- `message_sent`: observe final outbound assistant content
- `before_tool_call`: inspect or rewrite tool arguments before execution
- `after_tool_call`: inspect the completed tool result
- `before_compaction`: inspect or rewrite compaction input before summary generation
- `after_compaction`: observe the stored summary and compaction ref
- `session_start`: observe newly created top-level or delegated sessions
- `session_end`: observe resets/deletes and delegated teardown
- `subagent_spawning`: observe delegated-session creation intent
- `subagent_spawned`: observe successful delegated-session creation
- `subagent_ended`: observe delegated-session termination
- `gateway_start`: observe gateway startup with active mode/provider/model
- `gateway_stop`: observe gateway shutdown

## Namespacing rules

- tools are exposed as `pluginId.localName`
- RPC methods are called through `plugin_invoke`
- HTTP routes mount under `/api/plugins/<pluginId>/<path>`
- CLI commands are not prefixed automatically and must be declared in `manifest.cli.commands`
- services are tracked internally as `pluginId.serviceId`

## Event bus vs hooks

Use `events.on(...)` when you want low-level runtime events and do not need a typed mutating contract.

Use `registerHook(...)` when:

- the timing relative to model/tool/session flow matters
- you need typed payloads
- you may want to mutate the request path for supported hook types

## Other SDK helpers

The SDK also exports:

- `definePlugin(plugin)`
- `definePluginConfigSchema(schema)`
- `isPluginHttpResult(value)`

## Runtime constraints

- plugins must ship compiled JavaScript
- Keygate does not transpile TypeScript at runtime
- plugins run in-process, so only install trusted code
