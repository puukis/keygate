# Ngrok

Keygate includes a CLI-managed macOS ngrok background service.

Use this when you need a public internet URL.

For routine operator access, prefer `docs/REMOTE_ACCESS.md` and use:

- Tailscale for private tailnet access
- managed SSH tunnels for local operator forwarding

## Command surface

```bash
keygate ngrok start
keygate ngrok status
keygate ngrok url
keygate ngrok restart
keygate ngrok stop
```

## What it manages

- LaunchAgent label: `com.keygate.ngrok`
- LaunchAgent path: `~/Library/LaunchAgents/com.keygate.ngrok.plist`
- Forward target: `http://127.0.0.1:18790`
- Log file: `~/.keygate/ngrok.log`
- Inspector API: `http://127.0.0.1:4040/api/tunnels`

## Requirements

- macOS with `launchctl`
- `ngrok` installed locally
- ngrok authenticated with your authtoken
- Keygate listening on port `18790`

## Recommended workflow

1. Start Keygate in the background with `keygate gateway open`.
2. Start ngrok with `keygate ngrok start`.
3. Read the active public URL with `keygate ngrok url`.
4. Use `keygate ngrok status` and `tail -f ~/.keygate/ngrok.log` for diagnostics.
