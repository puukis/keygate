# WebSocket Event Reference

This page summarizes the primary websocket bridge between the gateway and UI clients.

## Connection and setup

Server push events:

- `connected`: initial runtime snapshot
- `models`: model catalog response
- `model_changed`: provider/model update confirmation
- `mcp_browser_status`: browser MCP health snapshot

WebChat guest connections use `/webchat/ws` instead of `/ws` and only receive session-scoped chat, canvas, and action events.

Guest-only requests on `/webchat/ws`:

- `message`
- `cancel_session`
- `poll-vote`

## Session lifecycle

Requests:

- `get_session_snapshot`
- `new_session`
- `switch_session`
- `rename_session`
- `clear_session`
- `delete_session`
- `delete_all_sessions`
- `cancel_session`

Results and push events:

- `session_snapshot`
- `session_created`
- `session_switched`
- `session_renamed`
- `session_cleared`
- `session_deleted`
- `session_cancelled`

## Message stream events

Requests:

- `message`

Push events:

- `message_received`
- `session_chunk`
- `session_message_end`
- `session_user_message`

## Tool and provider events

Push events:

- `tool_start`
- `tool_end`
- `provider_event`
- `canvas:state`
- `canvas:user_action`
- `canvas:close`
- `channel:action`
- `channel:action_result`
- `channel:poll`
- `channel:poll_vote`
- `voice:session`

`canvas:user_action` is emitted to operator and guest clients when a canvas surface sends a structured bridge action back to the gateway.

## WebChat link management

Operator REST surfaces:

- `GET /api/webchat/links`
- `POST /api/webchat/links`
- `DELETE /api/webchat/links/:id`
- `GET /api/channel-actions?sessionId=...`
- `POST /api/channel-actions`
- `GET /api/channel-polls?sessionId=...`

Guest upload surface:

- `POST /webchat/uploads/attachment`

## Usage, debug, and compaction

Requests:

- `usage_summary`
- `debug_events`
- `session_compact`

Results and push events:

- `usage_summary_result`
- `usage_snapshot`
- `debug_events_result`
- `debug_event`
- `session_compacted`

These power the web `Usage` tab, `Debug` tab, and session compaction flow.

## Safety and mode control

Requests:

- `confirm_response`
- `set_mode`
- `enable_spicy_mode`
- `set_spicy_obedience`

Push events:

- `confirm_request`
- `mode_changed`
- `spicy_enabled_changed`
- `spicy_obedience_changed`

## Model, browser, and config requests

Requests:

- `get_models`
- `set_model`
- `get_mcp_browser_status`
- `setup_mcp_browser`
- `remove_mcp_browser`
- `set_browser_policy`
- `set_discord_config`
- `set_slack_config`
- `set_whatsapp_config`
- `start_whatsapp_login`
- `cancel_whatsapp_login`

Results and push events include:

- `discord_config_updated`
- `slack_config_updated`
- `whatsapp_config_updated`
- `whatsapp_login_qr`
- `whatsapp_login_result`

## Scheduler, webhooks, routing, and Gmail automations

Scheduler requests:

- `scheduler_list`
- `scheduler_create`
- `scheduler_update`
- `scheduler_delete`
- `scheduler_trigger`

Webhook requests:

- `webhook_list`
- `webhook_create`
- `webhook_update`
- `webhook_delete`
- `webhook_rotate_secret`

Routing requests:

- `routing_list`
- `routing_create`
- `routing_delete`

Gmail requests:

- `gmail_watch_list`
- `gmail_watch_create`
- `gmail_watch_update`
- `gmail_watch_delete`
- `gmail_watch_test`

Results:

- `scheduler_list_result`
- `scheduler_create_result`
- `scheduler_update_result`
- `scheduler_delete_result`
- `scheduler_trigger_result`
- `webhook_list_result`
- `webhook_create_result`
- `webhook_update_result`
- `webhook_delete_result`
- `webhook_rotate_secret_result`
- `routing_list_result`
- `routing_create_result`
- `routing_delete_result`
- `gmail_watch_list_result`
- `gmail_watch_create_result`
- `gmail_watch_update_result`
- `gmail_watch_delete_result`
- `gmail_watch_test_result`

## Sandboxes and device nodes

Sandbox requests:

- `sandbox_list`
- `sandbox_explain`
- `sandbox_recreate`

Sandbox results:

- `sandbox_list_result`
- `sandbox_explain_result`
- `sandbox_recreate_result`

Node pairing and registry requests:

- `node_pair_request`
- `node_pair_pending`
- `node_pair_approve`
- `node_pair_reject`
- `node_list`
- `node_describe`

Node runtime requests:

- `node_register`
- `node_heartbeat`
- `node_invoke`
- `node_invoke_response`

Node results and push events:

- `node_pair_request_result`
- `node_pair_pending_result`
- `node_pair_approve_result`
- `node_pair_reject_result`
- `node_list_result`
- `node_describe_result`
- `node_register_result`
- `node_invoke_request`
- `node_invoke_result`
- `node_status_changed`

`node_status_changed` is a broadcast push used by the web app and macOS app to reflect online/offline state transitions.

## Memory and delegated sessions

Memory requests:

- `memory_list`
- `memory_get`
- `memory_set`
- `memory_delete`
- `memory_search`
- `memory_namespaces`
- `memory_vector_search`
- `memory_reindex`
- `memory_status`

Delegated session requests:

- `sessions_list`
- `sessions_spawn`
- `sessions_history`
- `sessions_send`
- `subagents`

Results:

- `memory_list_result`
- `memory_get_result`
- `memory_set_result`
- `memory_delete_result`
- `memory_status_result`

`memory_status_result` and `GET /api/status` now both report backend selection, migration phase, batch mode, and enabled multimodal modalities.
- `memory_search_result`
- `memory_namespaces_result`
- `memory_vector_search_result`
- `memory_reindex_result`
- `memory_status_result`
- `sessions_list_result`
- `sessions_spawn_result`
- `sessions_history_result`
- `sessions_send_result`
- `subagents_result`

## Plugins and marketplace

Plugin management requests:

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

Plugin management results:

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

Plugin RPC:

- `plugin_invoke`
- `plugin_result`
- `plugin_error`

Marketplace requests:

- `marketplace_search`
- `marketplace_info`
- `marketplace_featured`
- `marketplace_install`

## Git panel requests

- `git_status`
- `git_diff`
- `git_staged_diff`
- `git_log`
- `git_file_diff`
- `git_stage`
- `git_unstage`
- `git_discard`
- `git_commit`

## Error event

- `error`: generic runtime failure payload

For exact payload shapes, inspect:

- `packages/core/src/server/index.ts`
- `packages/web/src/App.tsx`
- `packages/macos/Sources/Keygate/Models/Messages.swift`
