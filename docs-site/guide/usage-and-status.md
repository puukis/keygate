# Usage & Status

Keygate now records turn-level usage and exposes the same data across chat commands, the web app, REST status, and the CLI.

## What is tracked

Each completed turn stores:

- provider
- model
- input tokens
- output tokens
- cached input tokens when the provider reports them
- latency
- `costUsd`

If a provider does not return native cost data, Keygate estimates cost from its built-in pricing catalog and optional `llm.pricing.overrides` values in `config.json`.

## Where to view it

### Web app

Open the **Usage** tab to see:

- 24h / 7d / 30d / all windows
- total turns, tokens, and cost
- breakdowns by provider
- breakdowns by model
- breakdowns by session
- daily aggregates

### Chat operator commands

Use the built-in commands in any supported chat surface:

```text
/status
/model
/model openai gpt-4o
/compact
/debug
/debug on
/debug off
```

`/status` shows:

- current provider/model
- reasoning effort
- security mode
- debug mode
- token/cost totals
- compaction state
- sandbox health
- node health
- Gmail watch health

`/compact` stores a non-destructive session summary. The full transcript remains in storage; future prompts use:

- the compaction summary
- a recent tail of messages

`/debug on` enables a bounded debug event buffer for the current session. The web app **Debug** tab and `/debug` both read from the same session buffer.

### CLI

```bash
keygate status [--session <id>] [--json]
keygate usage [--session <id>] [--window 24h|7d|30d|all] [--json]
```

Examples:

```bash
keygate status
keygate status --session web:abc123 --json
keygate usage --window 7d
keygate usage --session discord:1234567890 --window all
```

## REST and WebSocket surfaces

- `GET /api/status`
- websocket request: `usage_summary`
- websocket result: `usage_summary_result`
- websocket push: `usage_snapshot`
- websocket request: `debug_events`
- websocket result: `debug_events_result`
- websocket push: `debug_event`

See the websocket reference for request/result names.

## Pricing overrides

Add pricing overrides in `~/.keygate/config.json` when you want explicit cost math for a provider/model pair:

```json
{
  "llm": {
    "pricing": {
      "overrides": {
        "openai:gpt-4o": {
          "inputPerMillionUsd": 5,
          "outputPerMillionUsd": 15,
          "cachedInputPerMillionUsd": 2.5
        }
      }
    }
  }
}
```

## Operational notes

- Usage is persisted in SQLite in the `message_usage` table.
- Session rows also store aggregated counters for fast status reads.
- Old installs migrate automatically on startup.
