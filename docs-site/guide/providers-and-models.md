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

Guidance:

- low: quick iteration, lower depth
- medium: balanced default
- high/xhigh: complex planning, reviews, large changes

## Operational safety

- after provider/model changes, run a smoke prompt
- verify tools still behave as expected
- confirm channel behavior for mirrored sessions

## Common problems

- provider auth expired
- selected model no longer available
- rate limits or quota exceeded

When model calls fail, first verify auth, then model ID, then provider status.
