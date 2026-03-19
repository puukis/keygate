# Codex Provider Smoke Test

## 1) Install + Onboard

```bash
keygate onboarding
```

Expected:
- Detects `codex` in PATH or auto-installs with `npm i -g @openai/codex` (macOS fallback: `brew install --cask codex`).
- Runs ChatGPT OAuth login through Codex app-server.
- After login, shows a visible Codex model picker.
- Uses the live Codex model catalog when available.
- If live discovery returns nothing or fails, shows a warning and falls back to the built-in Codex model list.
- Writes provider config in `~/.keygate/.env`:
  - `LLM_PROVIDER=openai-codex`
  - `LLM_MODEL=openai-codex/<selected-model>`

Optional legacy auth-first shortcut:

```bash
keygate onboard --auth-choice openai-codex
```

Expected:
- Installs Codex CLI if needed.
- Runs auth and persists the default discovered Codex model without the full onboarding wizard.

## 2) Login Only (repeatable)

```bash
keygate auth login --provider openai-codex
```

Optional headless/device flow:

```bash
keygate auth login --provider openai-codex --device-auth
```

## 3) Run Prompt

```bash
keygate serve
```

Open web UI (`http://127.0.0.1:18790`) and send:

```text
What files are in the current workspace?
```

Expected:
- Provider/model picker shows `openai-codex` models.
- Response streams incrementally.
- Live activity includes Codex `turn/*` and `item/*` provider notifications.
