# Managed SSH Tunnels

Keygate can manage a local-forward SSH tunnel so the remote gateway appears as a local URL on the operator machine.

Default local URL:

```text
http://127.0.0.1:28790
```

This is useful when:

- you already trust and manage SSH access to the gateway host
- you do not want to expose the gateway publicly
- you want a stable local URL on the operator machine

## Requirements

- macOS or Linux
- an SSH client on the operator machine
- SSH key-based access to the gateway host

Keygate enforces a key-only style by starting the tunnel with non-interactive SSH flags.

## Configure the profile

Keygate v1 persists one SSH profile.

Example:

```bash
keygate remote ssh config \
  --host gateway.example.com \
  --user ops \
  --port 22 \
  --local-port 28790 \
  --remote-port 18790 \
  --identity-file ~/.ssh/id_ed25519
```

Fields:

- `--host`: required SSH destination
- `--user`: optional SSH user
- `--port`: SSH port, default `22`
- `--local-port`: local forward port, default `28790`
- `--remote-port`: remote Keygate port, default `18790`
- `--identity-file`: optional key path

If you run `keygate remote ssh config` with no flags, Keygate prints the current profile.

## Start, inspect, stop

```bash
keygate remote ssh start
keygate remote ssh status
keygate remote ssh url
keygate remote ssh stop
```

What `start` does:

- enables token auth if needed
- generates an operator token if none exists yet
- writes a managed service definition
- starts the SSH tunnel in the background

Service manager by OS:

- macOS: `launchd` user agent
- Linux: `systemd --user` unit

## Tunnel shape

The managed command is equivalent to:

```bash
ssh -N \
  -L 28790:127.0.0.1:18790 \
  -p 22 \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o IdentitiesOnly=yes \
  ops@gateway.example.com
```

This keeps the remote gateway bound to loopback on the gateway host and exposes it only on loopback on the operator machine.

## Security notes

- the SSH tunnel does not publish Keygate on the operator machine's external interfaces
- Keygate still requires the operator token on the protected operator surface
- if you rotate the token, the tunnel stays up, but the web app needs the new token for login

## Troubleshooting

### `status` says the profile is incomplete

Run at least:

```bash
keygate remote ssh config --host gateway.example.com
```

### The tunnel starts and dies immediately

Check:

- the host name
- the SSH port
- the key path
- whether the remote host actually has Keygate listening on `127.0.0.1:18790`

### The local URL loads but the login fails

That means the tunnel is working, but the operator token is wrong. Retry with the current `server.apiToken`.
