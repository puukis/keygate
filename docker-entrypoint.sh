#!/usr/bin/env sh
set -eu

echo "Starting Keygate container..."
echo "Node: $(node --version)"
echo "PNPM: $(pnpm --version)"
echo "Codex: $(codex --version 2>/dev/null || echo 'not installed')"

if [ "${KEYGATE_AUTO_SETUP_MCP_BROWSER:-true}" = "true" ]; then
  echo "Configuring Playwright MCP browser..."
  if node /app/packages/cli/dist/main.js mcp browser install; then
    echo "Playwright MCP browser is ready."
  else
    if [ "${KEYGATE_AUTO_SETUP_MCP_BROWSER_STRICT:-false}" = "true" ]; then
      echo "Playwright MCP browser setup failed and strict mode is enabled."
      exit 1
    fi
    echo "Playwright MCP browser setup failed; continuing startup."
  fi
else
  echo "Skipping MCP browser setup (KEYGATE_AUTO_SETUP_MCP_BROWSER=false)."
fi

echo "Launching Keygate service..."
exec "$@"
