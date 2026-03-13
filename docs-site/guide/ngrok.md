# Ngrok Tunnel

Keygate can manage a persistent ngrok tunnel for the local web app on macOS.

Use this when you need a public HTTPS URL.

For routine operator access, prefer:

- [/guide/tailscale-remote](/guide/tailscale-remote) for private tailnet access
- [/guide/ssh-tunnels](/guide/ssh-tunnels) for local SSH forwards

This guide covers the public-tunnel helper path only.

## What the command manages

When you run `keygate ngrok start`, Keygate writes and manages a user LaunchAgent with these defaults:

- LaunchAgent label: `com.keygate.ngrok`
- LaunchAgent path: `~/Library/LaunchAgents/com.keygate.ngrok.plist`
- Forward target: `http://127.0.0.1:18790`
- ngrok inspector API: `http://127.0.0.1:4040`
- Log file: `~/.keygate/ngrok.log`

The command reuses the same service label every time, so it can take over a manually created LaunchAgent without changing the naming convention.

## Requirements

- macOS with `launchctl`
- `ngrok` installed locally
- ngrok authenticated on the machine
- Keygate listening on port `18790`

If ngrok has never been authenticated on the machine, run:

```bash
ngrok config add-authtoken <your-token>
```

To make the tunnel actually serve Keygate, start the local gateway first:

```bash
keygate gateway open
```

## CLI commands

```bash
keygate ngrok start
keygate ngrok status
keygate ngrok url
keygate ngrok restart
keygate ngrok stop
```

What each command does:

- `keygate ngrok start`: writes the LaunchAgent definition if needed, bootstraps it with `launchctl`, kickstarts the agent, and prints the detected public URL when available
- `keygate ngrok status`: shows whether the LaunchAgent is running and prints the active public URL if the local inspector API is reachable
- `keygate ngrok url`: prints only the current public URL, which is useful for scripts or quick copy/paste
- `keygate ngrok restart`: unloads and starts the LaunchAgent again
- `keygate ngrok stop`: unloads the LaunchAgent

## Typical workflow

1. Start the Keygate background server with `keygate gateway open`.
2. Start the tunnel with `keygate ngrok start`.
3. Confirm the tunnel with `keygate ngrok status`.
4. Copy the public URL from `keygate ngrok url`.

Example:

```bash
keygate gateway open
keygate ngrok start
keygate ngrok url
```

## How it works

The managed LaunchAgent runs the equivalent of:

```bash
ngrok http 18790 --log ~/.keygate/ngrok.log
```

Keygate resolves the local ngrok binary before writing the LaunchAgent so `launchd` does not depend on your interactive shell PATH.

The LaunchAgent is configured with:

- `RunAtLoad=true`
- `KeepAlive=true`
- stdout and stderr redirected into `~/.keygate/ngrok.log`

That means the tunnel stays supervised by `launchd` once it has been started.

## Operational notes

- `keygate ngrok` currently manages a macOS-only background service.
- The tunnel is only as useful as the local service behind it. If nothing is listening on `127.0.0.1:18790`, the public URL will return connection failures.
- `keygate ngrok status` may show the tunnel as running before the public URL is visible for a brief moment. In that case, retry `keygate ngrok url`.
- The public URL can change when the tunnel reconnects, especially on free ngrok plans.

## Troubleshooting

If the command reports `unknown` state or no URL:

```bash
keygate ngrok status
tail -f ~/.keygate/ngrok.log
launchctl print gui/$(id -u)/com.keygate.ngrok
curl -s http://127.0.0.1:4040/api/tunnels
```

Check these failure cases first:

- ngrok is installed but not authenticated
- Keygate is not listening on port `18790`
- the LaunchAgent exists but crashed and needs `keygate ngrok restart`
- the tunnel reconnected and the public URL changed

For the exact CLI syntax, see the [CLI reference](/reference/cli).
