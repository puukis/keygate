# WebSocket Event Reference

This page summarizes the major websocket events used by the web app runtime bridge.

## Connection and setup

- `connected`: initial handshake + runtime state snapshot
- `models`: model catalog response for selected provider
- `model_changed`: confirms provider/model update

## Session lifecycle

- `session_snapshot`: full list of known sessions/messages metadata
- `session_created`: new session created
- `session_switched`: active session changed
- `session_deleted`: session removed
- `session_renamed`: session title updated
- `session_cleared`: main session contents reset

## Message stream events

- `message_received`: start of assistant turn
- `session_chunk`: streaming chunk
- `session_message_end`: stream completion
- `session_cancelled`: cancelled turn

## Tool and provider events

- `tool_start`: tool call started
- `tool_end`: tool call finished
- `provider_event`: raw provider-side event surfaced to UI timeline

## Confirmation and safety events

- `confirm_request`: runtime requests user approval
- `mode_changed`: safe/spicy mode changed
- `spicy_enabled_changed`: spicy capability unlocked/changed
- `spicy_obedience_changed`: obedience option changed

## Config and channel events

- `discord_config_updated`
- `slack_config_updated`
- `whatsapp_config_updated`
- `whatsapp_login_qr`
- `whatsapp_login_result`
- `mcp_browser_status`

## WhatsApp request messages

The web app sends these websocket requests for the WhatsApp channel:

- `set_whatsapp_config`
- `start_whatsapp_login`
- `cancel_whatsapp_login`

## Scheduler and memory events

- `scheduler_list_result`
- `scheduler_create_result`
- `scheduler_update_result`
- `scheduler_delete_result`
- `scheduler_trigger_result`
- `memory_list_result`
- `memory_search_result`
- `memory_set_result`
- `memory_delete_result`

## Plugin management messages

Requests:

- `plugins_list`
- `plugins_info`
- `plugins_install`
- `plugins_update`
- `plugins_remove`
- `plugins_enable`
- `plugins_disable`
- `plugins_reload`
- `plugins_set_config`
- `plugins_validate`

Results:

- `plugins_list_result`
- `plugins_info_result`
- `plugins_install_result`
- `plugins_update_result`
- `plugins_remove_result`
- `plugins_enable_result`
- `plugins_disable_result`
- `plugins_reload_result`
- `plugins_set_config_result`
- `plugins_validate_result`

## Plugin runtime invocation

- `plugin_invoke`: generic request envelope for plugin-defined RPC methods
- `plugin_result`: successful plugin RPC response
- `plugin_error`: sanitized plugin RPC failure response

## Error event

- `error`: generic runtime error payload; should be surfaced in active session state

---

For exact payload structure, inspect the corresponding TypeScript handlers in `packages/web/src/App.tsx` and runtime emitters in `packages/core`.
