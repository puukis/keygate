# Docker

This repository includes a production-style container setup in the repo root:

- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`
- `.env.docker.example`
- `docker-entrypoint.sh`

The container startup automatically runs:

```bash
keygate mcp browser install
```

This configures the Playwright MCP server (`@playwright/mcp`) for Keygate.  
It is controlled by:

- `KEYGATE_AUTO_SETUP_MCP_BROWSER=true|false`
- `KEYGATE_AUTO_SETUP_MCP_BROWSER_STRICT=true|false`

`STRICT=true` fails container startup if MCP setup fails.

## Quick Start

```bash
cp .env.docker.example .env.docker
docker compose --env-file .env.docker up --build
```

Then open:

- `http://localhost:18790`

## Codex OAuth in Container

If you use `LLM_PROVIDER=openai-codex`, authenticate once:

```bash
docker compose exec keygate node /app/packages/cli/dist/main.js auth login --provider openai-codex --headless
```

The login/session data persists in the `keygate-codex` volume.

Current images use `/home/node/.keygate` for the Keygate config root. Older `/home/node/.config/keygate` installs are copied forward on first run when the new directory is missing, or when `/home/node/.keygate` only contains bootstrap/cache files and no primary config yet.

## Persistent Data

Named volumes are used by default:

- `keygate-config` -> `/home/node/.keygate`
- `keygate-codex` -> `/home/node/.codex`
- `keygate-playwright-cache` -> `/home/node/.cache/ms-playwright`
- `keygate-workspace` -> `/workspace`

## Optional: Use Local Repo As Workspace

By default, workspace is a named Docker volume. If you want Keygate safe-mode tools to work directly on your local files, replace:

```yaml
- keygate-workspace:/workspace
```

with:

```yaml
- ./:/workspace
```
