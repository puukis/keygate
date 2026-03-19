# Providers and Models

Keygate can use multiple model providers and lets you choose provider/model both during CLI onboarding and later from the web app configuration drawer.

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

## CLI onboarding model selection

During `keygate onboarding`, the model step is interactive for every provider.

- OpenAI shows a curated built-in menu such as `gpt-4o`, `gpt-4.1`, and `o3-mini`
- Gemini shows a curated built-in menu such as `gemini-1.5-pro` and `gemini-1.5-flash`
- Ollama shows a curated built-in menu such as `llama3` and `qwen2.5-coder`
- every provider menu includes `Custom model ID` if you want to enter a provider-supported model manually

### Codex onboarding behavior

Codex is slightly different because model discovery depends on the authenticated Codex session.

- onboarding runs the Codex login flow first
- if Codex returns a live model catalog, Keygate shows that live list in the menu
- if Codex returns no models or the request fails, Keygate shows a warning and falls back to the built-in Codex list
- the built-in Codex fallback list currently starts with `openai-codex/gpt-5.3` and `openai-codex/gpt-5.2`

`keygate auth login --provider openai-codex` is still the fastest auth-only path. That command logs in and persists the default discovered Codex model without opening the full onboarding picker.

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
- onboarding could not load a live model list and fell back to built-in defaults

When model calls fail, first verify auth, then model ID, then provider status.
