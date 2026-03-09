# Providers and Models

Keygate can use multiple model providers and lets you switch provider/model from the web app configuration drawer.

## Provider concepts

A provider is the backend model platform (for example OpenAI-style APIs, Codex flow, Gemini, or local Ollama).

Key points:

- provider determines auth and available models
- model determines capability, speed, and cost profile
- some models expose reasoning controls

## Selection strategy

Use this practical approach:

1. choose a stable default for daily use
2. keep one fallback model available
3. use stronger models for planning/refactor tasks
4. use faster/cheaper models for repetitive operational prompts

## Reasoning effort

For providers that support it (e.g. codex variants), reasoning effort can be adjusted.

Codex exposes four levels:

- low: quick iteration, lower depth
- medium: balanced default
- high: deeper planning without the highest latency/cost profile
- extra high (`xhigh`): maximum Codex reasoning depth for large refactors, reviews, and multi-step changes

Where to set it:

- web app model controls
- macOS app **Settings → LLM**
- `/model [provider] <model> [low|medium|high|xhigh]`

Notes:

- Keygate sends `Extra High` to Codex as the native `xhigh` value.
- If an older Codex binary still rejects `xhigh`, Keygate retries once with the legacy `high` compatibility override.

## Operational safety

- after provider/model changes, run a smoke prompt
- verify tools still behave as expected
- confirm channel behavior for mirrored sessions

## Common problems

- provider auth expired
- selected model no longer available
- rate limits or quota exceeded

When model calls fail, first verify auth, then model ID, then provider status.
