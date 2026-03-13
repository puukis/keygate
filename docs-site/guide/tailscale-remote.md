# Tailscale Remote Access

Tailscale is the recommended Keygate remote-access path when both ends can live inside the same tailnet.

This integration is intentionally private-by-default:

- no public internet exposure mode in v1
- no Tailscale Funnel management in v1
- no Tailscale identity-header auth integration in v1

## What Keygate manages

`keygate remote tailscale start` configures Tailscale Serve against the local gateway:

```text
https://<your-tailnet-name>/<optional-path> -> http://127.0.0.1:18790
```

Keygate keeps the gateway local and asks Tailscale to publish it inside the tailnet over HTTPS.

## Requirements

- macOS or Linux
- `tailscale` installed locally
- the machine already joined to a tailnet
- Keygate running locally

## Commands

```bash
keygate gateway open
keygate remote tailscale start
keygate remote tailscale status
keygate remote tailscale url
keygate remote tailscale stop
```

## First start behavior

On first start, Keygate may do two additional things:

- enable `remote.authMode=token`
- generate `server.apiToken` if one does not exist yet

If a token is generated, Keygate prints it once. Store it securely. You need it for the web login screen.

## What `status` and `url` mean

- `status` shows whether Tailscale Serve is active and includes the best available serve detail
- `url` prints the tailnet HTTPS URL only

If the URL is missing right after start, wait a moment and run `keygate remote tailscale url` again.

## Stop behavior

```bash
keygate remote tailscale stop
```

Default behavior:

- turns off the managed HTTPS Serve target

If `remote.tailscale.resetOnStop=true` in `config.json`, stop uses a full `tailscale serve reset` instead.

## Security notes

- Tailscale is private to your tailnet in this workflow
- Keygate still requires the operator token for the protected operator surface
- webhooks, Gmail push, and plugin route auth are not folded into this token gate

## Troubleshooting

### `tailscale` not found

Install Tailscale and confirm:

```bash
tailscale version
```

### `status` says stopped or unknown

Check:

```bash
tailscale status --json
tailscale serve status
```

### The login screen keeps appearing

That usually means one of these:

- you entered the wrong `server.apiToken`
- the gateway restarted and the old session cookie was lost
- the remote transport was started before the token was copied correctly

Retry the login with the currently configured token.
