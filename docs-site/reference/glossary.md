# Glossary

## Agent
The AI runtime actor handling prompts, reasoning, and tool calls.

## Channel
An input/output surface such as web, terminal, Discord, or Slack.

## Session
A scoped conversation context with its own message and tool history.

## Main Session
Primary web interaction session.

## Read-only Session
Mirrored external conversation where replies must occur in the origin channel.

## Tool Event
UI-visible record of a tool start/end or provider action.

## Stream Activity
Live status indicator during model turn execution.

## Safe Mode
Conservative runtime mode with stronger confirmation behavior.

## Spicy Mode
Expanded autonomy mode intended for advanced usage.

## Scheduler Job
Cron-based automation tied to a target session and prompt.

## MCP Browser
Browser automation capability with configurable domain policy.

## Provider
Model backend service.

## Reasoning Effort
Provider/model-level option controlling depth vs speed tradeoff. Codex supports `low`, `medium`, `high`, and `xhigh` (shown in the UI as `Extra High`).
