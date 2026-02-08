# Codex Provider Smoke Test

## 1) Install + Onboard

```bash
keygate onboard --auth-choice openai-codex
```

Expected:
- Detects `codex` in PATH or auto-installs with `npm i -g @openai/codex` (macOS fallback: `brew install --cask codex`).
- Runs ChatGPT OAuth login through Codex app-server.
- Writes provider config in `~/.config/keygate/.keygate`:
  - `LLM_PROVIDER=openai-codex`
  - `LLM_MODEL=openai-codex/<default-from-model-list>`

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

Open web UI (`http://localhost:18790`) and send:

```text
What files are in the current workspace?
```

Expected:
- Provider/model picker shows `openai-codex` models.
- Response streams incrementally.
- Live activity includes Codex `turn/*` and `item/*` provider notifications.
