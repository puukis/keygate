---
name: channel-ops
description: Operate Keygate channel and gateway runtime commands quickly via explicit slash invocation. Use when starting, stopping, restarting, or checking status of web/discord/gateway services.
user-invocable: true
command-dispatch: tool
command-tool: run_command
command-arg-mode: raw
metadata: {"keygate":{"requires":{"bins":["node"]}}}
---
Dispatches raw runtime command arguments directly to the configured command tool.

Use this for short operational commands such as gateway/channel lifecycle checks.
