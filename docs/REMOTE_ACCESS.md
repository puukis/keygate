# Remote Gateway Access

Keygate Remote Gateway Access v1 adds two managed ways to reach the local operator surface without exposing the gateway broadly by default:

- Tailscale tailnet-only HTTPS on the gateway host
- managed SSH local-forward tunnels on operator machines

The gateway now binds to `127.0.0.1` by default and the main operator surface can be token-gated when remote access is enabled.

## What gets protected

When remote access is enabled, Keygate requires auth for:

- `/api/status`
- `/api/browser/*`
- `/api/uploads/*`
- `/ws`

Static assets stay public so the web app can load and present the token login form.

These routes keep their existing auth behavior:

- `/api/webhooks/*`
- `/api/gmail/push`
- `/api/plugins/*`

## Token auth model

Keygate uses the existing `server.apiToken` as the shared operator token.

Behavior:

- `keygate remote tailscale start` and `keygate remote ssh start` ensure `remote.authMode=token`
- if `server.apiToken` is empty, Keygate generates one and prints it once
- the web app exchanges that bearer token for an HttpOnly session cookie through `POST /api/auth/session`
- logging out clears the cookie through `DELETE /api/auth/session`

## Recommended order

1. Keep the gateway local with `keygate gateway open`
2. Use Tailscale if you control both ends and only need private tailnet access
3. Use SSH tunnels when you already have SSH reachability to the gateway host
4. Use ngrok only when you explicitly need a public URL

## Tailscale workflow

```bash
keygate gateway open
keygate remote tailscale start
keygate remote tailscale status
keygate remote tailscale url
```

What it does:

- configures `tailscale serve` against `http://127.0.0.1:18790`
- keeps access private to your tailnet
- leaves public internet exposure out of scope for v1

Stopping:

```bash
keygate remote tailscale stop
```

If `remote.tailscale.resetOnStop=true`, stop uses `tailscale serve reset`. Otherwise it turns off the HTTPS serve target only.

## SSH tunnel workflow

Configure the single persisted SSH profile first:

```bash
keygate remote ssh config \
  --host gateway.example.com \
  --user ops \
  --port 22 \
  --local-port 28790 \
  --remote-port 18790 \
  --identity-file ~/.ssh/id_ed25519
```

Start and inspect the tunnel:

```bash
keygate remote ssh start
keygate remote ssh status
keygate remote ssh url
```

What it does:

- creates a background `ssh -N -L ...` tunnel
- uses SSH keys only (`BatchMode=yes`, `IdentitiesOnly=yes`)
- manages the tunnel with `launchd` on macOS or `systemd --user` on Linux
- exposes the remote gateway locally on `http://127.0.0.1:28790` by default

Stopping:

```bash
keygate remote ssh stop
```

## Config fields

Relevant `config.json` fields:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 18790,
    "apiToken": "..."
  },
  "remote": {
    "authMode": "token",
    "tailscale": {
      "resetOnStop": false
    },
    "ssh": {
      "host": "gateway.example.com",
      "user": "ops",
      "port": 22,
      "localPort": 28790,
      "remotePort": 18790,
      "identityFile": "~/.ssh/id_ed25519"
    }
  }
}
```

Environment override:

- `KEYGATE_SERVER_HOST` overrides `server.host`

## Diagnostics

Use:

```bash
keygate status
keygate doctor
```

They now report:

- bind host
- remote auth mode
- Tailscale runtime state
- SSH profile completeness and runtime state

## Security notes

- keep the gateway on `127.0.0.1` unless you have a deliberate reason to bind wider
- treat the generated operator token like any other credential
- Tailscale v1 here is tailnet-only, not public internet exposure
- SSH tunnels are local forwards only; they do not publish the gateway on the operator machine's external interfaces by default
- ngrok remains available for public use cases, but it is a different risk profile than Tailscale or SSH
